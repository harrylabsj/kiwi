import json
import sys
from cloud_manifest import inspect
from resource_guard import apply_limits
from installed_cloud import inspect as inspect_installed

if len(sys.argv) not in (3,4):
    raise SystemExit('USAGE: inspect_cloud_cli.py PACKAGE_TGZ VERSION [INSTALLED_ROOT]')
try:
    apply_limits()
    result=inspect(sys.argv[1],sys.argv[2])
    if len(sys.argv) == 4:
        installed=inspect_installed(sys.argv[1],sys.argv[3])
        if installed['version'] != result['version'] or installed['files'] != result['files']:
            raise ValueError('INSTALLED_IDENTITY_MISMATCH')
        result['installed']=installed
    print(json.dumps(result, separators=(',', ':')))
except (ValueError, OSError, RuntimeError, MemoryError) as error:
    print(f'CLOUD_INSPECTION_HOLD: {error}', file=sys.stderr)
    raise SystemExit(1)
