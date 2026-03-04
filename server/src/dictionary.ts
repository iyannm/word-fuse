import fs from "node:fs";
import path from "node:path";
import wordListPath from "word-list";
import { ChunkTier, TierBand } from "./types";

const MIN_WORD_LENGTH = 3;
const MAX_WORD_LENGTH = 20;
const MIN_CHUNK_COVERAGE = 1500;
const MIN_CHUNK_POOL_SIZE = 400;
const TARGET_CHUNK_POOL_SIZE = 800;
const MIN_TIER_SIZE = 150;
const CHUNK_LENGTHS = [2, 3, 4] as const;
const DEFAULT_CHUNK_LENGTHS = [2, 3] as const;
const EXTENDED_CHUNK_LENGTHS = [2, 3, 4] as const;
const CHUNK_TIER_ORDER: ChunkTier[] = ["veryHard", "hard", "medium", "easy", "veryEasy"];
const CHUNK_TIER_WEIGHTS = [0.1, 0.2, 0.3, 0.25, 0.15];
const COMMON_CONSONANT_CLUSTERS = [
  "CH",
  "SH",
  "TH",
  "PH",
  "TR",
  "ST",
  "STR",
  "BR",
  "CL",
  "CR",
  "DR",
  "FR",
  "GR",
  "PL",
  "PR",
  "SC",
  "SK",
  "SL",
  "SM",
  "SN",
  "SP",
  "SPR",
  "SW",
  "TW",
  "WH",
  "WR",
];
const FALLBACK_CHUNKS = [
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
  "AL",
  "OR",
  "EN",
  "IST",
  "OUS",
];

export interface ChunkDescriptor {
  chunk: string;
  coverage: number;
  tier: ChunkTier;
  length: number;
  preferred: boolean;
}

export interface ChunkPool {
  label: string;
  poolSize: number;
  tierBands: Record<ChunkTier, TierBand>;
  tierChunks: Record<ChunkTier, string[]>;
  chunkMap: ReadonlyMap<string, ChunkDescriptor>;
}

export interface Dictionary {
  enabled: boolean;
  size: number;
  has(word: string): boolean;
  getChunkPool(includeFourLetterChunks: boolean): ChunkPool;
  getChunkInfo(chunk: string, includeFourLetterChunks: boolean): ChunkDescriptor | null;
}

interface RawChunkStat {
  chunk: string;
  coverage: number;
  length: number;
  preferred: boolean;
}

interface TierPlan {
  counts: number[];
  warning: string | null;
}

function normalizeDictionaryWord(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[^A-Za-z]/g, "")
    .toUpperCase();
}

function parseWords(raw: string): Set<string> {
  const words = raw
    .split(/\r?\n/)
    .map((line) => normalizeDictionaryWord(line.trim()))
    .filter((line) => line.length >= MIN_WORD_LENGTH && line.length <= MAX_WORD_LENGTH);

  return new Set(words);
}

function resolveBaseWordListPath(): string {
  const preferredPath = path.join(__dirname, "..", "assets", "wordlist.txt");
  if (fs.existsSync(preferredPath)) {
    return preferredPath;
  }

  return path.join(__dirname, "..", "wordlist.txt");
}

function readWordFile(filePath: string): Set<string> {
  const raw = fs.readFileSync(filePath, "utf8");
  return parseWords(raw);
}

function isPreferredChunk(chunk: string): boolean {
  if (/[AEIOU]/.test(chunk)) {
    return true;
  }

  return COMMON_CONSONANT_CLUSTERS.some(
    (cluster) => cluster === chunk || cluster.startsWith(chunk) || chunk.startsWith(cluster),
  );
}

function compareChunkStats(a: RawChunkStat, b: RawChunkStat): number {
  if (a.coverage !== b.coverage) {
    return a.coverage - b.coverage;
  }

  return a.chunk.localeCompare(b.chunk);
}

function scanChunkCoverage(wordsArray: string[]): RawChunkStat[] {
  const chunkCoverage = new Map<string, number>();

  for (const word of wordsArray) {
    for (const length of CHUNK_LENGTHS) {
      if (word.length < length) {
        continue;
      }

      const seen = new Set<string>();

      for (let index = 0; index <= word.length - length; index += 1) {
        seen.add(word.slice(index, index + length));
      }

      for (const chunk of seen) {
        chunkCoverage.set(chunk, (chunkCoverage.get(chunk) ?? 0) + 1);
      }
    }
  }

  return [...chunkCoverage.entries()]
    .filter(([, coverage]) => coverage >= MIN_CHUNK_COVERAGE)
    .map(([chunk, coverage]) => ({
      chunk,
      coverage,
      length: chunk.length,
      preferred: isPreferredChunk(chunk),
    }))
    .sort(compareChunkStats);
}

function interleaveStats(preferred: RawChunkStat[], other: RawChunkStat[]): RawChunkStat[] {
  const merged: RawChunkStat[] = [];
  let preferredIndex = 0;
  let otherIndex = 0;

  while (preferredIndex < preferred.length || otherIndex < other.length) {
    if (preferredIndex < preferred.length) {
      merged.push(preferred[preferredIndex]);
      preferredIndex += 1;
    }

    if (otherIndex < other.length) {
      merged.push(other[otherIndex]);
      otherIndex += 1;
    }
  }

  return merged;
}

function capChunkPool(stats: RawChunkStat[]): RawChunkStat[] {
  if (stats.length <= TARGET_CHUNK_POOL_SIZE) {
    return [...stats];
  }

  const sorted = [...stats].sort(compareChunkStats);
  const bucketCount = 5;
  const buckets = Array.from({ length: bucketCount }, () => [] as RawChunkStat[]);

  for (let index = 0; index < sorted.length; index += 1) {
    const bucketIndex = Math.min(
      bucketCount - 1,
      Math.floor((index / Math.max(1, sorted.length - 1)) * bucketCount),
    );
    buckets[bucketIndex].push(sorted[index]);
  }

  const queues = buckets.map((bucket) =>
    interleaveStats(
      bucket.filter((stat) => stat.preferred),
      bucket.filter((stat) => !stat.preferred),
    ),
  );

  const selected: RawChunkStat[] = [];
  const seen = new Set<string>();

  while (selected.length < TARGET_CHUNK_POOL_SIZE) {
    let addedInRound = false;

    for (const queue of queues) {
      while (queue.length > 0) {
        const next = queue.shift();
        if (!next || seen.has(next.chunk)) {
          continue;
        }

        seen.add(next.chunk);
        selected.push(next);
        addedInRound = true;
        break;
      }

      if (selected.length >= TARGET_CHUNK_POOL_SIZE) {
        break;
      }
    }

    if (!addedInRound) {
      break;
    }
  }

  return selected.sort(compareChunkStats);
}

function allocateCounts(total: number, weights: number[]): number[] {
  const exact = weights.map((weight) => total * weight);
  const counts = exact.map((value) => Math.floor(value));
  let remaining = total - counts.reduce((sum, count) => sum + count, 0);

  const remainders = exact
    .map((value, index) => ({ index, remainder: value - counts[index] }))
    .sort((a, b) => b.remainder - a.remainder);

  for (const entry of remainders) {
    if (remaining <= 0) {
      break;
    }

    counts[entry.index] += 1;
    remaining -= 1;
  }

  return counts;
}

function ensureNonEmptyCounts(counts: number[], total: number): number[] {
  if (total < counts.length) {
    return counts;
  }

  const adjusted = [...counts];

  for (let index = 0; index < adjusted.length; index += 1) {
    if (adjusted[index] > 0) {
      continue;
    }

    let donorIndex = adjusted.findIndex((count) => count > 1);
    if (donorIndex === -1) {
      donorIndex = adjusted.findIndex((count) => count > 0);
    }

    if (donorIndex === -1) {
      continue;
    }

    adjusted[donorIndex] -= 1;
    adjusted[index] += 1;
  }

  return adjusted;
}

function tryRelaxTierCounts(counts: number[]): number[] {
  const adjusted = [...counts];
  let mutated = true;

  while (mutated) {
    mutated = false;

    for (let index = 0; index < adjusted.length; index += 1) {
      if (adjusted[index] >= MIN_TIER_SIZE) {
        continue;
      }

      const leftSurplus = index > 0 ? adjusted[index - 1] - MIN_TIER_SIZE : -1;
      const rightSurplus = index < adjusted.length - 1 ? adjusted[index + 1] - MIN_TIER_SIZE : -1;

      if (leftSurplus <= 0 && rightSurplus <= 0) {
        continue;
      }

      if (rightSurplus > leftSurplus) {
        adjusted[index + 1] -= 1;
      } else {
        adjusted[index - 1] -= 1;
      }

      adjusted[index] += 1;
      mutated = true;
    }
  }

  return adjusted;
}

function createEmptyTierBands(): Record<ChunkTier, TierBand> {
  return {
    veryHard: { min: 0, max: 0 },
    hard: { min: 0, max: 0 },
    medium: { min: 0, max: 0 },
    easy: { min: 0, max: 0 },
    veryEasy: { min: 0, max: 0 },
  };
}

function createEmptyTierChunks(): Record<ChunkTier, string[]> {
  return {
    veryHard: [],
    hard: [],
    medium: [],
    easy: [],
    veryEasy: [],
  };
}

function planTierCounts(total: number): TierPlan {
  const baseCounts = ensureNonEmptyCounts(allocateCounts(total, CHUNK_TIER_WEIGHTS), total);

  if (total < MIN_TIER_SIZE * CHUNK_TIER_ORDER.length) {
    return {
      counts: baseCounts,
      warning:
        `Chunk pool has ${total} chunks; minimum tier size ${MIN_TIER_SIZE} cannot be met ` +
        `across ${CHUNK_TIER_ORDER.length} tiers.`,
    };
  }

  const relaxedCounts = tryRelaxTierCounts(baseCounts);
  const hasSmallTier = relaxedCounts.some((count) => count < MIN_TIER_SIZE);

  return {
    counts: relaxedCounts,
    warning: hasSmallTier
      ? `Chunk pool could not fully satisfy minimum tier size ${MIN_TIER_SIZE}; keeping non-empty tiers.`
      : null,
  };
}

function buildChunkPool(
  allEligibleChunks: RawChunkStat[],
  allowedLengths: readonly number[],
  label: string,
): ChunkPool {
  const lengthFiltered = allEligibleChunks.filter((stat) => allowedLengths.includes(stat.length));
  const preferredFiltered = lengthFiltered.filter((stat) => stat.preferred);
  const preferredPool =
    preferredFiltered.length >= TARGET_CHUNK_POOL_SIZE ? preferredFiltered : lengthFiltered;
  const finalStats = capChunkPool(preferredPool).sort(compareChunkStats);
  const tierPlan = planTierCounts(finalStats.length);
  const tierBands = createEmptyTierBands();
  const tierChunks = createEmptyTierChunks();
  const chunkMap = new Map<string, ChunkDescriptor>();

  let cursor = 0;

  for (let index = 0; index < CHUNK_TIER_ORDER.length; index += 1) {
    const tier = CHUNK_TIER_ORDER[index];
    const count = tierPlan.counts[index] ?? 0;
    const segment = finalStats.slice(cursor, cursor + count);

    if (segment.length > 0) {
      tierBands[tier] = {
        min: segment[0].coverage,
        max: segment[segment.length - 1].coverage,
      };

      tierChunks[tier] = segment.map((stat) => stat.chunk);

      for (const stat of segment) {
        chunkMap.set(stat.chunk, {
          chunk: stat.chunk,
          coverage: stat.coverage,
          tier,
          length: stat.length,
          preferred: stat.preferred,
        });
      }
    }

    cursor += count;
  }

  const leftovers = finalStats.slice(cursor);
  if (leftovers.length > 0) {
    const spillTier: ChunkTier = "veryEasy";
    const currentTierChunks = tierChunks[spillTier];

    for (const stat of leftovers) {
      currentTierChunks.push(stat.chunk);
      chunkMap.set(stat.chunk, {
        chunk: stat.chunk,
        coverage: stat.coverage,
        tier: spillTier,
        length: stat.length,
        preferred: stat.preferred,
      });
    }

    const lastCoverage = leftovers[leftovers.length - 1].coverage;
    tierBands[spillTier].max = Math.max(tierBands[spillTier].max, lastCoverage);
    if (tierBands[spillTier].min === 0) {
      tierBands[spillTier].min = leftovers[0].coverage;
    }
  }

  if (tierPlan.warning) {
    console.warn(`[Dictionary] ${label}: ${tierPlan.warning}`);
  }

  return {
    label,
    poolSize: chunkMap.size,
    tierBands,
    tierChunks,
    chunkMap,
  };
}

function logChunkPoolReport(pool: ChunkPool, totalWords: number): void {
  console.log(
    `[Dictionary] ${pool.label}: ${totalWords} words, ${pool.poolSize} chunks, coverage floor ${MIN_CHUNK_COVERAGE}.`,
  );
  console.log(
    `[Dictionary] ${pool.label} bands: ${CHUNK_TIER_ORDER.map((tier) => {
      const band = pool.tierBands[tier];
      return `${tier}=${band.min}-${band.max}`;
    }).join(" | ")}`,
  );

  for (const tier of CHUNK_TIER_ORDER) {
    const samples = pool.tierChunks[tier]
      .slice(0, 5)
      .map((chunk) => {
        const descriptor = pool.chunkMap.get(chunk);
        return `${chunk}(${descriptor?.coverage ?? 0})`;
      })
      .join(", ");

    console.log(
      `[Dictionary] ${pool.label} ${tier}: ${pool.tierChunks[tier].length} chunks` +
        `${samples ? ` | sample ${samples}` : ""}`,
    );
  }
}

function buildFallbackPool(label: string, includeFourLetterChunks: boolean): ChunkPool {
  const tierBands = createEmptyTierBands();
  const tierChunks = createEmptyTierChunks();
  const chunkMap = new Map<string, ChunkDescriptor>();
  const fallbackChunks = includeFourLetterChunks
    ? FALLBACK_CHUNKS
    : FALLBACK_CHUNKS.filter((chunk) => chunk.length <= 3);

  for (const chunk of fallbackChunks) {
    const descriptor: ChunkDescriptor = {
      chunk,
      coverage: MIN_CHUNK_COVERAGE,
      tier: "medium",
      length: chunk.length,
      preferred: true,
    };

    tierChunks.medium.push(chunk);
    chunkMap.set(chunk, descriptor);
  }

  return {
    label,
    poolSize: chunkMap.size,
    tierBands,
    tierChunks,
    chunkMap,
  };
}

function createDisabledDictionary(): Dictionary {
  const defaultPool = buildFallbackPool("Fallback 2-3 letter pool", false);
  const extendedPool = buildFallbackPool("Fallback 2-4 letter pool", true);

  return {
    enabled: false,
    size: 0,
    has: () => true,
    getChunkPool: (includeFourLetterChunks: boolean) =>
      includeFourLetterChunks ? extendedPool : defaultPool,
    getChunkInfo: (chunk: string, includeFourLetterChunks: boolean) =>
      (includeFourLetterChunks ? extendedPool : defaultPool).chunkMap.get(chunk.toUpperCase()) ??
      null,
  };
}

export function createDictionary(dictionaryEnabledEnv: string | undefined): Dictionary {
  const requested = dictionaryEnabledEnv !== "false";

  if (!requested) {
    console.warn("[Dictionary] Disabled via DICTIONARY_ENABLED=false. Falling back to non-dictionary validation.");
    return createDisabledDictionary();
  }

  try {
    const baseWords = readWordFile(resolveBaseWordListPath());
    const extraWords = readWordFile(path.join(__dirname, "..", "assets", "extra_words.txt"));
    const packageWords = readWordFile(wordListPath);
    const dictSet = new Set<string>([...packageWords, ...baseWords, ...extraWords]);
    const wordsArray = [...dictSet];

    if (wordsArray.length === 0) {
      throw new Error("Merged dictionary produced no words.");
    }

    const allEligibleChunks = scanChunkCoverage(wordsArray);
    const defaultPool = buildChunkPool(allEligibleChunks, DEFAULT_CHUNK_LENGTHS, "2-3 letter chunk pool");
    const extendedPool = buildChunkPool(allEligibleChunks, EXTENDED_CHUNK_LENGTHS, "2-4 letter chunk pool");

    logChunkPoolReport(defaultPool, wordsArray.length);
    logChunkPoolReport(extendedPool, wordsArray.length);

    return {
      enabled: true,
      size: dictSet.size,
      has: (word: string) => dictSet.has(normalizeDictionaryWord(word)),
      getChunkPool: (includeFourLetterChunks: boolean) =>
        includeFourLetterChunks ? extendedPool : defaultPool,
      getChunkInfo: (chunk: string, includeFourLetterChunks: boolean) =>
        (includeFourLetterChunks ? extendedPool : defaultPool).chunkMap.get(chunk.toUpperCase()) ??
        null,
    };
  } catch (error) {
    console.warn("[Dictionary] Falling back to non-dictionary validation because loading failed.", error);
    return createDisabledDictionary();
  }
}
