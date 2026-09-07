/** current open room (null on lists/AI) — drives foreground banner suppression */
let currentRoomId: string | null = null;

export function setCurrentRoom(roomId: string | null): void {
  currentRoomId = roomId;
}

export function getCurrentRoomId(): string | null {
  return currentRoomId;
}
