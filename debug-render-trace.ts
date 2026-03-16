/**
 * Trace the render step: get the raw HTML before cleaning.
 */
import { OpensteerSessionRuntime } from "./packages/opensteer/src/sdk/runtime.js";
import { cleanForAction, cleanForExtraction } from "./packages/opensteer/src/sdk/snapshot/cleaner.js";
import * as cheerio from "cheerio";

async function main() {
  const runtime = new OpensteerSessionRuntime({
    name: "debug-render",
    browser: { headless: false },
  });

  try {
    console.log("Opening browser...");
    await runtime.open({ url: "https://www.maersk.com/tracking/" });
    await new Promise(r => setTimeout(r, 5000));

    const engine = (runtime as any).engine;
    const pageRef = (runtime as any).pageRef;

    // Get main frame
    const frames = await engine.listFrames({ pageRef });
    const mainFrame = frames.find((f: any) => f.isMainFrame);
    const snapshot = await engine.getDomSnapshot({ frameRef: mainFrame.frameRef });

    console.log("Snapshot nodes:", snapshot.nodes.length);
    console.log("Root ID:", snapshot.rootSnapshotNodeId);

    // Manually render like the compiler does
    const nodesById = new Map(snapshot.nodes.map((n: any) => [n.snapshotNodeId, n]));

    function renderNode(node: any, depth: number = 0): string {
      if (node.nodeType === 3) {
        const text = (node.nodeValue || node.textContent || "").trim();
        return text ? escapeHtml(text) : "";
      }
      if (node.nodeType === 8 || node.nodeType === 10) return "";
      if (node.nodeType === 9 || node.nodeType === 11) {
        return node.childSnapshotNodeIds.map((id: number) => {
          const child = nodesById.get(id);
          return child ? renderNode(child, depth) : "";
        }).join("");
      }

      if (node.nodeType !== 1) {
        return node.childSnapshotNodeIds.map((id: number) => {
          const child = nodesById.get(id);
          return child ? renderNode(child, depth) : "";
        }).join("");
      }

      const tagName = (node.nodeName || "div").toLowerCase();
      if (tagName.startsWith("::")) {
        return node.childSnapshotNodeIds.map((id: number) => {
          const child = nodesById.get(id);
          return child ? renderNode(child, depth) : "";
        }).join("");
      }

      const attrs = (node.attributes || [])
        .map((a: any) => ` ${a.name}="${escapeAttr(a.value)}"`)
        .join("");

      const children = node.childSnapshotNodeIds.map((id: number) => {
        const child = nodesById.get(id);
        return child ? renderNode(child, depth + 1) : "";
      }).join("");

      const VOID_TAGS = new Set(["area","base","br","col","embed","hr","img","input","link","meta","param","source","track","wbr"]);
      if (VOID_TAGS.has(tagName)) {
        return `<${tagName}${attrs}>`;
      }
      return `<${tagName}${attrs}>${children}</${tagName}>`;
    }

    function escapeHtml(s: string): string {
      return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }
    function escapeAttr(s: string): string {
      return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }

    const rootNode = nodesById.get(snapshot.rootSnapshotNodeId);
    if (!rootNode) {
      console.error("No root node!");
      return;
    }

    console.log("\nRendering raw HTML...");
    const rawHtml = renderNode(rootNode);
    console.log("Raw HTML length:", rawHtml.length);
    console.log("Raw HTML first 1000 chars:", rawHtml.slice(0, 1000));

    // Now try cleaning
    console.log("\n=== Testing cleanForAction ===");
    const actionClean = cleanForAction(rawHtml);
    console.log("cleanForAction result length:", actionClean.length);
    console.log("cleanForAction first 1000:", actionClean.slice(0, 1000));

    console.log("\n=== Testing cleanForExtraction ===");
    const extractClean = cleanForExtraction(rawHtml);
    console.log("cleanForExtraction result length:", extractClean.length);
    console.log("cleanForExtraction first 1000:", extractClean.slice(0, 1000));

    // Now use the ACTUAL compiler to see if it matches
    console.log("\n=== Actual compiler ===");
    // Monkey-patch to capture intermediate values
    const origCompile = await import("./packages/opensteer/src/sdk/snapshot/compiler.js");
    const compiled = await origCompile.compileOpensteerSnapshot({ engine, pageRef, mode: "action" });
    console.log("Compiled HTML length:", compiled.html.length);
    console.log("Compiled counter count:", compiled.counters.length);

  } catch (err) {
    console.error("ERROR:", err);
  } finally {
    await runtime.close();
  }
}

main().catch(console.error);
