import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import wordListPath from "word-list";
import { normalizeLettersOnly } from "./utils";
import { ChunkTier, TierBand } from "./types";

const MIN_WORD_LENGTH = 3;
const MAX_WORD_LENGTH = 20;
const MIN_CHUNK_COVERAGE = 1500;
const TARGET_CHUNK_POOL_SIZE = 800;
const HARD_CHUNK_POOL_SIZE = 1200;
const MIN_TIER_SIZE = 150;
const CHUNK_LENGTHS = [2, 3, 4] as const;
const DEFAULT_CHUNK_LENGTHS = [2, 3] as const;
const EXTENDED_CHUNK_LENGTHS = [2, 3, 4] as const;
const COVERAGE_BUCKET_COUNT = 5;
const FOUR_LETTER_TARGET_SHARE = 0.15;
const FOUR_LETTER_MIN_SHARE = 0.1;
const FOUR_LETTER_MAX_SHARE = 0.2;
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

type ChunkLength = (typeof CHUNK_LENGTHS)[number];

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
  length: ChunkLength;
  preferred: boolean;
}

interface TierPlan {
  counts: number[];
  warning: string | null;
}

interface DictionarySource {
  label: string;
  filePath: string;
  required: boolean;
}

interface LoadedWordSource {
  label: string;
  filePath: string;
  words: Set<string>;
  blockedCount: number;
}

function resolveAssetPath(fileName: string): string {
  return path.join(__dirname, "..", "assets", fileName);
}

function normalizeDictionaryWord(input: string): string {
  return normalizeLettersOnly(input.trim()).toUpperCase();
}

function isAllowedDictionaryWord(word: string): boolean {
  return word.length >= MIN_WORD_LENGTH && word.length <= MAX_WORD_LENGTH;
}

function hashDictionaryWord(word: string): string {
  return createHash("sha256").update(word).digest("hex");
}

function resolveBaseWordListPath(): string {
  const preferredPath = resolveAssetPath("wordlist.txt");
  if (fs.existsSync(preferredPath)) {
    return preferredPath;
  }

  return path.join(__dirname, "..", "wordlist.txt");
}

function readBlockedWords(filePath: string): Set<string> {
  if (!fs.existsSync(filePath)) {
    return new Set<string>();
  }

  return new Set(
    fs
      .readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim().toLowerCase())
      .filter((line) => /^[a-f0-9]{64}$/.test(line)),
  );
}

function readWordSource(
  definition: DictionarySource,
  blockedWords: ReadonlySet<string>,
): LoadedWordSource {
  if (!fs.existsSync(definition.filePath)) {
    if (definition.required) {
      throw new Error(`Missing required dictionary source: ${definition.filePath}`);
    }

    return {
      label: definition.label,
      filePath: definition.filePath,
      words: new Set<string>(),
      blockedCount: 0,
    };
  }

  const words = new Set<string>();
  let blockedCount = 0;

  for (const line of fs.readFileSync(definition.filePath, "utf8").split(/\r?\n/)) {
    const normalized = normalizeDictionaryWord(line);
    if (!isAllowedDictionaryWord(normalized)) {
      continue;
    }

    if (blockedWords.has(hashDictionaryWord(normalized))) {
      blockedCount += 1;
      continue;
    }

    words.add(normalized);
  }

  return {
    label: definition.label,
    filePath: definition.filePath,
    words,
    blockedCount,
  };
}

function mergeWordSources(sources: LoadedWordSource[]): {
  dictSet: Set<string>;
  wordsArray: string[];
  reports: Array<{
    label: string;
    filePath: string;
    filteredCount: number;
    uniqueAddedCount: number;
    blockedCount: number;
  }>;
} {
  const dictSet = new Set<string>();
  const reports = sources.map((source) => {
    let uniqueAddedCount = 0;

    for (const word of source.words) {
      if (!dictSet.has(word)) {
        dictSet.add(word);
        uniqueAddedCount += 1;
      }
    }

    return {
      label: source.label,
      filePath: source.filePath,
      filteredCount: source.words.size,
      uniqueAddedCount,
      blockedCount: source.blockedCount,
    };
  });

  return {
    dictSet,
    wordsArray: [...dictSet],
    reports,
  };
}

function isPreferredChunk(chunk: string): boolean {
  if (/[AEIOU]/.test(chunk)) {
    return true;
  }

  return COMMON_CONSONANT_CLUSTERS.some(
    (cluster) =>
      cluster === chunk ||
      cluster.startsWith(chunk) ||
      chunk.startsWith(cluster) ||
      chunk.endsWith(cluster),
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
        const chunk = word.slice(index, index + length);

        if (length === 4 && !isPreferredChunk(chunk)) {
          continue;
        }

        seen.add(chunk);
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
      length: chunk.length as ChunkLength,
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

function createEmptyLengthCounts(): Record<ChunkLength, number> {
  return {
    2: 0,
    3: 0,
    4: 0,
  };
}

function buildCoverageQueues(stats: RawChunkStat[]): RawChunkStat[][] {
  if (stats.length === 0) {
    return [];
  }

  const sorted = [...stats].sort(compareChunkStats);
  const bucketCount = Math.min(COVERAGE_BUCKET_COUNT, sorted.length);
  const buckets = Array.from({ length: bucketCount }, () => [] as RawChunkStat[]);

  for (let index = 0; index < sorted.length; index += 1) {
    const bucketIndex = Math.min(
      bucketCount - 1,
      Math.floor((index / Math.max(1, sorted.length - 1)) * bucketCount),
    );
    buckets[bucketIndex].push(sorted[index]);
  }

  return buckets.map((bucket) =>
    interleaveStats(
      bucket.filter((stat) => stat.preferred),
      bucket.filter((stat) => !stat.preferred),
    ),
  );
}

function selectStatsWithSpread(
  stats: RawChunkStat[],
  targetCount: number,
  existingChunks: ReadonlySet<string>,
): RawChunkStat[] {
  if (targetCount <= 0) {
    return [];
  }

  const filteredStats = stats.filter((stat) => !existingChunks.has(stat.chunk));
  if (filteredStats.length <= targetCount) {
    return [...filteredStats].sort(compareChunkStats);
  }

  const queues = buildCoverageQueues(filteredStats);
  const selected: RawChunkStat[] = [];
  const seen = new Set<string>(existingChunks);

  while (selected.length < targetCount) {
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

      if (selected.length >= targetCount) {
        break;
      }
    }

    if (!addedInRound) {
      break;
    }
  }

  return selected.sort(compareChunkStats);
}

function appendSelected(
  selected: RawChunkStat[],
  seenChunks: Set<string>,
  additions: RawChunkStat[],
): void {
  for (const stat of additions) {
    if (seenChunks.has(stat.chunk)) {
      continue;
    }

    seenChunks.add(stat.chunk);
    selected.push(stat);
  }
}

function pickPreferredSingleLength(availableCounts: Record<ChunkLength, number>): ChunkLength {
  const priority: ChunkLength[] = [3, 2, 4];

  return (
    priority.find((length) => availableCounts[length] > 0) ??
    CHUNK_LENGTHS.find((length) => availableCounts[length] > 0) ??
    3
  );
}

function allocateBaseLengthTargets(
  total: number,
  availableCounts: Record<ChunkLength, number>,
): Record<ChunkLength, number> {
  const targets = createEmptyLengthCounts();

  if (total <= 0) {
    return targets;
  }

  const availableTwo = availableCounts[2];
  const availableThree = availableCounts[3];

  if (total === 1) {
    targets[pickPreferredSingleLength(availableCounts)] = 1;
    return targets;
  }

  if (availableTwo === 0) {
    targets[3] = Math.min(total, availableThree);
    return targets;
  }

  if (availableThree === 0) {
    targets[2] = Math.min(total, availableTwo);
    return targets;
  }

  let targetThree = Math.round((total * availableThree) / Math.max(1, availableTwo + availableThree));
  targetThree = Math.max(1, Math.min(targetThree, Math.min(availableThree, total - 1)));

  let targetTwo = total - targetThree;
  targetTwo = Math.max(1, targetTwo);

  if (targetTwo > availableTwo) {
    const overflow = targetTwo - availableTwo;
    targetTwo = availableTwo;
    targetThree = Math.min(availableThree, targetThree + overflow);
  }

  if (targetThree > availableThree) {
    const overflow = targetThree - availableThree;
    targetThree = availableThree;
    targetTwo = Math.min(availableTwo, targetTwo + overflow);
  }

  targets[2] = targetTwo;
  targets[3] = targetThree;
  return targets;
}

function getMaxFourLetterTarget(total: number, availableFour: number): number {
  return Math.min(availableFour, Math.ceil(total * FOUR_LETTER_MAX_SHARE));
}

function allocateExtendedLengthTargets(
  total: number,
  availableCounts: Record<ChunkLength, number>,
): Record<ChunkLength, number> {
  const targets = createEmptyLengthCounts();

  if (total <= 0) {
    return targets;
  }

  const availableFour = availableCounts[4];
  if (availableFour > 0) {
    const minFour = Math.min(availableFour, Math.floor(total * FOUR_LETTER_MIN_SHARE));
    const maxFour = getMaxFourLetterTarget(total, availableFour);
    const preferredFour = Math.min(availableFour, Math.round(total * FOUR_LETTER_TARGET_SHARE));

    if (maxFour > 0) {
      targets[4] = Math.min(maxFour, Math.max(minFour, preferredFour));
    }
  }

  const baseTargets = allocateBaseLengthTargets(total - targets[4], availableCounts);
  targets[2] = baseTargets[2];
  targets[3] = baseTargets[3];

  let assigned = targets[2] + targets[3] + targets[4];
  if (assigned >= total) {
    return targets;
  }

  const addThree = Math.min(total - assigned, Math.max(0, availableCounts[3] - targets[3]));
  targets[3] += addThree;
  assigned += addThree;

  const addTwo = Math.min(total - assigned, Math.max(0, availableCounts[2] - targets[2]));
  targets[2] += addTwo;
  assigned += addTwo;

  const maxFour = getMaxFourLetterTarget(total, availableFour);
  const addFour = Math.min(total - assigned, Math.max(0, maxFour - targets[4]));
  targets[4] += addFour;

  return targets;
}

function buildChunkPoolStats(
  allEligibleChunks: RawChunkStat[],
  allowedLengths: readonly number[],
): RawChunkStat[] {
  const lengthFiltered = allEligibleChunks.filter((stat) => allowedLengths.includes(stat.length));
  if (lengthFiltered.length === 0) {
    return [];
  }

  const poolTarget = Math.min(lengthFiltered.length, TARGET_CHUNK_POOL_SIZE, HARD_CHUNK_POOL_SIZE);
  const statsByLength: Record<ChunkLength, RawChunkStat[]> = {
    2: [],
    3: [],
    4: [],
  };

  for (const stat of lengthFiltered) {
    statsByLength[stat.length].push(stat);
  }

  const availableCounts: Record<ChunkLength, number> = {
    2: statsByLength[2].length,
    3: statsByLength[3].length,
    4: statsByLength[4].length,
  };
  const targets = allowedLengths.includes(4)
    ? allocateExtendedLengthTargets(poolTarget, availableCounts)
    : allocateBaseLengthTargets(poolTarget, availableCounts);

  const selected: RawChunkStat[] = [];
  const seenChunks = new Set<string>();

  for (const length of allowedLengths) {
    appendSelected(selected, seenChunks, selectStatsWithSpread(statsByLength[length as ChunkLength], targets[length as ChunkLength], seenChunks));
  }

  const nonFourLeftovers = lengthFiltered.filter(
    (stat) => stat.length !== 4 && !seenChunks.has(stat.chunk),
  );
  appendSelected(
    selected,
    seenChunks,
    selectStatsWithSpread(nonFourLeftovers, poolTarget - selected.length, seenChunks),
  );

  if (allowedLengths.includes(4)) {
    const maxFourLetterTarget = getMaxFourLetterTarget(poolTarget, availableCounts[4]);
    const currentFourLetterCount = selected.filter((stat) => stat.length === 4).length;
    const fourLetterCapacity = Math.max(0, maxFourLetterTarget - currentFourLetterCount);

    if (fourLetterCapacity > 0 && selected.length < poolTarget) {
      appendSelected(
        selected,
        seenChunks,
        selectStatsWithSpread(
          statsByLength[4].filter((stat) => !seenChunks.has(stat.chunk)),
          Math.min(poolTarget - selected.length, fourLetterCapacity),
          seenChunks,
        ),
      );
    }
  }

  return selected.sort(compareChunkStats).slice(0, HARD_CHUNK_POOL_SIZE);
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
  if (total < MIN_TIER_SIZE * CHUNK_TIER_ORDER.length) {
    return {
      counts: ensureNonEmptyCounts(allocateCounts(total, CHUNK_TIER_WEIGHTS), total),
      warning:
        `Chunk pool has ${total} chunks; minimum tier size ${MIN_TIER_SIZE} cannot be met ` +
        `across ${CHUNK_TIER_ORDER.length} tiers.`,
    };
  }

  const minimumCounts = Array(CHUNK_TIER_ORDER.length).fill(MIN_TIER_SIZE);
  const remaining = total - MIN_TIER_SIZE * CHUNK_TIER_ORDER.length;
  const relaxedCounts = minimumCounts.map(
    (count, index) => count + (allocateCounts(remaining, CHUNK_TIER_WEIGHTS)[index] ?? 0),
  );
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
  const finalStats = buildChunkPoolStats(allEligibleChunks, allowedLengths);
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

function logDictionarySourceReport(
  reports: Array<{
    label: string;
    filePath: string;
    filteredCount: number;
    uniqueAddedCount: number;
    blockedCount: number;
  }>,
  totalWords: number,
  blockedWordsCount: number,
): void {
  console.log(`[Dictionary] Total dictionary words after normalization: ${totalWords}.`);

  for (const report of reports) {
    console.log(
      `[Dictionary] ${report.label}: ${report.filteredCount} words after filtering, ` +
        `${report.uniqueAddedCount} added to merged dictionary` +
        `${report.blockedCount > 0 ? `, ${report.blockedCount} blocked` : ""}.`,
    );
  }

  console.log(`[Dictionary] Blocklist size: ${blockedWordsCount}.`);

  const attachedWordsReport = reports.find((report) => report.label === "repo words.txt");
  if (attachedWordsReport) {
    console.log(
      `[Dictionary] words.txt loaded successfully from ${attachedWordsReport.filePath}.`,
    );
  }
}

function logChunkPoolReport(pool: ChunkPool, totalWords: number): void {
  const countsByLength = createEmptyLengthCounts();

  for (const descriptor of pool.chunkMap.values()) {
    countsByLength[descriptor.length as ChunkLength] += 1;
  }

  console.log(
    `[Dictionary] ${pool.label}: ${totalWords} words, ${pool.poolSize} chunks ` +
      `(target ${TARGET_CHUNK_POOL_SIZE}, hard cap ${HARD_CHUNK_POOL_SIZE}), ` +
      `lengths 2=${countsByLength[2]} 3=${countsByLength[3]} 4=${countsByLength[4]}, ` +
      `coverage floor ${MIN_CHUNK_COVERAGE}.`,
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
    console.warn(
      "[Dictionary] Disabled via DICTIONARY_ENABLED=false. Falling back to non-dictionary validation.",
    );
    return createDisabledDictionary();
  }

  try {
    const blockedWords = readBlockedWords(resolveAssetPath("blocked_words.txt"));
    const sources = [
      readWordSource(
        {
          label: "package word-list",
          filePath: wordListPath,
          required: true,
        },
        blockedWords,
      ),
      readWordSource(
        {
          label: "base word list",
          filePath: resolveBaseWordListPath(),
          required: true,
        },
        blockedWords,
      ),
      readWordSource(
        {
          label: "extra words",
          filePath: resolveAssetPath("extra_words.txt"),
          required: false,
        },
        blockedWords,
      ),
      readWordSource(
        {
          label: "repo words.txt",
          filePath: resolveAssetPath("words.txt"),
          required: true,
        },
        blockedWords,
      ),
    ];
    const { dictSet, wordsArray, reports } = mergeWordSources(sources);

    if (wordsArray.length === 0) {
      throw new Error("Merged dictionary produced no words.");
    }

    logDictionarySourceReport(reports, dictSet.size, blockedWords.size);

    const allEligibleChunks = scanChunkCoverage(wordsArray);
    const defaultPool = buildChunkPool(
      allEligibleChunks,
      DEFAULT_CHUNK_LENGTHS,
      "2-3 letter chunk pool",
    );
    const extendedPool = buildChunkPool(
      allEligibleChunks,
      EXTENDED_CHUNK_LENGTHS,
      "2-4 letter chunk pool",
    );

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
    console.warn(
      "[Dictionary] Falling back to non-dictionary validation because loading failed.",
      error,
    );
    return createDisabledDictionary();
  }
}
