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
  OPENSTEER_SHADOW_BOUNDARY_TAG,
  OPENSTEER_UNAVAILABLE_ATTR,
  ROOT_TAGS,
  hasNonNegativeTabIndex,
  isBoundaryTag,
} from "./constants.js";

const STRIP_TAGS = new Set(["script", "style", "noscript", "meta", "link", "template"]);

const TEXT_ATTR_MAX = 150;
const URL_ATTR_MAX = 500;

const NOISE_SELECTORS = [
  `[${OPENSTEER_HIDDEN_ATTR}]`,
  "[hidden]",
  "[style*='display: none']",
  "[style*='display:none']",
  "[style*='visibility: hidden']",
  "[style*='visibility:hidden']",
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

function truncateValue(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }

  return value.slice(0, max);
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

    if (attr === "href" || attr === "src" || attr === "srcset") {
      el.attr(attr, truncateValue(value, URL_ATTR_MAX));
      continue;
    }

    if (
      attr === "alt" ||
      attr === "title" ||
      attr === "aria-label" ||
      attr === "placeholder" ||
      attr === "value"
    ) {
      el.attr(attr, truncateValue(value, TEXT_ATTR_MAX));
    }
  }
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

  function escapeAttribute(value: string): string {
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
        : ` ${attrKeys.map((key) => `${key}="${escapeAttribute(attrs[key] || "")}"`).join(" ")}`;

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
    const osUnavailable = el.attr(OPENSTEER_UNAVAILABLE_ATTR);
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
    if (osUnavailable !== undefined) {
      el.attr(OPENSTEER_UNAVAILABLE_ATTR, osUnavailable);
    }

    if (tag === "img") {
      if (srcValue) {
        el.attr("src", srcValue);
      }
      if (srcsetValue) {
        el.attr("srcset", srcsetValue);
      }
      if (altValue) {
        el.attr("alt", truncateValue(altValue, TEXT_ATTR_MAX));
      }
    } else if (isPictureSource) {
      if (srcValue != null && srcValue.trim() !== "") {
        el.attr("src", srcValue);
      }
      if (srcsetValue != null && srcsetValue.trim() !== "") {
        el.attr("srcset", srcsetValue);
      }
    } else if (tag === "a" && hrefValue) {
      el.attr("href", hrefValue);
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

  const clickableMark = "data-clickable-marker";
  const indicatorMark = "data-keep-indicator";
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
    if (hasTextDeep(el)) {
      return;
    }

    const wrapperAttrs = el.attr() || {};
    const hasWrapperIndicator =
      (typeof wrapperAttrs["aria-label"] === "string" &&
        wrapperAttrs["aria-label"].trim() !== "") ||
      (typeof wrapperAttrs.title === "string" && wrapperAttrs.title.trim() !== "");
    if (hasWrapperIndicator) {
      return;
    }

    const imageIndicator = el.find("img[alt], img[src], img[srcset]").first();
    if (imageIndicator.length) {
      imageIndicator.attr(indicatorMark, "1");
      return;
    }

    const semanticIndicator = el
      .find('[aria-label], [title], [data-icon], [role="img"], svg')
      .first();
    if (semanticIndicator.length) {
      semanticIndicator.attr(indicatorMark, "1");
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

      if (
        el.attr(clickableMark) !== undefined ||
        el.attr(indicatorMark) !== undefined ||
        hasDirectText($, el)
      ) {
        continue;
      }

      if (el.children().length === 0) {
        el.remove();
        changed = true;
        continue;
      }

      el.replaceWith(el.contents());
      changed = true;
    }
  }

  $("*").each(function stripActionAttrs() {
    const el = $(this as Element);
    const node = el[0];
    if (!node) {
      return;
    }

    const tag = (node.tagName || "").toLowerCase();
    const clickable = el.attr(clickableMark) !== undefined;
    const indicator = el.attr(indicatorMark) !== undefined;
    const keep = new Set<string>(["c", OPENSTEER_BOUNDARY_ATTR, OPENSTEER_UNAVAILABLE_ATTR]);

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
    el.removeAttr(OPENSTEER_INTERACTIVE_ATTR);
    el.removeAttr(OPENSTEER_HIDDEN_ATTR);
    el.removeAttr(OPENSTEER_SCROLLABLE_ATTR);
    el.removeAttr(OPENSTEER_NODE_ID_ATTR);
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
