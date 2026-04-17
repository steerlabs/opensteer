import * as cheerio from "cheerio";
import type { AnyNode, Element } from "domhandler";
import type { Cheerio, CheerioAPI } from "cheerio";

import {
  INTERACTIVE_ROLE_SET,
  NATIVE_INTERACTIVE_TAGS,
  OPENSTEER_BOUNDARY_ATTR,
  OPENSTEER_HIDDEN_ATTR,
  OPENSTEER_IFRAME_BOUNDARY_TAG,
  OPENSTEER_INTERACTIVE_ATTR,
  OPENSTEER_NODE_ID_ATTR,
  OPENSTEER_SCROLLABLE_ATTR,
  OPENSTEER_SELF_HIDDEN_ATTR,
  OPENSTEER_SHADOW_BOUNDARY_TAG,
  OPENSTEER_SPARSE_COUNTER_ATTR,
  ROOT_TAGS,
  hasNonNegativeTabIndex,
  isBoundaryTag,
} from "./constants.js";

const STRIP_TAGS = new Set(["script", "style", "noscript", "meta", "link", "template"]);

const TEXT_ATTR_MAX = 150;
const SRCSET_ATTR_MAX = 160;
const MIDDLE_TRUNCATED_URL_ATTRS = new Set(["href", "src"]);
const TEXT_ATTRS = new Set(["alt", "title", "aria-label", "placeholder", "value"]);
const TRUNCATION_SUFFIX = "...";
const MIDDLE_TRUNCATION_MARKER = "...";
const MIDDLE_TRUNCATION_HEAD_MAX = 40;
const MIDDLE_TRUNCATION_TAIL_MAX = 20;
const SRCSET_CANDIDATE_HEAD_MAX = 36;
const SRCSET_CANDIDATE_TAIL_MAX = 12;
const SRCSET_COMPACT_CANDIDATE_HEAD_MAX = 20;
const SRCSET_COMPACT_CANDIDATE_TAIL_MAX = 8;
const SRCSET_FALLBACK_HEAD_MAX = 56;
const SRCSET_FALLBACK_TAIL_MAX = 20;

const NOISE_SELECTORS = [
  `[${OPENSTEER_HIDDEN_ATTR}]`,
  "[hidden]",
  "[style*='display: none']",
  "[style*='display:none']",
];

interface ClickableContext {
  readonly hasPreMarked: boolean;
}

interface SrcsetCandidateSummary {
  readonly url: string;
  readonly descriptorText: string;
  readonly width: number | null;
  readonly density: number | null;
}

function compactHtml(html: string): string {
  return html
    .replace(/<!--.*?-->/gs, "")
    .replace(/>\s+</g, "><")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n")
    .replace(/\n\s*\n/g, "\n")
    .trim();
}

function getSerializedLength(value: string): number {
  let serializedLength = 0;

  for (const char of value) {
    if (char === "&") {
      serializedLength += 5;
      continue;
    }
    if (char === "<" || char === ">") {
      serializedLength += 4;
      continue;
    }
    if (char === '"') {
      serializedLength += 6;
      continue;
    }

    serializedLength += 1;
  }

  return serializedLength;
}

function takeValueWithinSerializedLength(value: string, max: number): string {
  let serializedLength = 0;
  let result = "";

  for (const char of value) {
    let nextLength = 1;
    if (char === "&") {
      nextLength = 5;
    } else if (char === "<" || char === ">") {
      nextLength = 4;
    } else if (char === '"') {
      nextLength = 6;
    }

    if (serializedLength + nextLength > max) {
      break;
    }

    result += char;
    serializedLength += nextLength;
  }

  return result;
}

function truncateValue(value: string, max: number): string {
  if (getSerializedLength(value) <= max) {
    return value;
  }

  const suffixLength = getSerializedLength(TRUNCATION_SUFFIX);
  if (suffixLength >= max) {
    return takeValueWithinSerializedLength(TRUNCATION_SUFFIX, max);
  }

  const head = takeValueWithinSerializedLength(value, max - suffixLength).replace(/\s+$/u, "");
  if (head.length === 0) {
    return TRUNCATION_SUFFIX.trimStart();
  }

  return `${head}${TRUNCATION_SUFFIX}`;
}

function takeValueWithinSerializedLengthFromEnd(value: string, max: number): string {
  let serializedLength = 0;
  const chars: string[] = [];

  for (let index = value.length - 1; index >= 0; index -= 1) {
    const char = value[index]!;

    let nextLength = 1;
    if (char === "&") {
      nextLength = 5;
    } else if (char === "<" || char === ">") {
      nextLength = 4;
    } else if (char === '"') {
      nextLength = 6;
    }

    if (serializedLength + nextLength > max) {
      break;
    }

    chars.push(char);
    serializedLength += nextLength;
  }

  return chars.reverse().join("");
}

function truncateValueInMiddle(
  value: string,
  headMax: number,
  tailMax: number,
  marker: string = MIDDLE_TRUNCATION_MARKER,
): string {
  const markerLength = getSerializedLength(marker);
  const max = headMax + markerLength + tailMax;
  if (getSerializedLength(value) <= max) {
    return value;
  }

  const head = takeValueWithinSerializedLength(value, headMax).replace(/\s+$/u, "");
  const tail = takeValueWithinSerializedLengthFromEnd(value, tailMax).replace(/^\s+/u, "");

  if (head.length === 0) {
    return tail.length === 0 ? marker : `${marker}${tail}`;
  }
  if (tail.length === 0) {
    return `${head}${marker}`;
  }

  return `${head}${marker}${tail}`;
}

function getAttrLimit(attr: string): number | undefined {
  if (attr === "srcset") {
    return SRCSET_ATTR_MAX;
  }
  if (TEXT_ATTRS.has(attr)) {
    return TEXT_ATTR_MAX;
  }
  return undefined;
}

function shouldBoundAttr(attr: string): boolean {
  return MIDDLE_TRUNCATED_URL_ATTRS.has(attr) || getAttrLimit(attr) !== undefined;
}

function setBoundedAttr(el: Cheerio<Element>, attr: string, value: string): void {
  if (MIDDLE_TRUNCATED_URL_ATTRS.has(attr)) {
    el.attr(
      attr,
      truncateValueInMiddle(value, MIDDLE_TRUNCATION_HEAD_MAX, MIDDLE_TRUNCATION_TAIL_MAX),
    );
    return;
  }

  const limit = getAttrLimit(attr);
  if (attr === "srcset" && limit !== undefined) {
    el.attr(attr, truncateSrcsetValue(value, limit));
    return;
  }

  el.attr(attr, limit === undefined ? value : truncateValue(value, limit));
}

function truncateSrcsetValue(value: string, max: number): string {
  if (getSerializedLength(value) <= max) {
    return value;
  }

  const candidates = parseSrcsetCandidates(value);
  if (candidates.length === 0) {
    return truncateValueInMiddle(value, SRCSET_FALLBACK_HEAD_MAX, SRCSET_FALLBACK_TAIL_MAX);
  }

  for (const [headMax, tailMax, includeBest] of [
    [SRCSET_CANDIDATE_HEAD_MAX, SRCSET_CANDIDATE_TAIL_MAX, true],
    [SRCSET_COMPACT_CANDIDATE_HEAD_MAX, SRCSET_COMPACT_CANDIDATE_TAIL_MAX, true],
    [SRCSET_COMPACT_CANDIDATE_HEAD_MAX, SRCSET_COMPACT_CANDIDATE_TAIL_MAX, false],
  ] as const) {
    const compact = buildTruncatedSrcsetValue(candidates, headMax, tailMax, includeBest);
    if (getSerializedLength(compact) <= max) {
      return compact;
    }
  }

  return truncateValueInMiddle(value, SRCSET_FALLBACK_HEAD_MAX, SRCSET_FALLBACK_TAIL_MAX);
}

function buildTruncatedSrcsetValue(
  candidates: readonly SrcsetCandidateSummary[],
  headMax: number,
  tailMax: number,
  includeBest: boolean,
): string {
  const kept = getPreferredSrcsetCandidateIndices(candidates, includeBest);
  const parts: string[] = [];
  let previousIndex: number | undefined;

  for (const candidateIndex of kept) {
    if (previousIndex !== undefined && candidateIndex - previousIndex > 1) {
      parts.push(MIDDLE_TRUNCATION_MARKER);
    }

    parts.push(formatSrcsetCandidate(candidates[candidateIndex]!, headMax, tailMax));
    previousIndex = candidateIndex;
  }

  return parts.join(", ");
}

function getPreferredSrcsetCandidateIndices(
  candidates: readonly SrcsetCandidateSummary[],
  includeBest: boolean,
): number[] {
  if (candidates.length === 0) {
    return [];
  }

  const kept = new Set<number>([0, candidates.length - 1]);
  if (includeBest) {
    kept.add(pickBestSrcsetCandidateIndex(candidates));
  }

  return [...kept].filter((index) => index >= 0 && index < candidates.length).sort((a, b) => a - b);
}

function pickBestSrcsetCandidateIndex(candidates: readonly SrcsetCandidateSummary[]): number {
  let bestWidthIndex = -1;
  let bestWidth = -1;
  let bestDensityIndex = -1;
  let bestDensity = -1;

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]!;

    if (
      typeof candidate.width === "number" &&
      Number.isFinite(candidate.width) &&
      candidate.width > bestWidth
    ) {
      bestWidth = candidate.width;
      bestWidthIndex = index;
    }

    if (
      typeof candidate.density === "number" &&
      Number.isFinite(candidate.density) &&
      candidate.density > bestDensity
    ) {
      bestDensity = candidate.density;
      bestDensityIndex = index;
    }
  }

  if (bestWidthIndex >= 0) {
    return bestWidthIndex;
  }
  if (bestDensityIndex >= 0) {
    return bestDensityIndex;
  }

  return candidates.length - 1;
}

function formatSrcsetCandidate(
  candidate: SrcsetCandidateSummary,
  headMax: number,
  tailMax: number,
): string {
  const url = truncateValueInMiddle(candidate.url, headMax, tailMax);
  return candidate.descriptorText ? `${url} ${candidate.descriptorText}` : url;
}

function parseSrcsetCandidates(raw: string): SrcsetCandidateSummary[] {
  const text = raw.trim();
  if (!text) {
    return [];
  }

  const out: SrcsetCandidateSummary[] = [];
  let index = 0;

  while (index < text.length) {
    index = skipSrcsetSeparators(text, index);
    if (index >= text.length) {
      break;
    }

    const urlToken = readSrcsetUrlToken(text, index);
    index = urlToken.nextIndex;
    const url = urlToken.value.trim();
    if (!url) {
      continue;
    }

    index = skipSrcsetWhitespace(text, index);
    const descriptors: string[] = [];
    while (index < text.length && text[index] !== ",") {
      const descriptorToken = readSrcsetDescriptorToken(text, index);
      if (!descriptorToken.value) {
        index = descriptorToken.nextIndex;
        continue;
      }
      descriptors.push(descriptorToken.value);
      index = descriptorToken.nextIndex;
      index = skipSrcsetWhitespace(text, index);
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
      descriptorText: descriptors.join(" "),
      width,
      density,
    });
  }

  return out;
}

function skipSrcsetWhitespace(value: string, index: number): number {
  let cursor = index;
  while (cursor < value.length && /\s/u.test(value[cursor]!)) {
    cursor += 1;
  }
  return cursor;
}

function skipSrcsetSeparators(value: string, index: number): number {
  let cursor = skipSrcsetWhitespace(value, index);
  while (cursor < value.length && value[cursor] === ",") {
    cursor += 1;
    cursor = skipSrcsetWhitespace(value, cursor);
  }
  return cursor;
}

function readSrcsetUrlToken(value: string, index: number): { value: string; nextIndex: number } {
  let cursor = index;
  let out = "";
  const isDataUrl = value
    .slice(index, index + 5)
    .toLowerCase()
    .startsWith("data:");

  while (cursor < value.length) {
    const char = value[cursor]!;
    if (/\s/u.test(char)) {
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

function readSrcsetDescriptorToken(
  value: string,
  index: number,
): { value: string; nextIndex: number } {
  let cursor = skipSrcsetWhitespace(value, index);
  let out = "";

  while (cursor < value.length) {
    const char = value[cursor]!;
    if (char === "," || /\s/u.test(char)) {
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

function removeNoise($: CheerioAPI): void {
  for (const tag of STRIP_TAGS) {
    $(tag).remove();
  }

  $(NOISE_SELECTORS.join(", ")).remove();
}

function removeComments($: CheerioAPI): void {
  $("*")
    .contents()
    .each(function removeComment(this: AnyNode) {
      if (this.type === "comment") {
        $(this).remove();
      }
    });
}

function markInlineSelfHiddenFallback($: CheerioAPI): void {
  $(
    "[style*='visibility: hidden'], [style*='visibility:hidden'], [style*='visibility: collapse'], [style*='visibility:collapse']",
  ).each(function markInlineVisibilityHidden() {
    const el = $(this as Element);
    if (el.attr(OPENSTEER_HIDDEN_ATTR) === undefined) {
      el.attr(OPENSTEER_SELF_HIDDEN_ATTR, "1");
    }
  });
}

function pruneSelfHiddenNodes($: CheerioAPI): void {
  for (const node of getElementsInReverseDocumentOrder($)) {
    if (node.attribs?.[OPENSTEER_SELF_HIDDEN_ATTR] === undefined) {
      continue;
    }

    const el = $(node);
    el.contents().each(function removeSelfHiddenText(this: AnyNode) {
      if (this.type === "text") {
        $(this).remove();
      }
    });

    if (!hasElementChildren(node)) {
      el.remove();
    }
  }
}

function getChildNodes(node: AnyNode | undefined): readonly AnyNode[] {
  return (node as { readonly children?: readonly AnyNode[] } | undefined)?.children ?? [];
}

function isElementLikeNode(node: AnyNode | undefined): node is Element {
  return node?.type === "tag" || node?.type === "script" || node?.type === "style";
}

function hasDirectText(node: Element | undefined): boolean {
  if (!node) {
    return false;
  }

  for (const child of getChildNodes(node)) {
    if (child.type === "text" && ((child as { readonly data?: string }).data || "").trim() !== "") {
      return true;
    }
  }

  return false;
}

function hasElementChildren(node: Element | undefined): boolean {
  if (!node) {
    return false;
  }

  for (const child of getChildNodes(node)) {
    if (isElementLikeNode(child)) {
      return true;
    }
  }

  return false;
}

function hasTextDeepNode(node: AnyNode | undefined): boolean {
  if (!node) {
    return false;
  }

  if (node.type === "text") {
    return ((node as { readonly data?: string }).data || "").trim() !== "";
  }

  for (const child of getChildNodes(node)) {
    if (hasTextDeepNode(child)) {
      return true;
    }
  }

  return false;
}

function hasActionLabel(attrs: Record<string, string | undefined>): boolean {
  return (
    (typeof attrs["aria-label"] === "string" && attrs["aria-label"].trim() !== "") ||
    (typeof attrs["aria-labelledby"] === "string" && attrs["aria-labelledby"].trim() !== "") ||
    (typeof attrs["aria-describedby"] === "string" && attrs["aria-describedby"].trim() !== "") ||
    (typeof attrs.title === "string" && attrs.title.trim() !== "") ||
    (typeof attrs.placeholder === "string" && attrs.placeholder.trim() !== "") ||
    (typeof attrs.value === "string" && attrs.value.trim() !== "")
  );
}

function unwrapActionNode($: CheerioAPI, el: Cheerio<Element>): void {
  if (hasTextDeepNode(el[0])) {
    if (el.prev().length > 0) {
      el.before(" ");
    }
    if (el.next().length > 0) {
      el.after(" ");
    }
  }

  el.replaceWith(el.contents());
}

function stripToAttrs(el: Cheerio<Element>, keep: Set<string>): void {
  const attrs = el.attr() || {};
  for (const attr of Object.keys(attrs)) {
    if (!keep.has(attr)) {
      el.removeAttr(attr);
      continue;
    }

    const value = el.attr(attr);
    if (typeof value !== "string") {
      continue;
    }

    if (shouldBoundAttr(attr)) {
      setBoundedAttr(el, attr, value);
    }
  }
}

function restoreBoundedAttr(el: Cheerio<Element>, attr: string, value: string | undefined): void {
  if (typeof value !== "string") {
    return;
  }

  const trimmed = value.trim();
  if (trimmed === "") {
    return;
  }

  setBoundedAttr(el, attr, value);
}

function deduplicateImagesInDom($: CheerioAPI): void {
  const seen = new Set<string>();

  $("img").each(function deduplicateDomImage() {
    const el = $(this as Element);
    if (el.attr("c") !== undefined) {
      return;
    }

    const srcValue = el.attr("src")?.trim();
    const srcsetValue = el.attr("srcset");
    const src =
      srcValue && srcValue.length > 0
        ? srcValue
        : srcsetValue?.split(",")[0]?.trim().split(/\s+/u)[0];
    if (!src) {
      return;
    }

    if (seen.has(src)) {
      el.remove();
      return;
    }

    seen.add(src);
  });
}

function hasAttribute(node: Element | undefined, attr: string): boolean {
  return node?.attribs?.[attr] !== undefined;
}

function hasPictureAncestor(node: Element | undefined): boolean {
  let current = node?.parent;
  while (current) {
    if (isElementLikeNode(current) && (current.tagName || "").toLowerCase() === "picture") {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function pictureHasPreservedDescendant(node: Element | undefined): boolean {
  if (!node) {
    return false;
  }

  for (const child of getChildNodes(node)) {
    if (!isElementLikeNode(child)) {
      continue;
    }

    const tag = (child.tagName || "").toLowerCase();
    if (tag === "img") {
      return true;
    }
    if (
      tag === "source" &&
      typeof child.attribs?.src === "string" &&
      child.attribs.src.trim() !== ""
    ) {
      return true;
    }
    if (
      tag === "source" &&
      typeof child.attribs?.srcset === "string" &&
      child.attribs.srcset.trim() !== ""
    ) {
      return true;
    }
    if (pictureHasPreservedDescendant(child)) {
      return true;
    }
  }

  return false;
}

function isPreservedImageElement(node: Element | undefined): boolean {
  const tag = (node?.tagName || "").toLowerCase();
  if (tag === "img") {
    return true;
  }

  if (tag === "picture") {
    return pictureHasPreservedDescendant(node);
  }

  if (tag === "source") {
    const inPicture = hasPictureAncestor(node);
    const hasSrc =
      (typeof node?.attribs?.src === "string" && node.attribs.src.trim() !== "") ||
      (typeof node?.attribs?.srcset === "string" && node.attribs.srcset.trim() !== "");
    return inPicture && hasSrc;
  }

  return false;
}

function getElementsInReverseDocumentOrder($: CheerioAPI): Element[] {
  return $.root()
    .find("*")
    .toArray()
    .reverse()
    .filter((node): node is Element => node.type === "tag");
}

function flattenExtractionTree($: CheerioAPI): void {
  for (const node of getElementsInReverseDocumentOrder($)) {
    const el = $(node);
    const tag = (node.tagName || "").toLowerCase();
    if (ROOT_TAGS.has(tag) || isBoundaryTag(tag) || isPreservedImageElement(node)) {
      continue;
    }

    if (tag === "a" || hasDirectText(node)) {
      continue;
    }

    if (!hasElementChildren(node)) {
      el.remove();
      continue;
    }

    el.replaceWith(el.contents());
  }
}

function isIndicatorImage(node: Element | undefined): boolean {
  return (
    (node?.tagName || "").toLowerCase() === "img" &&
    (hasAttribute(node, "alt") || hasAttribute(node, "src") || hasAttribute(node, "srcset"))
  );
}

function isIndicatorPictureSource(node: Element | undefined): boolean {
  return (
    (node?.tagName || "").toLowerCase() === "source" &&
    hasPictureAncestor(node) &&
    (hasAttribute(node, "src") || hasAttribute(node, "srcset"))
  );
}

function isSemanticIndicator(node: Element | undefined): boolean {
  const tag = (node?.tagName || "").toLowerCase();
  if (tag === "svg") {
    return true;
  }

  return (
    hasAttribute(node, "aria-label") ||
    hasAttribute(node, "title") ||
    hasAttribute(node, "data-icon") ||
    node?.attribs?.role === "img"
  );
}

function findIndicatorDescendant(root: Element | undefined): Element | undefined {
  if (!root) {
    return undefined;
  }

  let firstImage: Element | undefined;
  let firstSource: Element | undefined;
  let firstSemantic: Element | undefined;

  const visit = (node: AnyNode): boolean => {
    if (!isElementLikeNode(node)) {
      return false;
    }

    if (isIndicatorImage(node)) {
      firstImage = node;
      return true;
    }
    if (firstSource === undefined && isIndicatorPictureSource(node)) {
      firstSource = node;
    }
    if (firstSemantic === undefined && isSemanticIndicator(node)) {
      firstSemantic = node;
    }

    for (const child of getChildNodes(node)) {
      if (visit(child)) {
        return true;
      }
    }

    return false;
  };

  for (const child of getChildNodes(root)) {
    if (visit(child)) {
      return firstImage;
    }
  }

  return firstImage ?? firstSource ?? firstSemantic;
}

function serializeForExtraction($: CheerioAPI, root: AnyNode): string {
  const lines: string[] = [];

  function escapeHtml(value: string): string {
    if (!value) {
      return "";
    }

    return value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function traverse(node: AnyNode, depth: number): void {
    if (node.type === "text") {
      const text = ((node as { readonly data?: string }).data || "").replace(/\s+/g, " ").trim();
      if (text) {
        lines.push(`${"  ".repeat(depth)}${escapeHtml(text)}`);
      }
      return;
    }

    if (node.type === "comment") {
      return;
    }

    if (node.type === "root") {
      for (const child of (node as { readonly children?: readonly AnyNode[] }).children ?? []) {
        traverse(child, depth);
      }
      return;
    }

    if (node.type !== "tag" && node.type !== "script" && node.type !== "style") {
      return;
    }

    const element = node as Element;
    const tagName = element.tagName || element.name;
    if (!tagName) {
      return;
    }

    if (tagName === "html" || tagName === "head" || tagName === "body") {
      for (const child of element.children ?? []) {
        traverse(child as AnyNode, depth);
      }
      return;
    }

    const attrs = element.attribs || {};
    const attrKeys = Object.keys(attrs);
    const attrText =
      attrKeys.length === 0
        ? ""
        : ` ${attrKeys.map((key) => `${key}="${escapeHtml(attrs[key] || "")}"`).join(" ")}`;

    if (VOID_TAGS.has(tagName)) {
      lines.push(`${"  ".repeat(depth)}<${tagName}${attrText} />`);
      return;
    }

    const childNodes = (element.children || []).filter(
      (child: AnyNode) =>
        child.type !== "comment" &&
        (child.type !== "text" || ((child as { readonly data?: string }).data || "").trim() !== ""),
    );

    if (childNodes.length === 0) {
      lines.push(`${"  ".repeat(depth)}<${tagName}${attrText}></${tagName}>`);
      return;
    }

    if (childNodes.length === 1 && childNodes[0]?.type === "text") {
      const text = ((childNodes[0] as { readonly data?: string }).data || "")
        .replace(/\s+/g, " ")
        .trim();
      if (text.length < 80 && !text.includes("\n")) {
        lines.push(`${"  ".repeat(depth)}<${tagName}${attrText}>${escapeHtml(text)}</${tagName}>`);
        return;
      }
    }

    lines.push(`${"  ".repeat(depth)}<${tagName}${attrText}>`);
    for (const child of childNodes) {
      traverse(child as AnyNode, depth + 1);
    }
    lines.push(`${"  ".repeat(depth)}</${tagName}>`);
  }

  traverse(root, 0);
  return lines
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join("");
}

function isClickable(el: Cheerio<Element>, context: ClickableContext): boolean {
  if (context.hasPreMarked) {
    return el.attr(OPENSTEER_INTERACTIVE_ATTR) !== undefined;
  }

  const tag = ((el[0] as Element | undefined)?.tagName || "").toLowerCase();
  if (!tag || ROOT_TAGS.has(tag)) {
    return false;
  }

  if (NATIVE_INTERACTIVE_TAGS.has(tag)) {
    if (tag === "input" && String(el.attr("type") || "").toLowerCase() === "hidden") {
      return false;
    }

    return true;
  }

  const attrs = el.attr() || {};
  if (
    attrs.onclick !== undefined ||
    attrs.onmousedown !== undefined ||
    attrs.onmouseup !== undefined ||
    attrs["data-action"] !== undefined ||
    attrs["data-click"] !== undefined ||
    attrs["data-toggle"] !== undefined
  ) {
    return true;
  }

  if (hasNonNegativeTabIndex(attrs.tabindex)) {
    return true;
  }

  const role = String(attrs.role || "").toLowerCase();
  if (INTERACTIVE_ROLE_SET.has(role)) {
    return true;
  }

  const className = String(attrs.class || "").toLowerCase();
  const id = String(attrs.id || "").toLowerCase();
  for (const token of ["search", "magnify", "glass", "lookup", "find", "query"]) {
    if (className.includes(token) || id.includes(token)) {
      return true;
    }
  }

  return false;
}

export function prepareExtractionSnapshotDom(html: string): CheerioAPI | undefined {
  if (!html.trim()) {
    return undefined;
  }

  const $ = cheerio.load(html, { xmlMode: false });
  removeNoise($);
  removeComments($);
  markInlineSelfHiddenFallback($);
  pruneSelfHiddenNodes($);

  $("*").each(function stripAndRestoreExtractionAttrs() {
    const el = $(this as Element);
    const node = el[0];
    if (!node) {
      return;
    }

    const tag = (node.tagName || "").toLowerCase();
    const cValue = el.attr("c");
    const osBoundary = el.attr(OPENSTEER_BOUNDARY_ATTR);
    const osNodeId = el.attr(OPENSTEER_NODE_ID_ATTR);
    const osSparseCounter = el.attr(OPENSTEER_SPARSE_COUNTER_ATTR);
    const srcValue = el.attr("src");
    const srcsetValue = el.attr("srcset");
    const altValue = el.attr("alt");
    const hrefValue = el.attr("href");

    const isPictureSource =
      tag === "source" &&
      (srcValue != null || srcsetValue != null) &&
      el.parents("picture").length > 0;

    for (const attr of Object.keys(el.attr() || {})) {
      el.removeAttr(attr);
    }

    if (cValue !== undefined) {
      el.attr("c", cValue);
    }
    if (osBoundary !== undefined) {
      el.attr(OPENSTEER_BOUNDARY_ATTR, osBoundary);
    }
    if (osNodeId !== undefined) {
      el.attr(OPENSTEER_NODE_ID_ATTR, osNodeId);
    }
    if (osSparseCounter !== undefined) {
      el.attr(OPENSTEER_SPARSE_COUNTER_ATTR, osSparseCounter);
    }

    if (tag === "img") {
      restoreBoundedAttr(el, "src", srcValue);
      restoreBoundedAttr(el, "srcset", srcsetValue);
      restoreBoundedAttr(el, "alt", altValue);
    } else if (isPictureSource) {
      restoreBoundedAttr(el, "src", srcValue);
      restoreBoundedAttr(el, "srcset", srcsetValue);
    } else if (tag === "a") {
      restoreBoundedAttr(el, "href", hrefValue);
    }
  });

  flattenExtractionTree($);
  deduplicateImagesInDom($);
  return $;
}

export function serializePreparedExtractionSnapshot($: CheerioAPI): string {
  const root = $.root()[0];
  if (root === undefined) {
    return "";
  }

  return serializeForExtraction($, root);
}

export function cleanForExtraction(html: string): string {
  const prepared = prepareExtractionSnapshotDom(html);
  if (!prepared) {
    return "";
  }

  return serializePreparedExtractionSnapshot(prepared);
}

export function prepareActionSnapshotDom(html: string): CheerioAPI | undefined {
  if (!html.trim()) {
    return undefined;
  }

  const $ = cheerio.load(html, { xmlMode: false });
  removeNoise($);
  removeComments($);
  markInlineSelfHiddenFallback($);
  pruneSelfHiddenNodes($);

  const clickableMark = "data-clickable-marker";
  const indicatorMark = "data-keep-indicator";
  const context: ClickableContext = {
    hasPreMarked: $(`[${OPENSTEER_INTERACTIVE_ATTR}]`).length > 0,
  };

  $("*").each(function markClickables() {
    const el = $(this as Element);
    if (isClickable(el, context)) {
      el.attr(clickableMark, "1");
    }
  });

  $(`[${clickableMark}]`).each(function markIndicators() {
    const el = $(this as Element);
    const wrapperAttrs = el.attr() || {};
    if (hasTextDeepNode(el[0]) || hasActionLabel(wrapperAttrs)) {
      return;
    }

    const indicatorNode = findIndicatorDescendant(el[0]);
    if (indicatorNode !== undefined) {
      $(indicatorNode).attr(indicatorMark, "1");
    }
  });

  $(`[${clickableMark}]`).each(function removeEmptyClickable() {
    const el = $(this as Element);
    const node = el[0];
    const tag = (node?.tagName || "").toLowerCase();
    if (NATIVE_INTERACTIVE_TAGS.has(tag) || tag === "a") {
      return;
    }
    if (hasElementChildren(node) || hasDirectText(node)) {
      return;
    }

    const wrapperAttrs = el.attr() || {};
    if (!hasActionLabel(wrapperAttrs)) {
      el.remove();
    }
  });

  for (const node of getElementsInReverseDocumentOrder($)) {
    const el = $(node);
    const tag = (node.tagName || "").toLowerCase();
    if (ROOT_TAGS.has(tag) || isBoundaryTag(tag)) {
      continue;
    }

    if (el.attr(clickableMark) !== undefined || el.attr(indicatorMark) !== undefined) {
      continue;
    }

    const hasContent = hasElementChildren(node) || hasDirectText(node);

    if (!hasContent) {
      el.remove();
      continue;
    }

    unwrapActionNode($, el);
  }

  $.root()
    .find("*")
    .contents()
    .each(function normalizeActionTextNodes(this: AnyNode) {
      if (this.type !== "text") {
        return;
      }

      const currentText = (this as { data?: string }).data ?? "";
      const normalized = currentText.replace(/\s+/g, " ");
      if (normalized.trim() === "") {
        const previous = (this as { prev?: AnyNode | null }).prev;
        const next = (this as { next?: AnyNode | null }).next;
        if (previous != null && next != null) {
          (this as { data?: string }).data = " ";
        } else {
          $(this).remove();
        }
        return;
      }

      (this as { data?: string }).data = normalized;
    });

  $.root()
    .find("*")
    .each(function collapseActionTextRuns() {
      const parent = $(this as Element);
      const children = parent.contents().toArray();
      let run: AnyNode[] = [];

      const flush = () => {
        if (run.length === 0) {
          return;
        }

        const first = run[0];
        if (!first || first.type !== "text") {
          run = [];
          return;
        }

        const combined = run
          .map((node) => (node as { data?: string }).data ?? "")
          .join("")
          .replace(/\s+/g, " ");
        const startsParent = children[0] === first;
        const endsParent = children[children.length - 1] === run[run.length - 1];
        let normalized = combined;
        if (startsParent) {
          normalized = normalized.replace(/^\s+/, "");
        }
        if (endsParent) {
          normalized = normalized.replace(/\s+$/, "");
        }

        if (normalized === "") {
          for (const node of run) {
            $(node).remove();
          }
        } else {
          (first as { data?: string }).data = normalized;
          for (const node of run.slice(1)) {
            $(node).remove();
          }
        }

        run = [];
      };

      for (const child of children) {
        if (child.type === "text") {
          run.push(child);
          continue;
        }

        flush();
      }

      flush();
    });

  $("*").each(function stripActionAttrs() {
    const el = $(this as Element);
    const node = el[0];
    if (!node) {
      return;
    }

    const tag = (node.tagName || "").toLowerCase();
    const clickable = el.attr(clickableMark) !== undefined;
    const indicator = el.attr(indicatorMark) !== undefined;
    const keep = new Set<string>([
      "c",
      OPENSTEER_BOUNDARY_ATTR,
      OPENSTEER_NODE_ID_ATTR,
      OPENSTEER_SPARSE_COUNTER_ATTR,
    ]);

    if (clickable) {
      for (const attr of ["href", "role", "type", "title", "placeholder", "value", "aria-label"]) {
        keep.add(attr);
      }
    }

    if (indicator) {
      for (const attr of ["alt", "src", "srcset", "aria-label", "title", "data-icon", "role"]) {
        keep.add(attr);
      }
    }

    stripToAttrs(el, keep);
    if (tag === "img" && !indicator) {
      el.remove();
      return;
    }

    el.removeAttr(clickableMark);
    el.removeAttr(indicatorMark);
    el.removeAttr(OPENSTEER_INTERACTIVE_ATTR);
    el.removeAttr(OPENSTEER_HIDDEN_ATTR);
    el.removeAttr(OPENSTEER_SCROLLABLE_ATTR);
    el.removeAttr(OPENSTEER_SELF_HIDDEN_ATTR);
  });

  deduplicateImagesInDom($);
  return $;
}

export function serializePreparedActionSnapshot($: CheerioAPI): string {
  const normalized = compactHtml($.html());
  if (normalized.length === 0) {
    return "";
  }

  return cheerio.load(normalized, { xmlMode: false }).html();
}

export function cleanForAction(html: string): string {
  const prepared = prepareActionSnapshotDom(html);
  if (!prepared) {
    return "";
  }

  return serializePreparedActionSnapshot(prepared);
}

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
