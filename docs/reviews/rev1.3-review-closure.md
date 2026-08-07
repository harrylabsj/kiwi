# rev1.3 Review Closure

Source review: `kiwi-a2a-rev1.3-docs-review-2026-08-07.md`

## Absorbed

- R1 document identity conflict → v1.1 Draft separated from released v1.0.
- R2/K1 duplicate Handoff definitions → KTH is sole object/state authority.
- R3 Handoff safety invariants → added to architecture.
- R4 broken artifact paths → replaced with actual/current paths; created test plan path.
- R5 duplicated product definitions → architecture now contains summary + pointers.
- R6 / shopping-cli write authority → explicit per-field write modes and upstream proxy semantics.
- KNP state table gap → AWAITING_CLARIFICATION included in negotiation-level Withdraw/Decline; offer decline case clarified.
- KNP digest ambiguity → only `digest` is removed; transport signatures must remain outside envelope.
- condition nesting ambiguity → explicit depth counting.
- `in_reply_to` → defined next to Envelope.
- independent implementation claim → spec release separated from cross-vendor evidence.
- KTH candidate→handoff linkage/state machine/schema direction → added.
- kiwi-catalog COMMERCE_VERIFIED semantics/freshness → clarified.
- nickname wording → removed.

## Operational issue not executable from this artifact task

The review also notes the actual repo draft files were untracked. This document package cannot perform a Git commit in the user's repository. The generated bundle is organized so it can be copied/committed as one unit.
