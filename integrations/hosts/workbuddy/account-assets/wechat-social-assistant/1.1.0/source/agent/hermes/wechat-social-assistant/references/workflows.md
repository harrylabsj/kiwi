# wechat-social-assistant Workflows

## Daily Review

1. Run `wsa status`.
2. Run `wsa audit` if the user asks what local data exists.
3. Run `wsa dashboard` for the operating view.
4. Run `wsa next` for the top follow-up when the user wants a single draft.
5. If the user says the suggestion is done, irrelevant, too pushy, or useful, record that with `wsa feedback NAME ACTION` after confirmation.
6. If the user asks for broader planning, run `wsa analyze` after confirmation.
7. Read `reports/outreach.md` and `reports/contact-profiles.md`.

## Data Audit, Export, And Delete

1. Run `wsa audit` to inspect table counts and local paths.
2. To back up or migrate, confirm the output path and run `wsa export-data --out PATH --yes`.
3. To delete one contact, run `wsa delete-contact NAME --dry-run` first.
4. If the impact is expected, run `wsa delete-contact NAME --yes`.
5. Re-run `wsa audit` to verify counts changed as expected.

## Contact Lookup

1. Run `wsa contacts --query NAME`.
2. Run `wsa brief NAME`.
3. Run `wsa quality --contact NAME` when the user needs relationship strength, risks, gaps, and next action.
4. Run `wsa feedback-list --contact NAME` to inspect previous user preferences.
5. If the draft is too weak or absent, run `wsa next --contact NAME --min-score 0`.

## Feedback Loop

1. Confirm the user wants to record feedback locally.
2. Use `wsa feedback NAME ACTION`, where `ACTION` is one of `mark_done`, `snooze`, `not_relevant`, `too_pushy`, `good_draft`, `wrong_person`, `already_close`, or `do_not_contact`.
3. Use `wsa feedback-list --contact NAME` to verify the record.
4. Re-run `wsa next --contact NAME` or `wsa suggest --contact NAME` to see the adjusted recommendation.

## Group/Event Candidate Discovery

1. Run `wsa candidates --min-confidence 45` to review possible new people from groups and event-like contexts.
2. Explain that drafts are only suggestions and must not be sent automatically.
3. If the user wants to keep the queue, run `wsa candidates --sync` after confirmation.
4. If the user wants to promote one person, run `wsa candidate-confirm NAME --source-chat GROUP --yes` after confirmation.
5. Re-run `wsa brief NAME` or `wsa quality --contact NAME --min-score 0` to inspect the confirmed person.

## Local Source Import

1. Confirm the user selected local files to import, such as `.vcf`, `.ics`, `.md`, `.txt`, Obsidian `社交圈/人脉`, or `.eml`.
2. Run `wsa import-source PATH --dry-run` to preview parsed relationship sources.
3. If the preview is expected, run `wsa import-source PATH --yes`.
4. Run `wsa sources --contact NAME`, `wsa brief NAME`, or `wsa quality --contact NAME --min-score 0` to verify the contact-centered merge.

## Screenshot Import

1. Confirm the user wants to import local screenshots.
2. Run `wsa import-image PATH --contact NAME`.
3. Run `wsa brief NAME` to verify the evidence landed on the intended contact.

## Obsidian Export

1. Confirm the vault path.
2. Run `wsa export-obsidian --vault PATH`.
3. Check `社交圈/人脉/索引.md`, `社交圈/分析报告/YYYY-MM-DD.md`, and `社交圈/分析报告/YYYY-Www.md`.

## Obsidian Import

1. Confirm the user wants to import manual contact enrichment from Obsidian.
2. Run `wsa import-obsidian --vault PATH --dry-run`.
3. If the preview is expected, run `wsa import-obsidian --vault PATH --yes`.
4. Run `wsa export-obsidian --vault PATH` again if the user wants refreshed notes and reports.

## Weekly Review

1. Run `wsa weekly-report --date YYYY-MM-DD`.
2. Review the sections for active follow-ups, manual enrichment, information gaps, and recent relationship changes.
3. Do not send any drafted message without user confirmation.

## Explicit Watch Mode

1. Confirm the user wants automatic foreground WeChat capture.
2. Run `wsa watch --interval 60`.
3. Stop with `wsa stop-watch` or Ctrl-C.
4. Run `wsa status` after stopping.
