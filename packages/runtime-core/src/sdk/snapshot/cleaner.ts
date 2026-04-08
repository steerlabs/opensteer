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
const URL_ATTR_MAX = 500;
const URL_ATTRS = new Set(["href", "src", "srcset"]);
const TEXT_ATTRS = new Set(["alt", "title", "aria-label", "placeholder", "value"]);
const TRUNCATION_SUFFIX = " [truncated]";

const NOISE_SELECTORS = [
  `[${OPENSTEER_HIDDEN_ATTR}]`,
  "[hidden]",
  "[style*='display: none']",
  "[style*='display:none']",
];

interface ClickableContext {
  readonly hasPreMarked: boolean;
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

function getAttrLimit(attr: string): number | undefined {
  if (URL_ATTRS.has(attr)) {
    return URL_ATTR_MAX;
  }
  if (TEXT_ATTRS.has(attr)) {
    return TEXT_ATTR_MAX;
  }
  return undefined;
}

function setBoundedAttr(el: Cheerio<Element>, attr: string, value: string): void {
  const limit = getAttrLimit(attr);
  el.attr(attr, limit === undefined ? value : truncateValue(value, limit));
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
  const nodes: Cheerio<Element>[] = [];
  $(`[${OPENSTEER_SELF_HIDDEN_ATTR}]`).each(function collectSelfHiddenNodes() {
    nodes.push($(this as Element));
  });
  nodes.sort((left, right) => right.parents().length - left.parents().length);

  for (const el of nodes) {
    if (!el[0]) {
      continue;
    }

    el.contents().each(function removeSelfHiddenText(this: AnyNode) {
      if (this.type === "text") {
        $(this).remove();
      }
    });

    if (el.children().length === 0) {
      el.remove();
    }
  }
}

function hasDirectText($: CheerioAPI, el: Cheerio<Element>): boolean {
  return (
    el.contents().filter(function hasDirectNodeText(this: AnyNode) {
      return this.type === "text" && $(this).text().trim() !== "";
    }).length > 0
  );
}

function hasTextDeep(el: Cheerio<Element>): boolean {
  return el.text().trim().length > 0;
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
  if (hasTextDeep(el)) {
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

    if (getAttrLimit(attr) !== undefined) {
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

function deduplicateImages(html: string): string {
  const seen = new Set<string>();

  return html.replace(/<img\b([^>]*)>/gi, (full, attrContent) => {
    const srcMatch = attrContent.match(/\bsrc\s*=\s*(["']?)(.*?)\1/);
    const srcsetMatch = attrContent.match(/\bsrcset\s*=\s*(["'])(.*?)\1/);

    let src: string | null = null;
    if (srcMatch && srcMatch[2]) {
      src = srcMatch[2].trim();
    } else if (srcsetMatch && srcsetMatch[2]) {
      src = srcsetMatch[2].split(",")[0]?.trim().split(" ")[0] ?? null;
    }

    if (!src) {
      return full;
    }
    if (seen.has(src)) {
      return "";
    }

    seen.add(src);
    return full;
  });
}

function isPreservedImageElement($: CheerioAPI, el: Cheerio<Element>): boolean {
  const tag = ((el[0] as Element | undefined)?.tagName || "").toLowerCase();
  if (tag === "img") {
    return true;
  }

  if (tag === "picture") {
    const hasImg = el.find("img").length > 0;
    const hasSource = el.find("source[src], source[srcset]").length > 0;
    return hasImg || hasSource;
  }

  if (tag === "source") {
    const inPicture = el.parents("picture").length > 0;
    const hasSrc =
      (el.attr("src") != null && el.attr("src")!.trim() !== "") ||
      (el.attr("srcset") != null && el.attr("srcset")!.trim() !== "");
    return inPicture && hasSrc;
  }

  return false;
}

function flattenExtractionTree($: CheerioAPI): void {
  const flatten = (root: Cheerio<AnyNode>): void => {
    root.find("*").each(function flattenNode() {
      const el = $(this as Element);
      const node = el[0];
      if (!node) {
        return;
      }

      const tag = (node.tagName || "").toLowerCase();
      if (ROOT_TAGS.has(tag) || isBoundaryTag(tag)) {
        return;
      }

      if (isPreservedImageElement($, el)) {
        return;
      }

      if (tag === "a") {
        el.children().each(function flattenAnchorChild() {
          flatten($(this as Element));
        });
        return;
      }

      const hasText = hasDirectText($, el);
      if (hasText) {
        return;
      }

      if (el.children().length === 0) {
        el.remove();
        return;
      }

      el.children().each(function flattenChild() {
        flatten($(this as Element));
      });
      el.replaceWith(el.contents());
    });
  };

  flatten($.root());
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
  return lines.join("\n");
}

function isClickable($: CheerioAPI, el: Cheerio<Element>, context: ClickableContext): boolean {
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

export function cleanForExtraction(html: string): string {
  if (!html.trim()) {
    return "";
  }

  const $ = cheerio.load(html, { xmlMode: false });
  removeNoise($);
  removeComments($);
  markInlineSelfHiddenFallback($);
  pruneSelfHiddenNodes($);

  const $clean = cheerio.load(
    $.html()
      .replace(/\n{2,}/g, "\n")
      .trim(),
    { xmlMode: false },
  );

  $clean("*").each(function stripAndRestoreExtractionAttrs() {
    const el = $clean(this as Element);
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

  flattenExtractionTree($clean);
  return deduplicateImages(serializeForExtraction($clean, $clean.root()[0] as unknown as AnyNode));
}

export function cleanForAction(html: string): string {
  if (!html.trim()) {
    return "";
  }

  const $ = cheerio.load(html, { xmlMode: false });
  removeNoise($);
  removeComments($);
  markInlineSelfHiddenFallback($);
  pruneSelfHiddenNodes($);

  const clickableMark = "data-clickable-marker";
  const indicatorMark = "data-keep-indicator";
  const branchMark = "data-keep-branch";
  const context: ClickableContext = {
    hasPreMarked: $(`[${OPENSTEER_INTERACTIVE_ATTR}]`).length > 0,
  };

  $("*").each(function markClickables() {
    const el = $(this as Element);
    if (isClickable($, el, context)) {
      el.attr(clickableMark, "1");
    }
  });

  $(`[${clickableMark}]`).each(function markIndicators() {
    const el = $(this as Element);
    const wrapperAttrs = el.attr() || {};
    if (hasTextDeep(el) || hasActionLabel(wrapperAttrs)) {
      return;
    }

    const imageIndicator = el.find("img[alt], img[src], img[srcset]").first();
    if (imageIndicator.length) {
      imageIndicator.attr(indicatorMark, "1");
      return;
    }

    const pictureSourceIndicator = el.find("picture source[src], picture source[srcset]").first();
    if (pictureSourceIndicator.length) {
      pictureSourceIndicator.attr(indicatorMark, "1");
      return;
    }

    const semanticIndicator = el
      .find('[aria-label], [title], [data-icon], [role="img"], svg')
      .first();
    if (semanticIndicator.length) {
      semanticIndicator.attr(indicatorMark, "1");
    }
  });

  $(`[${clickableMark}]`).each(function removeEmptyClickable() {
    const el = $(this as Element);
    const node = el[0];
    const tag = (node?.tagName || "").toLowerCase();
    if (NATIVE_INTERACTIVE_TAGS.has(tag) || tag === "a") {
      return;
    }
    if (el.children().length > 0 || hasDirectText($, el)) {
      return;
    }

    const wrapperAttrs = el.attr() || {};
    if (!hasActionLabel(wrapperAttrs)) {
      el.remove();
    }
  });

  $(`[${clickableMark}], [${indicatorMark}]`).each(function markBranches() {
    let current = $(this as Element).parent();

    while (current.length > 0) {
      const node = current[0];
      if (!node || node.type !== "tag") {
        break;
      }

      const ancestor = current as Cheerio<Element>;
      const tag = (((node as Element).tagName || "") as string).toLowerCase();
      if (ROOT_TAGS.has(tag) || ancestor.attr(clickableMark) !== undefined) {
        break;
      }

      if (!isBoundaryTag(tag)) {
        ancestor.attr(branchMark, "1");
      }
      current = ancestor.parent();
    }
  });

  let changed = true;
  while (changed) {
    changed = false;
    const nodes: Cheerio<Element>[] = [];
    $("*").each(function collectNodes() {
      nodes.push($(this as Element));
    });
    nodes.sort((left, right) => right.parents().length - left.parents().length);

    for (const el of nodes) {
      const node = el[0];
      if (!node) {
        continue;
      }

      const tag = (node.tagName || "").toLowerCase();
      if (ROOT_TAGS.has(tag) || isBoundaryTag(tag)) {
        continue;
      }

      if (el.attr(clickableMark) !== undefined || el.attr(indicatorMark) !== undefined) {
        continue;
      }

      const insideClickable = el.parents(`[${clickableMark}]`).length > 0;
      const preserveBranch = el.attr(branchMark) !== undefined;
      const hasContent = el.children().length > 0 || hasDirectText($, el);

      if (insideClickable || preserveBranch) {
        if (!hasContent) {
          el.remove();
        } else {
          unwrapActionNode($, el);
        }
        changed = true;
        continue;
      }

      if (!hasContent) {
        el.remove();
        changed = true;
        continue;
      }

      unwrapActionNode($, el);
      changed = true;
    }
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
      for (const attr of [
        "href",
        "role",
        "type",
        "title",
        "placeholder",
        "value",
        "aria-label",
        "aria-labelledby",
        "aria-describedby",
        "aria-expanded",
        "aria-pressed",
        "aria-selected",
        "aria-haspopup",
      ]) {
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
    el.removeAttr(branchMark);
    el.removeAttr(OPENSTEER_INTERACTIVE_ATTR);
    el.removeAttr(OPENSTEER_HIDDEN_ATTR);
    el.removeAttr(OPENSTEER_SCROLLABLE_ATTR);
    el.removeAttr(OPENSTEER_SELF_HIDDEN_ATTR);
  });

  return compactHtml(deduplicateImages($.html()));
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
