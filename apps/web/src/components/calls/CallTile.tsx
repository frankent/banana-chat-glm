import { useMemo } from "react";
import { Track } from "livekit-client";
import {
  AudioTrack,
  ConnectionQualityIndicator,
  LockLockedIcon,
  ParticipantName,
  ParticipantPlaceholder,
  ScreenShareIcon,
  TrackMutedIndicator,
  VideoTrack,
  isTrackReference,
  useEnsureTrackRef,
  useIsEncrypted,
  useIsMuted,
  useParticipantInfo,
} from "@livekit/components-react";
import { parseParticipantAvatar } from "@banana-chat/chat-core";
import { Avatar } from "../Visual";

/**
 * FR-PROF-007 / DEC-089 — body of every call/meeting `ParticipantTile` (grid,
 * focus stage and thumbnail strip). It mirrors LiveKit's default tile body so a
 * live camera or screen share renders exactly as before; only the camera-off
 * placeholder changes: a large centred circular photo (from the participant's
 * LiveKit metadata, minted into the join token) with the name underneath.
 *
 * Visibility is still LiveKit's own `[data-lk-video-muted=true]
 * [data-lk-source=camera] .lk-participant-placeholder` rule, and the speaking
 * ring is CSS off the tile's `data-lk-speaking` — no extra state here.
 * `useParticipantInfo` observes ParticipantMetadataChanged, so a rejoin with a
 * fresh token (FR-CALL-009) picks up a changed photo.
 */
export function CallTileBody() {
  const trackRef = useEnsureTrackRef();
  const { participant, source } = trackRef;
  const isEncrypted = useIsEncrypted(participant);
  const cameraOff = useIsMuted(trackRef);
  const { name, identity, metadata } = useParticipantInfo({ participant });
  const avatar = useMemo(() => parseParticipantAvatar(metadata), [metadata]);
  const camera = source === Track.Source.Camera;
  // Empty only before the first connect completes: a blank circle, never a wrong name.
  const display = name || identity || "";
  return (
    <>
      {isTrackReference(trackRef) &&
      (trackRef.publication?.kind === "video" || camera || source === Track.Source.ScreenShare) ? (
        <VideoTrack trackRef={trackRef} />
      ) : (
        isTrackReference(trackRef) && <AudioTrack trackRef={trackRef} />
      )}
      <div className="lk-participant-placeholder bc-call-placeholder">
        {camera && cameraOff && (
          <div className="bc-call-person" data-testid="call-person">
            <span className="bc-call-photo">
              {/* Nameless only before the first connect: LiveKit's silhouette, not an empty disc. */}
              {display === "" && avatar === null ? <ParticipantPlaceholder /> : <Avatar name={display} avatar={avatar} large />}
            </span>
            <span className="bc-call-person-name">{display}</span>
          </div>
        )}
      </div>
      <div className="lk-participant-metadata">
        <div className="lk-participant-metadata-item">
          {camera ? (
            <>
              {isEncrypted && <LockLockedIcon style={{ marginRight: "0.25rem" }} />}
              <TrackMutedIndicator
                trackRef={{ participant, source: Track.Source.Microphone }}
                show="muted"
              />
              <ParticipantName />
            </>
          ) : (
            <>
              <ScreenShareIcon style={{ marginRight: "0.25rem" }} />
              <ParticipantName>&apos;s screen</ParticipantName>
            </>
          )}
        </div>
        <ConnectionQualityIndicator className="lk-participant-metadata-item" />
      </div>
    </>
  );
}
