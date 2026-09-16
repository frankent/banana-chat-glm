# Incoming 1-to-1 ringtone

FR-CALL-001 / DEC-RING-001: repeat a two-pulse ringtone for incoming DM voice
and video calls, never for outgoing or group calls. Stop on answer, decline,
remote cancellation, logout, local silence, or the existing 60-second ring
window. Realtime call changes drive refresh; polling provides recovery.

Web uses the existing gesture-unlocked AudioContext and offers Enable ringtone
when browser audio is blocked. Silence ringtone does not reject a call.

Native mobile adds foreground call-state monitoring and bundled expo-audio
playback. It respects silent mode and stops on backgrounding. The native app
does not yet implement answering/media or background/terminated-app call push;
the alert explicitly directs recipients to answer in the web app. A new native
build is required. No native runtime/device verification is claimed.

Mobile API and public Reverb configuration now target chat.gamecoms.net over
TLS. The Reverb application key is a public client identifier, not a secret.

Production rollback image: banana-ringtone-rollback:20260911.
Source backup: /opt/banana-ringtone-backup/source.tar.

Validation and deployment results are reported separately after execution.

## Validation before deployment

- Web TypeScript/Vite production image build passed.
- Candidate Playwright: 7 ringtone/screenshot checks passed, no browser runtime
  errors; isolated QA users/workspace removed.
- Candidate chat regression: 34 checks passed, including calls, media, message
  controls and responsive navigation.
- Mobile TypeScript: `node apps/mobile/node_modules/typescript/bin/tsc --noEmit
  -p apps/mobile/tsconfig.json` passed.
- Mobile Jest: 8 suites / 28 tests passed with `sqlite-cache.test.ts` excluded.
  The standard pnpm command hit a better-sqlite3 build failure because this
  machine lacks make. The direct compiler and non-SQLite suites passed.
- No native device/emulator audio test or installer build was performed.

The original audio probe counted a non-ringtone oscillator during answer.
The corrected probe tracks the distinctive 480 Hz ringtone component; answer
then passes without changing application audio code. Timeout simulation now
uses a fixed aged timestamp, not one that moves forward on each poll.

## Production deployment

Application commit: 79f3cf7, pushed to origin/main.

Production Playwright: all 7 ringtone/screenshot checks passed with no browser
runtime errors. Temporary accounts and workspace were cleaned up.
`production-results.json` and `production-*.png` contain the final evidence.

Running nginx image:
`sha256:77e4e81c788b2580552d710be91d06a04e4e364ff4ba51a46fd499ff37325109`.
Container healthy. Public API health returned healthy with database, Redis,
storage, Reverb and queue checks passing at 2026-09-11T14:25:09Z.
Only nginx was recreated; no database migrations or backend changes.
Native source was synchronized, but no mobile binary was built or released.
