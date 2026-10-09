import { describe, expect, it } from 'vitest';
import { pastedImageName, selectPastedImages } from './paste.js';

const file = (type: string) => ({ kind: 'file', type });
const str = (type: string) => ({ kind: 'string', type });

describe('FR-MEDIA-001 / DEC-099 which clipboard images the composer takes', () => {
  it('TC-CORE-PASTE-001 a screenshot (one image file, no text) is attached and the paste is intercepted', () => {
    expect(selectPastedImages({ items: [file('image/png')], plain: '' })).toEqual({ fileIndices: [0], intercept: true });
  });

  it('TC-CORE-PASTE-002 several image files are all attached, in clipboard order, by their own indices', () => {
    const items = [str('text/html'), file('image/png'), file('image/jpeg'), file('image/webp')];
    expect(selectPastedImages({ items, plain: '' })).toEqual({ fileIndices: [1, 2, 3], intercept: true });
  });

  it('TC-CORE-PASTE-003 a file copied in Finder / Explorer (a file item only) is attached', () => {
    // Measured in Chromium on macOS: types ["Files"], one file item, no text/plain at all.
    expect(selectPastedImages({ items: [file('image/png')], plain: '' }).intercept).toBe(true);
  });

  it('TC-CORE-PASTE-004 browser "Copy image" (text/html + the image, no plain text) is attached', () => {
    const items = [str('text/html'), file('image/png')];
    expect(selectPastedImages({ items, plain: '' })).toEqual({ fileIndices: [1], intercept: true });
  });

  it('TC-CORE-PASTE-005 an Excel / Word / web selection (plain + html + a rendered image) pastes as TEXT, nothing attached', () => {
    const items = [str('text/plain'), str('text/html'), file('image/png')];
    expect(selectPastedImages({ items, plain: 'A1\tB1\nA2\tB2' })).toEqual({ fileIndices: [], intercept: false });
  });

  it('TC-CORE-PASTE-006 plain text next to an image means text wins even without html', () => {
    expect(selectPastedImages({ items: [str('text/plain'), file('image/png')], plain: 'hello' }).intercept).toBe(false);
  });

  it('TC-CORE-PASTE-007 whitespace-only plain text does not count as text', () => {
    expect(selectPastedImages({ items: [str('text/plain'), file('image/png')], plain: ' \n\t ' })).toEqual({
      fileIndices: [1],
      intercept: true,
    });
  });

  it('TC-CORE-PASTE-008 text only, or nothing at all, is left to the browser', () => {
    expect(selectPastedImages({ items: [str('text/plain')], plain: 'hi' })).toEqual({ fileIndices: [], intercept: false });
    expect(selectPastedImages({ items: [], plain: '' })).toEqual({ fileIndices: [], intercept: false });
  });

  it('TC-CORE-PASTE-009 non-image files are not handled by paste (picker / drag remain the way in)', () => {
    expect(selectPastedImages({ items: [file('application/pdf')], plain: '' })).toEqual({ fileIndices: [], intercept: false });
  });

  it('TC-CORE-PASTE-010 an image next to a non-image file attaches only the image', () => {
    const items = [file('application/pdf'), file('image/gif')];
    expect(selectPastedImages({ items, plain: '' })).toEqual({ fileIndices: [1], intercept: true });
  });

  it('TC-CORE-PASTE-011 a string item that merely has an image/* type is not a file and is ignored', () => {
    expect(selectPastedImages({ items: [str('image/png')], plain: '' })).toEqual({ fileIndices: [], intercept: false });
  });

  it('TC-CORE-PASTE-012 the image check is case-insensitive about the MIME type', () => {
    expect(selectPastedImages({ items: [file('IMAGE/PNG')], plain: '' }).fileIndices).toEqual([0]);
  });
});

describe('FR-MEDIA-001 / DEC-099 the name a pasted image gets', () => {
  // Local-time constructor on purpose: the label is what the user's own clock showed.
  const now = new Date(2026, 9, 9, 14, 32, 5);

  it('TC-CORE-PASTE-013 the generic clipboard name "image.png" becomes a timestamped, readable label', () => {
    expect(pastedImageName({ name: 'image.png', mime: 'image/png', now, taken: [] })).toBe('pasted-143205.png');
  });

  it('TC-CORE-PASTE-014 an empty name is labelled too, and the extension follows the MIME type, not the name', () => {
    expect(pastedImageName({ name: '', mime: 'image/jpeg', now, taken: [] })).toBe('pasted-143205.jpg');
    expect(pastedImageName({ name: 'image.png', mime: 'image/webp', now, taken: [] })).toBe('pasted-143205.webp');
  });

  it('TC-CORE-PASTE-015 a real file name (a file copied from a folder) is kept untouched', () => {
    expect(pastedImageName({ name: 'Holiday-Photo.png', mime: 'image/png', now, taken: [] })).toBe('Holiday-Photo.png');
    expect(pastedImageName({ name: 'image2.png', mime: 'image/png', now, taken: [] })).toBe('image2.png');
  });

  it('TC-CORE-PASTE-016 two screenshots in the same second get distinct labels (-2, -3 …)', () => {
    const first = pastedImageName({ name: 'image.png', mime: 'image/png', now, taken: [] });
    const second = pastedImageName({ name: 'image.png', mime: 'image/png', now, taken: [first] });
    const third = pastedImageName({ name: 'image.png', mime: 'image/png', now, taken: [first, second] });
    expect([first, second, third]).toEqual(['pasted-143205.png', 'pasted-143205-2.png', 'pasted-143205-3.png']);
  });

  it('TC-CORE-PASTE-017 uniqueness ignores case, and a different second needs no suffix', () => {
    expect(
      pastedImageName({ name: 'image.png', mime: 'image/png', now, taken: ['PASTED-143205.PNG'] }),
    ).toBe('pasted-143205-2.png');
    expect(
      pastedImageName({ name: 'image.png', mime: 'image/png', now: new Date(2026, 9, 9, 14, 32, 6), taken: ['pasted-143205.png'] }),
    ).toBe('pasted-143206.png');
  });

  it('TC-CORE-PASTE-018 date and time are zero-padded', () => {
    expect(pastedImageName({ name: '', mime: 'image/png', now: new Date(2026, 0, 2, 3, 4, 5), taken: [] })).toBe(
      'pasted-030405.png',
    );
  });

  it('TC-CORE-PASTE-019 an unrecognised image type falls back to a safe extension', () => {
    expect(pastedImageName({ name: 'image.png', mime: 'image/x-weird', now, taken: [] })).toBe('pasted-143205.png');
    expect(pastedImageName({ name: '', mime: '', now, taken: [] })).toBe('pasted-143205.png');
  });

  it('TC-CORE-PASTE-020 the label is short enough to show WHOLE in a phone chip, even with a long same-second run', () => {
    // The chip shows ~22 characters at 320 px (measured). A label clipped by that ellipsis loses
    // exactly the part that tells two screenshots apart, so the whole label must fit.
    const taken: string[] = [];
    let longest = 0;
    for (let n = 0; n < 99; n += 1) {
      const name = pastedImageName({ name: 'image.png', mime: 'image/png', now, taken });
      taken.push(name);
      longest = Math.max(longest, name.length);
    }
    expect(longest).toBeLessThanOrEqual(20);
  });
});
