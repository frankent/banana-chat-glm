/**
 * FR-CALL-007 / FR-CALL-008 — platform-agnostic meeting stage + playback logic.
 * CLAUDE.md: this lives in chat-core so web and mobile share one implementation;
 * apps only map their SDK's track refs onto `CallTrackLike` and render.
 */

/** One renderable video track: a participant/guest camera, or a screen share. */
export interface CallTrackLike {
  id: string;
  screen: boolean;
}

/**
 * Stable id for a renderable track. Apps derive it once from their SDK
 * (participant identity + track source) instead of re-templating the string at
 * every call site, so "the id I selected" and "the id in the list" cannot drift.
 */
export function callTrackId(participantIdentity: string, source: string): string {
  return `${participantIdentity}:${source}`;
}

/**
 * How the main stage is currently filled:
 * - `selected` — the viewer explicitly picked this participant/guest or screen;
 * - `auto`     — no explicit pick, a screen share fills the stage automatically;
 * - `grid`     — nothing to feature, render everyone in the grid.
 */
export type CallStageMode = 'selected' | 'auto' | 'grid';

export interface CallStage<T extends CallTrackLike> {
  focus: T | undefined;
  mode: CallStageMode;
  /**
   * The explicit selection AFTER reconciliation. `null` once the selected track
   * has left: FR-CALL-007 says a removed selection falls back to another share
   * or the grid, so the selection is gone — it must not resurrect if the same
   * participant re-publishes the same source later. Callers store this back.
   */
  selection: string | null;
  /**
   * The screen currently holding the stage automatically. Feed it back on the
   * next resolve to keep "first available screen" sticky: track lists are
   * ordered by participant, not by who started sharing, so without this a
   * second concurrent share can steal the stage from the one already on it.
   */
  autoFocusId: string | null;
}

/**
 * FR-CALL-007 — resolve the main stage from the current tracks and the viewer's
 * selection. Pure: same inputs, same stage.
 */
export function resolveCallStage<T extends CallTrackLike>(
  tracks: readonly T[],
  selected: string | null,
  previousAutoFocusId: string | null = null,
): CallStage<T> {
  // Sticky automatic focus: keep the share that already holds the stage while it
  // is still being shared, otherwise take the first available screen.
  const sticky = previousAutoFocusId == null
    ? undefined
    : tracks.find((t) => t.id === previousAutoFocusId && t.screen);
  const auto = sticky ?? tracks.find((t) => t.screen);
  const autoFocusId = auto?.id ?? null;

  const chosen = selected == null ? undefined : tracks.find((t) => t.id === selected);
  if (chosen !== undefined) {
    return { focus: chosen, mode: 'selected', selection: chosen.id, autoFocusId };
  }
  // Selection absent or removed -> fall back to a share, then to the grid.
  return auto === undefined
    ? { focus: undefined, mode: 'grid', selection: null, autoFocusId }
    : { focus: auto, mode: 'auto', selection: null, autoFocusId };
}

/** FR-CALL-007: explicit focus wins; otherwise the first current screen share takes the stage. */
export function focusedCallTrack<T extends CallTrackLike>(
  tracks: readonly T[], selected: string | null,
): T | undefined {
  return resolveCallStage(tracks, selected).focus;
}

/** FR-CALL-008: moderate default playback boost, bounded user control. */
export const DEFAULT_CALL_GAIN = 1.5;
/** 300% with the Web Audio boost chain; 100% on the standard playback fallback. */
export const CALL_GAIN_MAX = 3;
export const CALL_GAIN_FALLBACK_MAX = 1;

/** Upper bound of the session volume control for the active playback path. */
export function callGainCeiling(boosted: boolean): number {
  return boosted ? CALL_GAIN_MAX : CALL_GAIN_FALLBACK_MAX;
}

export function callPlaybackGain(value: number, ceiling: number = CALL_GAIN_MAX): number {
  if (!Number.isFinite(value)) {
    return Math.min(ceiling, DEFAULT_CALL_GAIN);
  }
  return Math.min(ceiling, Math.max(0, value));
}

/** Slider position / readout for the current gain, clamped to the active ceiling. */
export function callGainPercent(gain: number, boosted: boolean): number {
  return Math.round(callPlaybackGain(gain, callGainCeiling(boosted)) * 100);
}
