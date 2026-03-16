/**
 * Step through cleanForAction with the actual compiled HTML to find where content vanishes.
 */
import { OpensteerSessionRuntime } from "./packages/opensteer/src/sdk/runtime.js";
import { compileOpensteerSnapshot } from "./packages/opensteer/src/sdk/snapshot/compiler.js";
import * as cheerio from "cheerio";
import type { AnyNode, Element } from "domhandler";
import type { Cheerio, CheerioAPI } from "cheerio";

const OPENSTEER_HIDDEN_ATTR = "data-opensteer-hidden";
const OPENSTEER_INTERACTIVE_ATTR = "data-opensteer-interactive";
const OPENSTEER_BOUNDARY_ATTR = "data-opensteer-boundary";
const ROOT_TAGS = new Set(["html", "head", "body"]);
const STRIP_TAGS = new Set(["script", "style", "noscript", "meta", "link", "template"]);
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

async function main() {
  const runtime = new OpensteerSessionRuntime({
    name: "debug-clean-steps",
    browser: { headless: false },
  });

  try {
    console.log("Opening browser...");
    await runtime.open({ url: "https://www.maersk.com/tracking/" });
    await new Promise(r => setTimeout(r, 5000));

    const engine = (runtime as any).engine;
    const pageRef = (runtime as any).pageRef;

    // Get compiled HTML before cleaning - hook into the compiler
    // We'll access the internal state by calling compile and capturing intermediate HTML

    // Actually, let me directly replicate the compiler flow to get the pre-clean HTML
    const { compileOpensteerSnapshot } = await import("./packages/opensteer/src/sdk/snapshot/compiler.js");

    // The compiler will print debug logs to stderr (I added them)
    // But I need the actual HTML. Let me capture it by patching.

    // Instead, let me use a simpler approach: just get the rawHtml from my render
    // and add the data-opensteer-interactive attributes

    // Actually, let me just read the compiler's intermediate HTML by writing it to a file
    const fs = await import("fs/promises");

    // Patch compileOpensteerSnapshot to save intermediate HTML
    const origModule = await import("./packages/opensteer/src/sdk/snapshot/compiler.js");

    // Let me use an even simpler approach: get the snapshot, render it manually
    // with the opensteer attributes, then step through cleanForAction

    const frames = await engine.listFrames({ pageRef });
    const mainFrame = frames.find((f: any) => f.isMainFrame);
    const snapshot = await engine.getDomSnapshot({ frameRef: mainFrame.frameRef });

    // Build the HTML like the compiler does but capture it
    // Actually, the compiled output's html is already clean. I need PRE-cleaned.
    // Let me just call compile and write the intermediate to a temp file.

    // Simplest approach: modify the compiler temporarily to write to file
    // Or, intercept at the module level...

    // Let me just replicate the core issue. First get the compiled result
    // (which has the debug logs), then manually simulate cleaning.

    // Actually, let me use a HACK: import the cleaner's internal functions
    // and the compiler, and capture the intermediate state

    // Let me try: get the raw HTML and assignCounters HTML
    // by calling the compiler and intercepting via monkey-patching

    // Forget it, let me just get the compiled HTML from the compiler
    // by modifying it to also return rawHtml

    // Simplest: just write it to file in the compiler debug logs
    // But that's stderr. Let me use a different approach.

    // Actually, I realize: I can just read the compiler's rawHtml from the debug output
    // since it prints to stderr. Let me capture stderr.

    // OK let me be practical. Let me reproduce the HTML another way.
    // I'll render the snapshot with the data-opensteer-* attrs like the compiler does,
    // then step through cleanForAction.

    const NATIVE_INTERACTIVE = new Set(["button", "input", "select", "textarea", "a", "details", "summary", "option"]);
    const INTERACTIVE_ROLES = new Set(["button", "link", "checkbox", "radio", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "switch", "combobox", "spinbutton", "slider", "textbox", "searchbox", "listbox", "treeitem"]);

    function findAttr(attrs: any[], name: string): string | undefined {
      return attrs.find((a: any) => a.name.toLowerCase() === name.toLowerCase())?.value;
    }

    function isLikelyHidden(node: any): boolean {
      if (findAttr(node.attributes, "hidden") !== undefined) return true;
      if (findAttr(node.attributes, "aria-hidden") === "true") return true;
      if ((node.nodeName || "").toLowerCase() === "input" && findAttr(node.attributes, "type")?.toLowerCase() === "hidden") return true;
      const rect = node.layout?.rect;
      if (!rect) return false;
      return rect.width <= 0 || rect.height <= 0;
    }

    function isLikelyInteractive(tag: string, attrs: any[]): boolean {
      if (NATIVE_INTERACTIVE.has(tag)) {
        if (tag === "input" && findAttr(attrs, "type")?.toLowerCase() === "hidden") return false;
        if (tag !== "a") return true;
      }
      if (tag === "a" && findAttr(attrs, "href") !== undefined) return true;
      if (findAttr(attrs, "onclick") !== undefined || findAttr(attrs, "onmousedown") !== undefined) return true;
      if (findAttr(attrs, "data-action") !== undefined || findAttr(attrs, "data-click") !== undefined || findAttr(attrs, "data-toggle") !== undefined) return true;
      const tabindex = findAttr(attrs, "tabindex");
      if (tabindex !== undefined && parseInt(tabindex, 10) >= 0) return true;
      const role = findAttr(attrs, "role")?.toLowerCase();
      if (role && INTERACTIVE_ROLES.has(role)) return true;
      return false;
    }

    const nodesById = new Map(snapshot.nodes.map((n: any) => [n.snapshotNodeId, n]));

    function renderNode(node: any): string {
      if (node.nodeType === 3) return escapeHtml((node.nodeValue || node.textContent || "").trim() ? (node.nodeValue || node.textContent || "") : "");
      if (node.nodeType === 8 || node.nodeType === 10) return "";
      if (node.nodeType === 9 || node.nodeType === 11 || node.shadowRootType !== undefined) {
        return node.childSnapshotNodeIds.map((id: number) => {
          const child = nodesById.get(id);
          return child ? renderNode(child) : "";
        }).join("");
      }
      if (node.nodeType !== 1) return node.childSnapshotNodeIds.map((id: number) => {
        const child = nodesById.get(id);
        return child ? renderNode(child) : "";
      }).join("");

      const tagName = (node.nodeName || "div").toLowerCase();
      if (tagName.startsWith("::")) return node.childSnapshotNodeIds.map((id: number) => {
        const child = nodesById.get(id);
        return child ? renderNode(child) : "";
      }).join("");

      const attrs = [...(node.attributes || [])];
      const hidden = isLikelyHidden(node);
      const interactive = !hidden && isLikelyInteractive(tagName, node.attributes || []);
      if (interactive) attrs.push({ name: OPENSTEER_INTERACTIVE_ATTR, value: "1" });
      if (hidden) attrs.push({ name: OPENSTEER_HIDDEN_ATTR, value: "1" });

      // Add a counter attribute like the compiler does
      if (node.nodeRef !== undefined) {
        attrs.push({ name: "c", value: String(node.snapshotNodeId) });
      }

      const attrStr = attrs.map((a: any) => ` ${a.name}="${escapeAttr(a.value)}"`).join("");
      const children = node.childSnapshotNodeIds.map((id: number) => {
        const child = nodesById.get(id);
        return child ? renderNode(child) : "";
      }).join("");

      const VOID_TAGS = new Set(["area","base","br","col","embed","hr","img","input","link","meta","param","source","track","wbr"]);
      if (VOID_TAGS.has(tagName)) return `<${tagName}${attrStr}>`;
      return `<${tagName}${attrStr}>${children}</${tagName}>`;
    }

    function escapeHtml(s: string): string {
      return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }
    function escapeAttr(s: string): string {
      return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }

    const rootNode = nodesById.get(snapshot.rootSnapshotNodeId);
    const rawHtml = renderNode(rootNode);
    console.log("\nRaw HTML with opensteer attrs length:", rawHtml.length);

    // Now step through cleanForAction
    const $ = cheerio.load(rawHtml, { xmlMode: false });

    // Step 1: Count before noise removal
    const totalBefore = $("*").length;
    const interactiveBefore = $(`[${OPENSTEER_INTERACTIVE_ATTR}]`).length;
    const hiddenBefore = $(`[${OPENSTEER_HIDDEN_ATTR}]`).length;
    console.log(`\nBefore removeNoise: ${totalBefore} elements, ${interactiveBefore} interactive, ${hiddenBefore} hidden`);

    // Step 2: removeNoise
    for (const tag of STRIP_TAGS) {
      const count = $(tag).length;
      if (count > 0) console.log(`  Removing ${count} <${tag}> elements`);
      $(tag).remove();
    }

    // Check each noise selector separately
    for (const sel of NOISE_SELECTORS) {
      const matched = $(sel).length;
      if (matched > 0) {
        // Count total descendants that would be removed
        let descendantCount = 0;
        $(sel).each(function () {
          descendantCount += $(this as Element).find("*").length;
        });
        console.log(`  Removing ${matched} "${sel}" elements (with ${descendantCount} descendants)`);
      }
      $(sel).remove();
    }

    const totalAfterNoise = $("*").length;
    const interactiveAfterNoise = $(`[${OPENSTEER_INTERACTIVE_ATTR}]`).length;
    console.log(`After removeNoise: ${totalAfterNoise} elements, ${interactiveAfterNoise} interactive`);
    console.log(`HTML after noise removal length: ${$.html().length}`);

    // Check hasPreMarked
    const hasPreMarked = $(`[${OPENSTEER_INTERACTIVE_ATTR}]`).length > 0;
    console.log(`hasPreMarked: ${hasPreMarked}`);

    // Step 3: Mark clickables
    const clickableMark = "data-clickable-marker";
    let clickableCount = 0;
    $("*").each(function markClickables() {
      const el = $(this as Element);
      if (hasPreMarked) {
        if (el.attr(OPENSTEER_INTERACTIVE_ATTR) !== undefined) {
          el.attr(clickableMark, "1");
          clickableCount++;
        }
      }
    });
    console.log(`Marked ${clickableCount} clickable elements`);

    // Step 4: Run one iteration of the removal loop
    let iterCount = 0;
    let changed = true;
    while (changed && iterCount < 100) {
      changed = false;
      iterCount++;
      const nodes: Cheerio<Element>[] = [];
      $("*").each(function () { nodes.push($(this as Element)); });
      nodes.sort((l, r) => r.parents().length - l.parents().length);

      let removedThisIter = 0;
      let flattenedThisIter = 0;
      for (const el of nodes) {
        const node = el[0];
        if (!node) continue;
        const tag = (node.tagName || "").toLowerCase();
        if (ROOT_TAGS.has(tag) || isBoundaryTag(tag)) continue;

        const hasClickable = el.attr(clickableMark) !== undefined;
        const hasText = el.contents().filter(function (this: AnyNode) {
          return this.type === "text" && $(this).text().trim() !== "";
        }).length > 0;

        if (hasClickable || hasText) continue;

        if (el.children().length === 0) {
          el.remove();
          changed = true;
          removedThisIter++;
          continue;
        }
        el.replaceWith(el.contents());
        changed = true;
        flattenedThisIter++;
      }

      if (iterCount <= 10 || !changed) {
        console.log(`  Iteration ${iterCount}: removed ${removedThisIter}, flattened ${flattenedThisIter}, remaining ${$("*").length}`);
      }
    }
    console.log(`Total iterations: ${iterCount}, remaining elements: ${$("*").length}`);
    console.log(`Final HTML length: ${$.html().length}`);
    console.log(`Final HTML first 500: ${$.html().slice(0, 500)}`);

  } catch (err) {
    console.error("ERROR:", err);
  } finally {
    await runtime.close();
  }
}

main().catch(console.error);
