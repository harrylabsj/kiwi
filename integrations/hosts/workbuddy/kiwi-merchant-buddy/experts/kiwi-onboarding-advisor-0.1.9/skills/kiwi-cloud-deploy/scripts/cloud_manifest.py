"""Offline inspection only; provenance and execution authorization are separate gates."""
import hashlib
import gzip
import json
import re
import tarfile
from pathlib import PurePosixPath

MAX_BYTES = 512 * 1024 * 1024
MAX_FILES = 100_000
MAX_METADATA_BYTES = 1024 * 1024


def scan_archive(path):
    """Bound inflated tar bytes and extension records before tarfile parsing.

    This is not an OS sandbox and must run in a resource-limited child. It
    reads in fixed-size blocks and refuses concatenated or nonzero trailing
    data after the tar end marker.
    """
    total = 0
    with gzip.open(path, 'rb') as source:
        def consume(amount, require_zero=False):
            nonlocal total
            while amount:
                chunk = source.read(min(amount, 65536))
                if not chunk: raise ValueError('TRUNCATED_ARCHIVE')
                total += len(chunk)
                if total > MAX_BYTES: raise ValueError('TOO_LARGE')
                if require_zero and any(chunk): raise ValueError('TRAILING_DATA')
                amount -= len(chunk)
        count = 0
        while True:
            header = source.read(512)
            if not header: raise ValueError('TRUNCATED_ARCHIVE')
            total += len(header)
            if len(header) != 512 or total > MAX_BYTES: raise ValueError('TOO_LARGE' if total > MAX_BYTES else 'TRUNCATED_ARCHIVE')
            if header == bytes(512):
                while chunk := source.read(65536):
                    total += len(chunk)
                    if total > MAX_BYTES: raise ValueError('TOO_LARGE')
                    if any(chunk): raise ValueError('TRAILING_DATA')
                break
            count += 1
            if count > MAX_FILES: raise ValueError('TOO_MANY_FILES')
            try: item = tarfile.TarInfo.frombuf(header,'utf-8','surrogateescape')
            except tarfile.HeaderError as error: raise ValueError('ARCHIVE_HEADER_INVALID') from error
            if item.size < 0 or item.size > MAX_BYTES: raise ValueError('TOO_LARGE')
            if item.type in (tarfile.XHDTYPE,tarfile.XGLTYPE,tarfile.GNUTYPE_LONGNAME,tarfile.GNUTYPE_LONGLINK) and item.size > MAX_METADATA_BYTES:
                raise ValueError('METADATA_TOO_LARGE')
            consume(((item.size + 511)//512)*512)


def limited_members(archive):
    # Apply limits while reading headers, before tarfile materializes the entire
    # archive or advances past a huge declared member. PAX parser internals and
    # decompression resource use still need an external process limit.
    members = []
    declared = 0
    for item in archive:
        if len(members) >= MAX_FILES:
            raise ValueError('TOO_MANY_FILES')
        if item.size < 0:
            raise ValueError('UNSUPPORTED_ENTRY')
        declared += item.size
        if declared > MAX_BYTES:
            raise ValueError('TOO_LARGE')
        members.append(item)
    return members


def safe_name(name):
    if not isinstance(name, str) or '\\' in name or '\0' in name or not name.startswith('package/'):
        raise ValueError('UNSAFE_PATH')
    parts = name.split('/')
    if any(p in ('', '.', '..') for p in parts) or str(PurePosixPath(name)) != name:
        raise ValueError('UNSAFE_PATH')
    return name


def inspect(path, expected_version):
    """Inspect without extraction or execution; callers must independently verify provenance."""
    scan_archive(path)
    with tarfile.open(path, 'r:gz') as archive:
        members = limited_members(archive)
        all_names = set()
        files = {}
        total = 0
        for item in members:
            name = safe_name(item.name.rstrip('/') if item.isdir() else item.name)
            if name in all_names:
                raise ValueError('DUPLICATE_PATH')
            all_names.add(name)
            if item.isdir():
                continue
            if not item.isfile() or item.size < 0:
                raise ValueError('UNSUPPORTED_ENTRY')
            total += item.size
            if total > MAX_BYTES:
                raise ValueError('TOO_LARGE')
            files[name] = item
        manifest_name = 'package/build-manifest.json'
        if manifest_name not in files or files[manifest_name].size > 16 * 1024 * 1024:
            raise ValueError('MANIFEST_MISSING')
        manifest = json.load(archive.extractfile(files[manifest_name]))
        if manifest.get('runtime_version') != expected_version or manifest.get('artifact_kind') != 'kiwi-merchant-cloud-package':
            raise ValueError('IDENTITY_MISMATCH')
        entries = manifest.get('files')
        if not isinstance(entries, list) or len(entries) > MAX_FILES or manifest.get('file_count') != len(entries):
            raise ValueError('MANIFEST_INVALID')
        expected = {}
        for entry in entries:
            rel = entry.get('path')
            name = safe_name('package/' + rel) if isinstance(rel, str) else ''
            digest = entry.get('sha256')
            if name in expected or not isinstance(entry.get('size'), int) or entry['size'] < 0 or not isinstance(digest, str) or not re.fullmatch(r'sha256:[0-9a-f]{64}', digest):
                raise ValueError('MANIFEST_INVALID')
            expected[name] = entry
        if set(files) != set(expected) | {manifest_name} or manifest_name in expected:
            raise ValueError('FILE_SET_MISMATCH')
        size_sum = 0
        # Read in archive order to avoid repeatedly rewinding the compressed stream.
        for name, item in sorted(files.items(), key=lambda pair: pair[1].offset_data):
            if name == manifest_name:
                continue
            entry = expected[name]
            if item.size != entry['size']:
                raise ValueError('SIZE_MISMATCH')
            size_sum += item.size
            digest = hashlib.sha256()
            with archive.extractfile(item) as src:
                while chunk := src.read(1024 * 1024):
                    digest.update(chunk)
            if 'sha256:' + digest.hexdigest() != entry['sha256']:
                raise ValueError('HASH_MISMATCH')
        if manifest.get('total_bytes') != size_sum:
            raise ValueError('TOTAL_MISMATCH')
        lines = sorted(f"{e['path']}\0{e['sha256']}" for e in entries)
        aggregate = 'sha256:' + hashlib.sha256('\n'.join(lines).encode()).hexdigest()
        if aggregate != manifest.get('artifact_sha256'):
            raise ValueError('AGGREGATE_MISMATCH')
        return {'version': expected_version, 'files': len(entries), 'bytes': size_sum, 'aggregate': aggregate, 'sourceCommit': manifest.get('source_commit')}
