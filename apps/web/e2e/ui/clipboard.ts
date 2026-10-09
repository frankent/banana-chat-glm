import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';

/** A real 200×200 PNG already used by the avatar specs. */
export const PNG_PATH = resolve(import.meta.dirname, 'assets', 'me-avatar.png');

export async function readPng(): Promise<Buffer> {
  return readFile(PNG_PATH);
}

/** Lets the page use the async clipboard API against the fixture origin. */
export async function grantClipboard(context: BrowserContext): Promise<void> {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://127.0.0.1:5180' });
}

export interface ClipboardShape {
  plain?: string;
  html?: string;
  png?: Buffer;
}

/**
 * Put a payload on the browser clipboard in one of the shapes real apps produce, so the test can
 * press the real paste shortcut afterwards (a real `paste` event, a real `clipboardData`).
 *
 * Shapes used by the specs (DEC-099):
 *  - screenshot            { png }                      — measured: one image file, nothing else
 *  - browser "Copy image"  { html, png }                — html + the image, no plain text
 *  - Excel / Word / web    { plain, html, png }         — text AND a rendered image of it
 *  - plain text            { plain }
 */
export async function writeClipboard(page: Page, shape: ClipboardShape): Promise<void> {
  await page.evaluate(
    async ({ plain, html, pngBase64 }) => {
      const parts: Record<string, Blob> = {};
      if (plain !== undefined) parts['text/plain'] = new Blob([plain], { type: 'text/plain' });
      if (html !== undefined) parts['text/html'] = new Blob([html], { type: 'text/html' });
      if (pngBase64 !== undefined) {
        const bytes = Uint8Array.from(atob(pngBase64), (char) => char.charCodeAt(0));
        parts['image/png'] = new Blob([bytes], { type: 'image/png' });
      }
      await navigator.clipboard.write([new ClipboardItem(parts)]);
    },
    { plain: shape.plain, html: shape.html, pngBase64: shape.png?.toString('base64') },
  );
}

export interface SyntheticFile {
  name: string;
  type: string;
  /** Optional plain text to put next to the files. */
  bytes?: Buffer;
}

/**
 * Dispatch a `paste` event carrying named files on the element that currently has focus.
 *
 * The async clipboard API cannot choose a file NAME, and the name is part of what is under test
 * (a file copied in Finder keeps `Holiday-Photo.png`; two screenshots in one paste are both
 * `image.png`). The event goes to the focused element and bubbles, exactly like a real paste.
 */
export async function pasteFiles(page: Page, files: SyntheticFile[], plain?: string): Promise<void> {
  await page.evaluate(
    ({ files, plain }) => {
      const data = new DataTransfer();
      for (const file of files) {
        const bytes = file.bytes64 === undefined ? new Uint8Array([137, 80, 78, 71]) : Uint8Array.from(atob(file.bytes64), (c) => c.charCodeAt(0));
        data.items.add(new File([bytes], file.name, { type: file.type }));
      }
      if (plain !== undefined) data.setData('text/plain', plain);
      document.activeElement?.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    },
    {
      files: files.map((file) => ({ name: file.name, type: file.type, bytes64: file.bytes?.toString('base64') })),
      plain,
    },
  );
}
