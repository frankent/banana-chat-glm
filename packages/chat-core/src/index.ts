export { MessageStore } from './message-store.js';
export type { GapFillRequest, MessageStoreState } from './message-store.js';
export { unreadTotals, readersAt } from './unread-calculator.js';
export { EventRouter } from './event-router.js';
export { backoffDelay, planSync } from './sync.js';
export type { SyncPlan } from './sync.js';
export { createAiStreamStore } from './ai-stream.js';
export type { AiStreamState, AiStreamStore } from './ai-stream.js';
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
