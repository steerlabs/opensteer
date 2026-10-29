export interface IntegrationSearchable {
  readonly installation: {
    readonly description: string;
    readonly name: string;
    readonly title: string;
  };
  readonly servers: readonly {
    readonly connectionRequirement: {
      readonly kind: string;
      readonly provider?: string;
    };
    readonly name: string;
  }[];
  readonly skills: readonly {
    readonly description: string;
    readonly name: string;
  }[];
  readonly tools: readonly {
    readonly description: string;
    readonly name: string;
    readonly title: string;
  }[];
}

const ignoredQueryTerms = new Set([
  "a",
  "account",
  "an",
  "and",
  "can",
  "connect",
  "connected",
  "connection",
  "for",
  "find",
  "from",
  "get",
  "in",
  "integration",
  "is",
  "it",
  "latest",
  "me",
  "my",
  "of",
  "on",
  "please",
  "read",
  "retrieve",
  "search",
  "show",
  "summarize",
  "the",
  "to",
  "tool",
  "tools",
  "use",
  "using",
  "want",
  "with",
  "you",
]);

export function searchIntegrationInventory<T extends IntegrationSearchable>(
  inventory: readonly T[],
  query: string,
  limit = 10,
): readonly T[] {
  const cappedLimit = Math.min(20, Math.max(1, limit));
  const normalizedQuery = normalizeText(query);
  const terms = integrationSearchTerms(query).slice(0, 24);
  const scored = inventory.map((entry) => ({
    entry,
    ...scoreEntry(entry, normalizedQuery, terms),
  }));
  const exactIdentityMatches = scored.filter(({ identityMatch }) => identityMatch);
  const bestMatchedTermCount = Math.max(
    ...scored.map((candidate) => candidate.matchedTermCount),
    0,
  );
  const candidates =
    exactIdentityMatches.length > 0
      ? exactIdentityMatches
      : scored.filter(({ matchedTermCount, score }) => {
          if (terms.length === 0) return true;
          return score > 0 && matchedTermCount === bestMatchedTermCount;
        });

  return candidates
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.entry.installation.title.localeCompare(right.entry.installation.title, "en", {
          sensitivity: "base",
        }) ||
        left.entry.installation.name.localeCompare(right.entry.installation.name),
    )
    .slice(0, cappedLimit)
    .map(({ entry }) => entry);
}

export function integrationSearchTerms(query: string): readonly string[] {
  const rawTerms = tokens(query);
  const meaningfulTerms = rawTerms.filter((term) => !ignoredQueryTerms.has(term));
  return meaningfulTerms.length > 0 ? meaningfulTerms : rawTerms;
}

function scoreEntry(
  entry: IntegrationSearchable,
  normalizedQuery: string,
  terms: readonly string[],
): {
  readonly identityMatch: boolean;
  readonly matchedTermCount: number;
  readonly score: number;
} {
  const identity = [entry.installation.name, entry.installation.title];
  const providers = entry.servers.flatMap(({ connectionRequirement }) =>
    connectionRequirement.provider ? [connectionRequirement.provider] : [],
  );
  const serverNames = entry.servers.map(({ name }) => name);
  const skillNames = entry.skills.map(({ name }) => name);
  const toolNames = entry.tools.flatMap(({ name, title }) => [name, title]);
  const descriptions = [
    entry.installation.description,
    ...entry.skills.map(({ description }) => description),
    ...entry.tools.map(({ description }) => description),
  ];
  const weightedFields = [
    { values: identity, weight: 120 },
    { values: providers, weight: 100 },
    { values: serverNames, weight: 65 },
    { values: skillNames, weight: 60 },
    { values: toolNames, weight: 55 },
    { values: descriptions, weight: 15 },
  ] as const;

  const identityMatch = identity.some((value) =>
    containsPhrase(normalizedQuery, normalizeText(value)),
  );
  let score = identityMatch ? 1_000 : 0;
  let matchedTermCount = 0;
  for (const term of terms) {
    let termMatched = false;
    for (const field of weightedFields) {
      const quality = Math.max(...field.values.map((value) => matchQuality(value, term)), 0);
      score += field.weight * quality;
      termMatched ||= quality > 0;
    }
    matchedTermCount += termMatched ? 1 : 0;
  }
  return { identityMatch, matchedTermCount, score };
}

function matchQuality(value: string, term: string): number {
  const valueTokens = tokens(value);
  if (valueTokens.includes(term)) return 1;
  if (
    term.length >= 4 &&
    valueTokens.some(
      (valueToken) =>
        valueToken.length >= 4 && (valueToken.startsWith(term) || term.startsWith(valueToken)),
    )
  ) {
    return 0.5;
  }
  return 0;
}

function containsPhrase(haystack: string, needle: string): boolean {
  return needle !== "" && ` ${haystack} `.includes(` ${needle} `);
}

function tokens(value: string): string[] {
  return [
    ...new Set(
      normalizeText(value)
        .split(" ")
        .map((term) => term.trim())
        .filter(Boolean),
    ),
  ];
}

function normalizeText(value: string): string {
  return value
    .normalize("NFKD")
    .replaceAll(/\p{M}/gu, "")
    .toLocaleLowerCase("en-US")
    .replaceAll(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
