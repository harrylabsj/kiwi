# wechat-social-assistant Commands

Use these commands through the local `wsa` CLI. Prefer read-only commands before running commands that mutate local state.

## Read-Only First

- `wsa status` - inspect database, screenshots, logs, and watch state.
- `wsa audit` - inspect local table counts and storage paths.
- `wsa connectors` - inspect window/screen capture availability and macOS Accessibility permission.
- `wsa backup --out PATH --yes` - create a consistent SQLite backup after confirmation.
- `wsa ocr-review --max-confidence 0.75` - list low-confidence OCR observations for human review.
- `wsa contacts --query NAME` - find known contacts, groups, speakers, organizations, and identity hints.
- `wsa brief NAME` - summarize one contact or matching set of contacts.
- `wsa dashboard` - render the daily relationship operating dashboard.
- `wsa cockpit --dry-run` - preview the full relationship cockpit using current DB plus safe source previews.
- `wsa quality --contact NAME` - render evidence-backed relationship quality, risks, gaps, and next actions.
- `wsa candidates --min-confidence 45` - discover group/event relationship candidates without writing by default.
- `wsa sources --contact NAME` - list locally imported relationship sources for a contact.
- `wsa weekly-report --date YYYY-MM-DD` - render a weekly relationship report.
- `wsa feedback-list --contact NAME` - review auditable local feedback.
- `wsa next --contact NAME` - show the highest-priority follow-up draft for a contact.
- `wsa suggest --contact NAME` - render a follow-up suggestion table.
- `wsa profiles --contact NAME` - render contact-centered relationship profiles.

## MCP Read-Only Server

- `wsa-mcp` - run the MCP stdio server when the package console script is installed.
- `python3 -m wsa.mcp_server` - run the same MCP server from a source checkout.

The v1.1 MCP server exposes read tools: `get_status`, `get_audit_report`, `search_contacts`, `get_contact_brief`, `get_next_followup`, `get_daily_report`, `get_weekly_report`, `get_relationship_quality`, `get_relationship_dashboard`, `list_relationship_sources`, `list_relationship_candidates`, `list_feedback`, `list_recent_captures`, `get_capture_observations`, and `list_ocr_reviews`. Write tools are `record_feedback`, `confirm_relationship_candidate`, and `record_ocr_review`; all require explicit confirmation arguments. The launcher restricts file paths to `WSA_ALLOWED_ROOT`.

## Confirm Before Running

- `wsa ingest --contact NAME --text TEXT` - adds manual text to the local database.
- `wsa ocr-review --observation-id ID --action accept|reject|correct --yes` - applies a confirmed OCR review; `correct` also requires `--corrected-text`.
- `wsa candidates --sync` - persists discovered candidates to the local pending queue.
- `wsa candidate-confirm NAME --source-chat GROUP --yes` - promotes a reviewed candidate to confirmed.
- `wsa feedback NAME ACTION` - records user feedback such as `mark_done`, `snooze`, `too_pushy`, or `good_draft`.
- `wsa import-image PATH --contact NAME` - OCRs screenshots and stores evidence.
- `wsa import-obsidian --vault PATH --yes` - imports manual enrichment edited in Obsidian contact notes.
- `wsa import-source PATH --yes` - imports user-provided local contacts, calendar files, meeting notes, Obsidian notes, or email files.
- `wsa import-wechat-archive --yes` - imports selected WeChat archive manifest metadata as local relationship sources.
- `wsa cockpit --yes` - imports contact notes and WeChat archive metadata, refreshes derived data, and writes the cockpit report.
- `wsa export-data --out PATH --yes` - writes a local JSON data export.
- `wsa delete-contact NAME --dry-run` then `--yes` - previews or deletes one contact's local records.
- `wsa capture --contact NAME` - captures the screen or a selected window.
- `wsa quick-capture` - immediately captures the current screen with shortcut-friendly defaults.
- `wsa watch-interval 10` - saves the default polling interval for future `wsa watch` runs that omit `--interval`.
- `wsa watch --interval 60` - starts explicit foreground WeChat polling.
- `wsa stop-watch` - stops matching local watch processes.
- `wsa analyze` - refreshes derived data and writes report files.
- `wsa export-obsidian --vault PATH` - writes Markdown files into an Obsidian vault.
- `wsa reset --dry-run` then `wsa reset --yes` - previews or clears local memory.

## Wrapper

Use `scripts/wsa_run.py` when an agent needs a guardrail around command execution. It lists allowed commands with `--list-commands` and requires `--confirm` for write or process-control commands.
