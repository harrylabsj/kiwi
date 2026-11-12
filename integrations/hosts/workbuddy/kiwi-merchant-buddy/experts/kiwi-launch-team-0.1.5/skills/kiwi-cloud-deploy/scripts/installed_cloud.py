"""Compare installed cloud package to a previously authenticated npm tarball.

This offline prototype does not establish provenance, user consent, TOCTOU
protection, WorkBuddy portability, or authorization to deploy.
"""
import hashlib
import json
import os
import stat
import tarfile
from pathlib import Path
from cloud_manifest import scan_archive, safe_name


def verify_bin(directory):
    modules = directory.parent
    count = 0
    for link in directory.iterdir():
        if not link.is_symlink(): raise ValueError('BIN_INVALID')
        raw = os.readlink(link)
        if not raw or Path(raw).is_absolute() or '\\' in raw: raise ValueError('BIN_INVALID')
        dest = (directory / raw).resolve(strict=True)
        try: relative = dest.relative_to(modules.resolve(strict=True))
        except ValueError: raise ValueError('BIN_INVALID') from None
        current = modules
        for part in relative.parts:
            current = current / part
            if current.is_symlink(): raise ValueError('BIN_INVALID')
        mode = dest.stat().st_mode
        if not stat.S_ISREG(mode) or not (mode & stat.S_IXUSR) or mode & 0o022: raise ValueError('BIN_INVALID')
        package = dest.parent
        while package != modules and not (package / 'package.json').is_file(): package = package.parent
        if package == modules: raise ValueError('BIN_INVALID')
        metadata = json.loads((package / 'package.json').read_text())
        declared = metadata.get('bin')
        name = metadata.get('name', '').split('/')[-1]
        path = declared if isinstance(declared, str) and name == link.name else declared.get(link.name) if isinstance(declared, dict) else None
        if not isinstance(path, str) or Path(path).is_absolute() or '\\' in path or (package/path).resolve(strict=True) != dest: raise ValueError('BIN_INVALID')
        count += 1
    return count


def inspect(tarball, package_dir):
    base = Path(package_dir)
    if base.is_symlink() or not base.is_dir(): raise ValueError('INSTALL_ROOT_INVALID')
    base = base.resolve(strict=True)
    scan_archive(tarball)
    with tarfile.open(tarball, 'r:gz') as archive:
        # Caller must first run cloud_manifest.inspect and verify source/SRI;
        # this operation binds the installed copy to that exact manifest.
        raw = archive.extractfile('package/build-manifest.json').read(16*1024*1024+1)
    if len(raw) > 16*1024*1024 or (base/'build-manifest.json').is_symlink() or (base/'build-manifest.json').read_bytes() != raw:
        raise ValueError('MANIFEST_MISMATCH')
    manifest = json.loads(raw)
    expected = {}
    for item in manifest['files']:
        rel=item['path']; safe_name('package/'+rel)
        if rel in expected: raise ValueError('DUPLICATE_PATH')
        expected[rel]=item
    actual=set(); bins=0
    for directory, subdirs, files in os.walk(base,followlinks=False):
        current=Path(directory)
        for name in subdirs + files:
            if (current/name).is_symlink(): raise ValueError('INSTALLED_SYMLINK')
        if current.name == 'node_modules' and '.bin' in subdirs:
            bins += verify_bin(current/'.bin')
            subdirs.remove('.bin')
        for name in files:
            file=current/name; rel=file.relative_to(base).as_posix()
            if rel == 'build-manifest.json' or rel == 'node_modules/.package-lock.json' or rel.endswith('/node_modules/.package-lock.json'): continue
            if not file.is_file() or file.stat().st_mode & 0o022: raise ValueError('INSECURE_FILE_MODE')
            actual.add(rel)
    if actual != set(expected): raise ValueError('FILE_SET_MISMATCH')
    for rel, entry in expected.items():
        file=base.joinpath(*rel.split('/'))
        if file.stat().st_size != entry['size']: raise ValueError('SIZE_MISMATCH')
        digest=hashlib.sha256()
        with file.open('rb') as src:
            while chunk := src.read(1024*1024): digest.update(chunk)
        if 'sha256:'+digest.hexdigest() != entry['sha256']: raise ValueError('HASH_MISMATCH')
    return {'files':len(expected),'verified_bin_links':bins,'version':manifest.get('runtime_version')}
