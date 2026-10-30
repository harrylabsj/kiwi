import json
import sys
from installed_tree import inspect_tree
from resource_guard import apply_limits

if len(sys.argv) != 2:
    raise SystemExit('USAGE: inspect_tree_cli.py PROJECT_DIR')
try:
    apply_limits()
    print(json.dumps(inspect_tree(sys.argv[1]), separators=(',', ':')))
except (ValueError, OSError, RuntimeError, MemoryError) as error:
    print(f'TREE_INSPECTION_HOLD: {error}', file=sys.stderr)
    raise SystemExit(1)
