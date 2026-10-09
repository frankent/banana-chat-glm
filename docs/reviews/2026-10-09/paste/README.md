# Paste an image into the composer — review and verification

Date: 2026-10-09 · Spec: FR-MEDIA-001, **DEC-099** (PRODUCT_SPEC.md §15), changelog 1.18.1 ·
Tests: `TC-CORE-PASTE-001..020` (Vitest), `TC-WEB-PASTE-001..013` (Playwright, fixture-based)

## Result

Ctrl/Cmd+V with an image on the clipboard stages it as a normal attachment chip (same
ticket → PUT → complete → send pipeline as the paperclip). Real text on the clipboard wins, so a
spreadsheet or Word selection pastes as text. The handler is a React `onPaste` on the composer root.

## What changed from the first (GLM) implementation, and why

The first version was a `document`-level listener plus 5 Playwright tests that all passed.
**They passed with the chip in an error state**: the fixture never mocked the upload ticket, so the chip
read `Cannot read properties of undefined (reading 'attachment_id')` and the tests only checked that
*a* chip was visible. It was replaced, not patched. An independent review also found it discarded pasted
*text* whenever an image was present, named every image `image.png`, and left test IDs that collided
with the existing `TC-MEDIA-*` upload cases.

## Clipboard shapes — measured, not assumed

Real Chromium (headed) on macOS, real OS pasteboard, page-side `paste` event:

| Source | What the page receives |
| --- | --- |
| File copied Finder-style (`NSPasteboard.writeObjects([file URL])`) | types `["Files"]`; one `image/png` file named `Holiday-Photo.png`; **no `text/plain`** |
| Selection copy of an `<img>` inside Chromium | `text/html` only, **no image file** |
| Screenshot | one file item, no text (established by the file-copy shape; not separately measured) |

**Synthesised, not measured** (cannot be produced natively on this machine; built with the async clipboard
API, which presents the same item shapes): browser context-menu "Copy image" (`text/html` + image, no plain
text) and an Excel/Word selection (`text/plain` + `text/html` + a rendered image).

## UX/UI review by Codex `gpt-6-luna` (read-only; it changed no file)

Screenshots reviewed: `01`–`06` below. Verbatim:

> 1. **Major — pasted images look identical.** Screenshots 2 and 3 show two `pasted-image-20261009-…` chips, with the distinguishing seconds and `-2` clipped by `max-w-40 truncate` in [Composer.tsx:214](/Users/kiattirat/trycatch/banana-chat-glm/apps/web/src/components/Composer.tsx:214). A Thai office user can’t confidently remove or send the intended screenshot. **Fix:** use a short, unique name with the differentiator first, such as `ภาพ 16-32-05.png` and `ภาพ 16-32-05-2.png`, for both the chip and sent attachment name. Keep the full date in a `title` if useful. This is better than middle ellipsis or wrapping because the same name appears to recipients and in downloads; a tooltip alone is easy to miss on phones.
>
> 2. **Major — upload failure is shown as a raw code.** Screenshot 5 shows `[MEDIA_TOO_LARGE]` and the Thai reason clipped. The uploader renders `s.error` directly; failed HTTP PUTs also become the generic English `upload failed (413)` in [useUploader.ts:178](/Users/kiattirat/trycatch/banana-chat-glm/apps/web/src/hooks/useUploader.ts:178). **Fix:** map known API codes/statuses to concise Thai, e.g. `ไฟล์ใหญ่เกินกำหนด · เลือกไฟล์ที่เล็กลง` and allow the status line to wrap with `whitespace-normal break-words`. This changes the shared uploader, so it affects paperclip uploads too. Add a Thai `aria-label` such as `นำภาพออก: ${filename}` to the remove button.
>
> 3. **Minor — no screen-reader announcement for chip changes.** The chip row in [Composer.tsx:201](/Users/kiattirat/trycatch/banana-chat-glm/apps/web/src/components/Composer.tsx:201) has no live region. Screen-reader users may miss that paste staged an image or that its upload failed. **Fix:** add `aria-live="polite"` and `aria-relevant="additions text"` to the row; keep focus in the textarea after paste. The handler does not move focus, so focus should remain there. Chips have no keyboard shortcut for removal, but their remove buttons are keyboard reachable; a shortcut is not necessary if those buttons have clear accessible names.
>
> 4. **Minor — touch removal target is too small.** At 390 and 320 px (screenshots 2 and 3), the × is a small glyph with only `px-1`, likely below a comfortable touch target. **Fix:** give the button `min-h-10 min-w-10 inline-flex items-center justify-center shrink-0` and keep a visible focus ring. Chip spacing is otherwise clear; three chips take about 178 px above the composer in the supplied phone crop. That is noticeable but not excessive in this example.
>
> 5. **Minor — text-wins can look like paste failed.** Screenshot 6 correctly shows text and no chip, per DEC-099. Silence protects common spreadsheet, Word, and web-selection pastes, but someone copying a picture out of Word may expect an attachment. **Fix:** don’t toast on every text paste. Add a brief Thai hint near the composer, e.g. `วางรูปภาพเพื่อแนบ · หากมีข้อความ ระบบจะวางข้อความแทน`, so the rule is discoverable without interrupting routine pastes.
>
> 6. **Nit — paste is undiscoverable and hint is English.** [Composer.tsx:270](/Users/kiattirat/trycatch/banana-chat-glm/apps/web/src/components/Composer.tsx:270) shows English send-key guidance; on phones the hint is hidden by CSS. **Fix:** localize the remaining hint into Thai and include the paste instruction above or inside the composer. The screenshots show the actual composer placeholder is Thai, but paste has no visible cue.
>
> **Looks good:** screenshot 4 shows a Thai uploading status and disabled send button; the spreadsheet paste in screenshot 6 preserves text as specified.
>
> ### Top 3 to fix before shipping
>
> 1. Put the unique time/sequence at the start of generated attachment names.
> 2. Replace raw upload errors with readable Thai, and let the status wrap.
> 3. Increase the remove button’s touch target and give it a Thai accessible name.

### Triage

| # | Finding | Decision |
| --- | --- | --- |
| 1 | Pasted labels look identical when clipped (major) | **Fixed.** Label is now `pasted-HHMMSS[-n].ext` (time first, ≤ 20 chars, shows whole). Codex's Thai-name suggestion was *not* taken: the storage / `Content-Disposition` round trip of a non-ASCII `original_name` is unverified. `title` added so the full name shows on hover. |
| 2 | Raw `[MEDIA_TOO_LARGE]` code and clipped reason; `upload failed (413)` is English (major) | **Deferred** — in the shared uploader, so it also changes the paperclip. Separate change. |
| 3 | No `aria-live` for chip changes (minor) | **Deferred** — applies to every chip, needs a persistent live region (a conditionally mounted one is not announced). |
| 4 | × remove target too small, no Thai accessible name (minor) | **Deferred** — pre-existing for every chip. |
| 5 | Text-wins can look like a failed paste (minor) | **Deferred** — Thai hint copy is a product decision. |
| 6 | Paste undiscoverable; hint line is English (nit) | **Deferred** — same copy decision. |

### Second pass on the fix (screenshots `07`–`09`)

> 1. **Resolved at both phone widths.** The generator puts the time first, so the labels stay distinct when clipped. I can read:
>    - 320px: `pasted-221734.png` and `pasted-221734-2.png`
>    - 390px: `pasted-221733.png` and `pasted-221733-2.png`
>
> 2. **No visible regression.** The `title` adds a hover tooltip on desktop; it doesn’t change the chip layout in the screenshots. The `-2` suffix keeps same-second pastes distinct. One edge case: the code doesn’t enforce the “≤ 20 chars” limit for unusually long extensions or high duplicate suffixes, though the shown labels fit.
>
> 3. **Deferring the other findings is defensible for a first release.** None appears to block basic paste usability in these screenshots. The “text wins” behavior is the one to prioritize next: swallowing copied text when an image is also on the clipboard could lose the user’s intended content.

Note on that last paragraph: under DEC-099 the *text* is pasted and the *image* is ignored — the
opposite of "swallowing copied text". The follow-up it points at is still finding 5 (a hint).

## Proof the tests can fail (mutation checks, run against the real code, then restored)

| Mutation | Caught by |
| --- | --- |
| Remove the "text wins" rule | `TC-CORE-PASTE-005`, `TC-CORE-PASTE-006`, `TC-WEB-PASTE-005` |
| Keep the browser's generic `image.png` (no unique naming) | `TC-WEB-PASTE-001`, `TC-WEB-PASTE-007`, `TC-WEB-PASTE-008` |
| `document`-level listener instead of `onPaste` on the composer | `TC-WEB-PASTE-009` |
| Long label shape (the defect found in review) | `TC-CORE-PASTE-013…020`, `TC-WEB-PASTE-013` (@390 and @320) — written first, seen failing |

(The three mutation runs were made before the label change; the last row is the label change itself, driven test-first.)

## Verification

| Check | Result |
| --- | --- |
| chat-core Vitest (all) | 28 files, 309 tests pass (20 new) |
| `pnpm -r typecheck` (shared, api-client, chat-core, mobile, web) | pass |
| oxlint on the changed files | pass |
| Web production build | pass |
| New Playwright spec `paste.spec.ts` | 14 tests (12 + 2 widths of 013) pass |
| Whole fixture UI suite | **184 pass, 3 fail** |

The 3 failures — `TC-WEB-CALLPUSH-001`, `TC-UI-007/FR-RT-003`, `TC-WEB-ROOMRENAME-006` — **fail identically on
pristine `57b971a`** (checked in a detached worktree with none of these changes, port free, Composer without
`onPaste`). They are unrelated to paste and were not touched.

## Known limits

* Image files only. Other pasted files and drag-and-drop remain TASK-WEB-010.
* The ≤ 20-character guarantee holds for the realistic range (`.png`/`.jpg`/`.webp`/…, up to 99 same-second
  duplicates — `TC-CORE-PASTE-020`); it is not enforced for exotic extensions.
* Chromium re-encodes an image that has been through the clipboard, so the pasted file's size differs from the
  source file's. The ticket size equals the bytes actually uploaded (asserted).
* Not run against the deployed site: the UI suite is fixture-only. See the deployment note in the hand-off.

## Screenshots

| File | Shows |
| --- | --- |
| `01-before-labels-clipped-320.png`, `02-before-labels-clipped-390.png`, `06-before-desktop-1440.png` | The defect: two pasted chips both read `pasted-image-20261009-…` |
| `03-uploading-390.png` | Uploading state |
| `04-failed-upload-390-deferred.png` | Failed upload — raw code, clipped reason (deferred, finding 2) |
| `05-spreadsheet-text-wins-1440.png` | Spreadsheet-shaped clipboard: text inserted, no chip |
| `07-after-320.png`, `08-after-390.png`, `09-after-desktop-1440.png` | After the fix: `pasted-221734.png`, `pasted-221734-2.png` |
| `10-after-long-real-name-390.png` | A long real file name still clips (existing chip behaviour), without horizontal overflow |
