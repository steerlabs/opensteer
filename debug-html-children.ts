import { OpensteerSessionRuntime } from "./packages/opensteer/src/sdk/runtime.js";

async function main() {
  const runtime = new OpensteerSessionRuntime({
    name: "debug-children",
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

    // Find HTML element and its children
    const htmlNode = snapshot.nodes.find((n: any) => n.snapshotNodeId === 3);
    console.log("HTML element children:", htmlNode.childSnapshotNodeIds);
    for (const childId of htmlNode.childSnapshotNodeIds) {
      const child = snapshot.nodes.find((n: any) => n.snapshotNodeId === childId);
      console.log(`  Child ${childId}:`, {
        type: child.nodeType,
        name: child.nodeName,
        shadowRootType: child.shadowRootType,
        childCount: child.childSnapshotNodeIds.length,
        attrs: child.attributes?.slice(0, 3),
      });
    }

    // Check the raw HTML structure around the HEAD close
    const { readFileSync } = await import("fs");
    const raw = readFileSync("/tmp/debug-rawHtml.html", "utf8");

    // Find what's between </head> and <body> (including any os-shadow-root tags)
    const headCloseIdx = raw.indexOf("</head>");
    const bodyOpenIdx = raw.indexOf("<body");
    console.log("\nBetween </head> and <body>:");
    console.log(raw.slice(headCloseIdx, bodyOpenIdx));

    // Also check what's right after <html...>
    const htmlCloseIdx = raw.indexOf(">", raw.indexOf("<html"));
    const headOpenIdx = raw.indexOf("<head");
    console.log("\nBetween <html> close and <head>:");
    console.log(JSON.stringify(raw.slice(htmlCloseIdx + 1, headOpenIdx)));
  } catch (err) {
    console.error("ERROR:", err);
  } finally {
    await runtime.close();
  }
}
main().catch(console.error);
