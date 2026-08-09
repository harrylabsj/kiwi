# Python service conformance kit (dev-only)

This directory is a test contract, not a production runtime dependency. Each
Python service supplies a tiny adapter exposing `apps(tmp_path)` with
`fallback` and `fastapi` application objects. The shared cases then exercise
only externally observable transport behavior.

The first gate covers malformed-body routing order, body-size rejection,
status/error envelopes, and secret non-reflection. Domain-specific auth,
idempotency, and SQLite migration behavior remains owned by each service until
two release cycles show that the semantics are genuinely identical.

Run from a portfolio composition checkout:

```sh
PYTHONPATH=contracts/conformance/python-service:kiwi-catalog:shopping-cli \
python contracts/conformance/python-service/run.py \
  kiwi_catalog_conformance:apps shopping_cli_conformance:apps
```
