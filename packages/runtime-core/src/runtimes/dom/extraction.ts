import type { DomArrayFieldSelector, DomExtractFieldSelector, ElementPath } from "./types.js";
import { buildPathCandidates } from "./match-selectors.js";

const URL_LIST_ATTRIBUTES = new Set(["srcset", "imagesrcset", "ping"]);
const IFRAME_URL_ATTRIBUTES = new Set([
  "href",
  "src",
  "srcset",
  "imagesrcset",
  "action",
  "formaction",
  "poster",
  "ping",
]);

interface SrcsetCandidate {
  readonly url: string;
  readonly width: number | null;
  readonly density: number | null;
}

export function buildArrayFieldPathCandidates(path: ElementPath): string[] {
  const strict = path.nodes.length ? buildPathCandidates(path.nodes) : [];
  const relaxedNodes = stripPositionClauses(path.nodes);
  const relaxed = relaxedNodes.length ? buildPathCandidates(relaxedNodes) : [];
  return dedupeSelectors([...strict, ...relaxed]);
}

export function isCurrentUrlField(field: DomExtractFieldSelector | DomArrayFieldSelector): boolean {
  return field.source === "current_url";
}

export function normalizeExtractedValue(raw: unknown, attribute?: string): string | null {
  if (raw == null) {
    return null;
  }

  const rawText = String(raw);
  if (!rawText.trim()) {
    return null;
  }

  const normalizedAttribute = String(attribute || "")
    .trim()
    .toLowerCase();

  if (URL_LIST_ATTRIBUTES.has(normalizedAttribute)) {
    const singleValue = pickSingleListAttributeValue(normalizedAttribute, rawText).trim();
    return singleValue || null;
  }

  const text = rawText.replace(/\s+/g, " ").trim();
  return text || null;
}

export function resolveExtractedValueInContext(
  normalizedValue: string | null,
  options: {
    readonly attribute?: string;
    readonly baseURI?: string | null;
    readonly insideIframe?: boolean;
  },
): string | null {
  if (normalizedValue == null) {
    return null;
  }

  const normalizedAttribute = String(options.attribute || "")
    .trim()
    .toLowerCase();

  if (!options.insideIframe) {
    return normalizedValue;
  }
  if (!IFRAME_URL_ATTRIBUTES.has(normalizedAttribute)) {
    return normalizedValue;
  }

  const baseURI = String(options.baseURI || "").trim();
  if (!baseURI) {
    return normalizedValue;
  }

  try {
    return new URL(normalizedValue, baseURI).href;
  } catch {
    return normalizedValue;
  }
}

function stripPositionClauses(nodes: ElementPath["nodes"]): ElementPath["nodes"] {
  return (nodes || []).map((node) => ({
    ...node,
    match: (node.match || []).filter(
      (clause) => clause.kind !== "position" && clause.kind !== "text",
    ),
  }));
}

function dedupeSelectors(selectors: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const selector of selectors) {
    if (!selector || seen.has(selector)) {
      continue;
    }
    seen.add(selector);
    out.push(selector);
  }
  return out;
}

function pickSingleListAttributeValue(attribute: string, raw: string): string {
  if (attribute === "ping") {
    const firstUrl = raw.trim().split(/\s+/)[0] || "";
    return firstUrl.trim();
  }

  if (attribute === "srcset" || attribute === "imagesrcset") {
    const picked = pickBestSrcsetCandidate(raw);
    if (picked) {
      return picked;
    }
    return pickFirstSrcsetToken(raw) || "";
  }

  return raw.trim();
}

function pickBestSrcsetCandidate(raw: string): string | null {
  const candidates = parseSrcsetCandidates(raw);
  if (!candidates.length) {
    return null;
  }

  const widthCandidates = candidates.filter(hasWidth);
  if (widthCandidates.length) {
    return widthCandidates.reduce((best, candidate) =>
      candidate.width > best.width ? candidate : best,
    ).url;
  }

  const densityCandidates = candidates.filter(hasDensity);
  if (densityCandidates.length) {
    return densityCandidates.reduce((best, candidate) =>
      candidate.density > best.density ? candidate : best,
    ).url;
  }

  return candidates[0]?.url || null;
}

function parseSrcsetCandidates(raw: string): SrcsetCandidate[] {
  const text = String(raw || "").trim();
  if (!text) {
    return [];
  }

  const out: SrcsetCandidate[] = [];
  let index = 0;

  while (index < text.length) {
    index = skipSeparators(text, index);
    if (index >= text.length) {
      break;
    }

    const urlToken = readUrlToken(text, index);
    index = urlToken.nextIndex;
    const url = urlToken.value.trim();
    if (!url) {
      continue;
    }

    index = skipWhitespace(text, index);
    const descriptors: string[] = [];
    while (index < text.length && text[index] !== ",") {
      const descriptorToken = readDescriptorToken(text, index);
      if (!descriptorToken.value) {
        index = descriptorToken.nextIndex;
        continue;
      }
      descriptors.push(descriptorToken.value);
      index = descriptorToken.nextIndex;
      index = skipWhitespace(text, index);
    }
    if (index < text.length && text[index] === ",") {
      index += 1;
    }

    let width: number | null = null;
    let density: number | null = null;
    for (const descriptor of descriptors) {
      const token = descriptor.trim().toLowerCase();
      if (!token) {
        continue;
      }

      const widthMatch = token.match(/^(\d+)w$/);
      if (widthMatch) {
        const parsed = Number.parseInt(widthMatch[1]!, 10);
        if (Number.isFinite(parsed)) {
          width = parsed;
        }
        continue;
      }

      const densityMatch = token.match(/^(\d*\.?\d+)x$/);
      if (densityMatch) {
        const parsed = Number.parseFloat(densityMatch[1]!);
        if (Number.isFinite(parsed)) {
          density = parsed;
        }
      }
    }

    out.push({
      url,
      width,
      density,
    });
  }

  return out;
}

function hasWidth(
  candidate: SrcsetCandidate,
): candidate is SrcsetCandidate & { readonly width: number } {
  return (
    typeof candidate.width === "number" && Number.isFinite(candidate.width) && candidate.width > 0
  );
}

function hasDensity(
  candidate: SrcsetCandidate,
): candidate is SrcsetCandidate & { readonly density: number } {
  return (
    typeof candidate.density === "number" &&
    Number.isFinite(candidate.density) &&
    candidate.density > 0
  );
}

function pickFirstSrcsetToken(raw: string): string | null {
  const candidate = parseSrcsetCandidates(raw)[0];
  if (candidate?.url) {
    return candidate.url;
  }

  const text = String(raw || "");
  const start = skipSeparators(text, 0);
  if (start >= text.length) {
    return null;
  }

  const firstToken = readUrlToken(text, start).value.trim();
  return firstToken || null;
}

function skipWhitespace(value: string, index: number): number {
  let cursor = index;
  while (cursor < value.length && /\s/.test(value[cursor]!)) {
    cursor += 1;
  }
  return cursor;
}

function skipSeparators(value: string, index: number): number {
  let cursor = skipWhitespace(value, index);
  while (cursor < value.length && value[cursor] === ",") {
    cursor += 1;
    cursor = skipWhitespace(value, cursor);
  }
  return cursor;
}

function readUrlToken(value: string, index: number): { value: string; nextIndex: number } {
  let cursor = index;
  let out = "";
  const isDataUrl = value
    .slice(index, index + 5)
    .toLowerCase()
    .startsWith("data:");

  while (cursor < value.length) {
    const char = value[cursor]!;
    if (/\s/.test(char)) {
      break;
    }
    if (char === "," && !isDataUrl) {
      break;
    }
    out += char;
    cursor += 1;
  }

  if (isDataUrl && out.endsWith(",") && cursor < value.length) {
    out = out.slice(0, -1);
  }

  return {
    value: out,
    nextIndex: cursor,
  };
}

function readDescriptorToken(value: string, index: number): { value: string; nextIndex: number } {
  let cursor = skipWhitespace(value, index);
  let out = "";

  while (cursor < value.length) {
    const char = value[cursor]!;
    if (char === "," || /\s/.test(char)) {
      break;
    }
    out += char;
    cursor += 1;
  }

  return {
    value: out.trim(),
    nextIndex: cursor,
  };
}
