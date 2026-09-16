export { ApiClient } from './client.js';
export { ApiError, NetworkError } from './error.js';
export type { ApiErrorBody } from './error.js';
export { TokenManager } from './token-manager.js';
export type { TokenStore } from './token-manager.js';
export { Endpoints } from './endpoints.js';
export type { LoginResponse, RoomDetail, SecretRoomOptions } from './endpoints.js';
/** §5.18 FR-PCHAT — request shapes for the visitor (API-210..216) and agent (API-220..228) tiers. */
export type {
  PublicChatAgentSendInput,
  PublicChatBroadcastAuth,
  PublicChatRoomPatch,
  PublicChatUploadInput,
  PublicChatUploadKind,
  PublicChatVisitorSendInput,
} from './endpoints.js';
