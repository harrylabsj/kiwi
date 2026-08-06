# CandidateAgent DTO 1.0 — vendored contract

`candidate-agent-dto-1.0.schema.json` is a **vendored copy** of the canonical
shopping-cli CandidateAgent DTO schema (contract **1.0**, draft-07).

## Source

| | |
|---|---|
| Canonical definition | `shopping_cli/agent_catalog/candidate_dto.py` → `CANDIDATE_AGENT_SCHEMA` |
| Repository | `shopping-cli`（契约 owner，见 shopping-cli 设计 §21 仓库归属） |
| Normative doc | `docs/a2a/candidate-agent-dto-1.0.md`（human-readable，字段语义） |
| Design intent | shopping-cli 设计 §8.2（Search Result Contract）、§21（AgentDiscovery Integration with Kiwi）、§22（Hosted/Direct Status Model） |
| `$id` | `urn:shopping-cli:candidate-agent:1.0` |

## Sync procedure

Kiwi **MUST NOT** hand-edit this file.  Re-export from the canonical Python dict:

```sh
cd <LOCAL_USER_HOME>/coding/shopping-cli
python3 -c "import json,sys; sys.path.insert(0,'.'); \
from shopping_cli.agent_catalog.candidate_dto import CANDIDATE_AGENT_SCHEMA; \
print(json.dumps(CANDIDATE_AGENT_SCHEMA, indent=2, ensure_ascii=False))" \
  > <WORKSPACE>/kiwi/contracts/candidate-agent-dto-1.0.schema.json
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
