export type GamePhase = "lobby" | "in_game" | "results";

export interface RoomConfig {
  turnSeconds: number;
  startingLives: number;
  dictionaryEnabled: boolean;
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

export interface Session {
  roomCode: string;
  playerId: string;
  name: string;
}