"""Inspect a private npm staging tree against cached locked tarball bytes.

Offline prototype: this is not an attestation, trusted installer, runtime sandbox,
or protection against a same-user process changing files after inspection.
"""
import base64
import hashlib
import json
import re
import os
import stat
from pathlib import Path
from urllib.parse import urlparse
from installed_root import inspect


def inspect_modules(root, locked_locations):
    """Reject untracked packages; check POSIX npm .bin links against bin declarations."""
    pending = [root / 'node_modules']; bins = 0
    while pending:
        modules = pending.pop()
        if modules.is_symlink() or not modules.is_dir(): raise ValueError('NODE_MODULES_INVALID')
        for child in modules.iterdir():
            if child.name == '.package-lock.json':
                if child.is_symlink() or not child.is_file(): raise ValueError('NODE_MODULES_INVALID')
                continue
            if child.name == '.bin':
                if child.is_symlink() or not child.is_dir(): raise ValueError('BIN_INVALID')
                for link in child.iterdir():
                    if not link.is_symlink(): raise ValueError('BIN_INVALID')
                    raw=os.readlink(link)
                    if not raw or Path(raw).is_absolute() or '\\' in raw: raise ValueError('BIN_INVALID')
                    target=(child/raw).resolve(strict=True)
                    try: rel=target.relative_to(modules.resolve(strict=True))
                    except ValueError: raise ValueError('BIN_INVALID') from None
                    current=modules
                    for part in rel.parts:
                        current=current/part
                        if current.is_symlink(): raise ValueError('BIN_INVALID')
                    mode=target.stat().st_mode
                    if not stat.S_ISREG(mode) or not (mode & stat.S_IXUSR) or mode & 0o022: raise ValueError('BIN_INVALID')
                    package=target.parent
                    while package != modules and not (package/'package.json').is_file(): package=package.parent
                    if package == modules: raise ValueError('BIN_INVALID')
                    if package.relative_to(root).as_posix() not in locked_locations: raise ValueError('EXTRANEOUS_PACKAGE')
                    data=json.loads((package/'package.json').read_text())
                    declared=data.get('bin');binpath=declared if isinstance(declared,str) and data.get('name','').split('/')[-1]==link.name else declared.get(link.name) if isinstance(declared,dict) else None
                    if not isinstance(binpath,str) or '\\' in binpath or Path(binpath).is_absolute() or (package/binpath).resolve(strict=True)!=target: raise ValueError('BIN_INVALID')
                    bins += 1
                continue
            if child.name.startswith('@'):
                if child.is_symlink() or not child.is_dir(): raise ValueError('NODE_MODULES_INVALID')
                candidates=list(child.iterdir())
            else:
                candidates=[child]
            for package in candidates:
                if package.is_symlink() or not package.is_dir(): raise ValueError('NODE_MODULES_INVALID')
                if package.relative_to(root).as_posix() not in locked_locations: raise ValueError('EXTRANEOUS_PACKAGE')
                nested=package/'node_modules'
                if nested.exists() or nested.is_symlink(): pending.append(nested)
    return bins


def inspect_tree(project):
    root = Path(project)
    if root.is_symlink() or not root.is_dir(): raise ValueError('PROJECT_INVALID')
    root = root.resolve(strict=True)
    flags=os.O_RDONLY | getattr(os,'O_NOFOLLOW',0)
    try:
        fd=os.open(root/'package-lock.json',flags)
        with os.fdopen(fd,'rb') as src:
            st=os.fstat(src.fileno())
            if not stat.S_ISREG(st.st_mode) or st.st_size>16*1024*1024 or st.st_mode&0o022 or (hasattr(os,'getuid') and st.st_uid!=os.getuid()): raise ValueError('PACKAGE_LOCK_INVALID')
            lock=json.load(src)
    except (OSError,ValueError): raise ValueError('PACKAGE_LOCK_INVALID') from None
    packages = lock.get('packages')
    if not isinstance(packages, dict): raise ValueError('LOCK_INVALID')
    checked = 0; total_files = 0; duplicates = 0
    for location, entry in packages.items():
        if location == '': continue
        if not isinstance(location, str) or not location.startswith('node_modules/') or any(x in ('', '.', '..') for x in location.split('/')) or '\\' in location:
            raise ValueError('LOCATION_INVALID')
        if entry.get('link') or entry.get('inBundle'): raise ValueError('UNSUPPORTED_DEPENDENCY')
        integrity = entry.get('integrity', '')
        if not re.fullmatch(r'sha512-[A-Za-z0-9+/]{86}==', integrity): raise ValueError('INTEGRITY_INVALID')
        url = urlparse(entry.get('resolved', ''))
        if url.scheme != 'https' or url.hostname != 'registry.npmjs.org' or url.port or url.username or url.password or url.query or url.fragment:
            raise ValueError('REGISTRY_URL_INVALID')
        digest = base64.b64decode(integrity[7:], validate=True)
        hexdigest = digest.hex()
        cached = root / 'npm-cache' / '_cacache' / 'content-v2' / 'sha512' / hexdigest[:2] / hexdigest[2:4] / hexdigest[4:]
        if cached.is_symlink() or not cached.is_file(): raise ValueError('CACHE_MISSING')
        sha = hashlib.sha512()
        with cached.open('rb') as src:
            while chunk := src.read(1024 * 1024): sha.update(chunk)
        if sha.digest() != digest: raise ValueError('CACHE_HASH_MISMATCH')
        directory = root
        for part in location.split('/'):
            directory = directory / part
            if directory.is_symlink(): raise ValueError('INSTALLED_SYMLINK')
        result = inspect(cached, directory, skip_nested_modules=True)
        installed_meta = json.loads((directory / 'package.json').read_text())
        if installed_meta.get('version') != entry.get('version'): raise ValueError('VERSION_MISMATCH')
        checked += 1; total_files += result['files']; duplicates += result['identical_duplicate_entries']
    if not checked: raise ValueError('LOCK_EMPTY')
    bins=inspect_modules(root,{k for k in packages if k})
    return {'packages':checked, 'files':total_files, 'identical_duplicate_entries':duplicates, 'verified_bin_links':bins}
