/**
 * Run cleanForAction on the exact compiled HTML and trace each step.
 */
import { readFileSync } from "fs";
import * as cheerio from "cheerio";
import type { AnyNode, Element } from "domhandler";
import type { Cheerio, CheerioAPI } from "cheerio";

const OPENSTEER_HIDDEN_ATTR = "data-opensteer-hidden";
const OPENSTEER_INTERACTIVE_ATTR = "data-opensteer-interactive";
const OPENSTEER_SCROLLABLE_ATTR = "data-opensteer-scrollable";
const OPENSTEER_NODE_ID_ATTR = "data-os-node-id";
const OPENSTEER_BOUNDARY_ATTR = "data-opensteer-boundary";
const OPENSTEER_UNAVAILABLE_ATTR = "data-opensteer-unavailable";
const ROOT_TAGS = new Set(["html", "head", "body"]);
const STRIP_TAGS = new Set(["script", "style", "noscript", "meta", "link", "template"]);
const NATIVE_INTERACTIVE_TAGS = new Set(["button", "input", "select", "textarea", "a", "details", "summary", "option"]);
const INTERACTIVE_ROLE_SET = new Set(["button", "link", "checkbox", "radio", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "switch", "combobox", "spinbutton", "slider", "textbox", "searchbox", "listbox", "treeitem"]);

const NOISE_SELECTORS = [
  `[${OPENSTEER_HIDDEN_ATTR}]`,
  "[hidden]",
  "[style*='display: none']",
  "[style*='display:none']",
  "[style*='visibility: hidden']",
  "[style*='visibility:hidden']",
];

function isBoundaryTag(tag: string): boolean {
  return tag === "os-iframe-root" || tag === "os-shadow-root";
}

function hasNonNegativeTabIndex(value: string | undefined): boolean {
  if (value === undefined) return false;
  const num = parseInt(value, 10);
  return !isNaN(num) && num >= 0;
}

function hasDirectText($: CheerioAPI, el: Cheerio<Element>): boolean {
  return el.contents().filter(function (this: AnyNode) {
    return this.type === "text" && $(this).text().trim() !== "";
  }).length > 0;
}

function hasTextDeep(el: Cheerio<Element>): boolean {
  return el.text().trim().length > 0;
}

interface ClickableContext {
  readonly hasPreMarked: boolean;
}

function isClickable($: CheerioAPI, el: Cheerio<Element>, context: ClickableContext): boolean {
  if (context.hasPreMarked) {
    return el.attr(OPENSTEER_INTERACTIVE_ATTR) !== undefined;
  }
  const tag = ((el[0] as Element | undefined)?.tagName || "").toLowerCase();
  if (!tag || ROOT_TAGS.has(tag)) return false;
  if (NATIVE_INTERACTIVE_TAGS.has(tag)) {
    if (tag === "input" && String(el.attr("type") || "").toLowerCase() === "hidden") return false;
    return true;
  }
  const attrs = el.attr() || {};
  if (attrs.onclick !== undefined || attrs.onmousedown !== undefined || attrs.onmouseup !== undefined ||
      attrs["data-action"] !== undefined || attrs["data-click"] !== undefined || attrs["data-toggle"] !== undefined) {
    return true;
  }
  if (hasNonNegativeTabIndex(attrs.tabindex)) return true;
  const role = String(attrs.role || "").toLowerCase();
  if (INTERACTIVE_ROLE_SET.has(role)) return true;
  return false;
}

function main() {
  const html = readFileSync("/tmp/debug-compiledHtml.html", "utf8");
  console.log("Input HTML length:", html.length);

  if (!html.trim()) {
    console.log("HTML is empty or whitespace only!");
    return;
  }

  const $ = cheerio.load(html, { xmlMode: false });
  console.log("Total elements after cheerio load:", $("*").length);

  // Step 1: Remove noise
  for (const tag of STRIP_TAGS) {
    const count = $(tag).length;
    if (count > 0) console.log(`  Strip <${tag}>: ${count} elements`);
    $(tag).remove();
  }

  for (const sel of NOISE_SELECTORS) {
    const matched = $(sel);
    if (matched.length > 0) {
      let desc = 0;
      matched.each(function () { desc += $(this as Element).find("*").length; });
      console.log(`  Noise "${sel}": ${matched.length} matches (${desc} descendants)`);
    }
    matched.remove();
  }

  // Remove comments
  $("*").contents().each(function (this: AnyNode) {
    if (this.type === "comment") $(this).remove();
  });

  console.log("\nAfter noise removal: ${$('*').length} elements");
  console.log(`After noise removal: ${$("*").length} elements`);
  console.log(`HTML length after noise: ${$.html().length}`);

  // Check for interactive attrs
  const interactiveAfter = $(`[${OPENSTEER_INTERACTIVE_ATTR}]`).length;
  console.log(`Interactive elements after noise: ${interactiveAfter}`);

  const context: ClickableContext = { hasPreMarked: interactiveAfter > 0 };
  console.log(`hasPreMarked: ${context.hasPreMarked}`);

  // Mark clickables
  const clickableMark = "data-clickable-marker";
  const indicatorMark = "data-keep-indicator";
  let clickableCount = 0;

  $("*").each(function () {
    const el = $(this as Element);
    if (isClickable($, el, context)) {
      el.attr(clickableMark, "1");
      clickableCount++;
    }
  });
  console.log(`Clickable marked: ${clickableCount}`);

  // Mark indicators
  $(`[${clickableMark}]`).each(function () {
    const el = $(this as Element);
    if (hasTextDeep(el)) return;
    const wrapperAttrs = el.attr() || {};
    const hasWrapperIndicator =
      (typeof wrapperAttrs["aria-label"] === "string" && wrapperAttrs["aria-label"].trim() !== "") ||
      (typeof wrapperAttrs.title === "string" && wrapperAttrs.title.trim() !== "");
    if (hasWrapperIndicator) return;
    const imageIndicator = el.find("img[alt], img[src], img[srcset]").first();
    if (imageIndicator.length) { imageIndicator.attr(indicatorMark, "1"); return; }
    const semanticIndicator = el.find('[aria-label], [title], [data-icon], [role="img"], svg').first();
    if (semanticIndicator.length) { semanticIndicator.attr(indicatorMark, "1"); }
  });

  console.log(`Indicator marked: ${$(`[${indicatorMark}]`).length}`);

  // Now run the element removal loop
  let iterCount = 0;
  let changed = true;
  while (changed) {
    changed = false;
    iterCount++;
    const nodes: Cheerio<Element>[] = [];
    $("*").each(function () { nodes.push($(this as Element)); });
    nodes.sort((l, r) => r.parents().length - l.parents().length);

    let removed = 0, flattened = 0, kept = 0, rootSkipped = 0;
    for (const el of nodes) {
      const node = el[0];
      if (!node) continue;
      const tag = (node.tagName || "").toLowerCase();
      if (ROOT_TAGS.has(tag) || isBoundaryTag(tag)) { rootSkipped++; continue; }

      if (el.attr(clickableMark) !== undefined || el.attr(indicatorMark) !== undefined || hasDirectText($, el)) {
        kept++;
        continue;
      }

      if (el.children().length === 0) {
        el.remove();
        changed = true;
        removed++;
        continue;
      }

      el.replaceWith(el.contents());
      changed = true;
      flattened++;
    }

    console.log(`  Iter ${iterCount}: removed=${removed} flattened=${flattened} kept=${kept} rootSkipped=${rootSkipped} remaining=${$("*").length}`);
    if (iterCount > 50) {
      console.log("  Breaking: too many iterations");
      break;
    }
  }

  console.log(`\nFinal elements: ${$("*").length}`);
  console.log(`Final HTML length before strip: ${$.html().length}`);
  console.log(`Final HTML first 500: ${$.html().slice(0, 500)}`);

  // Now strip attributes (the part the actual cleaner does after the loop)
  $("*").each(function () {
    const el = $(this as Element);
    const node = el[0];
    if (!node) return;
    const tag = (node.tagName || "").toLowerCase();
    const clickable = el.attr(clickableMark) !== undefined;
    const indicator = el.attr(indicatorMark) !== undefined;

    if (tag === "img" && !indicator) {
      el.remove();
      return;
    }

    // Keep c, boundary, unavailable attrs
    // Remove the rest except specific ones for clickable/indicator
  });

  console.log(`After attribute stripping: ${$("*").length} elements, HTML length: ${$.html().length}`);

  // compactHtml
  let finalHtml = $.html()
    .replace(/<!--.*?-->/gs, "")
    .replace(/>\s+</g, "><")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n")
    .replace(/\n\s*\n/g, "\n")
    .trim();

  console.log(`\nFinal compacted HTML length: ${finalHtml.length}`);
  console.log(`Final HTML first 500: ${finalHtml.slice(0, 500)}`);

  // Now test: import the ACTUAL cleanForAction and compare
  console.log("\n=== Running ACTUAL cleanForAction ===");
  const { cleanForAction } = require("./packages/opensteer/src/sdk/snapshot/cleaner.js");
  // Can't use require with ESM... let me use dynamic import
}

main();
