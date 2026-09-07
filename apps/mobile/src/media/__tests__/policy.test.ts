import { describe, expect, it } from '@jest/globals';
import { BLOCKED_EXTENSIONS, attachmentKind, imageResizePlan, isExtensionAllowed, videoCompressPlan } from '../policy';

/**
 * TASK-MOB-006 — media policy decisions (TC-MOB-020..022).
 */
describe('media policy', () => {
  it('TC-MOB-020 images resize so the longest side is ≤1920', () => {
    expect(imageResizePlan(4000, 3000)).toEqual({ resize: true, width: 1920, height: 1440 });
    expect(imageResizePlan(1920, 1080)).toEqual({ resize: false, width: 1920, height: 1080 });
    expect(imageResizePlan(1080, 1920)).toEqual({ resize: false, width: 1080, height: 1920 });
    expect(imageResizePlan(600, 400).resize).toBe(false);
  });

  it('TC-MOB-021 videos over 50MB compress to 1080p', () => {
    const MB = 1024 * 1024;
    expect(videoCompressPlan(80 * MB, 2160)).toEqual({ compress: true, targetHeight: 1080 });
    expect(videoCompressPlan(80 * MB, 1080)).toEqual({ compress: false, targetHeight: 1080 });
    expect(videoCompressPlan(20 * MB, 2160).compress).toBe(false);
  });

  it('TC-MOB-022 blocked extensions are rejected client-side', () => {
    for (const ext of BLOCKED_EXTENSIONS) {
      expect(isExtensionAllowed(`payload.${ext}`)).toBe(false);
      expect(isExtensionAllowed(`PAYLOAD.${ext.toUpperCase()}`)).toBe(false);
    }
    expect(isExtensionAllowed('report.pdf')).toBe(true);
    expect(isExtensionAllowed('slides.pptx')).toBe(true);
    expect(isExtensionAllowed('noextension')).toBe(true);
  });

  it('kinds map by mime with filename fallback', () => {
    expect(attachmentKind('image/jpeg', 'a.jpg')).toBe('image');
    expect(attachmentKind('video/mp4', 'a.mp4')).toBe('video');
    expect(attachmentKind('application/pdf', 'a.pdf')).toBe('file');
    expect(attachmentKind('', 'photo.HEIC')).toBe('image');
    expect(attachmentKind('', 'clip.mov')).toBe('video');
    expect(attachmentKind('', 'archive.zip')).toBe('file');
  });
});
