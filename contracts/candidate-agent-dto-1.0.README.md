# CandidateAgent DTO 1.0 — vendored contract

`candidate-agent-dto-1.0.schema.json` is the **normative wire contract** owned
by `kiwi/contracts` (contract **1.0**, draft-07). The Python DTO implementation
in `kiwi-catalog` is an implementation reference and must remain conformant.

## Source

| | |
|---|---|
| Wire-contract authority | `kiwi/contracts/candidate-agent-dto-1.0.schema.json` |
| Implementation reference | `kiwi-catalog/kiwi_catalog/agent_catalog/candidate_dto.py` → `CANDIDATE_AGENT_SCHEMA` |
| Contract owner | `kiwi`（跨仓库契约权威） |
| Normative doc | `docs/a2a/candidate-agent-dto-1.0.md`（human-readable，字段语义） |
| Design intent | shopping-cli 设计 §8.2（Search Result Contract）、§21（AgentDiscovery Integration with Kiwi）、§22（Hosted/Direct Status Model） |
| `$id` | `urn:shopping-cli:candidate-agent:1.0` |

## Sync procedure

Changes to this file are contract changes and must be reviewed in `kiwi` first.
The catalog implementation is checked against this schema; it is not the source
of wire truth. To regenerate a compatibility fixture from the implementation:

```sh
cd /path/to/kiwi-catalog
python3 -c "import json,sys; sys.path.insert(0,'.'); \
from kiwi_catalog.agent_catalog.candidate_dto import CANDIDATE_AGENT_SCHEMA; \
print(json.dumps(CANDIDATE_AGENT_SCHEMA, indent=2, ensure_ascii=False))" \
  > /tmp/candidate-agent-dto-implementation.json
```

A schema change that adds/renames/removes a field, changes a type, narrows the
required set, or removes an enum value is a **contract change** and must follow
the DTO versioning promise (contract §3).  Within `1.x` the contract is
additive-only, so `additionalProperties: false` tolerates nothing extra — a
response carrying a private field or unknown top-level key is a schema
violation and consumers treat it as corruption/failure (fail-closed).

## Consumers

- `src/discovery/catalog-source/schema.ts` loads this file and validates every
  received candidate element with ajv (draft-07 build).  Validation failure →
  `CatalogSourceError("contract_violation")`.
