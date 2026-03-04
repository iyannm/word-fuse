import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ClipboardPaste,
  Copy,
  Crown,
  Eye,
  EyeOff,
  Heart,
  Link2,
  MonitorPlay,
  Palmtree,
  RadioTower,
  Shield,
  Skull,
  Sparkles,
  Swords,
  TimerReset,
  Users,
  Waves,
  Zap,
} from "lucide-react";
import { FormEvent, RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import { socket } from "./socket";
import {
  AckResponse,
  ChunkTier,
  PublicPlayerState,
  PublicRoomState,
  RoomConfig,
  Session,
  TypingState,
} from "./types";

const SESSION_KEY = "word-fuse-session";
const MIN_ERROR_DISPLAY_MS = 3000;
const LONG_DISPLAY_ERRORS = new Set([
  "Word not found in dictionary.",
  "Word already used in this match.",
]);
const TYPING_THROTTLE_MS = 125;
const MOTION_FEEDBACK_MS = 420;
const BOOM_FEEDBACK_MS = 520;
const WORD_FLASH_MS = 320;

type RoomSettingsUpdate = Partial<RoomConfig> & { hostSpectatorMode?: boolean };
type ConnectionStatus = "connecting" | "connected" | "reconnecting" | "disconnected";

const TIER_LABELS: Record<ChunkTier, string> = {
  veryEasy: "Very Easy",
  easy: "Easy",
  medium: "Medium",
  hard: "Hard",
  veryHard: "Very Hard",
};

function sanitizeRoomCodeInput(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
}

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

function isPlayerOut(player: PublicPlayerState | null | undefined): boolean {
  return !!player && player.role === "player" && (player.eliminated || player.lives <= 0);
}

function orderedScoreboardPlayers(players: PublicPlayerState[]): PublicPlayerState[] {
  return [...players].sort((a, b) => {
    if (a.role !== b.role) {
      return a.role === "player" ? -1 : 1;
    }

    const aOut = isPlayerOut(a);
    const bOut = isPlayerOut(b);
    if (aOut !== bOut) {
      return aOut ? 1 : -1;
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

function formatCoverageK(value: number | null): string {
  return `${Math.round((value ?? 0) / 1000)}k`;
}

function loadJoinCodeFromUrl(): string {
  const params = new URLSearchParams(window.location.search);
  return sanitizeRoomCodeInput(params.get("room") ?? "");
}

function buildJoinUrl(roomCode: string): string {
  const url = new URL(window.location.href);
  url.searchParams.set("room", roomCode);
  return url.toString();
}

function extractRoomCodeFromText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }

  const directCode = sanitizeRoomCodeInput(trimmed);
  if (directCode.length === 6) {
    return directCode;
  }

  try {
    const url = new URL(trimmed);
    return sanitizeRoomCodeInput(url.searchParams.get("room") ?? "");
  } catch {
    const queryMatch = trimmed.match(/[?&]room=([a-z0-9]{1,6})/i);
    return sanitizeRoomCodeInput(queryMatch?.[1] ?? "");
  }
}

function playerInitials(name: string): string {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");

  return initials || "WF";
}

function formatTurnOwner(name: string): string {
  return name.endsWith("s") ? `${name}' turn` : `${name}'s turn`;
}

interface BannerProps {
  message: string;
  tone: "info" | "warning" | "error" | "success";
}

function Banner(props: BannerProps): JSX.Element {
  const toneMap = {
    info: {
      className: "border-neonCyan/30 bg-neonCyan/10 text-neonCyan",
      icon: Sparkles,
      role: "status" as const,
    },
    warning: {
      className: "border-sunsetOrange/40 bg-sunsetOrange/10 text-sunsetOrange",
      icon: RadioTower,
      role: "status" as const,
    },
    error: {
      className: "border-danger/45 bg-danger/10 text-danger",
      icon: AlertTriangle,
      role: "alert" as const,
    },
    success: {
      className: "border-success/45 bg-success/10 text-success",
      icon: CheckCircle2,
      role: "status" as const,
    },
  }[props.tone];

  const Icon = toneMap.icon;

  return (
    <div
      className={`card flex items-center gap-3 px-4 py-3 ${toneMap.className}`}
      role={toneMap.role}
      aria-live={props.tone === "error" ? "assertive" : "polite"}
    >
      <div className="flex size-10 shrink-0 items-center justify-center rounded-2xl border border-current/20 bg-black/10">
        <Icon className="size-5" aria-hidden="true" />
      </div>
      <p className="text-sm font-medium text-sand">{props.message}</p>
    </div>
  );
}

function ConnectionPill(props: { status: ConnectionStatus }): JSX.Element {
  const styles = {
    connected: "border-success/40 bg-success/10 text-success",
    connecting: "border-white/15 bg-white/10 text-sand/75",
    reconnecting: "border-sunsetOrange/40 bg-sunsetOrange/10 text-sunsetOrange",
    disconnected: "border-danger/40 bg-danger/10 text-danger",
  }[props.status];

  return (
    <div className={`badge ${styles}`}>
      <RadioTower className="size-3.5" aria-hidden="true" />
      {statusLabel(props.status)}
    </div>
  );
}

function RoleTag(props: { label: string; tone?: "default" | "cyan" | "orange" | "danger" }): JSX.Element {
  const toneClass = {
    default: "border-white/10 bg-white/10 text-sand/75",
    cyan: "border-neonCyan/35 bg-neonCyan/10 text-neonCyan",
    orange: "border-sunsetOrange/35 bg-sunsetOrange/10 text-sunsetOrange",
    danger: "border-danger/35 bg-danger/10 text-danger",
  }[props.tone ?? "default"];

  return <span className={`badge ${toneClass}`}>{props.label}</span>;
}

function Avatar(props: { name: string }): JSX.Element {
  return (
    <div className="flex size-12 shrink-0 items-center justify-center rounded-full border border-neonCyan/25 bg-neonCyan/10 font-display text-sm tracking-[0.18em] text-neonCyan">
      {playerInitials(props.name)}
    </div>
  );
}

function RangeSetting(props: {
  label: string;
  valueLabel: string;
  min: number;
  max: number;
  value: number;
  disabled: boolean;
  onChange: (value: number) => void;
}): JSX.Element {
  return (
    <div className="rounded-3xl border border-white/10 bg-ocean/40 p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-sand">{props.label}</p>
          <p className="text-xs uppercase tracking-[0.24em] text-sand/45">Lobby control</p>
        </div>
        <span className="badge arcade-mono">{props.valueLabel}</span>
      </div>
      <input
        className="mt-4 w-full"
        type="range"
        min={props.min}
        max={props.max}
        value={props.value}
        disabled={props.disabled}
        onChange={(event) => props.onChange(Number.parseInt(event.target.value, 10))}
      />
    </div>
  );
}

function ToggleSetting(props: {
  label: string;
  hint: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}): JSX.Element {
  return (
    <label className="flex items-start gap-3 rounded-3xl border border-white/10 bg-ocean/40 p-4">
      <input
        className="mt-1 size-4 rounded border-white/20 bg-ocean text-neonCyan focus:ring-2 focus:ring-neonCyan/40"
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.checked)}
      />
      <div>
        <p className="text-sm font-semibold text-sand">{props.label}</p>
        <p className="mt-1 text-sm text-sand/55">{props.hint}</p>
      </div>
    </label>
  );
}

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
  const [pasteState, setPasteState] = useState<"idle" | "ready" | "invalid" | "error">("idle");

  const handlePasteJoinLink = async (): Promise<void> => {
    try {
      const clipboardText = await navigator.clipboard.readText();
      const extractedCode = extractRoomCodeFromText(clipboardText);
      if (!extractedCode) {
        setPasteState("invalid");
        return;
      }

      props.onJoinCode(extractedCode);
      setPasteState("ready");
    } catch {
      setPasteState("error");
    }
  };

  return (
    <section className="mx-auto grid w-full max-w-6xl gap-6 xl:grid-cols-[1.15fr_0.85fr]">
      <div className="card card-glow px-6 py-7 sm:px-8 sm:py-9">
        <div className="max-w-3xl">
          <p className="text-xs uppercase tracking-[0.36em] text-neonCyan/80">University of Guam Charter Day</p>
          <h2 className="mt-3 font-display text-5xl uppercase leading-none text-sand text-shadow-neon sm:text-7xl">
            Defuse fast.
            <br />
            Stay alive.
          </h2>
          <p className="mt-4 max-w-2xl text-base leading-7 text-sand/72">
            Create a room, join from any device, and play.
          </p>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-1">
        <form className="card px-6 py-6 sm:px-7" onSubmit={props.onCreateRoom}>
          <div className="flex items-center gap-3">
            <div className="flex size-12 items-center justify-center rounded-2xl border border-neonCyan/25 bg-neonCyan/10 text-neonCyan">
              <Sparkles className="size-5" aria-hidden="true" />
            </div>
            <div>
              <p className="text-xs uppercase tracking-[0.3em] text-neonCyan/80">Host Cabinet</p>
              <h3 className="mt-1 text-2xl font-semibold text-sand">Create Room</h3>
            </div>
          </div>

          <label className="mt-6 block">
            <span className="mb-2 block text-sm font-medium text-sand/80">Display name</span>
            <input
              className="arcade-input"
              value={props.createName}
              onChange={(event) => props.onCreateName(event.target.value)}
              maxLength={20}
              placeholder="Island host"
              required
            />
          </label>

          <button className="btn-primary mt-6 w-full text-base" type="submit">
            <Swords className="size-4" aria-hidden="true" />
            Create Arcade Room
          </button>
        </form>

        <form className="card px-6 py-6 sm:px-7" onSubmit={props.onJoinRoom}>
          <div className="flex items-center gap-3">
            <div className="flex size-12 items-center justify-center rounded-2xl border border-sunsetOrange/25 bg-sunsetOrange/10 text-sunsetOrange">
              <Link2 className="size-5" aria-hidden="true" />
            </div>
            <div>
              <p className="text-xs uppercase tracking-[0.3em] text-sunsetOrange/80">Join Cabinet</p>
              <h3 className="mt-1 text-2xl font-semibold text-sand">Enter Room</h3>
            </div>
          </div>

          <label className="mt-6 block">
            <span className="mb-2 block text-sm font-medium text-sand/80">Room code</span>
            <input
              className="arcade-input arcade-mono caret-neonCyan text-center text-2xl font-semibold uppercase tracking-[0.55em] shadow-glow-cyan"
              value={props.joinCode}
              onChange={(event) => props.onJoinCode(sanitizeRoomCodeInput(event.target.value))}
              maxLength={6}
              placeholder="ABC123"
              required
            />
          </label>

          <label className="mt-4 block">
            <span className="mb-2 block text-sm font-medium text-sand/80">Display name</span>
            <input
              className="arcade-input"
              value={props.joinName}
              onChange={(event) => props.onJoinName(event.target.value)}
              maxLength={20}
              placeholder="Player name"
              required
            />
          </label>

          <div className="mt-4 flex flex-col gap-3 sm:flex-row">
            <button className="btn-primary flex-1 text-base" type="submit">
              <Users className="size-4" aria-hidden="true" />
              Join Match
            </button>
            <button className="btn-ghost sm:min-w-[170px]" type="button" onClick={handlePasteJoinLink}>
              <ClipboardPaste className="size-4" aria-hidden="true" />
              Paste join link
            </button>
          </div>

          <p className="mt-4 text-sm text-sand/58" aria-live="polite">
            {pasteState === "ready"
              ? "Invite link detected. Room code loaded."
              : pasteState === "invalid"
                ? "Clipboard did not contain a valid room link or room code."
                : pasteState === "error"
                  ? "Clipboard access is unavailable here."
                  : props.joinCode
                    ? "Invite code is ready. Add your name and jump in."
                    : "Paste a full join link or enter the six-character room code."}
          </p>
        </form>
      </div>
    </section>
  );
}

interface JoinLinkCardProps {
  roomCode: string;
}

function JoinLinkCard(props: JoinLinkCardProps): JSX.Element {
  const joinUrl = useMemo(() => buildJoinUrl(props.roomCode), [props.roomCode]);
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState("");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");

  useEffect(() => {
    let cancelled = false;

    QRCode.toDataURL(joinUrl, { margin: 1, width: 220 })
      .then((dataUrl: string) => {
        if (!cancelled) {
          setQrCodeDataUrl(dataUrl);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setQrCodeDataUrl("");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [joinUrl]);

  useEffect(() => {
    if (copyState === "idle") {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setCopyState("idle");
    }, 2000);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [copyState]);

  const handleCopyLink = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(joinUrl);
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[220px_minmax(0,1fr)]">
      <div className="flex items-center justify-center rounded-3xl border border-white/10 bg-white/5 p-4 shadow-glow-cyan">
        {qrCodeDataUrl ? (
          <img src={qrCodeDataUrl} alt={`QR code to join room ${props.roomCode}`} className="rounded-2xl" />
        ) : (
          <div className="flex size-[220px] items-center justify-center rounded-2xl border border-white/10 bg-ocean/60 text-sm text-sand/50">
            Generating QR...
          </div>
        )}
      </div>

      <div className="rounded-3xl border border-white/10 bg-ocean/45 p-5">
        <p className="text-xs uppercase tracking-[0.3em] text-neonCyan/80">Join Link</p>
        <div className="mt-3 rounded-2xl border border-white/10 bg-black/20 px-4 py-4">
          <p className="arcade-mono break-all text-sm text-sand/82">{joinUrl}</p>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button className="btn-primary" type="button" onClick={handleCopyLink}>
            <Copy className="size-4" aria-hidden="true" />
            Copy Link
          </button>
          <RoleTag label={`Room ${props.roomCode}`} tone="orange" />
        </div>

        <p className="mt-4 text-sm text-sand/58" aria-live="polite">
          {copyState === "copied"
            ? "Join link copied."
            : copyState === "error"
              ? "Copy failed. Select the link manually."
              : "Scan the QR code or send the link to preload the room code on another device."}
        </p>
      </div>
    </div>
  );
}

interface LobbyViewProps {
  session: Session;
  roomState: PublicRoomState;
  isHost: boolean;
  onStart: () => void;
  onUpdateSettings: (settings: RoomSettingsUpdate) => void;
  onLeave: () => void;
}

function LobbyView(props: LobbyViewProps): JSX.Element {
  const hostPlayer = props.roomState.players.find((player) => player.id === props.roomState.hostId) ?? null;
  const hostIsSpectating = hostPlayer?.role === "spectator";
  const [settingsOpen, setSettingsOpen] = useState(true);

  useEffect(() => {
    if (props.isHost) {
      setSettingsOpen(true);
    }
  }, [props.isHost]);

  return (
    <section className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
      <div className="space-y-6">
        <div className="card card-glow px-6 py-6 sm:px-7">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.32em] text-neonCyan/80">Lobby</p>
              <h2 className="mt-2 text-3xl font-semibold text-sand sm:text-4xl">Island Arcade Room</h2>
              <p className="mt-2 max-w-2xl text-sm text-sand/62">
                Share the cabinet code, set the survival rules, and launch once at least two active
                players are ready.
              </p>
            </div>
            <div className="rounded-3xl border border-neonCyan/30 bg-neonCyan/10 px-5 py-4 shadow-glow-cyan">
              <p className="text-xs uppercase tracking-[0.3em] text-neonCyan/80">Room Code</p>
              <div className="arcade-mono mt-2 text-4xl font-semibold tracking-[0.45em] text-sand sm:text-5xl">
                {props.roomState.roomCode}
              </div>
            </div>
          </div>

          <div className="mt-6">
            <JoinLinkCard roomCode={props.roomState.roomCode} />
          </div>
        </div>

        <div className="card px-6 py-6 sm:px-7">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-[0.3em] text-sunsetOrange/80">Roster</p>
              <h3 className="mt-2 text-2xl font-semibold text-sand">Players and Spectators</h3>
            </div>
            <RoleTag label={`${props.roomState.players.length} Connected Slots`} tone="orange" />
          </div>

          <ul className="mt-5 grid gap-3">
            {props.roomState.players.map((player) => {
              const isLocalPlayer = player.id === props.session.playerId;
              const isHostPlayer = player.id === props.roomState.hostId;

              return (
                <li
                  key={player.id}
                  className={`chip flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between ${
                    player.role === "spectator" ? "border-white/10 bg-white/5" : "border-neonCyan/15 bg-white/10"
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <Avatar name={player.name} />
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-lg font-semibold text-sand">{player.name}</span>
                        {isLocalPlayer ? <RoleTag label="You" tone="cyan" /> : null}
                      </div>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <RoleTag label={player.role === "spectator" ? "Spectator" : "Player"} />
                        {isHostPlayer ? <RoleTag label="Host" tone="orange" /> : null}
                        {!player.connected ? <RoleTag label="Offline" tone="danger" /> : null}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <RoleTag label={player.connected ? "Online" : "Offline"} tone={player.connected ? "cyan" : "danger"} />
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      </div>

      <aside className="card px-5 py-5 sm:px-6">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.3em] text-neonPurple/80">Control Deck</p>
            <h3 className="mt-2 text-2xl font-semibold text-sand">Host Settings</h3>
          </div>
          <button className="btn-ghost px-3 py-2" type="button" onClick={() => setSettingsOpen((open) => !open)}>
            {settingsOpen ? <ChevronUp className="size-4" aria-hidden="true" /> : <ChevronDown className="size-4" aria-hidden="true" />}
            {settingsOpen ? "Collapse" : "Expand"}
          </button>
        </div>

        <p className="mt-3 text-sm text-sand/58">
          {props.isHost
            ? "Tune the cabinet before launch. Spectators never enter the turn loop."
            : "Only the host can edit these settings. You can still monitor the match configuration."}
        </p>

        {settingsOpen ? (
          <div className="mt-5 space-y-4">
            <RangeSetting
              label="Timer Base"
              valueLabel={`${props.roomState.config.turnSeconds}s`}
              min={5}
              max={20}
              value={props.roomState.config.turnSeconds}
              disabled={!props.isHost}
              onChange={(value) => props.onUpdateSettings({ turnSeconds: value })}
            />

            <RangeSetting
              label="Lives"
              valueLabel={`${props.roomState.config.startingLives}`}
              min={1}
              max={5}
              value={props.roomState.config.startingLives}
              disabled={!props.isHost}
              onChange={(value) => props.onUpdateSettings({ startingLives: value })}
            />

            <ToggleSetting
              label="Show typing preview"
              hint="Expose the active player’s live attempt under the chunk."
              checked={props.roomState.config.showTypingPreviews}
              disabled={!props.isHost}
              onChange={(checked) => props.onUpdateSettings({ showTypingPreviews: checked })}
            />

            <ToggleSetting
              label="Host spectator mode"
              hint="Keep the host in the room without putting them into the turn rotation."
              checked={hostIsSpectating}
              disabled={!props.isHost}
              onChange={(checked) => props.onUpdateSettings({ hostSpectatorMode: checked })}
            />

            <ToggleSetting
              label="Dictionary validation"
              hint="Reject words that are not in the server dictionary."
              checked={props.roomState.config.dictionaryEnabled}
              disabled={!props.isHost}
              onChange={(checked) => props.onUpdateSettings({ dictionaryEnabled: checked })}
            />

            <ToggleSetting
              label="Allow four-letter chunks"
              hint="Expand the chunk pool from 2-3 letters to 2-4 letters."
              checked={props.roomState.config.allowFourLetterChunks}
              disabled={!props.isHost}
              onChange={(checked) => props.onUpdateSettings({ allowFourLetterChunks: checked })}
            />

            <div className="rounded-3xl border border-white/10 bg-ocean/40 p-4">
              <p className="text-sm text-sand/62">
                Difficulty rises after each set of active turns. Start requires at least two
                connected players in the live rotation.
              </p>
            </div>

            {props.isHost ? (
              <button className="btn-primary w-full text-base" type="button" onClick={props.onStart} disabled={!props.roomState.canStart}>
                <Zap className="size-4" aria-hidden="true" />
                Start Game
              </button>
            ) : (
              <div className="rounded-3xl border border-white/10 bg-white/5 px-4 py-4 text-sm text-sand/58">
                Waiting for the host to start the match.
              </div>
            )}

            <button className="btn-ghost w-full" type="button" onClick={props.onLeave}>
              Leave Room
            </button>
          </div>
        ) : (
          <div className="mt-5 rounded-3xl border border-white/10 bg-white/5 px-4 py-4 text-sm text-sand/58">
            Settings are collapsed.
          </div>
        )}
      </aside>
    </section>
  );
}

interface TimerRingProps {
  remainingMs: number;
  turnDurationSeconds: number;
  turnNumber: number;
}

function TimerRing(props: TimerRingProps): JSX.Element {
  const [remainingMs, setRemainingMs] = useState(() => Math.max(0, props.remainingMs));

  useEffect(() => {
    const endAt = Date.now() + props.remainingMs;

    const updateRemaining = (): void => {
      setRemainingMs(Math.max(0, endAt - Date.now()));
    };

    updateRemaining();
    const intervalId = window.setInterval(updateRemaining, 100);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [props.remainingMs, props.turnNumber]);

  const radius = 124;
  const circumference = 2 * Math.PI * radius;
  const turnDurationMs = Math.max(1, props.turnDurationSeconds * 1000);
  const progress = Math.max(0, Math.min(1, remainingMs / turnDurationMs));
  const dashOffset = circumference * (1 - progress);
  const secondsLeft = Math.max(0, Math.ceil(remainingMs / 1000));

  return (
    <>
      <div className="pointer-events-none absolute right-4 top-4 z-20">
        <div
          className={`arcade-mono rounded-full border px-4 py-2 text-sm font-semibold ${
            secondsLeft <= 3
              ? "border-danger/45 bg-danger/15 text-danger"
              : "border-neonCyan/35 bg-ocean/70 text-neonCyan"
          }`}
        >
          {secondsLeft}s
        </div>
      </div>

      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <svg
          className="h-[19rem] w-[19rem] sm:h-[22rem] sm:w-[22rem]"
          viewBox="0 0 320 320"
          fill="none"
          aria-hidden="true"
        >
          <defs>
            <linearGradient id="timer-ring-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#4AF8FF" />
              <stop offset="55%" stopColor="#8F5BFF" />
              <stop offset="100%" stopColor="#FF9B54" />
            </linearGradient>
          </defs>
          <circle cx="160" cy="160" r={radius} stroke="rgba(255,255,255,0.08)" strokeWidth="12" />
          <circle
            cx="160"
            cy="160"
            r={radius}
            stroke="url(#timer-ring-gradient)"
            strokeWidth="12"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
            transform="rotate(-90 160 160)"
          />
          <circle
            cx="160"
            cy="160"
            r="94"
            fill="rgba(7,11,26,0.34)"
            stroke="rgba(74,248,255,0.08)"
            strokeWidth="1"
          />
        </svg>
      </div>
    </>
  );
}

interface TurnOrderRowProps {
  roomState: PublicRoomState;
  session: Session;
}

function TurnOrderRow(props: TurnOrderRowProps): JSX.Element {
  const players = props.roomState.players.filter((player) => player.role === "player");
  const spectators = props.roomState.players.filter((player) => player.role === "spectator");

  return (
    <div className="space-y-4">
      <div>
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.3em] text-neonCyan/80">Turn Row</p>
            <p className="mt-2 text-sm text-sand/58">Swipe on mobile to scan the live order.</p>
          </div>
          <RoleTag label={`Turn ${props.roomState.turnNumber}`} tone="cyan" />
        </div>

        <div className="flex gap-3 overflow-x-auto pb-2">
          {players.map((player, index) => {
            const isActive = player.id === props.roomState.activePlayerId;
            const isLocalPlayer = player.id === props.session.playerId;
            const isEliminated = isPlayerOut(player);

            return (
              <div
                key={player.id}
                className={`chip min-w-[220px] shrink-0 ${
                  isActive ? "chip-active motion-safe:animate-chip-pulse" : ""
                } ${isEliminated ? "border-white/10 bg-white/5 opacity-50" : "bg-white/8"} ${
                  isActive && !isEliminated ? "scale-[1.01]" : ""
                }`}
                role="listitem"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <Avatar name={player.name} />
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={`text-base font-semibold text-sand ${
                            isEliminated ? "line-through decoration-danger/70" : ""
                          }`}
                        >
                          {player.name}
                        </span>
                        {isLocalPlayer ? <RoleTag label="You" tone="cyan" /> : null}
                        {isEliminated ? <RoleTag label="Out" tone="danger" /> : null}
                      </div>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {isActive ? (
                          <>
                            <RoleTag label="Active" tone="orange" />
                            <RoleTag label={`#${props.roomState.turnNumber}`} tone="cyan" />
                          </>
                        ) : (
                          <RoleTag label={`Slot ${index + 1}`} />
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex size-11 items-center justify-center rounded-2xl border border-current/15 bg-black/15 text-sand/70">
                    {isActive ? <Zap className="size-5 text-neonCyan" aria-hidden="true" /> : <Shield className="size-5" aria-hidden="true" />}
                  </div>
                </div>

                <div className="mt-4 flex items-center justify-between gap-3 text-sm">
                  <span className="truncate text-sand/60">{player.lastWord || "No last word yet"}</span>
                  <span className="arcade-mono text-sand/75">{player.lives} lives</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {spectators.length > 0 ? (
        <div>
          <div className="mb-3 flex items-center gap-2 text-xs uppercase tracking-[0.3em] text-sand/46">
            <MonitorPlay className="size-4 text-sand/55" aria-hidden="true" />
            Spectators
          </div>
          <div className="flex gap-3 overflow-x-auto pb-2">
            {spectators.map((player) => (
              <div key={player.id} className="chip min-w-[220px] shrink-0 border-white/10 bg-white/5 opacity-80">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <Avatar name={player.name} />
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-base font-semibold text-sand">{player.name}</span>
                        {player.id === props.session.playerId ? <RoleTag label="You" tone="cyan" /> : null}
                      </div>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <RoleTag label="Spectator" />
                        {!player.connected ? <RoleTag label="Offline" tone="danger" /> : null}
                      </div>
                    </div>
                  </div>
                  <MonitorPlay className="size-5 text-sand/55" aria-hidden="true" />
                </div>
                <p className="mt-4 text-sm text-sand/52">Never active. Watching the live turn loop.</p>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

interface ScoreboardPanelProps {
  title: string;
  roomState: PublicRoomState;
  session: Session;
  isHost?: boolean;
  onToggleTypingPreviews?: (enabled: boolean) => void;
}

function ScoreboardPlayerCard(props: {
  player: PublicPlayerState;
  roomState: PublicRoomState;
  session: Session;
}): JSX.Element {
  const [isFlashing, setIsFlashing] = useState(false);
  const previousWordRef = useRef(props.player.lastWord);
  const spectator = props.player.role === "spectator";
  const eliminated = isPlayerOut(props.player);
  const isLocalPlayer = props.player.id === props.session.playerId;
  const isActive = props.player.id === props.roomState.activePlayerId;

  useEffect(() => {
    if (spectator) {
      previousWordRef.current = props.player.lastWord;
      return;
    }

    if (props.player.lastWord && previousWordRef.current !== props.player.lastWord) {
      setIsFlashing(true);
      const timeoutId = window.setTimeout(() => {
        setIsFlashing(false);
      }, WORD_FLASH_MS);

      previousWordRef.current = props.player.lastWord;

      return () => {
        window.clearTimeout(timeoutId);
      };
    }

    previousWordRef.current = props.player.lastWord;
    return undefined;
  }, [props.player.lastWord, spectator]);

  return (
    <div
      className={`rounded-3xl border p-4 ${
        eliminated
          ? "border-white/10 bg-white/5 opacity-60"
          : isActive
            ? "border-neonCyan/30 bg-neonCyan/8 shadow-glow-cyan"
            : "border-white/10 bg-white/6"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <Avatar name={props.player.name} />
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`text-base font-semibold text-sand ${
                  eliminated ? "line-through decoration-danger/70" : ""
                }`}
              >
                {props.player.name}
              </span>
              {isLocalPlayer ? <RoleTag label="You" tone="cyan" /> : null}
              {isActive && !spectator && !eliminated ? <RoleTag label="Turn" tone="orange" /> : null}
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              <RoleTag label={spectator ? "Spectator" : "Player"} />
              {eliminated ? <RoleTag label="Eliminated" tone="danger" /> : null}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 text-sand/65">
          {eliminated ? <Skull className="size-5 text-danger" aria-hidden="true" /> : <Heart className="size-5 text-sunsetOrange" aria-hidden="true" />}
          <span className="arcade-mono text-sm font-semibold">{spectator ? "--" : props.player.lives}</span>
        </div>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
        <div>
          <p className="text-xs uppercase tracking-[0.24em] text-sand/42">Last Word</p>
          <div
            className={`mt-2 inline-flex max-w-full items-center rounded-full border px-3 py-2 text-sm ${
              isFlashing ? "score-flash border-neonCyan/30 bg-neonCyan/12" : "border-white/10 bg-black/15"
            } ${spectator ? "text-sand/45" : "text-sand/82"}`}
          >
            <span className="truncate">{spectator ? "Host controls only" : props.player.lastWord || "Waiting..."}</span>
          </div>
        </div>

        <div>
          <p className="text-xs uppercase tracking-[0.24em] text-sand/42">Lives</p>
          <div className="mt-2 flex items-center gap-2">
            {spectator ? (
              <MonitorPlay className="size-4 text-sand/50" aria-hidden="true" />
            ) : (
              <div className="flex items-center gap-1">
                {Array.from({ length: Math.max(props.player.lives, 0) }).map((_, index) => (
                  <Heart
                    key={`${props.player.id}-life-${index}`}
                    className="size-4 text-sunsetOrange"
                    fill="rgba(255,155,84,0.14)"
                    aria-hidden="true"
                  />
                ))}
              </div>
            )}
            <span className="arcade-mono text-sm text-sand/78">{spectator ? "--" : props.player.lives}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function ScoreboardPanel(props: ScoreboardPanelProps): JSX.Element {
  return (
    <div className="card px-5 py-5 sm:px-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.3em] text-sunsetOrange/80">Survival Board</p>
          <h3 className="mt-2 text-2xl font-semibold text-sand">{props.title}</h3>
        </div>

        {props.onToggleTypingPreviews ? (
          props.isHost ? (
            <button
              className="btn-ghost px-3 py-2 text-xs"
              type="button"
              onClick={() => props.onToggleTypingPreviews?.(!props.roomState.config.showTypingPreviews)}
            >
              {props.roomState.config.showTypingPreviews ? (
                <Eye className="size-4" aria-hidden="true" />
              ) : (
                <EyeOff className="size-4" aria-hidden="true" />
              )}
              {props.roomState.config.showTypingPreviews ? "Hide Previews" : "Show Previews"}
            </button>
          ) : (
            <RoleTag
              label={props.roomState.config.showTypingPreviews ? "Previews Live" : "Previews Hidden"}
              tone="cyan"
            />
          )
        ) : null}
      </div>

      <div className="mt-5 space-y-3">
        {orderedScoreboardPlayers(props.roomState.players).map((player) => (
          <ScoreboardPlayerCard
            key={player.id}
            player={player}
            roomState={props.roomState}
            session={props.session}
          />
        ))}
      </div>
    </div>
  );
}

interface GameViewProps {
  session: Session;
  roomState: PublicRoomState;
  typingState: TypingState;
  localPlayer: PublicPlayerState | null;
  wordDraft: string;
  errorMessage: string;
  errorVersion: number;
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
  const localPlayerOut = isPlayerOut(props.localPlayer);
  const chunkTierLabel = props.roomState.currentChunkTier
    ? TIER_LABELS[props.roomState.currentChunkTier]
    : null;
  const chunkCoverageLabel = formatCoverageK(props.roomState.currentChunkCoverage);
  const activeTurnLabel = activePlayer ? formatTurnOwner(activePlayer.name) : "Waiting for turn";
  const targetDifficultyLabel = props.roomState.globalDifficultyTier
    ? TIER_LABELS[props.roomState.globalDifficultyTier]
    : null;

  const typingPreviewText = props.typingState.isTyping
    ? props.roomState.config.showTypingPreviews
      ? props.typingState.text || "..."
      : "typing..."
    : "Waiting...";

  const typingLabel = typingPlayer ? `${typingPlayer.name} live attempt` : "Live attempt";

  const [panelFeedback, setPanelFeedback] = useState<"pass" | "boom" | null>(null);
  const [inputRejected, setInputRejected] = useState(false);
  const previousEventRef = useRef(props.roomState.lastEvent);

  useEffect(() => {
    if (previousEventRef.current === props.roomState.lastEvent) {
      return;
    }

    previousEventRef.current = props.roomState.lastEvent;

    if (props.roomState.lastEvent.includes('played "')) {
      setPanelFeedback("pass");
      const timeoutId = window.setTimeout(() => {
        setPanelFeedback(null);
      }, MOTION_FEEDBACK_MS);

      return () => {
        window.clearTimeout(timeoutId);
      };
    }

    if (props.roomState.lastEvent.includes("exploded")) {
      setPanelFeedback("boom");
      const timeoutId = window.setTimeout(() => {
        setPanelFeedback(null);
      }, BOOM_FEEDBACK_MS);

      return () => {
        window.clearTimeout(timeoutId);
      };
    }

    return undefined;
  }, [props.roomState.lastEvent]);

  useEffect(() => {
    if (!props.errorMessage || props.errorVersion === 0) {
      return;
    }

    setInputRejected(true);
    const timeoutId = window.setTimeout(() => {
      setInputRejected(false);
    }, WORD_FLASH_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [props.errorMessage, props.errorVersion]);

  return (
    <section className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
      <div className="space-y-6">
        <div className="card px-5 py-5 sm:px-6">
          <TurnOrderRow roomState={props.roomState} session={props.session} />
        </div>

        {localPlayerOut ? (
          <div
            className="card border-danger/45 bg-danger/12 px-6 py-4 text-center text-lg font-semibold uppercase tracking-[0.26em] text-danger"
            role="status"
            aria-live="polite"
          >
            You Are Out
          </div>
        ) : null}

        <div
          className={`panel-turn px-5 py-6 sm:px-7 sm:py-7 ${
            props.isYourTurn ? "panel-turn-active motion-safe:animate-panel-pulse" : ""
          } ${panelFeedback === "pass" ? "panel-turn-pass motion-safe:animate-pass-burst" : ""} ${
            panelFeedback === "boom" ? "panel-turn-boom motion-safe:animate-boom-flash" : ""
          }`}
        >
          <div className="relative z-10 flex flex-col items-center text-center">
            <div className="mb-5 flex w-full justify-center">
              <div
                className={`inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-semibold uppercase tracking-[0.32em] ${
                  props.isYourTurn
                    ? "border-neonCyan/40 bg-neonCyan/12 text-neonCyan"
                    : "border-white/15 bg-white/8 text-sand/78"
                }`}
                role="status"
                aria-live="polite"
              >
                {props.isYourTurn ? (
                  <>
                    <Sparkles className="size-4" aria-hidden="true" />
                    Your Turn
                  </>
                ) : (
                  activeTurnLabel
                )}
              </div>
            </div>

            <div className="relative flex min-h-[22rem] w-full items-center justify-center sm:min-h-[24rem]">
              <TimerRing
                remainingMs={props.roomState.remainingMs}
                turnDurationSeconds={props.roomState.turnDurationSeconds}
                turnNumber={props.roomState.turnNumber}
              />

              <div className="relative z-10 max-w-[32rem]">
                <div className="inline-flex flex-wrap items-end justify-center gap-3">
                  <span className="font-display text-[clamp(5rem,18vw,9rem)] uppercase leading-none text-sand text-shadow-neon">
                    {props.roomState.currentChunk ?? "--"}
                  </span>
                  {chunkTierLabel ? (
                    <span className="mb-4 inline-flex items-center rounded-full border border-white/10 bg-black/20 px-3 py-2 text-sm uppercase tracking-[0.24em] text-sand/72">
                      {chunkTierLabel} • {chunkCoverageLabel}
                    </span>
                  ) : null}
                </div>

                <div className="mt-6 flex flex-wrap justify-center gap-2">
                  <RoleTag label={`Turn ${props.roomState.turnNumber}`} tone="cyan" />
                  <RoleTag label={`${props.roomState.turnDurationSeconds}s`} />
                  <RoleTag
                    label={props.roomState.config.allowFourLetterChunks ? "2-4 Letters" : "2-3 Letters"}
                  />
                  {targetDifficultyLabel ? <RoleTag label={`Target ${targetDifficultyLabel}`} tone="orange" /> : null}
                  {props.roomState.globalStageIndex > 0 ? (
                    <RoleTag label={`Stage ${props.roomState.globalStageIndex + 1}`} />
                  ) : null}
                </div>
              </div>
            </div>

            <div className="mt-2 w-full max-w-3xl">
              <p className="text-xs uppercase tracking-[0.3em] text-neonCyan/80">{typingLabel}</p>
              <div
                className={`mt-4 font-display text-[clamp(2rem,8vw,4.5rem)] uppercase leading-tight ${
                  props.typingState.isTyping ? "text-sand text-shadow-neon" : "text-sand/32"
                }`}
                aria-live="polite"
              >
                {typingPreviewText}
              </div>
            </div>
          </div>
        </div>

        <form className="card px-5 py-5 sm:px-6" onSubmit={props.onSubmitWord}>
          <div className="flex flex-col gap-4 sm:flex-row">
            <input
              ref={props.wordInputRef}
              className={`arcade-input flex-1 px-5 py-4 text-lg ${
                props.isYourTurn ? "shadow-glow-cyan" : ""
              } ${
                inputRejected
                  ? "border-danger/60 text-danger motion-safe:animate-shake-retro focus:border-danger/70 focus:ring-danger/20"
                  : ""
              }`}
              value={props.wordDraft}
              onChange={(event) => props.onWordDraft(event.target.value)}
              maxLength={30}
              placeholder={
                localPlayerOut
                  ? "Cabinet locked for this round"
                  : props.canSubmit
                    ? "Type a word containing the chunk"
                    : "Warm up here while you wait"
              }
              autoCapitalize="none"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              disabled={localPlayerOut}
            />
            <button
              className="btn-primary px-6 text-base sm:min-w-[168px]"
              type="submit"
              disabled={localPlayerOut || !props.canSubmit || props.wordDraft.trim().length === 0}
            >
              <Zap className="size-4" aria-hidden="true" />
              Submit Word
            </button>
          </div>

          <div className="mt-4 flex flex-col gap-3 text-sm text-sand/58 sm:flex-row sm:items-center sm:justify-between">
            <p>
              {localPlayerOut
                ? "You can keep watching, but submit controls are disabled."
                : props.canSubmit
                  ? "Fuse a valid word before the timer burns out."
                  : "Only the active player can submit. Local practice stays on your device."}
            </p>
            <button className="btn-ghost self-start px-3 py-2 text-xs sm:self-auto" type="button" onClick={props.onLeave}>
              Leave Room
            </button>
          </div>
        </form>
      </div>

      <aside className="space-y-6">
        <ScoreboardPanel
          title="Scoreboard"
          roomState={props.roomState}
          session={props.session}
          isHost={props.isHost}
          onToggleTypingPreviews={props.onToggleTypingPreviews}
        />

        <div className="card px-5 py-5 sm:px-6">
          <p className="text-xs uppercase tracking-[0.3em] text-neonPurple/80">Room Pulse</p>
          <div className="mt-4 space-y-3">
            <div className="rounded-3xl border border-white/10 bg-ocean/40 p-4">
              <p className="text-xs uppercase tracking-[0.24em] text-sand/42">Room Code</p>
              <div className="arcade-mono mt-2 text-3xl font-semibold tracking-[0.4em] text-sand">
                {props.roomState.roomCode}
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
              <div className="rounded-3xl border border-white/10 bg-ocean/40 p-4">
                <div className="flex items-center gap-2 text-sm font-semibold text-sand">
                  <TimerReset className="size-4 text-neonCyan" aria-hidden="true" />
                  Turn Timer
                </div>
                <p className="mt-2 text-sm text-sand/58">{props.roomState.turnDurationSeconds}s per turn</p>
              </div>
              <div className="rounded-3xl border border-white/10 bg-ocean/40 p-4">
                <div className="flex items-center gap-2 text-sm font-semibold text-sand">
                  {props.roomState.config.showTypingPreviews ? (
                    <Eye className="size-4 text-success" aria-hidden="true" />
                  ) : (
                    <EyeOff className="size-4 text-sunsetOrange" aria-hidden="true" />
                  )}
                  Typing Preview
                </div>
                <p className="mt-2 text-sm text-sand/58">
                  {props.roomState.config.showTypingPreviews ? "Visible to everyone." : "Hidden behind typing..."}
                </p>
              </div>
            </div>
          </div>
        </div>
      </aside>
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
    <section className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
      <div className="space-y-6">
        <div className="card card-glow px-6 py-7 sm:px-7">
          <div className="flex flex-wrap items-center gap-3">
            <RoleTag label="Results" tone="orange" />
            <RoleTag label={`Room ${props.roomState.roomCode}`} tone="cyan" />
          </div>

          <div className="mt-6 flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.32em] text-sunsetOrange/80">Winner</p>
              <h2 className="mt-3 font-display text-5xl uppercase leading-none text-sand text-shadow-neon sm:text-6xl">
                {winner?.name ?? "No Winner"}
              </h2>
              <p className="mt-4 max-w-xl text-sm text-sand/62">
                The cabinet is cooled down. Review the survival board and relaunch when the host is ready.
              </p>
            </div>

            <div className="flex size-24 items-center justify-center rounded-[2rem] border border-sunsetOrange/30 bg-sunsetOrange/10 shadow-glow-orange">
              <Crown className="size-10 text-sunsetOrange" aria-hidden="true" />
            </div>
          </div>
        </div>

        <ScoreboardPanel title="Final Scoreboard" roomState={props.roomState} session={props.session} />
      </div>

      <aside className="card px-5 py-5 sm:px-6">
        <p className="text-xs uppercase tracking-[0.3em] text-neonPurple/80">Next Round</p>
        <div className="mt-5 space-y-4">
          {props.isHost ? (
            <button className="btn-primary w-full text-base" type="button" onClick={props.onPlayAgain}>
              <Sparkles className="size-4" aria-hidden="true" />
              Play Again
            </button>
          ) : (
            <div className="rounded-3xl border border-white/10 bg-white/5 px-4 py-4 text-sm text-sand/58">
              Waiting for the host to reset the match.
            </div>
          )}

          <button className="btn-ghost w-full" type="button" onClick={props.onLeave}>
            Leave Room
          </button>
        </div>
      </aside>
    </section>
  );
}

export default function App(): JSX.Element {
  const [session, setSession] = useState<Session | null>(() => loadStoredSession());
  const [roomState, setRoomState] = useState<PublicRoomState | null>(null);
  const [typingState, setTypingState] = useState<TypingState>(() => createBlankTypingState());
  const [createName, setCreateName] = useState("");
  const [joinName, setJoinName] = useState("");
  const [joinCode, setJoinCode] = useState(() => loadJoinCodeFromUrl());
  const [wordDraft, setWordDraft] = useState("");
  const [error, setError] = useState("");
  const [errorVersion, setErrorVersion] = useState(0);
  const [explosionPulse, setExplosionPulse] = useState(false);
  const wordInputRef = useRef<HTMLInputElement>(null);
  const errorMinVisibleUntilRef = useRef(0);
  const errorClearTimeoutRef = useRef<number | null>(null);
  const sessionRef = useRef<Session | null>(session);
  const roomStateRef = useRef<PublicRoomState | null>(roomState);
  const canBroadcastTypingRef = useRef(false);
  const lastTypingSentAtRef = useRef(0);
  const pendingTypingPreviewRef = useRef<string | null>(null);
  const typingSendTimeoutRef = useRef<number | null>(null);
  const previousLastEventRef = useRef<string | null>(null);
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
      setErrorVersion((current) => current + 1);

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
        if (canBroadcastTypingRef.current && sessionRef.current && roomStateRef.current) {
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
    me?.role === "player" &&
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

  useEffect(() => {
    if (!roomState?.lastEvent || previousLastEventRef.current === roomState.lastEvent) {
      previousLastEventRef.current = roomState?.lastEvent ?? null;
      return;
    }

    previousLastEventRef.current = roomState.lastEvent;

    if (roomState.phase !== "in_game" || !roomState.lastEvent.includes("exploded")) {
      return;
    }

    setExplosionPulse(true);
    const timeoutId = window.setTimeout(() => {
      setExplosionPulse(false);
    }, BOOM_FEEDBACK_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [roomState?.lastEvent, roomState?.phase]);

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
    setJoinCode(response.roomCode);
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

  const handleUpdateSettings = (settings: RoomSettingsUpdate): void => {
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
    <div className={`app-stage ${explosionPulse ? "screen-boom" : ""}`}>
      <div className="pointer-events-none absolute -left-24 top-20 size-72 rounded-full bg-neonPurple/10 blur-3xl" />
      <div className="pointer-events-none absolute right-[-5rem] top-1/3 size-80 rounded-full bg-neonCyan/10 blur-3xl" />
      <div className="pointer-events-none absolute bottom-[-6rem] left-1/4 h-72 w-72 rounded-full bg-sunsetOrange/10 blur-3xl" />
      <div
        className={`pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(255,91,126,0.14),transparent_56%)] transition-opacity duration-300 ${
          explosionPulse ? "opacity-100" : "opacity-0"
        }`}
      />
      <div className="pointer-events-none absolute inset-0 vignette-mask" />

      <div className="relative z-10 mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-6 px-4 py-5 sm:px-6 sm:py-6 lg:px-8">
        <header className="card card-glow px-5 py-5 sm:px-6">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <div className="flex flex-wrap items-center gap-3">
                <RoleTag label="Think Fast" tone="cyan" />
                <RoleTag label="Defuse the Bomb" tone="orange" />
              </div>

              <div className="mt-5 flex items-start gap-4">
                <div className="flex size-14 items-center justify-center rounded-[1.75rem] border border-neonCyan/25 bg-neonCyan/10 text-neonCyan shadow-glow-cyan">
                  <Palmtree className="size-7" aria-hidden="true" />
                </div>
                <div>
                  <h1 className="font-display text-4xl uppercase leading-none text-sand text-shadow-neon sm:text-5xl">
                    Word Fuse
                  </h1>
                  <p className="mt-3 max-w-2xl text-sm text-sand/65 sm:text-base">
                    Multiplayer word game for a fun time.
                  </p>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <div className="badge border-white/10 bg-white/10 text-sand/75">
                <Waves className="size-3.5" aria-hidden="true" />
                Made in Guam
              </div>
              <ConnectionPill status={connectionStatus} />
            </div>
          </div>
        </header>

        <div className="space-y-3">
          {connectionStatus !== "connected" ? (
            <Banner message="Reconnecting to the server..." tone="warning" />
          ) : null}

          {roomState?.lastEvent ? <Banner message={roomState.lastEvent} tone="info" /> : null}
          {error ? <Banner message={error} tone="error" /> : null}
        </div>

        <main className="flex-1">
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
            <section className="mx-auto max-w-2xl">
              <div className="card px-6 py-7 text-center sm:px-8">
                <div className="mx-auto flex size-16 items-center justify-center rounded-[1.75rem] border border-neonCyan/25 bg-neonCyan/10 text-neonCyan shadow-glow-cyan">
                  <RadioTower className="size-8" aria-hidden="true" />
                </div>
                <p className="mt-6 text-xs uppercase tracking-[0.32em] text-neonCyan/80">Reconnecting</p>
                <h2 className="mt-3 text-3xl font-semibold text-sand">Finding your cabinet</h2>
                <p className="mt-3 text-sm text-sand/62">Trying to reconnect you to room {session.roomCode}.</p>
                <button className="btn-ghost mt-6" type="button" onClick={handleLeaveRoom}>
                  Clear Session
                </button>
              </div>
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
              localPlayer={me}
              wordDraft={wordDraft}
              errorMessage={error}
              errorVersion={errorVersion}
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
        </main>
      </div>
    </div>
  );
}

/* __APP_SHELL__ */
