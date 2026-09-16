import { useEffect, useEffectEvent, useState, useRef } from "react";
import { Room, RoomEvent, Track, RemoteAudioTrack } from "livekit-client";
import {
  RoomContext,
  GridLayout,
  FocusLayout,
  useRoomContext,
  ParticipantTile,
  RoomAudioRenderer,
  ControlBar,
  useTracks,
  StartAudio,
  useParticipants,
} from "@livekit/components-react";
import "@livekit/components-styles";
import {
  resolveCallStage,
  callTrackId,
  DEFAULT_CALL_GAIN,
  callPlaybackGain,
  callGainCeiling,
  callGainPercent,
} from "@banana-chat/chat-core";
import { createCallAudioBoost } from "./audio-boost";

function Tiles() {
  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: false },
  );
  const participants = useParticipants();
  const [selected, setSelected] = useState<string | null>(null);
  // FR-CALL-007: which screen currently holds the stage automatically. A ref,
  // not state — resolveCallStage runs on every render and feeding its own
  // output back through state would re-render on every resolve. Written in an
  // effect (never during render) so concurrent renders stay consistent.
  const autoFocusRef = useRef<string | null>(null);
  const options = tracks.map((ref) => ({
    id: callTrackId(ref.participant.identity, ref.source),
    screen: ref.source === Track.Source.ScreenShare,
    ref,
  }));
  // Reading the sticky id during render is the point: the stage must resolve
  // from what already holds it, and a state round-trip would re-render on every
  // resolve. The ref is only ever WRITTEN in the effect below.
  // eslint-disable-next-line react/refs
  const stage = resolveCallStage(options, selected, autoFocusRef.current);
  useEffect(() => {
    autoFocusRef.current = stage.autoFocusId;
  });
  useEffect(() => {
    // FR-CALL-007: once the selected track leaves, the selection is dropped for
    // good — it must not resurrect when that participant re-publishes later.
    // eslint-disable-next-line react/set-state-in-effect
    if (stage.selection !== selected) setSelected(stage.selection);
  }, [stage.selection, selected]);
  const stageEl = useRef<HTMLDivElement>(null);
  const [fullscreenError, setFullscreenError] = useState("");
  return (
    <>
      <div className="bc-call-count">
        {participants.length} participant{participants.length === 1 ? "" : "s"}
      </div>
      <div className="bc-call-view-controls">
        {/* FR-CALL-007: the value tracks the viewer's own pick, never the automatic
            one, so "Automatic (screen share)" stays selected while a share is
            auto-staged and the viewer can tell pinned from automatic. */}
        <label>Focus <select aria-label="Focus participant or screen" value={stage.mode === "selected" ? stage.selection ?? "" : ""}
          onChange={(e) => setSelected(e.target.value || null)}>
          <option value="">Automatic (screen share)</option>
          {options.map((t) => <option key={t.id} value={t.id}>
            {t.ref.participant.name || t.ref.participant.identity}{t.screen ? " — screen" : " — participant"}
          </option>)}
        </select></label>
        {stage.mode === "selected" && <button onClick={() => setSelected(null)}>Automatic view</button>}
        {/* DEC-059: real browser fullscreen only ever from this user gesture. */}
        {stage.focus && <button onClick={() => {
          const element = stageEl.current;
          if (element?.requestFullscreen) void element.requestFullscreen().catch(() => setFullscreenError("Full screen is unavailable in this browser. The selected view is expanded below."));
          else setFullscreenError("Full screen is unavailable in this browser. The selected view is expanded below.");
        }}>Full screen</button>}
      </div>
      {fullscreenError && <small role="status">{fullscreenError}</small>}
      {stage.focus ? <>
        <div ref={stageEl} className="bc-call-focus" data-focus-source={stage.focus.ref.source}>
          <FocusLayout trackRef={stage.focus.ref} />
          <button className="bc-call-exit-fullscreen" onClick={() => void document.exitFullscreen?.()}>Exit full screen</button>
        </div>
        <div className="bc-call-thumbnails">
          {options.map((t) => <div key={t.id}>
            <ParticipantTile trackRef={t.ref} onParticipantClick={() => setSelected(t.id)} />
            <button onClick={() => setSelected(t.id)}>Show {t.ref.participant.name || "participant"}{t.screen ? " screen" : ""}</button>
          </div>)}
        </div>
      </> : <GridLayout tracks={tracks}>
        <ParticipantTile onParticipantClick={(event) => setSelected(callTrackId(event.participant.identity, event.track?.source ?? Track.Source.Camera))} />
      </GridLayout>}
    </>
  );
}

function BoostedAudio({ context, gain }: { context: AudioContext | null; gain: number }) {
  const room = useRoomContext();
  const nodes = useRef(new Map<RemoteAudioTrack, ReturnType<typeof createCallAudioBoost>>());
  const currentGain = useRef(gain);
  useEffect(() => {
    if (!context) return;
    const chains = nodes.current;
    const attach = (track: Track) => {
      if (!(track instanceof RemoteAudioTrack) || nodes.current.has(track)) return;
      const chain = createCallAudioBoost(context, currentGain.current);
      nodes.current.set(track, chain);
      track.setWebAudioPlugins(chain.nodes);
    };
    const detach = (track: Track) => {
      if (!(track instanceof RemoteAudioTrack)) return;
      const chain = nodes.current.get(track);
      if (!chain) return;
      track.setWebAudioPlugins([]);
      chain.boost.disconnect();
      chain.limiter.disconnect();
      nodes.current.delete(track);
    };
    room.remoteParticipants.forEach((p) => p.audioTrackPublications.forEach((pub) => { if (pub.track) attach(pub.track); }));
    room.on(RoomEvent.TrackSubscribed, attach);
    room.on(RoomEvent.TrackUnsubscribed, detach);
    return () => {
      room.off(RoomEvent.TrackSubscribed, attach);
      room.off(RoomEvent.TrackUnsubscribed, detach);
      Array.from(chains.keys()).forEach(detach);
    };
  }, [room, context]);
  useEffect(() => {
    currentGain.current = gain;
    nodes.current.forEach((chain) => chain.boost.gain.setTargetAtTime(gain, context?.currentTime ?? 0, 0.03));
  }, [gain, context]);
  // FR-CALL-008: without Web Audio the boost chain is unavailable, so playback
  // is capped at the standard 100% ceiling rather than a second hard-coded 1.
  return <RoomAudioRenderer volume={context ? 1 : callPlaybackGain(gain, callGainCeiling(false))} />;
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
  const [audioContext, setAudioContext] = useState<AudioContext | null>(null);
  const [gain, setGain] = useState(DEFAULT_CALL_GAIN);
  const [room, setRoom] = useState<Room | null>(null);
  const [error, setError] = useState("");
  const [connecting, setConnecting] = useState(true);
  const [minimized, setMinimized] = useState(false);
  const isActive = useEffectEvent(checkActive);
  const leaveCall = useEffectEvent(onLeave);
  const ownDisconnect = useEffectEvent(registerDisconnect);
  useEffect(() => {
    let context: AudioContext | null = null;
    try { context = new AudioContext(); } catch { /* Standard playback remains available. */ }
    // Expose the browser resource created for this effect lifetime.
    // eslint-disable-next-line react/set-state-in-effect
    setAudioContext(context);
    const room = new Room({
      webAudioMix: context ? { audioContext: context } : false,
      audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
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
      void room.disconnect(true).finally(() => { if (context && context.state !== "closed") void context.close(); });
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
          // FR-CALL-007: camera always starts off, including public guests. Explicit opt-in only.
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
        <BoostedAudio context={audioContext} gain={gain} />
        <label className="bc-call-volume">Speaker volume
          <input aria-label="Speaker volume" type="range" min="0" max={callGainCeiling(!!audioContext) * 100} step="10"
            value={callGainPercent(gain, !!audioContext)}
            onChange={(e) => setGain(callPlaybackGain(Number(e.target.value) / 100, callGainCeiling(!!audioContext)))} />
          <output>{callGainPercent(gain, !!audioContext)}%</output>
        </label>
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
