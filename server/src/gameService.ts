import { Server } from "socket.io";
import { Dictionary } from "./dictionary";
import {
  PublicRoomState,
  RoomState,
  PlayerState,
  AckResponse,
  UpdateSettingsPayload,
  SubmitWordPayload,
  PlayerActionPayload,
} from "./types";
import {
  clampInt,
  createPlayerId,
  createRoomCode,
  sanitizePlayerName,
  sanitizeRoomCode,
  sanitizeWord,
} from "./utils";

const DEFAULT_TURN_SECONDS = 10;
const MIN_TURN_SECONDS = 5;
const MAX_TURN_SECONDS = 20;
const DEFAULT_STARTING_LIVES = 3;
const MIN_STARTING_LIVES = 1;
const MAX_STARTING_LIVES = 5;
const MIN_PLAYERS_TO_START = 2;
const MAX_PLAYERS_PER_ROOM = 12;
const TIMER_TICK_MS = 250;
const SUBMIT_RATE_LIMIT_MS = 300;
const EMPTY_ROOM_TTL_MS = 5 * 60 * 1000;

const CHUNKS = [
  "AR",
  "ER",
  "ING",
  "TION",
  "CH",
  "SH",
  "TH",
  "EA",
  "OU",
  "ST",
  "TR",
  "SP",
  "CL",
  "BR",
  "PL",
  "GR",
  "PH",
  "WH",
  "CK",
  "LL",
  "MENT",
  "NESS",
  "ABLE",
  "FUL",
  "LESS",
  "AL",
  "OR",
  "EN",
  "IST",
  "OUS",
];

interface SocketSession {
  roomCode: string;
  playerId: string;
}

interface OperationResult {
  ok: boolean;
  error?: string;
  roomCode?: string;
  playerId?: string;
  state?: PublicRoomState;
}

export class GameService {
  private readonly rooms = new Map<string, RoomState>();
  private readonly socketSessions = new Map<string, SocketSession>();
  private readonly lastSubmitAtBySocket = new Map<string, number>();

  constructor(
    private readonly io: Server,
    private readonly dictionary: Dictionary,
  ) {
    setInterval(() => this.tick(), TIMER_TICK_MS);
    setInterval(() => this.cleanupRooms(), 30_000);
  }

  public createRoom(socketId: string, nameInput: string): OperationResult {
    const name = sanitizePlayerName(nameInput);
    if (!name) {
      return { ok: false, error: "Enter a valid display name." };
    }

    const roomCode = createRoomCode(new Set(this.rooms.keys()));
    const playerId = createPlayerId();

    const host: PlayerState = {
      id: playerId,
      name,
      joinedAt: Date.now(),
      socketId,
      connected: true,
      score: 0,
      lives: DEFAULT_STARTING_LIVES,
      eliminated: false,
    };

    const room: RoomState = {
      code: roomCode,
      hostId: host.id,
      phase: "lobby",
      config: {
        turnSeconds: DEFAULT_TURN_SECONDS,
        startingLives: DEFAULT_STARTING_LIVES,
        dictionaryEnabled: this.dictionary.enabled,
      },
      players: [host],
      usedWords: new Set<string>(),
      usedWordsOrdered: [],
      activePlayerId: null,
      currentChunk: null,
      previousChunk: null,
      timerEndsAt: null,
      winnerId: null,
      lastEvent: "Room created. Waiting for players.",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      emptySince: null,
    };

    this.rooms.set(roomCode, room);
    this.bindSocketSession(socketId, roomCode, playerId);

    this.io.sockets.sockets.get(socketId)?.join(roomCode);

    return {
      ok: true,
      roomCode,
      playerId,
      state: this.serializeRoom(room),
    };
  }

  public joinRoom(socketId: string, roomCodeInput: string, nameInput: string): OperationResult {
    const roomCode = sanitizeRoomCode(roomCodeInput);
    const name = sanitizePlayerName(nameInput);

    if (!roomCode) {
      return { ok: false, error: "Enter a valid room code." };
    }

    if (!name) {
      return { ok: false, error: "Enter a valid display name." };
    }

    const room = this.rooms.get(roomCode);
    if (!room) {
      return { ok: false, error: "Room not found." };
    }

    if (room.phase !== "lobby") {
      return { ok: false, error: "Game already started in this room." };
    }

    if (room.players.length >= MAX_PLAYERS_PER_ROOM) {
      return { ok: false, error: "Room is full." };
    }

    const duplicateName = room.players.some(
      (player) => player.name.toLowerCase() === name.toLowerCase(),
    );

    if (duplicateName) {
      return { ok: false, error: "Display name already taken in this room." };
    }

    const playerId = createPlayerId();
    const player: PlayerState = {
      id: playerId,
      name,
      joinedAt: Date.now(),
      socketId,
      connected: true,
      score: 0,
      lives: room.config.startingLives,
      eliminated: false,
    };

    room.players.push(player);
    room.emptySince = null;
    room.updatedAt = Date.now();
    room.lastEvent = `${player.name} joined the room.`;

    this.bindSocketSession(socketId, room.code, player.id);
    this.io.sockets.sockets.get(socketId)?.join(room.code);

    this.broadcastRoom(room);

    return {
      ok: true,
      roomCode: room.code,
      playerId,
      state: this.serializeRoom(room),
    };
  }

  public reconnectPlayer(
    socketId: string,
    roomCodeInput: string,
    playerId: string,
    nameInput?: string,
  ): OperationResult {
    const roomCode = sanitizeRoomCode(roomCodeInput);
    const room = this.rooms.get(roomCode);

    if (!room) {
      return { ok: false, error: "Room no longer exists." };
    }

    const player = this.getPlayer(room, playerId);
    if (!player) {
      return { ok: false, error: "Player not found in room." };
    }

    const maybeName = typeof nameInput === "string" ? sanitizePlayerName(nameInput) : "";
    if (maybeName && maybeName !== player.name) {
      const duplicateName = room.players.some(
        (entry) => entry.id !== player.id && entry.name.toLowerCase() === maybeName.toLowerCase(),
      );
      if (!duplicateName) {
        player.name = maybeName;
      }
    }

    player.socketId = socketId;
    player.connected = true;

    this.bindSocketSession(socketId, room.code, player.id);
    this.io.sockets.sockets.get(socketId)?.join(room.code);

    room.emptySince = null;
    this.ensureHostIsConnected(room);

    if (room.phase === "in_game" && room.activePlayerId === null) {
      const next = this.getNextEligiblePlayer(room, null);
      if (next) {
        room.activePlayerId = next.id;
        room.currentChunk = this.chooseChunk(room.currentChunk);
        room.timerEndsAt = Date.now() + room.config.turnSeconds * 1000;
      }
    }

    room.updatedAt = Date.now();
    this.broadcastRoom(room);

    return {
      ok: true,
      roomCode: room.code,
      playerId: player.id,
      state: this.serializeRoom(room),
    };
  }

  public updateSettings(socketId: string, payload: UpdateSettingsPayload): OperationResult {
    const roomCode = sanitizeRoomCode(payload.roomCode);
    const room = this.rooms.get(roomCode);

    if (!room) {
      return { ok: false, error: "Room not found." };
    }

    if (!this.socketOwnsPlayer(socketId, roomCode, payload.playerId)) {
      return { ok: false, error: "Action not allowed for this socket." };
    }

    if (room.phase !== "lobby") {
      return { ok: false, error: "Settings can only be changed in lobby." };
    }

    if (room.hostId !== payload.playerId) {
      return { ok: false, error: "Only the host can change settings." };
    }

    if (typeof payload.turnSeconds === "number") {
      room.config.turnSeconds = clampInt(payload.turnSeconds, MIN_TURN_SECONDS, MAX_TURN_SECONDS);
    }

    if (typeof payload.startingLives === "number") {
      room.config.startingLives = clampInt(
        payload.startingLives,
        MIN_STARTING_LIVES,
        MAX_STARTING_LIVES,
      );
    }

    if (typeof payload.dictionaryEnabled === "boolean") {
      room.config.dictionaryEnabled = payload.dictionaryEnabled && this.dictionary.enabled;
    }

    room.updatedAt = Date.now();
    room.lastEvent = "Host updated game settings.";

    this.broadcastRoom(room);

    return { ok: true, state: this.serializeRoom(room) };
  }

  public startGame(socketId: string, payload: PlayerActionPayload): OperationResult {
    const roomCode = sanitizeRoomCode(payload.roomCode);
    const room = this.rooms.get(roomCode);

    if (!room) {
      return { ok: false, error: "Room not found." };
    }

    if (!this.socketOwnsPlayer(socketId, roomCode, payload.playerId)) {
      return { ok: false, error: "Action not allowed for this socket." };
    }

    if (room.hostId !== payload.playerId) {
      return { ok: false, error: "Only the host can start the game." };
    }

    if (room.phase !== "lobby") {
      return { ok: false, error: "Game already running." };
    }

    const connectedCount = room.players.filter((player) => player.connected).length;
    if (connectedCount < MIN_PLAYERS_TO_START) {
      return { ok: false, error: "Need at least 2 connected players to start." };
    }

    room.phase = "in_game";
    room.usedWords.clear();
    room.usedWordsOrdered = [];
    room.winnerId = null;
    room.previousChunk = null;

    for (const player of room.players) {
      player.score = 0;
      player.lives = room.config.startingLives;
      player.eliminated = false;
    }

    const firstActive = this.getNextEligiblePlayer(room, null);
    if (!firstActive) {
      room.phase = "lobby";
      return { ok: false, error: "No eligible players to start the game." };
    }

    room.activePlayerId = firstActive.id;
    room.currentChunk = this.chooseChunk(null);
    room.timerEndsAt = Date.now() + room.config.turnSeconds * 1000;
    room.lastEvent = `${firstActive.name} starts with the bomb.`;
    room.updatedAt = Date.now();

    this.broadcastRoom(room);

    return { ok: true, state: this.serializeRoom(room) };
  }

  public submitWord(socketId: string, payload: SubmitWordPayload): OperationResult {
    const now = Date.now();
    const lastSubmit = this.lastSubmitAtBySocket.get(socketId) ?? 0;
    if (now - lastSubmit < SUBMIT_RATE_LIMIT_MS) {
      return { ok: false, error: "Submitting too quickly. Slow down slightly." };
    }
    this.lastSubmitAtBySocket.set(socketId, now);

    const roomCode = sanitizeRoomCode(payload.roomCode);
    const room = this.rooms.get(roomCode);

    if (!room) {
      return { ok: false, error: "Room not found." };
    }

    if (!this.socketOwnsPlayer(socketId, roomCode, payload.playerId)) {
      return { ok: false, error: "Action not allowed for this socket." };
    }

    if (room.phase !== "in_game") {
      return { ok: false, error: "Game is not active." };
    }

    const player = this.getPlayer(room, payload.playerId);
    if (!player || !player.connected || player.eliminated) {
      return { ok: false, error: "You are not an active player." };
    }

    if (room.activePlayerId !== player.id) {
      return { ok: false, error: "It is not your turn." };
    }

    const word = sanitizeWord(payload.word);
    if (!/^[a-z]+$/.test(word)) {
      return { ok: false, error: "Word must contain letters A-Z only." };
    }

    if (word.length < 3) {
      return { ok: false, error: "Word must be at least 3 letters." };
    }

    const chunk = room.currentChunk?.toLowerCase();
    if (!chunk || !word.includes(chunk)) {
      return { ok: false, error: `Word must include chunk \"${room.currentChunk}\".` };
    }

    if (room.usedWords.has(word)) {
      return { ok: false, error: "Word already used in this match." };
    }

    if (room.config.dictionaryEnabled && !this.dictionary.has(word)) {
      return { ok: false, error: "Word not found in dictionary." };
    }

    room.usedWords.add(word);
    room.usedWordsOrdered.push(word);
    player.score += 1;
    room.lastEvent = `${player.name} played \"${word}\".`;

    this.advanceTurn(room, player.id);
    room.updatedAt = Date.now();

    this.broadcastRoom(room);

    return { ok: true, state: this.serializeRoom(room) };
  }

  public playAgain(socketId: string, payload: PlayerActionPayload): OperationResult {
    const roomCode = sanitizeRoomCode(payload.roomCode);
    const room = this.rooms.get(roomCode);

    if (!room) {
      return { ok: false, error: "Room not found." };
    }

    if (!this.socketOwnsPlayer(socketId, roomCode, payload.playerId)) {
      return { ok: false, error: "Action not allowed for this socket." };
    }

    if (room.hostId !== payload.playerId) {
      return { ok: false, error: "Only the host can reset the match." };
    }

    if (room.phase !== "results") {
      return { ok: false, error: "Match has not ended yet." };
    }

    room.phase = "lobby";
    room.activePlayerId = null;
    room.currentChunk = null;
    room.previousChunk = null;
    room.timerEndsAt = null;
    room.winnerId = null;
    room.usedWords.clear();
    room.usedWordsOrdered = [];

    for (const player of room.players) {
      player.score = 0;
      player.lives = room.config.startingLives;
      player.eliminated = false;
    }

    room.lastEvent = "Match reset. Host can start a new game.";
    room.updatedAt = Date.now();

    this.broadcastRoom(room);

    return { ok: true, state: this.serializeRoom(room) };
  }

  public handleDisconnect(socketId: string): void {
    const session = this.socketSessions.get(socketId);
    this.socketSessions.delete(socketId);
    this.lastSubmitAtBySocket.delete(socketId);

    if (!session) {
      return;
    }

    const room = this.rooms.get(session.roomCode);
    if (!room) {
      return;
    }

    const player = this.getPlayer(room, session.playerId);
    if (!player) {
      return;
    }

    if (player.socketId !== socketId) {
      return;
    }

    player.socketId = null;
    player.connected = false;

    if (player.id === room.hostId) {
      this.ensureHostIsConnected(room);
    }

    if (room.phase === "in_game") {
      if (room.activePlayerId === player.id) {
        room.lastEvent = `${player.name} disconnected. Bomb moved to next player.`;
        this.advanceTurn(room, player.id);
      } else {
        const eligible = this.getEligiblePlayers(room);
        if (eligible.length <= 1) {
          this.finishGame(room, eligible[0] ?? null);
        }
      }
    }

    const connectedCount = room.players.filter((entry) => entry.connected).length;
    room.emptySince = connectedCount === 0 ? Date.now() : null;
    room.updatedAt = Date.now();

    this.broadcastRoom(room);
  }

  public toAck(result: OperationResult): AckResponse {
    if (!result.ok) {
      return {
        ok: false,
        error: result.error ?? "Unknown error.",
      };
    }

    return {
      ok: true,
      roomCode: result.roomCode,
      playerId: result.playerId,
      state: result.state,
    };
  }

  private tick(): void {
    for (const room of this.rooms.values()) {
      if (room.phase !== "in_game") {
        continue;
      }

      if (!room.activePlayerId || room.timerEndsAt === null) {
        continue;
      }

      const now = Date.now();
      if (now >= room.timerEndsAt) {
        this.handleTimerExpiry(room);
      }

      this.broadcastRoom(room);
    }
  }

  private handleTimerExpiry(room: RoomState): void {
    if (room.phase !== "in_game" || !room.activePlayerId) {
      return;
    }

    const active = this.getPlayer(room, room.activePlayerId);

    if (!active || !active.connected || active.eliminated) {
      this.advanceTurn(room, room.activePlayerId);
      room.lastEvent = "Bomb moved because active player was unavailable.";
      room.updatedAt = Date.now();
      return;
    }

    active.lives = Math.max(0, active.lives - 1);

    if (active.lives === 0) {
      active.eliminated = true;
      room.lastEvent = `${active.name} exploded and was eliminated.`;
    } else {
      room.lastEvent = `${active.name} exploded and lost a life.`;
    }

    this.advanceTurn(room, active.id);
    room.updatedAt = Date.now();
  }

  private cleanupRooms(): void {
    const now = Date.now();

    for (const [roomCode, room] of this.rooms.entries()) {
      if (room.emptySince !== null && now - room.emptySince > EMPTY_ROOM_TTL_MS) {
        this.rooms.delete(roomCode);
      }
    }
  }

  private advanceTurn(room: RoomState, fromPlayerId: string | null): void {
    const eligible = this.getEligiblePlayers(room);

    if (eligible.length <= 1) {
      this.finishGame(room, eligible[0] ?? null);
      return;
    }

    const next = this.getNextEligiblePlayer(room, fromPlayerId);
    if (!next) {
      this.finishGame(room, eligible[0] ?? null);
      return;
    }

    room.activePlayerId = next.id;
    room.previousChunk = room.currentChunk;
    room.currentChunk = this.chooseChunk(room.previousChunk);
    room.timerEndsAt = Date.now() + room.config.turnSeconds * 1000;
  }

  private finishGame(room: RoomState, winner: PlayerState | null): void {
    room.phase = "results";
    room.winnerId = winner?.id ?? null;
    room.activePlayerId = null;
    room.currentChunk = null;
    room.timerEndsAt = null;
    room.updatedAt = Date.now();

    room.lastEvent = winner ? `${winner.name} wins the match.` : "Match ended.";
  }

  private chooseChunk(previousChunk: string | null): string {
    const pool = CHUNKS.filter((chunk) => chunk !== previousChunk);
    const source = pool.length > 0 ? pool : CHUNKS;
    return source[Math.floor(Math.random() * source.length)];
  }

  private getEligiblePlayers(room: RoomState): PlayerState[] {
    return room.players.filter((player) => player.connected && !player.eliminated);
  }

  private getNextEligiblePlayer(room: RoomState, fromPlayerId: string | null): PlayerState | null {
    const eligible = this.getEligiblePlayers(room);
    if (eligible.length === 0) {
      return null;
    }

    if (fromPlayerId === null) {
      return eligible[0];
    }

    const startIndex = room.players.findIndex((player) => player.id === fromPlayerId);
    if (startIndex === -1) {
      return eligible[0];
    }

    for (let offset = 1; offset <= room.players.length; offset += 1) {
      const index = (startIndex + offset) % room.players.length;
      const candidate = room.players[index];
      if (candidate.connected && !candidate.eliminated) {
        return candidate;
      }
    }

    return null;
  }

  private getPlayer(room: RoomState, playerId: string): PlayerState | undefined {
    return room.players.find((player) => player.id === playerId);
  }

  private ensureHostIsConnected(room: RoomState): void {
    const currentHost = this.getPlayer(room, room.hostId);
    if (currentHost?.connected) {
      return;
    }

    const nextHost = room.players.find((player) => player.connected);
    if (nextHost) {
      room.hostId = nextHost.id;
      room.lastEvent = `${nextHost.name} is now host.`;
    }
  }

  private bindSocketSession(socketId: string, roomCode: string, playerId: string): void {
    this.socketSessions.set(socketId, { roomCode, playerId });
  }

  private socketOwnsPlayer(socketId: string, roomCode: string, playerId: string): boolean {
    const session = this.socketSessions.get(socketId);
    return !!session && session.roomCode === roomCode && session.playerId === playerId;
  }

  private broadcastRoom(room: RoomState): void {
    const snapshot = this.serializeRoom(room);
    this.io.to(room.code).emit("room:update", snapshot);
    this.io.to(room.code).emit("game:state", snapshot);
  }

  private serializeRoom(room: RoomState): PublicRoomState {
    const remainingMs =
      room.phase === "in_game" && room.timerEndsAt
        ? Math.max(0, room.timerEndsAt - Date.now())
        : 0;

    return {
      roomCode: room.code,
      phase: room.phase,
      hostId: room.hostId,
      players: room.players.map((player) => ({
        id: player.id,
        name: player.name,
        connected: player.connected,
        score: player.score,
        lives: player.lives,
        eliminated: player.eliminated,
        joinedAt: player.joinedAt,
      })),
      config: {
        turnSeconds: room.config.turnSeconds,
        startingLives: room.config.startingLives,
        dictionaryEnabled: room.config.dictionaryEnabled,
      },
      activePlayerId: room.activePlayerId,
      currentChunk: room.currentChunk,
      remainingMs,
      usedWords: [...room.usedWordsOrdered],
      winnerId: room.winnerId,
      lastEvent: room.lastEvent,
      canStart: room.phase === "lobby" && room.players.filter((player) => player.connected).length >= 2,
      serverTime: Date.now(),
    };
  }
}
