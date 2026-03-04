export type GamePhase = "lobby" | "in_game" | "results";
export type ChunkTier = "veryEasy" | "easy" | "medium" | "hard" | "veryHard";
export type PlayerRole = "player" | "spectator";

export interface RoomConfig {
  turnSeconds: number;
  startingLives: number;
  dictionaryEnabled: boolean;
  showTypingPreviews: boolean;
  allowFourLetterChunks: boolean;
}

export interface TierBand {
  min: number;
  max: number;
}

export interface ActiveTurnTypingState {
  playerId: string | null;
  preview: string;
  isTyping: boolean;
  updatedAt: number;
}

export interface PlayerState {
  id: string;
  name: string;
  role: PlayerRole;
  joinedAt: number;
  socketId: string | null;
  connected: boolean;
  score: number;
  lastWord: string;
  activeTurnCount: number;
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
  currentChunkCoverage: number | null;
  currentChunkTier: ChunkTier | null;
  globalDifficultyTier: ChunkTier | null;
  globalStageIndex: number;
  turnNumber: number;
  turnDurationSeconds: number;
  turnStartedAt: number | null;
  matchStartedAt: number | null;
  activePlayerCountAtMatchStart: number;
  recentChunks: string[];
  randomState: number;
  winnerId: string | null;
  lastEvent: string;
  activeTurnTyping: ActiveTurnTypingState;
  createdAt: number;
  updatedAt: number;
  emptySince: number | null;
}

export interface PublicPlayerState {
  id: string;
  name: string;
  role: PlayerRole;
  connected: boolean;
  score: number;
  lastWord: string;
  activeTurnCount: number;
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
  currentChunkCoverage: number | null;
  currentChunkTier: ChunkTier | null;
  globalDifficultyTier: ChunkTier | null;
  globalStageIndex: number;
  turnNumber: number;
  turnDurationSeconds: number;
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
  showTypingPreviews?: boolean;
  allowFourLetterChunks?: boolean;
  hostSpectatorMode?: boolean;
}

export interface PlayerActionPayload {
  roomCode: string;
  playerId: string;
}

export interface SubmitWordPayload extends PlayerActionPayload {
  word: string;
}

export interface PlayerTypingPayload {
  roomCode: string;
  preview: string;
}

export interface PublicTypingState {
  activePlayerId: string | null;
  isTyping: boolean;
  text: string;
}
