import { Server } from "socket.io";
import { ChunkDescriptor, ChunkPool, Dictionary } from "./dictionary";
import {
  ChunkTier,
  PublicTypingState,
  PublicRoomState,
  RoomState,
  PlayerState,
  AckResponse,
  PlayerTypingPayload,
  UpdateSettingsPayload,
  SubmitWordPayload,
  PlayerActionPayload,
} from "./types";
import {
  clampInt,
  createPlayerId,
  createRoomCode,
  createSeededRandomState,
  nextSeededRandom,
  sanitizePlayerName,
  sanitizeRoomCode,
  sanitizeTypingPreview,
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
const TYPING_RATE_LIMIT_WINDOW_MS = 1000;
const MAX_TYPING_EVENTS_PER_WINDOW = 8;
const EMPTY_ROOM_TTL_MS = 5 * 60 * 1000;
const CHUNK_COOLDOWN_TURNS = 8;
const STAGE_TIER_ORDER: ChunkTier[] = ["veryEasy", "easy", "medium", "hard", "veryHard"];
const POST_VERY_HARD_TIER_WEIGHTS: Array<{ tier: ChunkTier; weight: number }> = [
  { tier: "medium", weight: 20 },
  { tier: "hard", weight: 40 },
  { tier: "veryHard", weight: 40 },
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

interface DifficultyTarget {
  stageIndex: number;
  targetTier: ChunkTier;
}

export class GameService {
  private readonly rooms = new Map<string, RoomState>();
  private readonly socketSessions = new Map<string, SocketSession>();
  private readonly lastSubmitAtBySocket = new Map<string, number>();
  private readonly typingEventTimesBySocket = new Map<string, number[]>();

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
      role: "player",
      joinedAt: Date.now(),
      socketId,
      connected: true,
      score: 0,
      lastWord: "",
      activeTurnCount: 0,
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
        showTypingPreviews: true,
        allowFourLetterChunks: false,
      },
      players: [host],
      usedWords: new Set<string>(),
      usedWordsOrdered: [],
      activePlayerId: null,
      currentChunk: null,
      currentChunkCoverage: null,
      currentChunkTier: null,
      globalDifficultyTier: null,
      globalStageIndex: 0,
      turnNumber: 0,
      turnDurationSeconds: 0,
      turnStartedAt: null,
      matchStartedAt: null,
      activePlayerCountAtMatchStart: 0,
      recentChunks: [],
      randomState: 1,
      winnerId: null,
      lastEvent: "Room created. Waiting for players.",
      activeTurnTyping: this.createActiveTurnTypingState(null),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      emptySince: null,
    };

    this.rooms.set(roomCode, room);
    this.bindSocketSession(socketId, roomCode, playerId);

    this.io.sockets.sockets.get(socketId)?.join(roomCode);
    this.emitTypingState(room, socketId);

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
      role: "player",
      joinedAt: Date.now(),
      socketId,
      connected: true,
      score: 0,
      lastWord: "",
      activeTurnCount: 0,
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
    this.emitTypingState(room, socketId);

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
        const resumedTurnNumber = room.turnNumber > 0 ? room.turnNumber : 1;
        if (!this.beginTurn(room, next.id, resumedTurnNumber)) {
          this.finishGame(room, next);
        }
      }
    }

    room.updatedAt = Date.now();
    this.broadcastRoom(room);
    this.emitTypingState(room);

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

    if (room.hostId !== payload.playerId) {
      return { ok: false, error: "Only the host can change settings." };
    }

    const hasLobbyOnlyUpdates =
      typeof payload.turnSeconds === "number" ||
      typeof payload.startingLives === "number" ||
      typeof payload.dictionaryEnabled === "boolean" ||
      typeof payload.allowFourLetterChunks === "boolean" ||
      typeof payload.hostSpectatorMode === "boolean";

    if (hasLobbyOnlyUpdates && room.phase !== "lobby") {
      return {
        ok: false,
        error:
          "Turn timer, lives, dictionary, chunk pool, and spectator mode can only be changed in lobby.",
      };
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

    if (typeof payload.showTypingPreviews === "boolean") {
      room.config.showTypingPreviews = payload.showTypingPreviews;
    }

    if (typeof payload.allowFourLetterChunks === "boolean") {
      room.config.allowFourLetterChunks = payload.allowFourLetterChunks;
    }

    if (typeof payload.hostSpectatorMode === "boolean") {
      this.setHostSpectatorMode(room, payload.hostSpectatorMode);
      room.lastEvent = payload.hostSpectatorMode
        ? "Host will spectate this match."
        : "Host rejoined the player rotation.";
    } else {
      room.lastEvent = "Host updated game settings.";
    }

    room.updatedAt = Date.now();

    this.broadcastRoom(room);
    if (typeof payload.showTypingPreviews === "boolean") {
      this.emitTypingState(room);
    }

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

    const connectedTurnPlayers = this.getConnectedTurnPlayers(room);
    if (connectedTurnPlayers.length < MIN_PLAYERS_TO_START) {
      return { ok: false, error: "Need at least 2 connected players in the turn rotation to start." };
    }

    room.phase = "in_game";
    room.usedWords.clear();
    room.usedWordsOrdered = [];
    room.winnerId = null;
    room.activePlayerId = null;
    room.currentChunk = null;
    room.currentChunkCoverage = null;
    room.currentChunkTier = null;
    room.globalDifficultyTier = null;
    room.globalStageIndex = 0;
    room.turnNumber = 0;
    room.turnDurationSeconds = 0;
    room.turnStartedAt = null;
    room.matchStartedAt = Date.now();
    room.activePlayerCountAtMatchStart = connectedTurnPlayers.length;
    room.recentChunks = [];
    room.randomState = createSeededRandomState(`${room.code}:${room.matchStartedAt}`);
    room.activeTurnTyping = this.createActiveTurnTypingState(null);

    for (const player of room.players) {
      player.score = 0;
      player.lastWord = "";
      player.activeTurnCount = 0;
      player.lives = player.role === "player" ? room.config.startingLives : 0;
      player.eliminated = false;
    }

    const firstActive = this.getNextEligiblePlayer(room, null);
    if (!firstActive) {
      room.phase = "lobby";
      room.matchStartedAt = null;
      room.activePlayerCountAtMatchStart = 0;
      return { ok: false, error: "No eligible players to start the game." };
    }

    if (!this.beginTurn(room, firstActive.id, 1)) {
      room.phase = "lobby";
      room.matchStartedAt = null;
      room.activePlayerCountAtMatchStart = 0;
      room.randomState = 1;
      return { ok: false, error: "Could not create a chunk pool for this match." };
    }

    room.lastEvent = `${firstActive.name} starts with the bomb.`;
    room.updatedAt = Date.now();

    this.broadcastRoom(room);
    this.emitTypingState(room);

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
    if (!player || !player.connected) {
      return { ok: false, error: "You are not an active player." };
    }

    if (player.role !== "player") {
      return { ok: false, error: "Spectators cannot submit words." };
    }

    if (player.eliminated) {
      return { ok: false, error: "You are out for this match." };
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
      return { ok: false, error: `Word must include chunk "${room.currentChunk}".` };
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
    player.lastWord = word.toUpperCase();
    room.lastEvent = `${player.name} played "${word}".`;

    this.advanceTurn(room, player.id);
    room.updatedAt = Date.now();

    this.broadcastRoom(room);
    this.emitTypingState(room);

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
    room.currentChunkCoverage = null;
    room.currentChunkTier = null;
    room.globalDifficultyTier = null;
    room.globalStageIndex = 0;
    room.turnNumber = 0;
    room.turnDurationSeconds = 0;
    room.turnStartedAt = null;
    room.matchStartedAt = null;
    room.activePlayerCountAtMatchStart = 0;
    room.recentChunks = [];
    room.randomState = 1;
    room.winnerId = null;
    room.usedWords.clear();
    room.usedWordsOrdered = [];
    room.activeTurnTyping = this.createActiveTurnTypingState(null);

    for (const player of room.players) {
      player.score = 0;
      player.lastWord = "";
      player.activeTurnCount = 0;
      player.lives = player.role === "player" ? room.config.startingLives : 0;
      player.eliminated = false;
    }

    room.lastEvent = "Match reset. Host can start a new game.";
    room.updatedAt = Date.now();

    this.broadcastRoom(room);
    this.emitTypingState(room);

    return { ok: true, state: this.serializeRoom(room) };
  }

  public handleTyping(socketId: string, payload: PlayerTypingPayload): void {
    const now = Date.now();
    if (!this.consumeTypingRateLimit(socketId, now)) {
      return;
    }

    const roomCode = sanitizeRoomCode(payload?.roomCode ?? "");
    const room = this.rooms.get(roomCode);
    if (!room || room.phase !== "in_game") {
      return;
    }

    const session = this.socketSessions.get(socketId);
    if (!session || session.roomCode !== roomCode) {
      return;
    }

    if (!room.activePlayerId || room.activePlayerId !== session.playerId) {
      return;
    }

    const player = this.getPlayer(room, session.playerId);
    if (!player || !player.connected || player.role !== "player" || player.eliminated) {
      return;
    }

    const preview = sanitizeTypingPreview(payload?.preview ?? "");
    const activePlayerId = room.activePlayerId;
    const hasChanged =
      room.activeTurnTyping.playerId !== activePlayerId ||
      !room.activeTurnTyping.isTyping ||
      room.activeTurnTyping.preview !== preview;

    if (!hasChanged) {
      return;
    }

    room.activeTurnTyping = {
      playerId: activePlayerId,
      preview,
      isTyping: true,
      updatedAt: now,
    };
    room.updatedAt = now;
    this.emitTypingState(room);
  }

  public handleDisconnect(socketId: string): void {
    const session = this.socketSessions.get(socketId);
    this.socketSessions.delete(socketId);
    this.lastSubmitAtBySocket.delete(socketId);
    this.typingEventTimesBySocket.delete(socketId);

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
    this.emitTypingState(room);
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

      if (!room.activePlayerId || room.turnStartedAt === null || room.turnDurationSeconds <= 0) {
        continue;
      }

      const now = Date.now();
      if (now >= this.getTurnEndsAt(room)) {
        this.handleTimerExpiry(room);
      }
    }
  }

  private handleTimerExpiry(room: RoomState): void {
    if (room.phase !== "in_game" || !room.activePlayerId) {
      return;
    }

    const active = this.getPlayer(room, room.activePlayerId);

    if (!active || !active.connected || active.role !== "player" || active.eliminated) {
      this.advanceTurn(room, room.activePlayerId);
      if (room.phase === "in_game") {
        room.lastEvent = "Bomb moved because active player was unavailable.";
      }
      room.updatedAt = Date.now();
      this.broadcastRoom(room);
      this.emitTypingState(room);
      return;
    }

    active.lives = Math.max(0, active.lives - 1);

    if (active.lives === 0) {
      active.lives = 0;
      active.eliminated = true;
      room.lastEvent = `${active.name} exploded and was eliminated.`;
    } else {
      room.lastEvent = `${active.name} exploded and lost a life.`;
    }

    this.advanceTurn(room, active.id);
    room.updatedAt = Date.now();
    this.broadcastRoom(room);
    this.emitTypingState(room);
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

    const nextTurnNumber = room.turnNumber + 1;
    if (!this.beginTurn(room, next.id, nextTurnNumber)) {
      this.finishGame(room, next);
    }
  }

  private finishGame(room: RoomState, winner: PlayerState | null): void {
    room.phase = "results";
    room.winnerId = winner?.id ?? null;
    room.activePlayerId = null;
    room.currentChunk = null;
    room.currentChunkCoverage = null;
    room.currentChunkTier = null;
    room.globalDifficultyTier = null;
    room.globalStageIndex = 0;
    room.turnNumber = 0;
    room.turnDurationSeconds = 0;
    room.turnStartedAt = null;
    room.matchStartedAt = null;
    room.activePlayerCountAtMatchStart = 0;
    room.recentChunks = [];
    room.randomState = 1;
    room.activeTurnTyping = this.createActiveTurnTypingState(null);
    room.updatedAt = Date.now();

    room.lastEvent = winner ? `${winner.name} wins the match.` : "Match ended.";
  }

  private beginTurn(room: RoomState, activePlayerId: string, turnNumber: number): boolean {
    const activePlayer = this.getPlayer(room, activePlayerId);
    if (!activePlayer || activePlayer.role !== "player") {
      return false;
    }

    const chunkPool = this.getChunkPool(room);
    if (chunkPool.poolSize === 0) {
      return false;
    }

    const difficultyTarget = this.getDifficultyTarget(room, activePlayer.id, chunkPool);
    const selectedChunk = this.selectNextChunk(room, chunkPool, difficultyTarget.targetTier);
    if (!selectedChunk) {
      return false;
    }

    activePlayer.activeTurnCount += 1;
    room.activePlayerId = activePlayerId;
    room.currentChunk = selectedChunk.chunk;
    room.currentChunkCoverage = selectedChunk.coverage;
    room.currentChunkTier = selectedChunk.tier;
    room.globalDifficultyTier = difficultyTarget.targetTier;
    room.globalStageIndex = difficultyTarget.stageIndex;
    room.turnNumber = turnNumber;
    room.turnDurationSeconds = this.computeTurnDurationSeconds(room, turnNumber);
    room.turnStartedAt = Date.now();
    room.recentChunks = [...room.recentChunks.slice(-(CHUNK_COOLDOWN_TURNS - 1)), selectedChunk.chunk];
    this.resetActiveTurnTyping(room, activePlayerId);

    return true;
  }

  private getDifficultyTarget(
    room: RoomState,
    incomingActivePlayerId: string,
    chunkPool: ChunkPool,
  ): DifficultyTarget {
    const divisor = Math.max(
      1,
      room.activePlayerCountAtMatchStart || this.getPlayersInRotation(room).length,
    );
    const totalActiveTurns = room.players.reduce((sum, player) => {
      if (player.role !== "player") {
        return sum;
      }

      return sum + player.activeTurnCount + (player.id === incomingActivePlayerId ? 1 : 0);
    }, 0);

    const stageIndex = Math.min(
      STAGE_TIER_ORDER.length - 1,
      Math.floor(totalActiveTurns / (2 * divisor)),
    );

    if (stageIndex < STAGE_TIER_ORDER.length - 1) {
      return {
        stageIndex,
        targetTier: STAGE_TIER_ORDER[stageIndex],
      };
    }

    return {
      stageIndex,
      targetTier: this.pickPostVeryHardTier(room, chunkPool),
    };
  }

  private pickPostVeryHardTier(room: RoomState, chunkPool: ChunkPool): ChunkTier {
    const weightedTiers = POST_VERY_HARD_TIER_WEIGHTS.filter(
      (entry) => chunkPool.tierChunks[entry.tier].length > 0,
    );

    if (weightedTiers.length === 0) {
      const fallbackTier = STAGE_TIER_ORDER.find((tier) => chunkPool.tierChunks[tier].length > 0);
      return fallbackTier ?? "medium";
    }

    const totalWeight = weightedTiers.reduce((sum, entry) => sum + entry.weight, 0);
    let roll = this.nextRandom(room) * totalWeight;

    for (const entry of weightedTiers) {
      if (roll < entry.weight) {
        return entry.tier;
      }

      roll -= entry.weight;
    }

    return weightedTiers[weightedTiers.length - 1].tier;
  }

  private selectNextChunk(
    room: RoomState,
    chunkPool: ChunkPool,
    targetTier: ChunkTier,
  ): ChunkDescriptor | null {
    const tiersToTry = [targetTier, ...this.getFallbackTierOrder(targetTier)];

    for (const tier of tiersToTry) {
      const descriptor = this.pickChunkFromTier(room, chunkPool, tier);
      if (descriptor) {
        return descriptor;
      }
    }

    return this.pickChunkFromPool(room, chunkPool);
  }

  private getFallbackTierOrder(primaryTier: ChunkTier): ChunkTier[] {
    const primaryIndex = STAGE_TIER_ORDER.indexOf(primaryTier);

    return STAGE_TIER_ORDER
      .filter((tier) => tier !== primaryTier)
      .sort((left, right) => {
        const leftDistance = Math.abs(STAGE_TIER_ORDER.indexOf(left) - primaryIndex);
        const rightDistance = Math.abs(STAGE_TIER_ORDER.indexOf(right) - primaryIndex);

        if (leftDistance !== rightDistance) {
          return leftDistance - rightDistance;
        }

        return STAGE_TIER_ORDER.indexOf(left) - STAGE_TIER_ORDER.indexOf(right);
      });
  }

  private pickChunkFromTier(
    room: RoomState,
    chunkPool: ChunkPool,
    tier: ChunkTier,
  ): ChunkDescriptor | null {
    const tierChunks = chunkPool.tierChunks[tier];
    if (tierChunks.length === 0) {
      return null;
    }

    const availableChunks = this.filterChunksByCooldown(tierChunks, room.recentChunks);
    if (availableChunks.length === 0) {
      return null;
    }

    const selectedChunk = availableChunks[Math.floor(this.nextRandom(room) * availableChunks.length)];
    return chunkPool.chunkMap.get(selectedChunk) ?? null;
  }

  private pickChunkFromPool(room: RoomState, chunkPool: ChunkPool): ChunkDescriptor | null {
    const allChunks = STAGE_TIER_ORDER.flatMap((tier) => chunkPool.tierChunks[tier]);
    const availableChunks = this.filterChunksByCooldown(allChunks, room.recentChunks);

    if (availableChunks.length === 0) {
      return null;
    }

    const selectedChunk = availableChunks[Math.floor(this.nextRandom(room) * availableChunks.length)];
    return chunkPool.chunkMap.get(selectedChunk) ?? null;
  }

  private filterChunksByCooldown(chunks: string[], recentChunks: string[]): string[] {
    if (chunks.length === 0) {
      return [];
    }

    const immediatePrevious = recentChunks[recentChunks.length - 1] ?? null;
    let cooldownWindow = recentChunks.slice(-CHUNK_COOLDOWN_TURNS);

    while (true) {
      const disallowed = new Set(cooldownWindow);
      if (immediatePrevious) {
        disallowed.add(immediatePrevious);
      }

      const available = chunks.filter((chunk) => !disallowed.has(chunk));
      if (available.length > 0) {
        return available;
      }

      if (cooldownWindow.length <= 1) {
        break;
      }

      cooldownWindow = cooldownWindow.slice(1);
    }

    return chunks.filter((chunk) => chunk !== immediatePrevious);
  }

  private computeTurnDurationSeconds(room: RoomState, turnNumber: number): number {
    return Math.max(
      MIN_TURN_SECONDS,
      room.config.turnSeconds - Math.floor((turnNumber - 1) / 3),
    );
  }

  private getTurnEndsAt(room: RoomState): number {
    return (room.turnStartedAt ?? 0) + room.turnDurationSeconds * 1000;
  }

  private getChunkPool(room: RoomState): ChunkPool {
    return this.dictionary.getChunkPool(room.config.allowFourLetterChunks);
  }

  private nextRandom(room: RoomState): number {
    const next = nextSeededRandom(room.randomState);
    room.randomState = next.state;
    return next.value;
  }

  private getPlayersInRotation(room: RoomState): PlayerState[] {
    return room.players.filter((player) => player.role === "player");
  }

  private getConnectedTurnPlayers(room: RoomState): PlayerState[] {
    return room.players.filter((player) => player.role === "player" && player.connected);
  }

  private getEligiblePlayers(room: RoomState): PlayerState[] {
    return room.players.filter(
      (player) => player.role === "player" && player.connected && !player.eliminated,
    );
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
      if (candidate.role === "player" && candidate.connected && !candidate.eliminated) {
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

    const nextHost =
      room.players.find((player) => player.connected && player.role === "player") ??
      room.players.find((player) => player.connected);
    if (nextHost) {
      room.hostId = nextHost.id;
      room.lastEvent = `${nextHost.name} is now host.`;
    }
  }

  private setHostSpectatorMode(room: RoomState, enabled: boolean): void {
    const host = this.getPlayer(room, room.hostId);
    if (!host) {
      return;
    }

    host.role = enabled ? "spectator" : "player";
    host.eliminated = false;
    host.lastWord = enabled ? "" : host.lastWord;
    host.lives = enabled ? 0 : room.config.startingLives;
  }

  private bindSocketSession(socketId: string, roomCode: string, playerId: string): void {
    this.socketSessions.set(socketId, { roomCode, playerId });
  }

  private createActiveTurnTypingState(playerId: string | null): RoomState["activeTurnTyping"] {
    return {
      playerId,
      preview: "",
      isTyping: false,
      updatedAt: Date.now(),
    };
  }

  private resetActiveTurnTyping(room: RoomState, playerId: string | null): void {
    room.activeTurnTyping = this.createActiveTurnTypingState(playerId);
  }

  private consumeTypingRateLimit(socketId: string, now: number): boolean {
    const recentEvents = (this.typingEventTimesBySocket.get(socketId) ?? []).filter(
      (timestamp) => now - timestamp < TYPING_RATE_LIMIT_WINDOW_MS,
    );

    if (recentEvents.length >= MAX_TYPING_EVENTS_PER_WINDOW) {
      this.typingEventTimesBySocket.set(socketId, recentEvents);
      return false;
    }

    recentEvents.push(now);
    this.typingEventTimesBySocket.set(socketId, recentEvents);
    return true;
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

  private emitTypingState(room: RoomState, target: string = room.code): void {
    this.io.to(target).emit("room:typingState", this.serializeTypingState(room));
  }

  private serializeRoom(room: RoomState): PublicRoomState {
    const remainingMs =
      room.phase === "in_game" && room.turnStartedAt !== null
        ? Math.max(0, this.getTurnEndsAt(room) - Date.now())
        : 0;

    return {
      roomCode: room.code,
      phase: room.phase,
      hostId: room.hostId,
      players: room.players.map((player) => ({
        id: player.id,
        name: player.name,
        role: player.role,
        connected: player.connected,
        score: player.score,
        lastWord: player.lastWord,
        activeTurnCount: player.activeTurnCount,
        lives: player.lives,
        eliminated: player.eliminated,
        joinedAt: player.joinedAt,
      })),
      config: {
        turnSeconds: room.config.turnSeconds,
        startingLives: room.config.startingLives,
        dictionaryEnabled: room.config.dictionaryEnabled,
        showTypingPreviews: room.config.showTypingPreviews,
        allowFourLetterChunks: room.config.allowFourLetterChunks,
      },
      activePlayerId: room.activePlayerId,
      currentChunk: room.currentChunk,
      currentChunkCoverage: room.currentChunkCoverage,
      currentChunkTier: room.currentChunkTier,
      globalDifficultyTier: room.globalDifficultyTier,
      globalStageIndex: room.globalStageIndex,
      turnNumber: room.turnNumber,
      turnDurationSeconds: room.turnDurationSeconds,
      remainingMs,
      usedWords: room.usedWordsOrdered.map((word) => word.toLowerCase()),
      winnerId: room.winnerId,
      lastEvent: room.lastEvent,
      canStart: room.phase === "lobby" && this.getConnectedTurnPlayers(room).length >= MIN_PLAYERS_TO_START,
      serverTime: Date.now(),
    };
  }

  private serializeTypingState(room: RoomState): PublicTypingState {
    const canShowPreviewText = room.phase === "in_game" && room.config.showTypingPreviews;

    return {
      activePlayerId: room.activeTurnTyping.playerId ?? room.activePlayerId,
      isTyping: room.activeTurnTyping.isTyping,
      text: canShowPreviewText ? room.activeTurnTyping.preview : "",
    };
  }
}
