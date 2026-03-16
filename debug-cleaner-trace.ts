/**
 * Trace exactly what cleanForAction does step by step.
 */
import { OpensteerSessionRuntime } from "./packages/opensteer/src/sdk/runtime.js";
import { compileOpensteerSnapshot } from "./packages/opensteer/src/sdk/snapshot/compiler.js";
import * as cheerio from "cheerio";

const OPENSTEER_HIDDEN_ATTR = "data-opensteer-hidden";
const OPENSTEER_INTERACTIVE_ATTR = "data-opensteer-interactive";

const STRIP_TAGS = new Set(["script", "style", "noscript", "meta", "link", "template"]);
const NOISE_SELECTORS = [
  `[${OPENSTEER_HIDDEN_ATTR}]`,
  "[hidden]",
  "[style*='display: none']",
  "[style*='display:none']",
  "[style*='visibility: hidden']",
  "[style*='visibility:hidden']",
];

async function main() {
  const runtime = new OpensteerSessionRuntime({
    name: "debug-clean",
    browser: { headless: false },
  });

  try {
    console.log("Opening browser...");
    await runtime.open({ url: "https://www.maersk.com/tracking/" });
    await new Promise(r => setTimeout(r, 5000));

    const engine = (runtime as any).engine;
    const pageRef = (runtime as any).pageRef;

    // Get the compiled HTML (before cleaning)
    const frames = await engine.listFrames({ pageRef });
    const mainFrame = frames.find((f: any) => f.isMainFrame);
    const snapshot = await engine.getDomSnapshot({ frameRef: mainFrame.frameRef });

    // Get raw compiled HTML from compiler by calling compile
    // The debug logs I added will show intermediate values
    // But let me also get the actual compiled HTML before cleaning

    // Use compileOpensteerSnapshot but capture the intermediate compiledHtml
    // Since we can't easily hook into it, let me replicate the key step

    // Instead, let's just get the snapshot nodes and count hidden ones
    console.log("\n=== Hidden elements analysis ===");
    let hiddenCount = 0;
    let interactiveCount = 0;
    const hiddenElements: any[] = [];

    for (const node of snapshot.nodes) {
      if (node.nodeType !== 1) continue;
      const tagName = (node.nodeName || "").toLowerCase();

      // Check if hidden
      const hiddenAttr = node.attributes.find((a: any) => a.name.toLowerCase() === "hidden");
      const ariaHidden = node.attributes.find((a: any) => a.name.toLowerCase() === "aria-hidden" && a.value === "true");
      const isHiddenInput = tagName === "input" && node.attributes.find((a: any) => a.name === "type" && a.value?.toLowerCase() === "hidden");
      const zeroRect = node.layout?.rect && (node.layout.rect.width <= 0 || node.layout.rect.height <= 0);

      const isHidden = !!hiddenAttr || !!ariaHidden || !!isHiddenInput || !!zeroRect;
      if (isHidden) {
        hiddenCount++;
        if (hiddenElements.length < 30) {
          hiddenElements.push({
            id: node.snapshotNodeId,
            tag: tagName,
            reason: hiddenAttr ? `hidden attr="${hiddenAttr.value}"` : ariaHidden ? "aria-hidden" : isHiddenInput ? "input[hidden]" : "zero-rect",
            childCount: node.childSnapshotNodeIds.length,
            rect: node.layout?.rect,
            attrs: node.attributes.slice(0, 3).map((a: any) => `${a.name}=${a.value?.slice(0,50)}`),
          });
        }
      }

      // Check if interactive
      const NATIVE_INTERACTIVE = new Set(["button", "input", "select", "textarea", "a", "details", "summary", "option"]);
      if (NATIVE_INTERACTIVE.has(tagName)) interactiveCount++;
    }

    console.log(`Hidden elements: ${hiddenCount}`);
    console.log(`Interactive elements: ${interactiveCount}`);
    console.log("First 30 hidden elements:");
    for (const h of hiddenElements) {
      console.log(`  ${h.tag} (id=${h.id}, children=${h.childCount}): ${h.reason} attrs=[${h.attrs.join(", ")}]`);
    }

    // Now get the compiled HTML with counter attributes
    // We need the HTML that has data-opensteer-interactive and data-opensteer-hidden
    // Let's use the snapshot to generate it through the actual compiler
    const compiled = await compileOpensteerSnapshot({ engine, pageRef, mode: "action" });
    // The debug logs I added will print to stderr, so we'll see them

    // Now let's manually trace cleanForAction on the compiled HTML
    // Actually, the compiledHtml is available from the compiler's output
    // but we need the pre-cleaned version. Let me compute it.

    // Actually, I need the HTML after assignCounters but before cleanForAction
    // Let me just load the compiled output and check what removeNoise does

    // Let me use page.content() to see what hidden elements exist on the actual page
    console.log("\n=== Checking for 'hidden' attribute on page ===");
    const page = (engine as any).pages?.values()?.next()?.value?.page;
    if (page) {
      const hiddenEls = await page.evaluate(() => {
        const els = document.querySelectorAll("[hidden]");
        return Array.from(els).map(el => ({
          tag: el.tagName.toLowerCase(),
          id: el.id,
          class: el.className?.toString().slice(0, 100),
          childCount: el.childElementCount,
          outerHTML: el.outerHTML.slice(0, 200),
        }));
      });
      console.log(`Elements with [hidden] attribute: ${hiddenEls.length}`);
      for (const el of hiddenEls.slice(0, 20)) {
        console.log(`  <${el.tag}${el.id ? ` id="${el.id}"` : ""}${el.class ? ` class="${el.class}"` : ""}> (${el.childCount} children)`);
        console.log(`    ${el.outerHTML.slice(0, 150)}`);
      }

      // Check body specifically
      const bodyHidden = await page.evaluate(() => {
        const body = document.body;
        return {
          hasHidden: body.hasAttribute("hidden"),
          ariaHidden: body.getAttribute("aria-hidden"),
          display: getComputedStyle(body).display,
          visibility: getComputedStyle(body).visibility,
        };
      });
      console.log("\nBody element:", bodyHidden);

      // Check how many total elements with hidden attr, and their total descendant count
      const hiddenImpact = await page.evaluate(() => {
        const els = document.querySelectorAll("[hidden]");
        let totalDescendants = 0;
        for (const el of els) {
          totalDescendants += el.querySelectorAll("*").length;
        }
        return {
          count: els.length,
          totalDescendants,
          totalElements: document.querySelectorAll("*").length,
        };
      });
      console.log("\nHidden impact:", hiddenImpact);
      console.log(`${hiddenImpact.totalDescendants} out of ${hiddenImpact.totalElements} elements are inside [hidden] elements (${(hiddenImpact.totalDescendants / hiddenImpact.totalElements * 100).toFixed(1)}%)`);
    }

  } catch (err) {
    console.error("ERROR:", err);
  } finally {
    await runtime.close();
  }
}

main().catch(console.error);
