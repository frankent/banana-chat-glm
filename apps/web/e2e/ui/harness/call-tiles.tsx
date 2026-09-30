/**
 * FR-PROF-007 / DEC-089 harness. A real LiveKit `Room` that never connects,
 * populated with bare `Participant`s whose `metadata` is exactly what the join
 * token mints (`{"avatar": {...}|null}`), rendered by the production `Tiles`
 * (grid, focus stage, thumbnail strip, FR-CALL-007 focus picker). Playwright
 * drives speaking / metadata changes through `window.__callHarness`.
 */
import { createRoot } from 'react-dom/client';
import { Participant, Room, Track, LocalVideoTrack, type RemoteParticipant } from 'livekit-client';
import { RoomContext } from '@livekit/components-react';
import '@livekit/components-styles';
import '../../../src/index.css';
import '../../../src/components/calls/calls.css';
import { Tiles } from '../../../src/components/calls/MediaPanel';

const params = new URLSearchParams(location.search);
const origin = location.origin;
const photo = (name: string, gif = false) => ({ sm: `${origin}/ui-avatars/${name}-sm.png`, md: `${origin}/ui-avatars/${name}-md.png`, animated: gif ? `${origin}/ui-avatars/${name}.gif` : null });
const meta = (avatar: unknown) => JSON.stringify({ avatar });

const room = new Room();
// The local participant carries the token's metadata too (own tile shows own photo).
Object.assign(room.localParticipant, { identity: 'ui-me', name: 'Alex Morgan', metadata: meta(photo('me')) });

const people: Array<[string, string, unknown]> = [
  ['ui-peer', 'มินตรา Chen', photo('peer', true)],
  ['guest-1', 'Sam Guest', null],
  ['ui-broken', 'Broken Photo', photo('broken')],
];
const count = Number(params.get('people') ?? people.length);
const remotes = people.slice(0, count).map(([identity, name, avatar]) => {
  const participant = new Participant(`PA_${identity}`, identity, name, meta(avatar));
  room.remoteParticipants.set(identity, participant as RemoteParticipant);
  return participant;
});

// ?camera=1 gives the local participant a live (canvas) camera, to prove a
// camera-on tile still renders LiveKit video and no photo.
if (params.get('camera') === '1') {
  const canvas = Object.assign(document.createElement('canvas'), { width: 320, height: 180 });
  const ctx = canvas.getContext('2d')!;
  let frame = 0;
  setInterval(() => { ctx.fillStyle = `hsl(${(frame++ * 7) % 360} 60% 45%)`; ctx.fillRect(0, 0, 320, 180); }, 60);
  const track = new LocalVideoTrack(canvas.captureStream(15).getVideoTracks()[0]!, undefined, true);
  track.source = Track.Source.Camera;
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const publication = {
    kind: Track.Kind.Video, source: Track.Source.Camera, trackSid: 'TR_ui_cam', trackName: 'camera',
    isMuted: false, isSubscribed: true, isEnabled: true, isDesired: true, track, videoTrack: track, dimensions: { width: 320, height: 180 },
    on(event: string, fn: (...args: unknown[]) => void) { (listeners.get(event) ?? listeners.set(event, new Set()).get(event)!).add(fn); return this; },
    off(event: string, fn: (...args: unknown[]) => void) { listeners.get(event)?.delete(fn); return this; },
  };
  const local = room.localParticipant as unknown as { trackPublications: Map<string, unknown>; videoTrackPublications: Map<string, unknown> };
  local.trackPublications.set(publication.trackSid, publication);
  local.videoTrackPublications.set(publication.trackSid, publication);
}

(window as unknown as { __callHarness: unknown }).__callHarness = {
  room,
  participants: [room.localParticipant, ...remotes],
  speak(identity: string, speaking: boolean) {
    const p = [room.localParticipant, ...remotes].find(x => x.identity === identity)!;
    p.setIsSpeaking(speaking);
  },
  setAvatar(identity: string, avatar: unknown) {
    const p = remotes.find(x => x.identity === identity)! as unknown as { _setMetadata(md: string): void };
    p._setMetadata(meta(avatar));
  },
  photo,
};

const voice = params.get('voice') === '1';
createRoot(document.getElementById('root')!).render(
  <div className={`bc-call-stage ${voice ? 'is-voice' : ''}`} data-lk-theme="default" role="dialog" aria-label={voice ? 'Voice call' : 'Video call'}>
    <header><div><span className="bc-call-live" /><strong>Design studio</strong><small>{voice ? 'Voice call' : 'Video meeting'}</small></div></header>
    <RoomContext.Provider value={room}>
      <div className="bc-call-grid"><Tiles /></div>
      <footer><button className="bc-call-hangup">Leave</button></footer>
    </RoomContext.Provider>
  </div>,
);
