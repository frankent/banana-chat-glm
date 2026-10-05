/**
 * FR-CALL-008/009 / DEC-094 harness. A real AudioContext and a real
 * RemoteAudioTrack (fed by a WebAudio oscillator) attached to <audio> elements
 * the way livekit does with webAudioMix: muted, volume 0, routed through the
 * graph. Playwright suspends/resumes the context and reads element state.
 */
import { createRoot } from 'react-dom/client';
import { RemoteAudioTrack, Room, type RemoteParticipant } from 'livekit-client';
import { useCallPlaybackFallback } from '../../../src/components/calls/use-call-playback-fallback';

const context = new AudioContext();
const oscillator = context.createOscillator();
const destination = context.createMediaStreamDestination();
oscillator.connect(destination);
oscillator.start();

const room = new Room();
const track = new RemoteAudioTrack(destination.stream.getAudioTracks()[0]!, 'TR_ui_audio', null as unknown as RTCRtpReceiver, context);
room.remoteParticipants.set('ui-peer', { audioTrackPublications: new Map([['TR_ui_audio', { track }]]) } as unknown as RemoteParticipant);

function attach(): HTMLAudioElement {
  const el = document.createElement('audio');
  document.body.append(el);
  track.attach(el);
  return el;
}

(window as unknown as { __audioHarness: unknown }).__audioHarness = {
  context,
  attach,
  detachAll() { track.detach().forEach(el => el.remove()); },
  state: () => ({ contextState: context.state, elements: track.attachedElements.map(el => ({ muted: el.muted, volume: el.volume })) }),
  async unmount() { root.unmount(); },
};

function Probe() { useCallPlaybackFallback(room, context); return null; }
const root = createRoot(document.getElementById('root')!);
root.render(<Probe />);
