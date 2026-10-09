/**
 * FR-MEDIA-001 / DEC-099 — which pasted clipboard items the composer turns into attachments.
 *
 * Structural types only (no DOM globals), so the rule is unit-testable and reusable by any
 * client; the web composer feeds it a snapshot of `ClipboardEvent.clipboardData`.
 *
 * THE RULE: take the image files, unless the clipboard also carries real text.
 *
 * Why "text wins": copying cells from Excel / Numbers, text from Word, or a selection from a
 * web page puts `text/plain` + `text/html` AND a rendered `image/png` of the same content on
 * the clipboard. Someone pasting that wants the text. Attaching the picture and swallowing the
 * text would be wrong in the one case the user cannot undo.
 *
 * Measured, not assumed (Chromium on macOS): a screenshot and a file copied in Finder both
 * arrive as a single file item with NO `text/plain`; browser "Copy image" arrives as
 * `text/html` + the image, again with no plain text. So "any non-blank `text/plain` means
 * text" separates the cases cleanly without needing to parse the HTML.
 */

export interface PasteItemLike {
  /** `DataTransferItem.kind` — 'file' | 'string'. */
  kind: string;
  /** `DataTransferItem.type` — the MIME type. */
  type: string;
}

export interface PasteSnapshot {
  items: ReadonlyArray<PasteItemLike>;
  /** `clipboardData.getData('text/plain')`; '' when there is none. */
  plain: string;
}

export interface PasteImageSelection {
  /** Indices into `snapshot.items` of the image files to attach, in clipboard order. */
  fileIndices: number[];
  /** True when the caller must `preventDefault()` — i.e. the images are ours and no text is wanted. */
  intercept: boolean;
}

const NONE: PasteImageSelection = { fileIndices: [], intercept: false };

export function selectPastedImages(snapshot: PasteSnapshot): PasteImageSelection {
  const fileIndices: number[] = [];
  snapshot.items.forEach((item, index) => {
    if (item.kind === 'file' && item.type.toLowerCase().startsWith('image/')) fileIndices.push(index);
  });

  if (fileIndices.length === 0) return NONE;
  if (snapshot.plain.trim() !== '') return NONE;

  return { fileIndices, intercept: true };
}

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/tiff': 'tiff',
};

/** Browsers hand every clipboard image the same placeholder name (`image.png`), or none at all. */
const GENERIC_NAME = /^image\.[a-z0-9]+$/i;

const pad = (value: number, width = 2) => String(value).padStart(width, '0');

export interface PastedImageNameInput {
  /** The `File.name` the browser gave the clipboard item. */
  name: string;
  mime: string;
  /** The user's local clock — the label is what their own watch showed. */
  now: Date;
  /** Names already staged in this composer. */
  taken: Iterable<string>;
}

/**
 * A readable, unique name for a pasted image.
 *
 * A real file name (an image copied from a folder keeps `Holiday-Photo.png`) is returned
 * untouched. Only the placeholder is replaced, because two screenshots both called
 * `image.png` are indistinguishable in the chip row and in the sent message.
 *
 * Shape: `pasted-HHMMSS[-n].ext` — the part that differs is FIRST and the whole label is short.
 * The composer chip clips names at ~22 characters; the first version (`pasted-image-YYYYMMDD-
 * HHMMSS`) put the seconds past that cut, so two screenshots looked identical on a phone
 * (found in the UX review). ASCII on purpose: the label is also the attachment's `original_name`
 * the recipient sees and downloads, and a non-ASCII name's round trip through storage and
 * `Content-Disposition` has not been verified. The date is omitted — the message already carries it.
 */
export function pastedImageName({ name, mime, now, taken }: PastedImageNameInput): string {
  const trimmed = name.trim();
  if (trimmed !== '' && !GENERIC_NAME.test(trimmed)) return name;

  const known = EXTENSION_BY_MIME[mime.toLowerCase()];
  const fromName = /\.([a-z0-9]{1,5})$/i.exec(trimmed)?.[1]?.toLowerCase();
  const extension = known ?? fromName ?? 'png';

  const stamp = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const used = new Set(Array.from(taken, (entry) => entry.toLowerCase()));

  let candidate = `pasted-${stamp}.${extension}`;
  for (let n = 2; used.has(candidate.toLowerCase()); n += 1) {
    candidate = `pasted-${stamp}-${n}.${extension}`;
  }
  return candidate;
}
