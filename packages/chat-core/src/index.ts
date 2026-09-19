export { MessageStore } from './message-store.js';
export type { GapFillRequest, MessageStoreState } from './message-store.js';
export { unreadTotals, readersAt } from './unread-calculator.js';
export { EventRouter } from './event-router.js';
export { backoffDelay, planSync } from './sync.js';
export type { SyncPlan } from './sync.js';
export { createAiStreamStore } from './ai-stream.js';
export type { AiStreamState, AiStreamStore } from './ai-stream.js';
export { parseMarkdown, parseInline } from './markdown.js';
export type { MdBlock, MdInlineNode } from './markdown.js';
export {
  CACHE_SCHEMA_VERSION,
  MemoryCacheAdapter,
  SchemaVersionGuard,
  scopeKey,
} from './cache.js';
export type { CacheAdapter, CacheScope, MemoryCacheOptions, OutboxAttachmentDraft, OutboxEntry, OutboxStatus } from './cache.js';
export { MemoryAiCacheAdapter } from './ai-cache.js';
export type { AiCacheAdapter, MemoryAiCacheOptions } from './ai-cache.js';
export { Outbox } from './outbox.js';
export type { OutboxDraft, OutboxOptions, OutboxSendFn, OutboxSendResult } from './outbox.js';
// NOTE: the contract test suites (cache.contract.js) are test-only — they
// import vitest, so they must never enter the production import graph.
// Consumers run them via the '@banana-chat/chat-core/contract' subpath.
export { RoomSync, ReadReceiptReporter } from './room-sync.js';
export { uploadTicket } from './upload.js';
export type { CompletedPart } from './upload.js';
export { applyRoomEvent } from './room-sync.js';

export { TypingState, TypingPublisher } from './typing.js';

export { continuesMessage } from './message-layout.js';
export { roomListTime, roomPreviewText } from './room-list-presentation.js';
export type { RoomListTime } from './room-list-presentation.js';
export { NotificationGate, DesktopNotificationGate, desktopNotificationBody, unreadTitle } from './notification.js';
export type { AlertKind } from './notification.js';
export { ticketKey, deadlineState } from './kanban.js';
export { CallAttempt, canRingCall } from './call.js';
export { meetingGuestName, meetingReturnPath } from './meeting.js';
export { editMarkdown } from './markdown-editor.js';
export type { MarkdownAction } from './markdown-editor.js';
export {
  focusedCallTrack,
  resolveCallStage,
  callTrackId,
  DEFAULT_CALL_GAIN,
  CALL_GAIN_MAX,
  CALL_GAIN_FALLBACK_MAX,
  callPlaybackGain,
  callGainCeiling,
  callGainPercent,
} from './call-presentation.js';
export type { CallTrackLike, CallStage, CallStageMode } from './call-presentation.js';
export {
  SECRET_EXPIRY_MIN_DAYS,
  SECRET_EXPIRY_MAX_DAYS,
  secretExpiryState,
  isSecretRoomActive,
  secretExpiryShort,
  secretExpiryAbsolute,
  filterExpiredRooms,
  nextSecretDeadline,
} from './secret-room.js';
export type { SecretRoomLike, SecretExpiryState } from './secret-room.js';

/**
 * FR-PCHAT-008 — public support chat. `packages/chat-core` is the ONLY place
 * this logic may live (CLAUDE.md); apps import from here, never reimplement.
 */
export {
  PUBLIC_CHAT_STATUSES,
  VISITOR_DISPLAY_NAME_MAX,
  agentExternalName,
  comparePublicChatRooms,
  filterPublicChatRooms,
  isPublicChatCode,
  matchesPublicChatFilters,
  needsReply,
  publicChatCanSend,
  publicChatClaimState,
  publicChatClosedReasonKey,
  publicChatComposerBannerKey,
  publicChatComposerState,
  publicChatLinkPath,
  publicChatStatusLabel,
  publicChatStatusLabelKey,
  publicChatStatusPublic,
  publicChatStatusPublicLabel,
  publicChatStatusTone,
  sortPublicChatQueue,
  visitorDisplayName,
} from './public-chat.js';
export type {
  PublicChatClaimState,
  PublicChatComposerContext,
  PublicChatComposerState,
  PublicChatRoomLike,
  PublicChatStatusTone,
} from './public-chat.js';
export { isWebPushConfigured, webPushStatus, serviceWorkerUrl, resolveWebDeviceId, WEB_DEVICE_ID_KEY } from './web-push.js';
export type { FirebaseWebConfig, WebPushEnvironment, WebPushStatus } from './web-push.js';
export { DEVICE_ID_PATTERN, generateDeviceId, isValidDeviceId } from './device-id.js';
