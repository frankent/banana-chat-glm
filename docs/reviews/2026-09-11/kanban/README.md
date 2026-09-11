# TASK-BE/WEB/ADM/QA-041 — workspace Kanban

FR-KAN-001..005, DEC-051, API-140..148, EVT-064.

One board per workspace, three initial lanes. Members collaborate on tickets (title, Markdown description, task/bug/story, priority, assignee, reporter, labels, deadline), comments and activity. Desktop drag between lanes and keyboard/mobile select; search, mine/priority filters, cursor pagination. Workspace owner/admin manages lanes in board settings; system admins use `/admin/kanban`.

Isolation is enforced by active workspace middleware, explicit scoped ID queries, assignee membership validation and a composite workspace/lane foreign key. Ticket version conflicts return 409 rather than overwriting concurrent work. Workspace row locks serialize lane changes, ticket numbering/edits and deadline checks. Occupied/last lane deletion is rejected. Every lane write is audited; ticket history is retained (latest 100 shown).

The every-minute job records a durable `ticket_due` notification and its marker in the same transaction. It catches up missed deadlines after downtime, skips completed/unassigned/inactive/removed assignments, and resets on a changed deadline/assignee or reopen. Existing notification event/audio honors sound/DND. Feed is scoped to the active workspace for ticket notifications; clicking opens the ticket. This includes in-app persistence and online sound, not a new email or closed-browser push service. Chat unread totals remain message-only.

## Verification

- First four API tests failed before implementation (missing board routes); core helper test failed before module creation.
- Full API regression: 354 passed / 2 existing skips / 1,621 assertions, exclusively orgchat_test.
- All unit suites: 130 passed (3 shared, 6 api-client, 82 chat-core, 39 mobile).
- Workspace TypeScript checks and web production build passed (existing large bundle warning).
- Browser `verify.mjs`: 7 passed with real API/Reverb and isolated orgchat_kanban_review: create/share, move/comment, lane permissions/realtime, due notification/deep link, mobile, workspace switch isolation, no JS errors.
- Admin browser: saved/renamed/added lanes survive reload; desktop/mobile layouts checked. Tests wait for Livewire workspace update before editing; immediate text assertion was initially satisfied by the previous workspace's identical default name. Mobile backdrop click targets the exposed edge rather than its covered center.
- OpenAPI parses with Symfony YAML. Fixed a pre-existing unquoted comma in a response description. `pnpm gen:client` is absent in this repository; maintained the existing typed wrapper/types and verified typechecks instead.

## Review

Reuse of Filament, membership and notifications avoids a second auth or alert system. Traced API ID resolution, lane/assignee cross-workspace rejection, client workspace-key remount, stale-version errors, atomic reminder marker, completed/reopened lanes and scheduler registration. Tests also cover ticket/comment pagination beyond the first page and current-assignee-only reminders. No Jira API integration or full Jira parity claimed.

Production deployment/verification will be recorded in production-results.json. Migration is additive; rollback images may keep the unused new tables without touching chat data.

## Production outcome

Runtime commit `8768584` deployed to https://chat.gamecoms.net. Backup/database dump and rollback image tags `before-kanban-20260911` retained under `/root/banana-chat-backups/kanban-20260911`. Checked incremental patch against existing server modifications, built api/worker/scheduler/reverb/nginx, ran the additive migration successfully, then recreated those services. All nine services healthy. Schedule inventory includes NotifyDueTickets every minute.

Five production checks passed in a dedicated QA workspace with tony/tony2: create/live share; **actual scheduler** deadline notification (no manual trigger), exactly one feed row and deep link; foreign-workspace GET returns 404 and list excludes the ticket; comment/live move to Done; zero browser runtime errors. Both test browser sessions signed out. QA workspace, ticket, comments and notification were removed; existing user accounts and memberships retained.

The first production harness run mixed Playwright response.status() with browser Fetch response.status, causing assertions to fail after the actual ticket was created. Corrected only the test helper, removed/recreated its isolated fixture, and reran all five checks successfully. Admin CRUD and responsive rendering were verified locally; production admin code is deployed, without using an existing user's credentials or elevating their role.
