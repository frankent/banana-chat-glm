import { Track, type Room } from "livekit-client";

/**
 * Narrow local shape of `navigator.mediaSession`: the DOM lib here predates
 * the call actions ("hangup", "togglemicrophone"), and unknown action names
 * throw at runtime on older browsers anyway — everything stays feature-detected.
 */
interface KeepaliveMediaSession {
  metadata: MediaMetadata | null;
  playbackState: string;
  setActionHandler(action: string, handler: (() => void) | null): void;
}

/**
 * FR-CALL-009 / DEC-086 browser adapter: keep the tab registered as active
 * media while a call/meeting is joined so mobile OSes keep audio alive and
 * hardware controls keep working. Every API is feature-detected and wrapped in
 * try/catch — a missing or throwing keepalive API must never break the call.
 * Returns a `stop()` that fully undoes the registration.
 */
export interface CallKeepaliveOptions {
  title: string;
  room: Room;
  /** Media Session "hangup" hardware/browser action. */
  onHangup: () => void;
  /**
   * True when the LOCAL USER muted their own microphone. The OS can also mute
   * the track (interruption); only the user's own choice must be respected —
   * never fight it by re-enabling the microphone.
   */
  isUserMuted: () => boolean;
}

export function startCallKeepalive({ title, room, onHangup, isUserMuted }: CallKeepaliveOptions): () => void {
  let stopped = false;
  let wakeLock: { release: () => Promise<void> } | null = null;

  // Media Session: registers the tab as playing media (lock-screen / OS media
  // controls), which is what keeps Safari/Chrome from freezing the audio.
  try {
    const mediaSession = (navigator as Navigator & { mediaSession?: KeepaliveMediaSession }).mediaSession;
    if (mediaSession) {
      mediaSession.metadata = new MediaMetadata({
        title,
        artist: "Banana Chat",
        artwork: [{ src: "/icon-512.png", sizes: "512x512", type: "image/png" }],
      });
      mediaSession.playbackState = "playing";
      // Unknown action names throw on older browsers — guard each handler.
      try {
        mediaSession.setActionHandler("hangup", () => onHangup());
      } catch { /* Action unsupported; media registration still helps. */ }
      try {
        mediaSession.setActionHandler("togglemicrophone", () => {
          void room.localParticipant.setMicrophoneEnabled(isUserMuted());
        });
      } catch { /* Action unsupported. */ }
    }
  } catch { /* Media Session unavailable. */ }

  // Screen Wake Lock: stops the screen (and with it, on many devices, the
  // audio session) from being throttled while visible; auto-released on hide.
  const requestWakeLock = async () => {
    if (stopped || document.visibilityState !== "visible") return;
    try {
      const lock = await (navigator as Navigator & {
        wakeLock?: { request: (type: "screen") => Promise<{ release: () => Promise<void> }> };
      }).wakeLock?.request("screen");
      if (lock) wakeLock = lock;
    } catch { /* Wake Lock denied/unavailable. */ }
  };
  void requestWakeLock();

  // FR-CALL-009: the OS may mute or drop the microphone track when the app is
  // backgrounded; once visible again, re-enable it unless the user muted.
  const restoreMicrophone = () => {
    if (stopped || isUserMuted()) return;
    try {
      const publication = room.localParticipant.getTrackPublication(Track.Source.Microphone);
      const track = publication?.track;
      const osMuted = !track || track.isMuted || track.mediaStreamTrack?.muted === true;
      if (osMuted) void room.localParticipant.setMicrophoneEnabled(true).catch(() => {});
    } catch { /* Room already closed. */ }
  };

  const onVisible = () => {
    if (document.visibilityState !== "visible") return;
    void requestWakeLock();
    restoreMicrophone();
  };
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("pageshow", onVisible);

  return () => {
    if (stopped) return;
    stopped = true;
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("pageshow", onVisible);
    try {
      const mediaSession = (navigator as Navigator & { mediaSession?: KeepaliveMediaSession }).mediaSession;
      if (mediaSession) {
        try { mediaSession.setActionHandler("hangup", null); } catch { /* not registered */ }
        try { mediaSession.setActionHandler("togglemicrophone", null); } catch { /* not registered */ }
        try { mediaSession.metadata = null; } catch { /* read-only */ }
        try { mediaSession.playbackState = "none"; } catch { /* read-only */ }
      }
    } catch { /* Media Session unavailable. */ }
    try { void wakeLock?.release().catch(() => {}); } catch { /* already released */ }
    wakeLock = null;
  };
}
