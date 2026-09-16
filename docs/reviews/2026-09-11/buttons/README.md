# Button consistency - production verification

Deployed to https://chat.gamecoms.net on 2026-09-11. Production passed 37 screen-state checks (539 standardized action-button observations, including repeated navigation controls), with no size violations, off-screen buttons or browser runtime errors. All 34 functional Playwright regressions also passed.

## Changes

- Shared buttons.css replaces inconsistent per-screen geometry: 40px desktop action height, 44px touch height, 8px corners, 12px horizontal padding, centered labels/icons and 18px SVGs. Icon-only controls are matching squares. Text buttons retain content-dependent widths.
- Formatting controls use a deliberate compact tier: 32px desktop / 40px touch.
- Call icons and labels now sit on one line. Header actions, message actions, composer controls, notes, media tabs, search, board actions, ticket forms, AI controls, meeting actions and native file-picker buttons share the same sizing rules.
- Replaced mixed emoji message icons with matching SVG reply, pin, edit, delete and menu icons.
- Removed inherited margins/stretching that made the mobile board's Manage lanes button 68px tall beside a 38px Create ticket button.
- Narrow chat headers use a separate action row; the AI sidebar stacks above its content on narrow layouts so buttons remain reachable.
- Content cards, image previews, branding and overlay backdrops intentionally retain content-driven geometry. The admin remains within Filament's established component system: 36px action buttons and 32/36px utility icons. Its create-user dialog actions were checked for equal heights; these are not forced into the web client's separate visual theme.

## Before / after

| Control | Before desktop | After desktop |
| --- | --- | --- |
| Voice / video | 50.5px | 40px |
| Notes | 34.5px | 40px |
| Media | 28px | 40px |
| Reply / pin | 28 x 24px | 40 x 40px |
| Edit / delete | approximately 31 x 24px | 40 x 40px |
| Native notes file picker | unstyled browser control | 40px |

## Validation

Screens: login, home, new-group form, chat actions, notes, media, notifications, search, members, meetings, board, ticket editor, lane settings, AI, memories, consent, admin login/dashboard and create-user modal. Responsive passes include 768px, 390px and 320px; the functional suite additionally covers 1440px, 1024px, 820px, 760px and tablet touch.

Production measurements and errors: production.json. Before measurements: baseline.json. Screenshots: production-*.png. Functional evidence: ../chat-ui/buttons-production/results.json. The functional suite covers messaging, edit/delete/reply/pin, uploads/viewers, drafts, mentions, notes, navigation, notification sound and two-user call controls. Camera/microphone input is synthetic; OS-level device pickers and every content/error combination are not certified.

The first measurement script incorrectly assumed /admin/users/create existed. The admin uses a table action modal; the final audit opens that actual modal and waits for its transition to settle. Browser-native file selectors were added to the audit after screenshot inspection, rather than relying only on HTML button measurements.

## Deployment and rerun

TypeScript and Vite production builds passed. Only nginx/frontend was rebuilt and recreated. No API, environment or schema changes. Running image: sha256:c4d3aee3096aa5c0d5e3933e3bf546b67c0d0174ed1623ead723e8a22e7375ac running healthy.

Rollback image: banana-buttons-rollback:20260911. Source backup: /opt/banana-buttons-backup/source.tar. QA workspaces/accounts were removed; the functional suite also removes its uploaded files. No credentials are committed.

verify.cjs uses an authenticated /tmp/banana-buttons-ssh control socket and creates a uniquely named temporary QA workspace plus two accounts, one with admin access for the read-only admin checks. Its generated credentials are kept temporarily in /tmp/banana-buttons-fixture.json so candidate and production can use the same fixtures. Remove that run's workspace/accounts and credential file after verification. Set BUTTON_QA_PACKAGE to a package.json whose node_modules includes Playwright, RUN to the artifact prefix, and optionally ASSETS to a candidate static-asset server. Omit ASSETS for production.
