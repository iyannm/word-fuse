const ROOM_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.max(min, Math.min(max, Math.round(value)));
}

export function sanitizeRoomCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
}

export function sanitizePlayerName(input: string): string {
  return input
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[^A-Za-z0-9 _-]/g, "")
    .slice(0, 20);
}

export function sanitizeWord(input: string): string {
  return input.trim().toLowerCase();
}

export function createRoomCode(existingCodes: Set<string>): string {
  for (let attempt = 0; attempt < 10_000; attempt += 1) {
    let next = "";
    for (let i = 0; i < 6; i += 1) {
      next += ROOM_CHARS[Math.floor(Math.random() * ROOM_CHARS.length)];
    }

    if (!existingCodes.has(next)) {
      return next;
    }
  }

  throw new Error("Could not allocate a unique room code.");
}

export function createPlayerId(): string {
  return `p_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}