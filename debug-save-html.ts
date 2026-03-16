/**
 * Save the compiler's intermediate HTML to disk and then test cleaning it.
 */
import { OpensteerSessionRuntime } from "./packages/opensteer/src/sdk/runtime.js";
import * as cheerio from "cheerio";
import { writeFile } from "fs/promises";

// Import the actual compiler internals
import { compileOpensteerSnapshot } from "./packages/opensteer/src/sdk/snapshot/compiler.js";
import { cleanForAction, cleanForExtraction } from "./packages/opensteer/src/sdk/snapshot/cleaner.js";

const OPENSTEER_HIDDEN_ATTR = "data-opensteer-hidden";
const OPENSTEER_INTERACTIVE_ATTR = "data-opensteer-interactive";
const OPENSTEER_NODE_ID_ATTR = "data-os-node-id";

async function main() {
  const runtime = new OpensteerSessionRuntime({
    name: "debug-save",
    browser: { headless: false },
  });

  try {
    console.log("Opening browser...");
    await runtime.open({ url: "https://www.maersk.com/tracking/" });
    await new Promise(r => setTimeout(r, 5000));

    const engine = (runtime as any).engine;
    const pageRef = (runtime as any).pageRef;

    // APPROACH: Monkey-patch the cleanForAction to capture the pre-clean HTML
    const cleanerModule = await import("./packages/opensteer/src/sdk/snapshot/cleaner.js");
    const origCleanForAction = cleanerModule.cleanForAction;

    let capturedPreCleanHtml = "";
    (cleanerModule as any).cleanForAction = function(html: string) {
      capturedPreCleanHtml = html;
      return origCleanForAction(html);
    };

    // Hmm, this won't work because the compiler imports cleanForAction at module load time.
    // Let me try a different approach.

    // Let me directly get the snapshot data and build the HTML manually using the compiler's logic.
    // Actually, let me just read the rawHtml from renderDocumentSnapshot.

    // The simplest approach: patch the compiler file temporarily.
    // But I already have debug logs there. The issue is I need the actual HTML content.
    // Let me write a temp file from within the compiler.

    // Actually, let me try a completely different approach.
    // I'll manually replicate the compiler flow and save each step.

    const frames = await engine.listFrames({ pageRef });
    const mainFrame = frames.find((f: any) => f.isMainFrame);
    const mainSnapshot = await engine.getDomSnapshot({ frameRef: mainFrame.frameRef });

    // Collect child document snapshots
    const snapshotsByDocRef = new Map();
    snapshotsByDocRef.set(mainSnapshot.documentRef, mainSnapshot);
    const queue = [mainSnapshot];
    while (queue.length > 0) {
      const current = queue.shift();
      for (const node of current.nodes) {
        if (node.contentDocumentRef && !snapshotsByDocRef.has(node.contentDocumentRef)) {
          const childSnapshot = await engine.getDomSnapshot({ documentRef: node.contentDocumentRef });
          snapshotsByDocRef.set(childSnapshot.documentRef, childSnapshot);
          queue.push(childSnapshot);
        }
      }
    }
    console.log(`Documents collected: ${snapshotsByDocRef.size}`);

    // Now import the actual compiler's render function and use it
    // Actually the render functions aren't exported. Let me call compileOpensteerSnapshot
    // and just capture the intermediate HTML via the debug logs.

    // Better approach: Write to a file from the compiler.
    // Let me modify the compiler temporarily.

    // Import from the modified compiler that has debug logs
    const compiled = await compileOpensteerSnapshot({ engine, pageRef, mode: "action" });

    // The compiled.html is already cleaned (empty). But the debug logs show intermediate values.
    // I need the HTML BEFORE cleaning.

    // OK let me try yet another approach. The internal data is:
    // - rawHtml from renderDocumentSnapshot
    // - compiledHtml from assignCounters(rawHtml)
    // - cleanedHtml from cleanForAction(compiledHtml.html)
    // I need compiledHtml.html

    // Since I can't easily intercept, let me modify the compiler to write to file.
    console.log("\nModifying compiler to save intermediate HTML...");

  } catch (err) {
    console.error("ERROR:", err);
  } finally {
    await runtime.close();
  }
}

main().catch(console.error);
