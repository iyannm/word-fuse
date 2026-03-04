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

export interface Session {
  roomCode: string;
  playerId: string;
  name: string;
}

export interface TypingState {
  activePlayerId: string | null;
  isTyping: boolean;
  text: string;
}
