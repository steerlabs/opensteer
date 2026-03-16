/**
 * Check why the <html> element is marked as hidden.
 */
import { OpensteerSessionRuntime } from "./packages/opensteer/src/sdk/runtime.js";

async function main() {
  const runtime = new OpensteerSessionRuntime({
    name: "debug-hidden",
    browser: { headless: false },
  });

  try {
    await runtime.open({ url: "https://www.maersk.com/tracking/" });
    await new Promise(r => setTimeout(r, 5000));

    const engine = (runtime as any).engine;
    const pageRef = (runtime as any).pageRef;

    const frames = await engine.listFrames({ pageRef });
    const mainFrame = frames.find((f: any) => f.isMainFrame);
    const snapshot = await engine.getDomSnapshot({ frameRef: mainFrame.frameRef });

    // Find the <html> element (snapshotNodeId 3 based on our earlier output)
    const htmlNode = snapshot.nodes.find((n: any) => n.nodeType === 1 && (n.nodeName || "").toLowerCase() === "html");
    if (!htmlNode) {
      console.log("No HTML element found!");
      return;
    }

    console.log("HTML element:");
    console.log("  snapshotNodeId:", htmlNode.snapshotNodeId);
    console.log("  nodeName:", htmlNode.nodeName);
    console.log("  nodeType:", htmlNode.nodeType);
    console.log("  attributes:", JSON.stringify(htmlNode.attributes));
    console.log("  layout:", JSON.stringify(htmlNode.layout));
    console.log("  childCount:", htmlNode.childSnapshotNodeIds.length);

    // Check isLikelyHidden logic
    const hiddenAttr = htmlNode.attributes.find((a: any) => a.name.toLowerCase() === "hidden");
    const ariaHidden = htmlNode.attributes.find((a: any) => a.name.toLowerCase() === "aria-hidden" && a.value === "true");
    const rect = htmlNode.layout?.rect;

    console.log("\nHidden check:");
    console.log("  has 'hidden' attr:", !!hiddenAttr, hiddenAttr ? `value="${hiddenAttr.value}"` : "");
    console.log("  has aria-hidden=true:", !!ariaHidden);
    console.log("  rect:", rect ? `${rect.width}x${rect.height}` : "undefined");
    console.log("  zero rect:", rect ? (rect.width <= 0 || rect.height <= 0) : "no rect");

    // Also check <body> and first-level children
    const bodyNode = snapshot.nodes.find((n: any) => n.nodeType === 1 && (n.nodeName || "").toLowerCase() === "body");
    if (bodyNode) {
      console.log("\nBody element:");
      console.log("  attributes:", JSON.stringify(bodyNode.attributes));
      console.log("  layout:", JSON.stringify(bodyNode.layout));
      const bodyRect = bodyNode.layout?.rect;
      console.log("  rect:", bodyRect ? `${bodyRect.width}x${bodyRect.height}` : "undefined");
      console.log("  zero rect:", bodyRect ? (bodyRect.width <= 0 || bodyRect.height <= 0) : "no rect");
    }

    // Check the page with playwright
    const page = (engine as any).pages?.values()?.next()?.value?.page;
    if (page) {
      const htmlInfo = await page.evaluate(() => {
        const html = document.documentElement;
        const rect = html.getBoundingClientRect();
        return {
          hasHidden: html.hasAttribute("hidden"),
          ariaHidden: html.getAttribute("aria-hidden"),
          width: rect.width,
          height: rect.height,
          scrollWidth: html.scrollWidth,
          scrollHeight: html.scrollHeight,
          attrs: Array.from(html.attributes).map(a => `${a.name}="${a.value}"`),
        };
      });
      console.log("\nActual <html> element from page.evaluate:");
      console.log("  attrs:", htmlInfo.attrs);
      console.log("  hasHidden:", htmlInfo.hasHidden);
      console.log("  ariaHidden:", htmlInfo.ariaHidden);
      console.log("  BoundingClientRect:", `${htmlInfo.width}x${htmlInfo.height}`);
      console.log("  scroll:", `${htmlInfo.scrollWidth}x${htmlInfo.scrollHeight}`);
    }

  } catch (err) {
    console.error("ERROR:", err);
  } finally {
    await runtime.close();
  }
}

main().catch(console.error);
