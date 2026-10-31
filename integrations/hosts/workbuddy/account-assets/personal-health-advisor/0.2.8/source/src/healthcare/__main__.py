import sys

# dataclass(slots=True) in models.py breaks below 3.10 with a cryptic
# "unexpected keyword argument 'slots'"; fail fast with an actionable message
# instead (pyproject declares requires-python >= 3.11). Agent shells (launchd,
# Hermes) may resolve bare `python3` to Xcode's 3.9 — scripts/healthcare pins
# a supported interpreter.
if sys.version_info < (3, 10):
    sys.stderr.write(
        "healthcare: Python {} at {} is too old (requires >= 3.11).\n"
        "Use the wrapper, which pins a supported interpreter: scripts/healthcare ...\n".format(
            ".".join(str(part) for part in sys.version_info[:3]), sys.executable
        )
    )
    raise SystemExit(2)

from .cli import main

raise SystemExit(main())
