import fs from "node:fs";
import path from "node:path";

export interface Dictionary {
  enabled: boolean;
  size: number;
  has(word: string): boolean;
}

function loadWordFile(): Set<string> {
  const filePath = path.join(__dirname, "..", "wordlist.txt");
  const raw = fs.readFileSync(filePath, "utf8");
  const words = raw
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .filter((line) => /^[a-z]{3,}$/.test(line));
  return new Set(words);
}

export function createDictionary(dictionaryEnabledEnv: string | undefined): Dictionary {
  const requested = dictionaryEnabledEnv !== "false";

  if (!requested) {
    return {
      enabled: false,
      size: 0,
      has: () => true,
    };
  }

  try {
    const words = loadWordFile();

    if (words.size === 0) {
      return {
        enabled: false,
        size: 0,
        has: () => true,
      };
    }

    return {
      enabled: true,
      size: words.size,
      has: (word: string) => words.has(word.toLowerCase()),
    };
  } catch (error) {
    console.warn("Dictionary disabled: could not load wordlist.txt", error);

    return {
      enabled: false,
      size: 0,
      has: () => true,
    };
  }
}