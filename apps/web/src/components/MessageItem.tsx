import type { Message } from '@banana-chat/shared';

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function systemText(message: Message): string {
  const event = message.system_event?.event ?? 'system';
  const actor = message.sender?.display_name ?? 'Someone';
  switch (event) {
    case 'room.created':
      return `${actor} created the room`;
    case 'room.renamed':
      return `${actor} renamed the room to ${String(message.system_event?.name ?? '')}`;
    case 'member_added':
      return `${actor} added ${String(message.system_event?.username ?? 'a member')}`;
    case 'member_removed':
      return `${actor} removed ${String(message.system_event?.username ?? 'a member')}`;
    case 'member_left':
      return `${actor} left`;
    default:
      return `${actor} · ${event}`;
  }
}

export function MessageItem({ message, mine }: { message: Message; mine: boolean }) {
  if (message.type === 'system') {
    return (
      <div className="my-2 text-center" data-testid="message" data-system="true">
        <span className="rounded-full bg-slate-200 px-3 py-1 text-xs text-slate-600">{systemText(message)}</span>
      </div>
    );
  }

  const pending = message.id.startsWith('optimistic-');
  const deleted = message.deleted_at !== null;

  return (
    <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`} data-testid="message" data-mine={mine}>
      <div className={`max-w-[70%] rounded-2xl px-3 py-1.5 ${mine ? 'bg-yellow-300' : 'bg-white'} ${pending ? 'opacity-60' : ''} shadow-sm`}>
        {!mine && message.sender !== null && (
          <p className="text-xs font-semibold text-slate-600">{message.sender.display_name}</p>
        )}
        {deleted ? (
          <p className="text-sm italic text-slate-400">This message was deleted</p>
        ) : (
          <p className="whitespace-pre-wrap break-words text-sm">{message.body}</p>
        )}
        <p className="mt-0.5 text-right text-[10px] text-slate-500">
          {pending ? 'sending…' : formatTime(message.created_at)}
        </p>
      </div>
    </div>
  );
}
