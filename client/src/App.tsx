import { FormEvent, RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { socket } from "./socket";
import {
  AckResponse,
  PublicPlayerState,
  PublicRoomState,
  RoomConfig,
  Session,
  TypingState,
} from "./types";

const SESSION_KEY = "word-fuse-session";

function loadStoredSession(): Session | null {
  const raw = localStorage.getItem(SESSION_KEY);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Session;
    if (!parsed.roomCode || !parsed.playerId || !parsed.name) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function saveStoredSession(session: Session): void {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

function clearStoredSession(): void {
  localStorage.removeItem(SESSION_KEY);
}

function statusLabel(status: ConnectionStatus): string {
  if (status === "connected") {
    return "Connected";
  }

  if (status === "connecting") {
    return "Connecting";
  }

  if (status === "reconnecting") {
    return "Reconnecting";
  }

  return "Offline";
}

function sortedScoreboard(players: PublicPlayerState[]): PublicPlayerState[] {
  return [...players].sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    if (b.lives !== a.lives) {
      return b.lives - a.lives;
    }
    return a.joinedAt - b.joinedAt;
  });
}

function normalizeWordForSubmit(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim()
    .toLowerCase();
}

function normalizeTypingPreview(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[^A-Za-z]/g, "")
    .toUpperCase()
    .slice(0, 24);
}

function createBlankTypingState(activePlayerId: string | null = null): TypingState {
  return {
    activePlayerId,
    isTyping: false,
    text: "",
  };
}

const MIN_ERROR_DISPLAY_MS = 3000;
const LONG_DISPLAY_ERRORS = new Set([
  "Word not found in dictionary.",
  "Word already used in this match.",
]);
const TYPING_THROTTLE_MS = 125;

type ConnectionStatus = "connecting" | "connected" | "reconnecting" | "disconnected";

interface HomeViewProps {
  createName: string;
  joinName: string;
  joinCode: string;
  onCreateName: (value: string) => void;
  onJoinName: (value: string) => void;
  onJoinCode: (value: string) => void;
  onCreateRoom: (event: FormEvent) => void;
  onJoinRoom: (event: FormEvent) => void;
}

function HomeView(props: HomeViewProps): JSX.Element {
  return (
    <section className="view-card">
      <h2>Play Word Fuse</h2>
      <p className="subtitle">Create a room or join with a room code.</p>

      <div className="home-grid">
        <form className="panel" onSubmit={props.onCreateRoom}>
          <h3>Create Room</h3>
          <label>
            Display Name
            <input
              value={props.createName}
              onChange={(event) => props.onCreateName(event.target.value)}
              maxLength={20}
              placeholder="Your name"
              required
            />
          </label>
          <button type="submit">Create</button>
        </form>

        <form className="panel" onSubmit={props.onJoinRoom}>
          <h3>Join Room</h3>
          <label>
            Room Code
            <input
              value={props.joinCode}
              onChange={(event) => props.onJoinCode(event.target.value.toUpperCase())}
              maxLength={6}
              placeholder="ABC123"
              required
            />
          </label>
          <label>
            Display Name
            <input
              value={props.joinName}
              onChange={(event) => props.onJoinName(event.target.value)}
              maxLength={20}
              placeholder="Your name"
              required
            />
          </label>
          <button type="submit">Join</button>
        </form>
      </div>
    </section>
  );
}

interface LobbyViewProps {
  session: Session;
  roomState: PublicRoomState;
  isHost: boolean;
  onStart: () => void;
  onUpdateSettings: (settings: Partial<RoomConfig>) => void;
  onLeave: () => void;
}

function LobbyView(props: LobbyViewProps): JSX.Element {
  return (
    <section className="view-card">
      <div className="header-row">
        <h2>Lobby</h2>
        <div className="room-code">Room: {props.roomState.roomCode}</div>
      </div>

      <p className="subtitle">Share this room code so players can join.</p>

      <div className="panel-group">
        <div className="panel">
          <h3>Players</h3>
          <ul className="player-list">
            {props.roomState.players.map((player) => (
              <li key={player.id} className="player-row">
                <div>
                  <span className="player-name">{player.name}</span>
                  {player.id === props.session.playerId ? <span className="tag">You</span> : null}
                  {player.id === props.roomState.hostId ? <span className="tag host">Host</span> : null}
                </div>
                <span className={player.connected ? "status online" : "status offline"}>
                  {player.connected ? "Online" : "Offline"}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="panel">
          <h3>Settings</h3>

          <label>
            Turn Timer: <strong>{props.roomState.config.turnSeconds}s</strong>
            <input
              type="range"
              min={5}
              max={20}
              value={props.roomState.config.turnSeconds}
              disabled={!props.isHost}
              onChange={(event) =>
                props.onUpdateSettings({ turnSeconds: Number.parseInt(event.target.value, 10) })
              }
            />
          </label>

          <label>
            Starting Lives: <strong>{props.roomState.config.startingLives}</strong>
            <input
              type="range"
              min={1}
              max={5}
              value={props.roomState.config.startingLives}
              disabled={!props.isHost}
              onChange={(event) =>
                props.onUpdateSettings({ startingLives: Number.parseInt(event.target.value, 10) })
              }
            />
          </label>

          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={props.roomState.config.dictionaryEnabled}
              disabled={!props.isHost}
              onChange={(event) =>
                props.onUpdateSettings({ dictionaryEnabled: event.target.checked })
              }
            />
            Dictionary validation enabled
          </label>

          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={props.roomState.config.showTypingPreviews}
              disabled={!props.isHost}
              onChange={(event) =>
                props.onUpdateSettings({ showTypingPreviews: event.target.checked })
              }
            />
            Show live typing previews
          </label>

          {props.isHost ? (
            <button type="button" onClick={props.onStart} disabled={!props.roomState.canStart}>
              Start Game
            </button>
          ) : (
            <p className="small-note">Waiting for host to start the game.</p>
          )}

          <button type="button" className="secondary" onClick={props.onLeave}>
            Leave Room
          </button>
        </div>
      </div>
    </section>
  );
}

interface GameViewProps {
  session: Session;
  roomState: PublicRoomState;
  typingState: TypingState;
  wordDraft: string;
  onWordDraft: (value: string) => void;
  onSubmitWord: (event: FormEvent) => void;
  onToggleTypingPreviews: (enabled: boolean) => void;
  canSubmit: boolean;
  isHost: boolean;
  isYourTurn: boolean;
  wordInputRef: RefObject<HTMLInputElement>;
  onLeave: () => void;
}

function GameView(props: GameViewProps): JSX.Element {
  const activePlayer = props.roomState.players.find(
    (player) => player.id === props.roomState.activePlayerId,
  );
  const typingPlayer = props.roomState.players.find(
    (player) => player.id === (props.typingState.activePlayerId ?? props.roomState.activePlayerId),
  );
  const secondsLeft = Math.max(0, Math.ceil(props.roomState.remainingMs / 1000));
  const liveAttemptPreview = props.typingState.text || "...";

  return (
    <section className="view-card">
      <div className="header-row">
        <h2>Game</h2>
        <div className="room-code">Room: {props.roomState.roomCode}</div>
      </div>

      {props.isYourTurn ? (
        <div className="turn-callout" role="status" aria-live="polite">
          <span className="turn-callout-mark">GO!</span>
          <span>Your Turn</span>
        </div>
      ) : null}

      <div className={props.isYourTurn ? "bomb-area active-turn" : "bomb-area"}>
        <div className="chunk">{props.roomState.currentChunk ?? "--"}</div>
        <div className={secondsLeft <= 3 ? "timer danger" : "timer"}>{secondsLeft}s</div>
        <div className="active-player">Active: {activePlayer?.name ?? "Waiting"}</div>
      </div>

      <div
        className={
          props.typingState.isTyping
            ? props.roomState.config.showTypingPreviews
              ? "typing-status"
              : "typing-status preview-hidden"
            : "typing-status idle"
        }
        aria-live="polite"
      >
        <div className="typing-label">Live Attempt</div>
        {props.typingState.isTyping && typingPlayer ? (
          props.roomState.config.showTypingPreviews ? (
            <>
              <div className="typing-copy">{typingPlayer.name} typing:</div>
              <div className="typing-preview">{liveAttemptPreview}</div>
            </>
          ) : (
            <div className="typing-copy">{typingPlayer.name} is typing...</div>
          )
        ) : (
          <div className="typing-copy subtle">Waiting for input...</div>
        )}
      </div>

      <form className="word-form" onSubmit={props.onSubmitWord}>
        <input
          ref={props.wordInputRef}
          className={props.canSubmit ? "turn-input" : ""}
          value={props.wordDraft}
          onChange={(event) => props.onWordDraft(event.target.value)}
          maxLength={30}
          placeholder={props.canSubmit ? "Type a word" : "Type to practice while you wait"}
          autoCapitalize="none"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
        />
        <button type="submit" disabled={!props.canSubmit || props.wordDraft.trim().length === 0}>
          Submit
        </button>
      </form>

      <div className="panel-group">
        <div className="panel">
          <h3>Scoreboard</h3>
          <ul className="player-list">
            {sortedScoreboard(props.roomState.players).map((player) => (
              <li key={player.id} className="player-row">
                <div>
                  <span className="player-name">{player.name}</span>
                  {player.id === props.session.playerId ? <span className="tag">You</span> : null}
                  {player.id === props.roomState.activePlayerId ? <span className="tag active">Bomb</span> : null}
                  {player.eliminated ? <span className="tag eliminated">Out</span> : null}
                </div>
                <span>
                  {player.score} pts | {player.lives} lives
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="panel">
          {props.isHost ? (
            <label className="checkbox-row typing-settings">
              <input
                type="checkbox"
                checked={props.roomState.config.showTypingPreviews}
                onChange={(event) => props.onToggleTypingPreviews(event.target.checked)}
              />
              Show live typing previews
            </label>
          ) : (
            <p className="small-note">
              Typing previews: {props.roomState.config.showTypingPreviews ? "On" : "Hidden"}
            </p>
          )}

          <h3>Used Words ({props.roomState.usedWords.length})</h3>
          <div className="used-words">
            {props.roomState.usedWords.length === 0 ? (
              <p className="small-note">No words yet.</p>
            ) : (
              props.roomState.usedWords
                .slice()
                .reverse()
                .map((word, index) => (
                  <div key={`${word}-${index}`} className="used-word-item">
                    {word}
                  </div>
                ))
            )}
          </div>
          <button type="button" className="secondary" onClick={props.onLeave}>
            Leave Room
          </button>
        </div>
      </div>
    </section>
  );
}

interface ResultsViewProps {
  session: Session;
  roomState: PublicRoomState;
  isHost: boolean;
  onPlayAgain: () => void;
  onLeave: () => void;
}

function ResultsView(props: ResultsViewProps): JSX.Element {
  const winner = props.roomState.players.find((player) => player.id === props.roomState.winnerId);

  return (
    <section className="view-card">
      <div className="header-row">
        <h2>Results</h2>
        <div className="room-code">Room: {props.roomState.roomCode}</div>
      </div>

      <div className="winner-box">
        <p className="subtitle">Winner</p>
        <h3>{winner?.name ?? "No winner"}</h3>
      </div>

      <div className="panel">
        <h3>Final Scoreboard</h3>
        <ul className="player-list">
          {sortedScoreboard(props.roomState.players).map((player) => (
            <li key={player.id} className="player-row">
              <div>
                <span className="player-name">{player.name}</span>
                {player.id === props.session.playerId ? <span className="tag">You</span> : null}
              </div>
              <span>
                {player.score} pts | {player.lives} lives
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="actions-row">
        {props.isHost ? (
          <button type="button" onClick={props.onPlayAgain}>
            Play Again
          </button>
        ) : (
          <p className="small-note">Waiting for host to reset the match.</p>
        )}
        <button type="button" className="secondary" onClick={props.onLeave}>
          Leave Room
        </button>
      </div>
    </section>
  );
}

export default function App(): JSX.Element {
  const [session, setSession] = useState<Session | null>(() => loadStoredSession());
  const [roomState, setRoomState] = useState<PublicRoomState | null>(null);
  const [typingState, setTypingState] = useState<TypingState>(() => createBlankTypingState());
  const [createName, setCreateName] = useState("");
  const [joinName, setJoinName] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [wordDraft, setWordDraft] = useState("");
  const [error, setError] = useState("");
  const wordInputRef = useRef<HTMLInputElement>(null);
  const errorMinVisibleUntilRef = useRef(0);
  const errorClearTimeoutRef = useRef<number | null>(null);
  const sessionRef = useRef<Session | null>(session);
  const roomStateRef = useRef<PublicRoomState | null>(roomState);
  const canBroadcastTypingRef = useRef(false);
  const lastTypingSentAtRef = useRef(0);
  const pendingTypingPreviewRef = useRef<string | null>(null);
  const typingSendTimeoutRef = useRef<number | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>(
    socket.connected ? "connected" : "connecting",
  );

  const saveSession = useCallback((next: Session | null) => {
    setSession(next);
    if (next) {
      saveStoredSession(next);
    } else {
      clearStoredSession();
    }
  }, []);

  const clearScheduledErrorClear = useCallback((): void => {
    if (errorClearTimeoutRef.current !== null) {
      window.clearTimeout(errorClearTimeoutRef.current);
      errorClearTimeoutRef.current = null;
    }
  }, []);

  const clearError = useCallback(
    (force = false): void => {
      if (!force && Date.now() < errorMinVisibleUntilRef.current) {
        return;
      }

      clearScheduledErrorClear();
      errorMinVisibleUntilRef.current = 0;
      setError("");
    },
    [clearScheduledErrorClear],
  );

  const showError = useCallback(
    (message: string): void => {
      setError(message);

      if (!LONG_DISPLAY_ERRORS.has(message)) {
        errorMinVisibleUntilRef.current = 0;
        clearScheduledErrorClear();
        return;
      }

      errorMinVisibleUntilRef.current = Date.now() + MIN_ERROR_DISPLAY_MS;
      clearScheduledErrorClear();

      errorClearTimeoutRef.current = window.setTimeout(() => {
        if (Date.now() >= errorMinVisibleUntilRef.current) {
          setError("");
          errorMinVisibleUntilRef.current = 0;
          errorClearTimeoutRef.current = null;
        }
      }, MIN_ERROR_DISPLAY_MS);
    },
    [clearScheduledErrorClear],
  );

  const clearPendingTypingSend = useCallback((): void => {
    if (typingSendTimeoutRef.current !== null) {
      window.clearTimeout(typingSendTimeoutRef.current);
      typingSendTimeoutRef.current = null;
    }
    pendingTypingPreviewRef.current = null;
  }, []);

  const flushPendingTypingPreview = useCallback((): void => {
    if (typingSendTimeoutRef.current !== null) {
      window.clearTimeout(typingSendTimeoutRef.current);
      typingSendTimeoutRef.current = null;
    }

    const nextPreview = pendingTypingPreviewRef.current;
    pendingTypingPreviewRef.current = null;

    if (!nextPreview || !canBroadcastTypingRef.current || !sessionRef.current || !roomStateRef.current) {
      if (nextPreview === "") {
        if (
          canBroadcastTypingRef.current &&
          sessionRef.current &&
          roomStateRef.current
        ) {
          socket.emit("player:typing", {
            roomCode: sessionRef.current.roomCode,
            preview: nextPreview,
          });
          lastTypingSentAtRef.current = Date.now();
        }
      }
      return;
    }

    socket.emit("player:typing", {
      roomCode: sessionRef.current.roomCode,
      preview: nextPreview,
    });
    lastTypingSentAtRef.current = Date.now();
  }, []);

  const queueTypingPreview = useCallback(
    (preview: string): void => {
      if (!canBroadcastTypingRef.current || !sessionRef.current || !roomStateRef.current) {
        return;
      }

      pendingTypingPreviewRef.current = preview;

      const elapsed = Date.now() - lastTypingSentAtRef.current;
      if (elapsed >= TYPING_THROTTLE_MS) {
        flushPendingTypingPreview();
        return;
      }

      if (typingSendTimeoutRef.current !== null) {
        window.clearTimeout(typingSendTimeoutRef.current);
      }

      typingSendTimeoutRef.current = window.setTimeout(() => {
        flushPendingTypingPreview();
      }, TYPING_THROTTLE_MS - elapsed);
    },
    [flushPendingTypingPreview],
  );

  useEffect(() => {
    return () => {
      clearScheduledErrorClear();
      clearPendingTypingSend();
    };
  }, [clearPendingTypingSend, clearScheduledErrorClear]);

  const attemptReconnect = useCallback(
    (targetSession: Session | null) => {
      if (!targetSession) {
        return;
      }

      socket.emit(
        "room:reconnect",
        {
          roomCode: targetSession.roomCode,
          playerId: targetSession.playerId,
          name: targetSession.name,
        },
        (response: AckResponse) => {
          if (response.ok && response.state) {
            setRoomState(response.state);
            setTypingState(createBlankTypingState(response.state.activePlayerId));
            clearError(true);
          } else {
            saveSession(null);
            setRoomState(null);
            setTypingState(createBlankTypingState());
            if (response.error) {
              showError(response.error);
            }
          }
        },
      );
    },
    [clearError, saveSession, showError],
  );

  useEffect(() => {
    const onConnect = (): void => {
      setConnectionStatus("connected");
      attemptReconnect(loadStoredSession());
    };

    const onDisconnect = (): void => {
      setConnectionStatus("reconnecting");
    };

    const onReconnectAttempt = (): void => {
      setConnectionStatus("reconnecting");
    };

    const onReconnectFailed = (): void => {
      setConnectionStatus("disconnected");
    };

    const onRoomUpdate = (state: PublicRoomState): void => {
      setRoomState(state);
      clearError();
    };

    const onTypingState = (nextTypingState: TypingState): void => {
      setTypingState(nextTypingState);
    };

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("room:update", onRoomUpdate);
    socket.on("room:typingState", onTypingState);
    socket.io.on("reconnect_attempt", onReconnectAttempt);
    socket.io.on("reconnect_failed", onReconnectFailed);

    if (socket.connected) {
      onConnect();
    }

    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("room:update", onRoomUpdate);
      socket.off("room:typingState", onTypingState);
      socket.io.off("reconnect_attempt", onReconnectAttempt);
      socket.io.off("reconnect_failed", onReconnectFailed);
    };
  }, [attemptReconnect, clearError]);

  const me = useMemo(() => {
    if (!roomState || !session) {
      return null;
    }
    return roomState.players.find((player) => player.id === session.playerId) ?? null;
  }, [roomState, session]);

  const isHost = !!(roomState && session && roomState.hostId === session.playerId);
  const canSubmit =
    !!roomState &&
    !!session &&
    roomState.phase === "in_game" &&
    roomState.activePlayerId === session.playerId &&
    connectionStatus === "connected" &&
    !me?.eliminated;

  useEffect(() => {
    sessionRef.current = session;
    roomStateRef.current = roomState;
    canBroadcastTypingRef.current = canSubmit;
  }, [canSubmit, roomState, session]);

  useEffect(() => {
    if (!roomState || roomState.phase !== "in_game") {
      setTypingState(createBlankTypingState());
      return;
    }

    setTypingState((current) =>
      current.activePlayerId === roomState.activePlayerId
        ? current
        : createBlankTypingState(roomState.activePlayerId),
    );
  }, [roomState?.activePlayerId, roomState?.phase]);

  useEffect(() => {
    if (canSubmit) {
      return;
    }

    clearPendingTypingSend();
  }, [canSubmit, clearPendingTypingSend]);

  useEffect(() => {
    if (!canSubmit) {
      return;
    }

    const focusId = window.setTimeout(() => {
      wordInputRef.current?.focus();
      wordInputRef.current?.select();
    }, 0);

    return () => {
      window.clearTimeout(focusId);
    };
  }, [canSubmit, roomState?.activePlayerId]);

  const createOrJoinSessionFromAck = (response: AckResponse, fallbackName: string): void => {
    if (!response.ok || !response.roomCode || !response.playerId || !response.state) {
      showError(response.error ?? "Unable to join room.");
      return;
    }

    const ownPlayer = response.state.players.find((player) => player.id === response.playerId);

    const nextSession: Session = {
      roomCode: response.roomCode,
      playerId: response.playerId,
      name: ownPlayer?.name ?? fallbackName.trim(),
    };

    saveSession(nextSession);
    setRoomState(response.state);
    setTypingState(createBlankTypingState(response.state.activePlayerId));
    clearError(true);
    setWordDraft("");
  };

  const handleCreateRoom = (event: FormEvent): void => {
    event.preventDefault();
    clearError(true);

    socket.emit("room:create", { name: createName }, (response: AckResponse) => {
      createOrJoinSessionFromAck(response, createName);
      if (response.ok) {
        setCreateName("");
      }
    });
  };

  const handleJoinRoom = (event: FormEvent): void => {
    event.preventDefault();
    clearError(true);

    socket.emit(
      "room:join",
      {
        roomCode: joinCode,
        name: joinName,
      },
      (response: AckResponse) => {
        createOrJoinSessionFromAck(response, joinName);
      },
    );
  };

  const handleUpdateSettings = (settings: Partial<RoomConfig>): void => {
    if (!session || !roomState) {
      return;
    }

    socket.emit(
      "room:updateSettings",
      {
        roomCode: session.roomCode,
        playerId: session.playerId,
        ...settings,
      },
      (response: AckResponse) => {
        if (!response.ok) {
          showError(response.error ?? "Could not update settings.");
        }
      },
    );
  };

  const handleWordDraftChange = (value: string): void => {
    setWordDraft(value);

    if (!canSubmit) {
      return;
    }

    queueTypingPreview(normalizeTypingPreview(value));
  };

  const handleStartGame = (): void => {
    if (!session) {
      return;
    }

    socket.emit(
      "game:start",
      {
        roomCode: session.roomCode,
        playerId: session.playerId,
      },
      (response: AckResponse) => {
        if (!response.ok) {
          showError(response.error ?? "Could not start game.");
        }
      },
    );
  };

  const handleSubmitWord = (event: FormEvent): void => {
    event.preventDefault();
    if (!session || !canSubmit) {
      return;
    }

    const word = normalizeWordForSubmit(wordDraft);
    setWordDraft("");
    queueTypingPreview("");

    if (!word) {
      wordInputRef.current?.focus();
      return;
    }

    socket.emit(
      "turn:submitWord",
      {
        roomCode: session.roomCode,
        playerId: session.playerId,
        word,
      },
      (response: AckResponse) => {
        if (!response.ok) {
          showError(response.error ?? "Word rejected.");
          wordInputRef.current?.focus();
          return;
        }

        clearError(true);
      },
    );
  };

  const handlePlayAgain = (): void => {
    if (!session) {
      return;
    }

    socket.emit(
      "game:playAgain",
      {
        roomCode: session.roomCode,
        playerId: session.playerId,
      },
      (response: AckResponse) => {
        if (!response.ok) {
          showError(response.error ?? "Could not reset match.");
        }
      },
    );
  };

  const handleLeaveRoom = (): void => {
    saveSession(null);
    setRoomState(null);
    setTypingState(createBlankTypingState());
    clearError(true);
    clearPendingTypingSend();
    setWordDraft("");
    setJoinCode("");

    socket.disconnect();
    socket.connect();
    setConnectionStatus("connecting");
  };

  return (
    <div className={`app-shell ${canSubmit ? "your-turn-active" : ""}`}>
      <header className="app-header">
        <div className="title-wrap">
          <div className="island-chip">University of Guam Island Edition</div>
          <h1>Word Fuse</h1>
          <p className="subtitle">Fast multiplayer word survival.</p>
        </div>
        <div className={`connection-pill ${connectionStatus}`}>{statusLabel(connectionStatus)}</div>
      </header>

      {connectionStatus !== "connected" ? (
        <div className="banner warning">Reconnecting to server...</div>
      ) : null}

      {roomState?.lastEvent ? <div className="banner info">{roomState.lastEvent}</div> : null}
      {error ? <div className="banner error">{error}</div> : null}

      {!session ? (
        <HomeView
          createName={createName}
          joinName={joinName}
          joinCode={joinCode}
          onCreateName={setCreateName}
          onJoinName={setJoinName}
          onJoinCode={setJoinCode}
          onCreateRoom={handleCreateRoom}
          onJoinRoom={handleJoinRoom}
        />
      ) : null}

      {session && !roomState ? (
        <section className="view-card">
          <h2>Reconnecting</h2>
          <p className="subtitle">Trying to reconnect you to room {session.roomCode}.</p>
          <button type="button" className="secondary" onClick={handleLeaveRoom}>
            Clear Session
          </button>
        </section>
      ) : null}

      {session && roomState && roomState.phase === "lobby" ? (
        <LobbyView
          session={session}
          roomState={roomState}
          isHost={isHost}
          onStart={handleStartGame}
          onUpdateSettings={handleUpdateSettings}
          onLeave={handleLeaveRoom}
        />
      ) : null}

      {session && roomState && roomState.phase === "in_game" ? (
        <GameView
          session={session}
          roomState={roomState}
          typingState={typingState}
          wordDraft={wordDraft}
          onWordDraft={handleWordDraftChange}
          onSubmitWord={handleSubmitWord}
          onToggleTypingPreviews={(showTypingPreviews) =>
            handleUpdateSettings({ showTypingPreviews })
          }
          canSubmit={canSubmit}
          isHost={isHost}
          isYourTurn={canSubmit}
          wordInputRef={wordInputRef}
          onLeave={handleLeaveRoom}
        />
      ) : null}

      {session && roomState && roomState.phase === "results" ? (
        <ResultsView
          session={session}
          roomState={roomState}
          isHost={isHost}
          onPlayAgain={handlePlayAgain}
          onLeave={handleLeaveRoom}
        />
      ) : null}
    </div>
  );
}
