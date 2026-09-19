# Chat UI regression fixtures

Run from `apps/web`:

```sh
node node_modules/@playwright/test/cli.js test --config playwright.ui.config.ts
```

This suite starts Vite on `127.0.0.1:5180`, mocks every API request, and supplies a synthetic Reverb/Pusher connection. It never logs in to production and contains no real credentials, room content, or customer data. `synthetic-ui-token` is intentionally fake. Incoming/edit events travel through the browser WebSocket listener rather than patching the React state.

Coverage: 320/390/1440px reflow, actual body text sizes, and compact conversation header, touch actions without invisible layout, Escape focus restoration, visible quote highlight and timer cleanup after a realtime edit, retaining room rows after a failed refresh, incoming-message scroll preservation with jump-to-latest and duplicate/edit/own-message count exclusions, prepend/arrival concurrency with single-flight loading, stale pagination responses after a room switch, live-edit and room-return anchor preservation within 4 CSS pixels, read receipt suppression while reading history, precise quote return, and sending from anchored history.

Persistent screenshots are saved under ignored `e2e-artifacts/ui/screenshots`; failure traces/results are under `e2e-artifacts/ui/test-results`. Screenshots are visual review evidence, not pixel-golden assertions. Frontend fixture passes do not establish backend correctness, actual-device keyboard behavior, production permissions, or live read receipt semantics.

Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to use a custom Chromium. Otherwise the config uses the locally available cached binary when present, falling back to Playwright’s default installed browser.
