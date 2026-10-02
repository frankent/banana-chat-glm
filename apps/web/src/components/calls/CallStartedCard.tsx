import type { Message } from '@banana-chat/shared';
import { useChatText } from '../../lib/use-chat-text';
import { Icon } from '../Visual';
import { useCalls } from './CallProvider';

/**
 * FR-CALL-010 / DEC-091 — the `call_started` system message as a card.
 * The row only stores {call_id, kind}; whether the call is still running
 * comes from the live calls list (GET /calls + call.changed), so the card
 * flips to "Call ended" on its own and Join always uses the current RoomCall.
 */
export function CallStartedCard({ message }: { message: Message }) {
  const { text, locale } = useChatText();
  const calls = useCalls();
  const event = message.system_event ?? { event: 'call_started' };
  const callId = typeof event.call_id === 'string' ? event.call_id : null;
  const voice = event.kind === 'voice';
  const call = callId !== null ? calls.calls.find(c => c.id === callId && !c.ended_at) : undefined;
  const mine = call !== undefined && calls.activeCallId === call.id;
  const name = message.sender?.display_name ?? '…';
  const title = text(voice ? 'chat.callStartedVoice' : 'chat.callStartedVideo').replace('{name}', name);
  const time = new Date(message.created_at).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  const people = call?.participants.length ?? 0;
  const status = call === undefined
    ? text('chat.callEnded')
    : mine
      ? text('chat.callYouAreIn')
      : people > 0 ? text('chat.callLive').replace('{count}', String(people)) : text('chat.callLiveEmpty');

  return (
    <div className="bc-system-message bc-call-msg-row" data-testid="message" data-system="true">
      <div className="bc-call-msg" data-testid="call-started-card" data-state={call === undefined ? 'ended' : mine ? 'mine' : 'live'}>
        <span className="bc-call-msg-icon" aria-hidden="true"><Icon name={voice ? 'phone' : 'video'} size={18} /></span>
        <span className="bc-call-msg-text">
          <strong>{title}</strong>
          <span><time dateTime={message.created_at}>{time}</time> · <span role="status">{status}</span></span>
        </span>
        {call !== undefined && !mine && calls.enabled && (
          <button type="button" className="bc-call-msg-join" data-testid="call-started-join" disabled={calls.busy} onClick={() => calls.join(call)}>
            {text('chat.joinCall')}
          </button>
        )}
      </div>
    </div>
  );
}
