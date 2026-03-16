/**
 * Trace through the opensteer engine to find where content gets lost.
 * Uses the SDK runtime directly but patches compileOpensteerSnapshot to log intermediate steps.
 */
import { OpensteerSessionRuntime } from "./packages/opensteer/src/sdk/runtime.js";
import { compileOpensteerSnapshot } from "./packages/opensteer/src/sdk/snapshot/compiler.js";
import { cleanForAction, cleanForExtraction } from "./packages/opensteer/src/sdk/snapshot/cleaner.js";

async function main() {
  const runtime = new OpensteerSessionRuntime({
    name: "debug-trace",
    browser: { headless: false },
  });

  try {
    console.log("Opening browser...");
    await runtime.open({ url: "https://www.maersk.com/tracking/" });

    console.log("Waiting 5s...");
    await new Promise(r => setTimeout(r, 5000));

    // Access the engine directly
    const engine = (runtime as any).engine;
    if (!engine) {
      console.error("No engine found on runtime");
      return;
    }
    console.log("Engine type:", engine.constructor.name);

    // Get page ref
    const pageRef = (runtime as any).pageRef;
    console.log("Page ref:", pageRef);

    // Step 1: List frames
    const frames = await engine.listFrames({ pageRef });
    console.log("\n=== Frames ===");
    console.log("Number of frames:", frames.length);
    for (const frame of frames) {
      console.log(`  Frame: ref=${frame.frameRef}, isMain=${frame.isMainFrame}, url=${frame.url}`);
    }

    const mainFrame = frames.find((f: any) => f.isMainFrame);
    if (!mainFrame) {
      console.error("No main frame found!");
      return;
    }

    // Step 2: Get DOM snapshot
    console.log("\n=== DOM Snapshot ===");
    const snapshot = await engine.getDomSnapshot({ frameRef: mainFrame.frameRef });
    console.log("Document ref:", snapshot.documentRef);
    console.log("Root snapshot node ID:", snapshot.rootSnapshotNodeId);
    console.log("Number of nodes:", snapshot.nodes.length);

    // Count node types
    const nodeTypeCounts: Record<number, number> = {};
    for (const node of snapshot.nodes) {
      nodeTypeCounts[node.nodeType] = (nodeTypeCounts[node.nodeType] || 0) + 1;
    }
    console.log("Node type counts:", nodeTypeCounts);
    // 1=Element, 3=Text, 8=Comment, 9=Document, 10=DocType, 11=DocumentFragment

    // Count elements with nodeRef
    const withNodeRef = snapshot.nodes.filter((n: any) => n.nodeRef !== undefined).length;
    console.log("Nodes with nodeRef:", withNodeRef);

    // Show first few element nodes
    const elements = snapshot.nodes.filter((n: any) => n.nodeType === 1);
    console.log("Total element nodes:", elements.length);
    console.log("First 10 elements:", elements.slice(0, 10).map((n: any) => ({
      id: n.snapshotNodeId,
      name: n.nodeName,
      hasLayout: !!n.layout,
      childCount: n.childSnapshotNodeIds.length,
      attrCount: n.attributes.length,
    })));

    // Step 3: Compile full snapshot
    console.log("\n=== Compile Snapshot ===");
    const compiled = await compileOpensteerSnapshot({
      engine,
      pageRef,
      mode: "action",
    });

    console.log("Compiled HTML length:", compiled.html.length);
    console.log("Compiled counter count:", compiled.counters.length);
    console.log("HTML first 2000 chars:", compiled.html.slice(0, 2000));

    // If HTML is empty, let me try the raw rendering without cleaning
    if (compiled.html.length === 0) {
      console.log("\n=== Trying to understand the raw rendering ===");

      // Manually replicate the compiler flow
      const mainSnapshot2 = await engine.getDomSnapshot({ frameRef: mainFrame.frameRef });
      console.log("Snapshot nodes:", mainSnapshot2.nodes.length);

      // Check root node
      const rootNode = mainSnapshot2.nodes.find((n: any) => n.snapshotNodeId === mainSnapshot2.rootSnapshotNodeId);
      console.log("Root node:", rootNode ? {
        id: rootNode.snapshotNodeId,
        type: rootNode.nodeType,
        name: rootNode.nodeName,
        childCount: rootNode.childSnapshotNodeIds.length,
      } : "NOT FOUND");

      // Check if root node's children exist
      if (rootNode) {
        console.log("Root children IDs:", rootNode.childSnapshotNodeIds.slice(0, 10));
        for (const childId of rootNode.childSnapshotNodeIds.slice(0, 5)) {
          const child = mainSnapshot2.nodes.find((n: any) => n.snapshotNodeId === childId);
          console.log(`  Child ${childId}:`, child ? {
            type: child.nodeType,
            name: child.nodeName,
            childCount: child.childSnapshotNodeIds.length,
          } : "NOT FOUND");
        }
      }
    }

  } catch (err) {
    console.error("ERROR:", err);
  } finally {
    await runtime.close();
  }
}

main().catch(console.error);
