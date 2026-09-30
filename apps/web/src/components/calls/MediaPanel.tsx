import { useEffect, useEffectEvent, useState, useRef } from "react";
import {
  Room,
  RoomEvent,
  Track,
  RemoteAudioTrack,
  DisconnectReason,
  type Participant,
  type TrackPublication,
} from "livekit-client";
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
  classifyDisconnect,
  isMobileBrowser,
  reconnectDelayMs,
  shouldGiveUpReconnect,
} from "@banana-chat/chat-core";
import { createCallAudioBoost } from "./audio-boost";
import { startCallKeepalive } from "./background-keepalive";

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
  refreshCredentials,
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
  refreshCredentials?: () => Promise<{ url: string; token: string }>;
  canMinimize?: boolean;
}) {
  const [audioContext, setAudioContext] = useState<AudioContext | null>(null);
  const [gain, setGain] = useState(DEFAULT_CALL_GAIN);
  const [room, setRoom] = useState<Room | null>(null);
  const [error, setError] = useState("");
  const [connecting, setConnecting] = useState(true);
  const [reconnecting, setReconnecting] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const isActive = useEffectEvent(checkActive);
  const leaveCall = useEffectEvent(onLeave);
  const ownDisconnect = useEffectEvent(registerDisconnect);
  // FR-CALL-009: the user's own mute choice survives OS interruptions and
  // rejoins; rejoin/keepalive restore the microphone only when this is false.
  const userMuted = useRef(false);
  // Kept current between renders so the join effect (deps: id/kind/token/url)
  // can always call the freshest credential refresher without re-joining.
  const refreshRef = useRef(refreshCredentials);
  useEffect(() => {
    refreshRef.current = refreshCredentials;
  });
  useEffect(() => {
    // FR-CALL-009 / DEC-086: iOS/Android suspend the Web Audio graph when the
    // tab is backgrounded, silencing the FR-CALL-008 boost chain entirely —
    // on those browsers never create the AudioContext; plain <audio> playback
    // (and the 100% ceiling fallback) keeps working. Desktop keeps the boost.
    const mobile = isMobileBrowser(
      navigator.userAgent,
      navigator.maxTouchPoints,
      navigator.platform,
    );
    let context: AudioContext | null = null;
    if (!mobile) {
      try { context = new AudioContext(); } catch { /* Standard playback remains available. */ }
    }
    // Expose the browser resource created for this effect lifetime.
    // eslint-disable-next-line react/set-state-in-effect
    setAudioContext(context);
    // FR-CALL-009: ask Safari 16.4+ to keep the audio session live across
    // backgrounding while in call (feature-detected, best effort).
    try {
      const audioSession = (navigator as Navigator & { audioSession?: { type?: string } }).audioSession;
      if (audioSession) audioSession.type = "play-and-record";
    } catch { /* Older browsers ignore the audio session hint. */ }
    let currentUrl = url;
    let currentToken = token;
    let cancelled = false; // registered disconnect / effect teardown ran
    let deliberate = false; // the call is over for us — never rejoin again
    let failedAttempts = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let rejoining = false;
    let wantsReconnect = false; // disconnected and waiting to rejoin
    let keepaliveStop: (() => void) | null = null;
    let activeRoom: Room | null = null;
    const makeRoom = () =>
      new Room({
        webAudioMix: context ? { audioContext: context } : false,
        audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        adaptiveStream: true,
        dynacast: true,
        videoCaptureDefaults: {
          resolution: { width: 640, height: 360, frameRate: 24 },
        },
        publishDefaults: { simulcast: true },
      });
    const published = () => setError("");
    const trackMuted = (publication: TrackPublication, participant: Participant) => {
      // An OS interruption also emits TrackMuted, but it flags the underlying
      // MediaStreamTrack as muted; a deliberate mute only disables the track.
      if (participant.isLocal && publication.source === Track.Source.Microphone
        && publication.track?.mediaStreamTrack?.muted !== true)
        userMuted.current = true;
    };
    const trackUnmuted = (publication: TrackPublication, participant: Participant) => {
      if (participant.isLocal && publication.source === Track.Source.Microphone)
        userMuted.current = false;
    };
    const onDisconnected = (reason?: DisconnectReason) => {
      if (cancelled || deliberate) return;
      // FR-CALL-009 / DEC-086: only a room/membership-ending reason hangs up;
      // background freezes and network drops rejoin with fresh credentials.
      if (classifyDisconnect(reason, false) === "leave") {
        deliberate = true;
        stopReconnectTimer();
        leaveCall();
        return;
      }
      wantsReconnect = true;
      setReconnecting(true);
      if (reconnectTimer === null && !rejoining) scheduleReconnect();
    };
    const attach = (room: Room) => {
      room.on(RoomEvent.LocalTrackPublished, published);
      room.on(RoomEvent.TrackMuted, trackMuted);
      room.on(RoomEvent.TrackUnmuted, trackUnmuted);
      room.on(RoomEvent.Disconnected, onDisconnected);
    };
    const detach = (room: Room) => {
      room.off(RoomEvent.LocalTrackPublished, published);
      room.off(RoomEvent.TrackMuted, trackMuted);
      room.off(RoomEvent.TrackUnmuted, trackUnmuted);
      room.off(RoomEvent.Disconnected, onDisconnected);
    };
    const stopRoom = (room: Room) => {
      keepaliveStop?.();
      keepaliveStop = null;
      detach(room);
      room.localParticipant.trackPublications.forEach((publication) =>
        publication.track?.stop(),
      );
      void room.disconnect(true);
    };
    const stopReconnectTimer = () => {
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };
    const scheduleReconnect = () => {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void attemptRejoin();
      }, reconnectDelayMs(failedAttempts));
    };
    const giveUp = () => {
      deliberate = true;
      stopReconnectTimer();
      leaveCall();
    };
    const afterJoin = (room: Room) => {
      // FR-CALL-009 / DEC-086: register as active media (Media Session, wake
      // lock, OS-mute recovery) so backgrounding does not tear the call down.
      keepaliveStop = startCallKeepalive({
        title,
        room,
        onHangup: () => {
          deliberate = true;
          leaveCall();
        },
        isUserMuted: () => userMuted.current,
      });
    };
    const attemptRejoin = async () => {
      if (cancelled || deliberate || !wantsReconnect) return;
      rejoining = true;
      try {
        let active = true;
        try {
          active = await isActive();
        } catch { /* An unreachable liveness probe must not strand the call. */ }
        if (cancelled || deliberate) return;
        // FR-CALL-009: the server-ended call/meeting is the other give-up rule.
        if (!active) {
          giveUp();
          return;
        }
        // Fresh credentials put the reconnect ahead of media-token expiry and
        // re-check admission server-side; a 409 "Call ended." stops here.
        try {
          const refresher = refreshRef.current;
          if (refresher) {
            const credentials = await refresher();
            currentUrl = credentials.url;
            currentToken = credentials.token;
          }
        } catch {
          giveUp();
          return;
        }
        if (cancelled || deliberate) return;
        const room = makeRoom();
        if (activeRoom) stopRoom(activeRoom);
        activeRoom = room;
        attach(room);
        // Expose the SDK resource created for this effect lifetime to the renderer.
        setRoom(room);
        try {
          await room.connect(currentUrl, currentToken);
          if (cancelled || deliberate) {
            detach(room);
            await room.disconnect(true);
            return;
          }
          failedAttempts = 0;
          wantsReconnect = false;
          setReconnecting(false);
          try {
            // Restore the user's own microphone choice across the rejoin.
            await room.localParticipant.setMicrophoneEnabled(!userMuted.current);
          } catch {
            setError(
              "Allow camera/microphone access in your browser, then use the controls to try again.",
            );
          }
          // FR-CALL-007: camera always stays off across rejoins too.
          afterJoin(room);
        } catch {
          detach(room);
          // A hidden tab or a dead network says nothing about the call: only
          // failures while we could plausibly connect spend the budget.
          if (document.visibilityState === "visible" && navigator.onLine) failedAttempts += 1;
          // FR-CALL-009: backoff (1s, 2s, 4s, 8s…) until the budget is spent.
          if (shouldGiveUpReconnect(failedAttempts)) {
            giveUp();
            return;
          }
          scheduleReconnect();
        }
      } finally {
        rejoining = false;
      }
    };
    // FR-CALL-009: returning to the tab or regaining network retries at once
    // instead of waiting out the backoff timer.
    const retryNow = () => {
      if (cancelled || deliberate || !wantsReconnect || rejoining) return;
      stopReconnectTimer();
      void attemptRejoin();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") retryNow();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pageshow", retryNow);
    window.addEventListener("online", retryNow);
    const disconnect = () => {
      cancelled = true;
      deliberate = true;
      stopReconnectTimer();
      keepaliveStop?.();
      keepaliveStop = null;
      if (activeRoom) {
        const room = activeRoom;
        activeRoom = null;
        detach(room);
        room.localParticipant.trackPublications.forEach((publication) =>
          publication.track?.stop(),
        );
        void room.disconnect(true).finally(() => { if (context && context.state !== "closed") void context.close(); });
      } else if (context && context.state !== "closed") void context.close();
    };
    ownDisconnect(disconnect);
    // FR-CALL-009 (desktop only, where the boost AudioContext exists): resume
    // an interrupted/suspended context once the page is visible again.
    let resumeAudio: (() => void) | null = null;
    if (context) {
      const ctx = context;
      resumeAudio = () => {
        if (cancelled || ctx.state === "closed") return;
        const state = ctx.state as string;
        if ((state === "suspended" || state === "interrupted") && document.visibilityState === "visible") {
          void ctx.resume().catch(() => {});
          if (activeRoom) void activeRoom.startAudio().catch(() => {});
        }
      };
      ctx.onstatechange = resumeAudio;
      document.addEventListener("visibilitychange", resumeAudio);
      window.addEventListener("pageshow", resumeAudio);
    }
    const room = makeRoom();
    activeRoom = room;
    attach(room);
    // Expose the SDK resource created for this effect lifetime to the renderer.
    // eslint-disable-next-line react/set-state-in-effect
    setRoom(room);
    void (async () => {
      await Promise.resolve();
      if (cancelled) return;
      try {
        await room.connect(currentUrl, currentToken);
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
        if (!cancelled) afterJoin(room);
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
          if (!cancelled && !deliberate && !active) {
            deliberate = true;
            leaveCall();
          }
        })
        .catch(() => {});
    }, 5000);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pageshow", retryNow);
      window.removeEventListener("online", retryNow);
      if (context) {
        context.onstatechange = null;
        if (resumeAudio) {
          document.removeEventListener("visibilitychange", resumeAudio);
          window.removeEventListener("pageshow", resumeAudio);
        }
      }
      disconnect();
    };
    // `title` only feeds the Media Session label; a rename must never tear
    // down and re-join a live call, so it is deliberately not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
            {/* FR-CALL-009 / DEC-086: a dropped connection is survivable — show
                it instead of silently hanging up. */}
            {reconnecting
              ? "Reconnecting…"
              : connecting
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
