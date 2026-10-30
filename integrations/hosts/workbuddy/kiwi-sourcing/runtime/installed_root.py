"""Offline root-package inspection; not a dependency-tree or runtime gate."""
import hashlib
import json
import os
import stat
import tarfile
from pathlib import Path
from cloud_manifest import safe_name, scan_archive, limited_members, MAX_BYTES


def inspect(tarball, installed, skip_nested_modules=False):
    scan_archive(tarball)
    base = Path(installed)
    if base.is_symlink() or not base.is_dir():
        raise ValueError('INSTALL_ROOT_INVALID')
    with tarfile.open(tarball, 'r:gz') as archive:
        members = limited_members(archive)
        expected = {}; seen = {}; file_entries = []; size = 0; archive_root = None; duplicates = 0
        for item in members:
            raw = item.name.rstrip('/') if item.isdir() else item.name
            head, separator, tail = raw.partition('/')
            if not head or head in ('.', '..') or '\\' in head:
                raise ValueError('UNSAFE_PATH')
            if archive_root is None: archive_root = head
            if head != archive_root: raise ValueError('ARCHIVE_ROOT_MISMATCH')
            if not separator:
                if not item.isdir(): raise ValueError('UNSAFE_PATH')
                continue
            # Some npm archives contain harmless './' components; normalize
            # those only, and detect collisions after normalization below.
            parts = tail.split('/')
            if any(part in ('', '..') for part in parts): raise ValueError('UNSAFE_PATH')
            normalized = '/'.join(part for part in parts if part != '.')
            if not normalized: raise ValueError('UNSAFE_PATH')
            name = safe_name('package/' + normalized)
            previous = seen.get(name)
            if previous:
                # Only duplicate regular files with identical metadata can be
                # considered; every copy is independently hashed below.
                attrs = ('size', 'mode', 'uid', 'gid', 'mtime', 'type', 'pax_headers', 'linkname')
                if not previous.isfile() or not item.isfile() or any(getattr(previous, k) != getattr(item, k) for k in attrs):
                    raise ValueError('DUPLICATE_PATH_CONFLICT')
                duplicates += 1
            else:
                seen[name] = item
            if item.isdir(): continue
            if not item.isfile() or item.size < 0: raise ValueError('UNSUPPORTED_ENTRY')
            size += item.size
            if size > MAX_BYTES: raise ValueError('TOO_LARGE')
            rel = name.removeprefix('package/')
            if skip_nested_modules and 'node_modules' in rel.split('/'):
                raise ValueError('BUNDLED_DEPENDENCY_UNSUPPORTED')
            expected[rel] = item
            file_entries.append((rel, item))
        actual = set(); directories = {}
        for directory, subdirs, files in os.walk(base, followlinks=False):
            current=Path(directory)
            directories[current.relative_to(base).as_posix()] = stat.S_IMODE(current.stat().st_mode)
            for name in subdirs + files:
                path = Path(directory, name)
                if path.is_symlink(): raise ValueError('INSTALLED_SYMLINK')
            if skip_nested_modules and Path(directory) == base and 'node_modules' in subdirs:
                subdirs.remove('node_modules')
            for name in files:
                path = Path(directory, name)
                if not path.is_file(): raise ValueError('UNSUPPORTED_ENTRY')
                if path.stat().st_nlink != 1: raise ValueError('INSTALLED_HARDLINK')
                if path.stat().st_mode & 0o022: raise ValueError('INSECURE_FILE_MODE')
                actual.add(path.relative_to(base).as_posix())
        if actual != set(expected): raise ValueError('FILE_SET_MISMATCH')
        verified = {}
        for rel, item in sorted(file_entries, key=lambda p:p[1].offset_data):
            path = base.joinpath(*rel.split('/'))
            if path.stat().st_size != item.size: raise ValueError('SIZE_MISMATCH')
            a = hashlib.sha256(); b = hashlib.sha256()
            with archive.extractfile(item) as source, path.open('rb') as current:
                while chunk := source.read(1024 * 1024): a.update(chunk)
                while chunk := current.read(1024 * 1024): b.update(chunk)
            if a.digest() != b.digest():
                raise ValueError('DUPLICATE_PATH_CONFLICT' if sum(1 for x,_ in file_entries if x == rel) > 1 else 'HASH_MISMATCH')
            verified[rel] = {'sha256':b.hexdigest(), 'mode':stat.S_IMODE(path.stat().st_mode)}
        content_digest=hashlib.sha256(json.dumps({'files':verified,'directories':directories},sort_keys=True,separators=(',',':'),ensure_ascii=True).encode()).hexdigest()
        return {'files':len(expected), 'bytes':size, 'identical_duplicate_entries':duplicates, 'content_sha256':content_digest}
