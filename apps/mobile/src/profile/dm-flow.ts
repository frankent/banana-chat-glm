import { classifyDmError, findExistingDmRoomId, type DmFailureKind } from '@banana-chat/chat-core';
import type { RoomListItem } from '@banana-chat/shared';

/**
 * FR-PROF-009 / DEC-101 (mobile slice) — the "Chat 1-1" action behind the
 * profile sheet. Same rules as web's ProfilePopover, minus the DOM:
 *  - an existing normal DM in the cached room list opens without any API call;
 *  - otherwise one `POST /rooms` (200 and 201 both navigate), then the cached
 *    room list is refreshed so the DM is there when the user goes back;
 *  - a second tap while in flight is a no-op (exactly one POST);
 *  - dispose() (sheet closed / room or workspace switched) wins over any
 *    in-flight request: nothing navigates afterwards, no state is emitted.
 */
export type DmState = 'idle' | DmFailureKind;

export interface DmFlowSnapshot {
  busy: boolean;
  state: DmState;
}

export interface DmFlowDeps {
  createDm(userId: string, slug: string): Promise<{ room: { id: string } }>;
  /** Cached room list (SQLite); null when unavailable. */
  cachedRooms(): Promise<readonly RoomListItem[] | null | undefined>;
  /** Re-sync the room list cache after a DM was created. Failures are ignored. */
  refreshRooms(slug: string): Promise<void>;
  /** Slug of the workspace the user is in *now* (not when the sheet opened). */
  currentSlug(): string | undefined;
  navigate(roomId: string): void;
}

export class ProfileDmFlow {
  private disposed = false;
  private inFlight = false;
  private snap: DmFlowSnapshot;

  constructor(
    private readonly deps: DmFlowDeps,
    private readonly targetUserId: string,
    private readonly slug: string,
    isSelf: boolean,
    private readonly onChange: (snapshot: DmFlowSnapshot) => void,
  ) {
    this.snap = { busy: false, state: isSelf ? 'self' : 'idle' };
  }

  get snapshot(): DmFlowSnapshot {
    return this.snap;
  }

  /** The button is hidden for yourself and for an account that can't be messaged (404). */
  get canStart(): boolean {
    return this.snap.state !== 'self' && this.snap.state !== 'unavailable';
  }

  dispose(): void {
    this.disposed = true;
  }

  async start(): Promise<void> {
    if (this.inFlight || this.disposed || !this.canStart) return;
    this.inFlight = true;
    try {
      const rooms = await this.deps.cachedRooms().catch(() => null);
      if (this.disposed) return;
      const existing = findExistingDmRoomId(rooms ?? undefined, this.targetUserId);
      if (existing !== null) {
        this.deps.navigate(existing);
        return;
      }
      this.set({ busy: true, state: 'idle' });
      const result = await this.deps.createDm(this.targetUserId, this.slug);
      if (this.disposed || this.deps.currentSlug() !== this.slug) return;
      await this.deps.refreshRooms(this.slug).catch(() => undefined);
      if (this.disposed) return;
      this.deps.navigate(result.room.id);
    } catch (error) {
      if (this.disposed) return;
      this.set({ busy: false, state: classifyDmError(error) });
    } finally {
      this.inFlight = false;
      if (!this.disposed && this.snap.busy && this.snap.state === 'idle') this.set({ busy: false, state: 'idle' });
    }
  }

  private set(next: DmFlowSnapshot): void {
    this.snap = next;
    this.onChange(next);
  }
}

/**
 * Room type for the trigger gate: cached room list first, `GET /rooms/{id}`
 * on a miss (push / deep-link open). `null` = unknown -> render no trigger.
 */
export async function resolveRoomType(
  roomId: string,
  cachedRooms: () => Promise<readonly RoomListItem[] | null | undefined>,
  fetchRoom: () => Promise<{ room: { type: string } }>,
): Promise<string | null> {
  const cached = (await cachedRooms().catch(() => null))?.find(item => item.room.id === roomId);
  if (cached) return cached.room.type;
  try {
    return (await fetchRoom()).room.type;
  } catch {
    return null;
  }
}
