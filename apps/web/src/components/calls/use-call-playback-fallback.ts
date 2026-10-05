import { useEffect } from "react";
import { RemoteAudioTrack, RoomEvent, type Room } from "livekit-client";
import { shouldPlayViaMediaElement } from "@banana-chat/chat-core";

/**
 * FR-CALL-008/009, DEC-094: with webAudioMix livekit keeps every remote
 * <audio> element muted and plays through the boost graph. While the context
 * is not running (backgrounded phone, locked autoplay) the graph is silent, so
 * un-mute the elements — plain playback, at most 100% — and re-mute once it
 * runs again, or the stream would play twice. Elements attach after
 * subscription and livekit re-mutes each on attach, hence the 1 s safety sync.
 */
export function useCallPlaybackFallback(room: Room, context: AudioContext | null) {
  useEffect(() => {
    if (!context) return;
    const sync = () => {
      const viaElement = shouldPlayViaMediaElement(context.state);
      const wantMuted = !viaElement;
      room.remoteParticipants.forEach((p) => p.audioTrackPublications.forEach((pub) => {
        if (!(pub.track instanceof RemoteAudioTrack)) return;
        pub.track.attachedElements.forEach((el) => {
          if (el.muted === wantMuted) return;
          el.muted = wantMuted;
          if (viaElement) {
            el.volume = 1;
            void el.play().catch(() => {});
          }
        });
      }));
    };
    sync();
    const timer = setInterval(sync, 1000);
    context.addEventListener("statechange", sync);
    document.addEventListener("visibilitychange", sync);
    window.addEventListener("pageshow", sync);
    room.on(RoomEvent.TrackSubscribed, sync);
    return () => {
      clearInterval(timer);
      context.removeEventListener("statechange", sync);
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("pageshow", sync);
      room.off(RoomEvent.TrackSubscribed, sync);
    };
  }, [room, context]);
}
