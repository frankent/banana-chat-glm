import { useEffect, useEffectEvent, useState } from "react";
import { Room, RoomEvent, Track } from "livekit-client";
import {
  RoomContext,
  GridLayout,
  ParticipantTile,
  RoomAudioRenderer,
  ControlBar,
  useTracks,
  StartAudio,
  useParticipants,
} from "@livekit/components-react";
import "@livekit/components-styles";

function Tiles() {
  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: false },
  );
  const participants = useParticipants();
  return (
    <>
      <div className="bc-call-count">
        {participants.length} participant{participants.length === 1 ? "" : "s"}
      </div>
      <GridLayout tracks={tracks}>
        <ParticipantTile />
      </GridLayout>
    </>
  );
}
export default function MediaPanel({
  id,
  kind,
  title,
  url,
  token,
  canEnd,
  onLeave,
  registerDisconnect,
  checkActive,
  canMinimize = true,
}: {
  id: string;
  kind: "video" | "voice";
  title: string;
  url: string;
  token: string;
  canEnd: boolean;
  onLeave: (end?: boolean) => void;
  registerDisconnect: (fn: () => void) => void;
  checkActive: () => Promise<boolean>;
  canMinimize?: boolean;
}) {
  const [room, setRoom] = useState<Room | null>(null);
  const [error, setError] = useState("");
  const [connecting, setConnecting] = useState(true);
  const [minimized, setMinimized] = useState(false);
  const isActive = useEffectEvent(checkActive);
  const leaveCall = useEffectEvent(onLeave);
  const ownDisconnect = useEffectEvent(registerDisconnect);
  useEffect(() => {
    const room = new Room({
      adaptiveStream: true,
      dynacast: true,
      videoCaptureDefaults: {
        resolution: { width: 640, height: 360, frameRate: 24 },
      },
      publishDefaults: { simulcast: true },
    });
    // Expose the SDK resource created for this effect lifetime to the renderer.
    // eslint-disable-next-line react/set-state-in-effect
    setRoom(room);
    let cancelled = false;
    const disconnect = () => {
      cancelled = true;
      room.localParticipant.trackPublications.forEach((publication) =>
        publication.track?.stop(),
      );
      void room.disconnect(true);
    };
    ownDisconnect(disconnect);
    const dropped = () => {
      if (!cancelled) leaveCall();
    };
    const published = () => setError("");
    room.on(RoomEvent.LocalTrackPublished, published);
    room.on(RoomEvent.Disconnected, dropped);
    void (async () => {
      await Promise.resolve();
      if (cancelled) return;
      try {
        await room.connect(url, token);
        if (cancelled) {
          await room.disconnect(true);
          return;
        }
        setConnecting(false);
        try {
          await room.localParticipant.setMicrophoneEnabled(true);
          if (cancelled) {
            await room.disconnect(true);
            return;
          }
          if (kind === "video" && !cancelled)
            await room.localParticipant.setCameraEnabled(true);
          if (cancelled) await room.disconnect(true);
        } catch {
          if (!cancelled)
            setError(
              "Allow camera/microphone access in your browser, then use the controls to try again.",
            );
        }
      } catch {
        if (!cancelled) {
          setError(
            "Unable to connect. Check your network and try joining again.",
          );
          setConnecting(false);
        }
      }
    })();
    const timer = setInterval(() => {
      void isActive()
        .then((active) => {
          if (!cancelled && !active) leaveCall();
        })
        .catch(() => {});
    }, 5000);
    return () => {
      clearInterval(timer);
      room.off(RoomEvent.Disconnected, dropped);
      room.off(RoomEvent.LocalTrackPublished, published);
      disconnect();
    };
  }, [id, kind, token, url]);
  if (!room) return null;
  return (
    <div
      className={`bc-call-stage ${minimized ? "is-minimized" : ""} ${kind === "voice" ? "is-voice" : ""}`}
      data-lk-theme="default"
      role="dialog"
      aria-label={kind === "voice" ? "Voice call" : "Video call"}
    >
      <header>
        <div>
          <span className="bc-call-live" />
          <strong>{title}</strong>
          <small>
            {connecting
              ? "Connecting…"
              : kind === "voice"
                ? "Voice call"
                : "Video meeting"}
          </small>
        </div>
        {canMinimize && (
          <button
            onClick={() => setMinimized((v) => !v)}
            aria-label={minimized ? "Expand call" : "Minimize call"}
          >
            {minimized ? "Expand" : "Minimize"}
          </button>
        )}
      </header>
      <RoomContext.Provider value={room}>
        {error && (
          <div role="alert" className="bc-call-error">
            {error}
          </div>
        )}
        <div className="bc-call-grid">
          <Tiles />
        </div>
        <RoomAudioRenderer />
        <StartAudio label="Enable call audio" />
        <footer>
          <ControlBar
            saveUserChoices={false}
            onDeviceError={() =>
              setError(
                "Could not access the selected device. Check browser permissions and choose another device.",
              )
            }
            controls={{
              microphone: true,
              camera: kind === "video",
              screenShare: kind === "video",
              chat: false,
              leave: false,
            }}
          />
          <button className="bc-call-hangup" onClick={() => onLeave()}>
            Leave
          </button>
          {canEnd && (
            <button className="bc-call-end" onClick={() => onLeave(true)}>
              End for everyone
            </button>
          )}
        </footer>
      </RoomContext.Provider>
    </div>
  );
}
