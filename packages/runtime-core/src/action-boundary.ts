import type { ActionBoundarySnapshot, BrowserCoreEngine, PageRef } from "@opensteer/browser-core";

export async function captureActionBoundarySnapshot(
  engine: BrowserCoreEngine,
  pageRef: PageRef,
): Promise<ActionBoundarySnapshot> {
  const frames = await engine.listFrames({ pageRef });
  const mainFrame = frames.find((frame) => frame.isMainFrame);
  if (!mainFrame) {
    throw new Error(`page ${pageRef} does not expose a main frame`);
  }

  return {
    pageRef,
    documentRef: mainFrame.documentRef,
  };
}
