"""Inspect the buyer npm tarball without extracting or executing it."""
import json
import sys
import tarfile
from cloud_manifest import scan_archive, limited_members, safe_name
from resource_guard import apply_limits

if len(sys.argv)!=3:
    raise SystemExit('USAGE: inspect_buyer_archive_cli.py PACKAGE_TGZ VERSION')
try:
    apply_limits()
    scan_archive(sys.argv[1])
    with tarfile.open(sys.argv[1],'r:gz') as archive:
        members=limited_members(archive);seen=set();package=None;count=0
        for item in members:
            name=safe_name(item.name.rstrip('/') if item.isdir() else item.name)
            if name in seen: raise ValueError('DUPLICATE_PATH')
            seen.add(name)
            if item.isdir(): continue
            if not item.isfile() or item.size<0: raise ValueError('UNSUPPORTED_ENTRY')
            count+=1
            if name=='package/package.json':
                if item.size>1024*1024: raise ValueError('METADATA_TOO_LARGE')
                package=json.load(archive.extractfile(item))
        if not isinstance(package,dict) or package.get('name')!='@harrylabsj/kiwi' or package.get('version')!=sys.argv[2]:
            raise ValueError('IDENTITY_MISMATCH')
        print(json.dumps({'name':package['name'],'version':package['version'],'files':count},separators=(',',':')))
except (ValueError,OSError,RuntimeError,MemoryError,tarfile.TarError) as error:
    print(f'BUYER_ARCHIVE_HOLD: {error}',file=sys.stderr)
    raise SystemExit(1)
