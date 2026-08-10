## What & why

<!-- Concise summary of the change and the problem it solves. Link to a related issue if one exists. -->

## Test plan

<!--
What did you run to validate this change?
Minimum: `npm ci` and `npm run verify` (lint + typecheck + build + tests + package smoke).
For contract/protocol changes, also run the relevant `verify:*` scripts and update docs as needed.
-->

- [ ] `npm run verify`
- [ ] Relevant targeted tests / scripts (list them)

## Checklist

<!-- Confirm before requesting review. -->

- [ ] No new runtime dependencies unless required and justified.
- [ ] No credentials, personal data, private host details, or local filesystem paths are introduced.
- [ ] If this PR touches `package-lock.json`, `portfolio.lock.json`, or `uv.lock`, the lock changes match the source changes.
- [ ] If this PR touches `.github/workflows/*`, every `uses:` action remains pinned to a full 40-character commit SHA with a matching version comment.
- [ ] Public API, protocol schemas, and contract definitions are unchanged unless the change is intentional and documented.
- [ ] Changelog / docs updated where behavior or process changes.
