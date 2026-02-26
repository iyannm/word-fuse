import fs from "node:fs";
import path from "node:path";
import wordListPath from "word-list";

export interface Dictionary {
  enabled: boolean;
  size: number;
  has(word: string): boolean;
  hasAnyForChunk(chunk: string, usedWords: Set<string>): boolean;
}

function parseWords(raw: string): Set<string> {
  const words = raw
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .filter((line) => /^[a-z]{3,}$/.test(line));
  return new Set(words);
}

function loadLocalWordFile(): Set<string> {
  const filePath = path.join(__dirname, "..", "wordlist.txt");
  const raw = fs.readFileSync(filePath, "utf8");
  return parseWords(raw);
}

function loadPackageWordFile(): Set<string> {
  const raw = fs.readFileSync(wordListPath, "utf8");
  return parseWords(raw);
}

export function createDictionary(dictionaryEnabledEnv: string | undefined): Dictionary {
  const requested = dictionaryEnabledEnv !== "false";

  if (!requested) {
    return {
      enabled: false,
      size: 0,
      has: () => true,
      hasAnyForChunk: () => true,
    };
  }

  try {
    const localWords = loadLocalWordFile();
    const packageWords = loadPackageWordFile();
    const words = new Set<string>([...packageWords, ...localWords]);
    const chunkCache = new Map<string, string[]>();

    if (words.size === 0) {
      return {
        enabled: false,
        size: 0,
        has: () => true,
        hasAnyForChunk: () => true,
      };
    }

    const wordsArray = [...words];
    const wordsForChunk = (chunkInput: string): string[] => {
      const chunk = chunkInput.toLowerCase();
      const cached = chunkCache.get(chunk);
      if (cached) {
        return cached;
      }

      const matched = wordsArray.filter((word) => word.includes(chunk));
      chunkCache.set(chunk, matched);
      return matched;
    };

    return {
      enabled: true,
      size: words.size,
      has: (word: string) => words.has(word.toLowerCase()),
      hasAnyForChunk: (chunk: string, usedWords: Set<string>) => {
        const candidates = wordsForChunk(chunk);
        if (candidates.length === 0) {
          return false;
        }

        if (usedWords.size === 0) {
          return true;
        }

        return candidates.some((word) => !usedWords.has(word));
      },
    };
  } catch (error) {
    console.warn("Dictionary disabled: could not load a word list", error);

    return {
      enabled: false,
      size: 0,
      has: () => true,
      hasAnyForChunk: () => true,
    };
  }
}
