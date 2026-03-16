/**
 * Deep debug: trace the snapshot pipeline step by step.
 */
import { chromium } from "playwright";
import type { CDPSession } from "playwright";

async function main() {
  console.log("Launching browser...");
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log("Navigating to Maersk tracking...");
  await page.goto("https://www.maersk.com/tracking/", { waitUntil: "networkidle" });
  console.log("Page loaded, title:", await page.title());

  // Wait extra for JS hydration
  await new Promise(r => setTimeout(r, 3000));

  // Get CDP session
  const cdp: CDPSession = await page.context().newCDPSession(page);

  // Step 1: CDP DOMSnapshot.captureSnapshot
  console.log("\n=== Step 1: CDP DOMSnapshot.captureSnapshot ===");
  const snapshotResult = await cdp.send("DOMSnapshot.captureSnapshot", {
    computedStyles: [],
    includePaintOrder: true,
    includeDOMRects: true,
  });

  console.log("Number of documents:", snapshotResult.documents.length);
  for (let i = 0; i < snapshotResult.documents.length; i++) {
    const doc = snapshotResult.documents[i] as any;
    const frameId = snapshotResult.strings[doc.frameId] || "(unknown)";
    const nodeCount = doc.nodes?.nodeType?.length ?? 0;
    const layoutCount = doc.layout?.nodeIndex?.length ?? 0;
    console.log(`  Document ${i}: frameId="${frameId}", nodes=${nodeCount}, layout=${layoutCount}`);

    // Show first few node types and names
    if (nodeCount > 0) {
      const nodeTypes = doc.nodes.nodeType.slice(0, 10);
      const nodeNames = doc.nodes.nodeName?.slice(0, 10)?.map((idx: number) => snapshotResult.strings[idx]) ?? [];
      console.log(`    First node types: ${JSON.stringify(nodeTypes)}`);
      console.log(`    First node names: ${JSON.stringify(nodeNames)}`);
    }
  }

  // Step 2: DOM.getDocument for comparison
  console.log("\n=== Step 2: DOM.getDocument ===");
  const domTree = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
  console.log("Root node name:", domTree.root.nodeName);
  console.log("Root children count:", domTree.root.children?.length ?? 0);

  function countNodes(node: any): number {
    let count = 1;
    for (const child of node.children || []) {
      count += countNodes(child);
    }
    return count;
  }
  console.log("Total DOM nodes:", countNodes(domTree.root));

  // Step 3: Get the main frame info
  console.log("\n=== Step 3: Frame info ===");
  const mainFrame = page.mainFrame();
  console.log("Main frame URL:", mainFrame.url());

  // Step 4: Try page.content() as baseline
  console.log("\n=== Step 4: page.content() baseline ===");
  const content = await page.content();
  console.log("page.content() length:", content.length);
  console.log("First 500 chars:", content.slice(0, 500));

  // Step 5: Try evaluate to get outerHTML
  console.log("\n=== Step 5: document.documentElement.outerHTML ===");
  const outerHTML = await page.evaluate(() => document.documentElement.outerHTML.length);
  console.log("outerHTML length:", outerHTML);

  // Step 6: Check what the CDP frame ID is
  console.log("\n=== Step 6: Frame tree ===");
  const frameTree = await cdp.send("Page.getFrameTree");
  console.log("Frame tree root ID:", (frameTree.frameTree.frame as any).id);
  console.log("Frame tree root URL:", (frameTree.frameTree.frame as any).url);

  // Check if frame ID from frame tree matches any document in snapshot
  const mainFrameId = (frameTree.frameTree.frame as any).id;
  console.log("\nLooking for frameId", mainFrameId, "in snapshot documents...");
  let found = false;
  for (let i = 0; i < snapshotResult.documents.length; i++) {
    const doc = snapshotResult.documents[i] as any;
    const frameId = snapshotResult.strings[doc.frameId] || "";
    if (frameId === mainFrameId) {
      console.log(`  FOUND at document index ${i}!`);
      found = true;
    }
  }
  if (!found) {
    console.log("  NOT FOUND! This would explain empty snapshots.");
    console.log("  Snapshot frame IDs:");
    for (let i = 0; i < snapshotResult.documents.length; i++) {
      const doc = snapshotResult.documents[i] as any;
      const frameId = snapshotResult.strings[doc.frameId] || "(empty)";
      console.log(`    Document ${i}: "${frameId}"`);
    }
  }

  await browser.close();
}

main().catch(console.error);
