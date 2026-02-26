export type GamePhase = "lobby" | "in_game" | "results";

export interface RoomConfig {
  turnSeconds: number;
  startingLives: number;
  dictionaryEnabled: boolean;
}

export interface PlayerState {
  id: string;
  name: string;
  joinedAt: number;
  socketId: string | null;
  connected: boolean;
  score: number;
  lives: number;
  eliminated: boolean;
}

export interface RoomState {
  code: string;
  hostId: string;
  phase: GamePhase;
  config: RoomConfig;
  players: PlayerState[];
  usedWords: Set<string>;
  usedWordsOrdered: string[];
  activePlayerId: string | null;
  currentChunk: string | null;
  previousChunk: string | null;
  timerEndsAt: number | null;
  winnerId: string | null;
  lastEvent: string;
  createdAt: number;
  updatedAt: number;
  emptySince: number | null;
}

export interface PublicPlayerState {
  id: string;
  name: string;
  connected: boolean;
  score: number;
  lives: number;
  eliminated: boolean;
  joinedAt: number;
}

export interface PublicRoomState {
  roomCode: string;
  phase: GamePhase;
  hostId: string;
  players: PublicPlayerState[];
  config: RoomConfig;
  activePlayerId: string | null;
  currentChunk: string | null;
  remainingMs: number;
  usedWords: string[];
  winnerId: string | null;
  lastEvent: string;
  canStart: boolean;
  serverTime: number;
}

export interface AckResponse {
  ok: boolean;
  error?: string;
  roomCode?: string;
  playerId?: string;
  state?: PublicRoomState;
}

export interface CreateRoomPayload {
  name: string;
}

export interface JoinRoomPayload {
  roomCode: string;
  name: string;
}

export interface ReconnectPayload {
  roomCode: string;
  playerId: string;
  name?: string;
}

export interface UpdateSettingsPayload {
  roomCode: string;
  playerId: string;
  turnSeconds?: number;
  startingLives?: number;
  dictionaryEnabled?: boolean;
}

export interface PlayerActionPayload {
  roomCode: string;
  playerId: string;
}

export interface SubmitWordPayload extends PlayerActionPayload {
  word: string;
}