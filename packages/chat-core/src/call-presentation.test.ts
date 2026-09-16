import { describe, it, expect } from 'vitest';
import {
  focusedCallTrack,
  resolveCallStage,
  callTrackId,
  callPlaybackGain,
  callGainCeiling,
  callGainPercent,
  DEFAULT_CALL_GAIN,
} from './call-presentation.js';

const camera = { id: 'guest-camera', screen: false };
const first = { id: 'first-share', screen: true };
const second = { id: 'second-share', screen: true };

describe('TC-CALL-030 focus across concurrent shares', () => {
  it('automatically focuses sharing and keeps manual selection across a new share', () => {
    expect(focusedCallTrack([camera], null)).toBeUndefined();
    expect(focusedCallTrack([camera, first, second], null)).toBe(first);
    expect(focusedCallTrack([camera, first, second], camera.id)).toBe(camera);
    expect(focusedCallTrack([camera, first, second], second.id)).toBe(second);
  });
  it('falls back when selected track disappears', () => {
    expect(focusedCallTrack([camera, second], first.id)).toBe(second);
    expect(focusedCallTrack([camera], first.id)).toBeUndefined();
  });
});

describe('TC-CALL-030 resolveCallStage — stage mode, fallback and sticky auto focus', () => {
  it('camera-only calls render the grid: camera off on join means nothing to feature', () => {
    expect(resolveCallStage([camera], null)).toEqual({
      focus: undefined, mode: 'grid', selection: null, autoFocusId: null,
    });
    expect(resolveCallStage([], null)).toEqual({
      focus: undefined, mode: 'grid', selection: null, autoFocusId: null,
    });
  });

  it('the first available screen fills the stage automatically, not as a selection', () => {
    const stage = resolveCallStage([camera, first, second], null);
    expect(stage.focus).toBe(first);
    expect(stage.mode).toBe('auto');
    // mode, not a fake selection: the UI must still read "Automatic".
    expect(stage.selection).toBeNull();
    expect(stage.autoFocusId).toBe(first.id);
  });

  it('any participant/guest or screen can be selected explicitly', () => {
    expect(resolveCallStage([camera, first, second], camera.id))
      .toMatchObject({ focus: camera, mode: 'selected', selection: camera.id });
    expect(resolveCallStage([camera, first, second], second.id))
      .toMatchObject({ focus: second, mode: 'selected', selection: second.id });
  });

  it('a removed selection falls back to another share and is DROPPED, not kept', () => {
    const stage = resolveCallStage([camera, second], first.id);
    expect(stage.focus).toBe(second);
    expect(stage.mode).toBe('auto');
    expect(stage.selection).toBeNull();
  });

  it('a removed selection with no share left falls back to the grid, never a blank stage', () => {
    const stage = resolveCallStage([camera], first.id);
    expect(stage.focus).toBeUndefined();
    expect(stage.mode).toBe('grid');
    expect(stage.selection).toBeNull();
  });

  it('a dropped selection does not resurrect when the same track id comes back', () => {
    // Viewer selects a share, the sharer stops, then re-publishes the same
    // identity:source id. The stage must stay automatic, not yank back.
    const dropped = resolveCallStage([camera, second], first.id);
    expect(dropped.selection).toBeNull();
    const returned = resolveCallStage([camera, first, second], dropped.selection, dropped.autoFocusId);
    expect(returned.focus).toBe(second);
    expect(returned.mode).toBe('auto');
  });

  it('a second concurrent share does not steal the stage from the one already on it', () => {
    // Track lists are ordered by participant, so `second` can be listed first
    // once its owner is re-ordered/joins earlier in the list.
    const held = resolveCallStage([camera, second], null);
    expect(held.autoFocusId).toBe(second.id);
    const later = resolveCallStage([camera, first, second], null, held.autoFocusId);
    expect(later.focus).toBe(second);
    expect(later.autoFocusId).toBe(second.id);
  });

  it('sticky auto focus releases when that share ends and takes the next one', () => {
    const next = resolveCallStage([camera, first], null, second.id);
    expect(next.focus).toBe(first);
    expect(next.autoFocusId).toBe(first.id);
  });

  it('keeps tracking the automatic share while an explicit selection holds the stage', () => {
    const stage = resolveCallStage([camera, first, second], camera.id, second.id);
    expect(stage.mode).toBe('selected');
    expect(stage.focus).toBe(camera);
    // Returning to automatic focus resumes the share that was already on stage.
    expect(stage.autoFocusId).toBe(second.id);
  });

  it('a stale auto focus id pointing at a camera is ignored', () => {
    const stage = resolveCallStage([camera, first], null, camera.id);
    expect(stage.focus).toBe(first);
    expect(stage.autoFocusId).toBe(first.id);
  });
});

describe('TC-CALL-032 callTrackId', () => {
  it('builds one stable id for a participant/guest track source', () => {
    expect(callTrackId('guest-7', 'screen_share')).toBe('guest-7:screen_share');
    expect(callTrackId('guest-7', 'camera')).not.toBe(callTrackId('guest-7', 'screen_share'));
  });
});

it('TC-CALL-031 playback gain is bounded and retains mute', () => {
  expect(callPlaybackGain(0)).toBe(0);
  expect(callPlaybackGain(-1)).toBe(0);
  expect(callPlaybackGain(99)).toBe(3);
  expect(callPlaybackGain(1.5)).toBe(1.5);
  expect(callPlaybackGain(NaN)).toBe(1.5);
});

describe('TC-CALL-031 gain ceiling follows the playback path', () => {
  it('boosted playback offers 0-300%, the standard fallback only 0-100%', () => {
    expect(callGainCeiling(true)).toBe(3);
    expect(callGainCeiling(false)).toBe(1);
    expect(callPlaybackGain(2.5, callGainCeiling(true))).toBe(2.5);
    expect(callPlaybackGain(2.5, callGainCeiling(false))).toBe(1);
  });

  it('the 150% default degrades to 100% on the standard playback fallback', () => {
    expect(DEFAULT_CALL_GAIN).toBe(1.5);
    expect(callPlaybackGain(NaN, callGainCeiling(false))).toBe(1);
    expect(callGainPercent(DEFAULT_CALL_GAIN, true)).toBe(150);
    expect(callGainPercent(DEFAULT_CALL_GAIN, false)).toBe(100);
  });

  it('percent readout matches the slider position at both ends', () => {
    expect(callGainPercent(0, true)).toBe(0);
    expect(callGainPercent(3, true)).toBe(300);
    expect(callGainPercent(9, true)).toBe(300);
    expect(callGainPercent(9, false)).toBe(100);
  });
});
