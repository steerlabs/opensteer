import {
  createBodyPayload,
  createDevicePixelRatio,
  createPageScaleFactor,
  createPageZoomFactor,
  createScrollOffset,
  createSize,
  type ScreenshotArtifact,
  type ViewportMetrics,
} from "@opensteer/browser-core";

import type { FrameState, PageController } from "./types.js";

export async function getViewportMetricsFromCdp(controller: {
  readonly cdp: PageController["cdp"];
}): Promise<ViewportMetrics> {
  const layout = await controller.cdp.send("Page.getLayoutMetrics");
  const dprResult = await controller.cdp.send("Runtime.evaluate", {
    expression: "window.devicePixelRatio",
    returnByValue: true,
  });
  const pageZoomFactor = layout.cssVisualViewport.zoom ?? 1;
  const devicePixelRatio = typeof dprResult.result.value === "number" ? dprResult.result.value : 1;
  return {
    layoutViewport: {
      origin: { x: layout.cssLayoutViewport.pageX, y: layout.cssLayoutViewport.pageY },
      size: {
        width: layout.cssLayoutViewport.clientWidth,
        height: layout.cssLayoutViewport.clientHeight,
      },
    },
    visualViewport: {
      origin: { x: layout.cssVisualViewport.pageX, y: layout.cssVisualViewport.pageY },
      offsetWithinLayoutViewport: {
        x: layout.cssVisualViewport.offsetX,
        y: layout.cssVisualViewport.offsetY,
      },
      size: {
        width: layout.cssVisualViewport.clientWidth,
        height: layout.cssVisualViewport.clientHeight,
      },
    },
    scrollOffset: {
      x: layout.cssVisualViewport.pageX,
      y: layout.cssVisualViewport.pageY,
    },
    contentSize: {
      width: layout.cssContentSize.width,
      height: layout.cssContentSize.height,
    },
    devicePixelRatio: createDevicePixelRatio(devicePixelRatio),
    pageScaleFactor: createPageScaleFactor(layout.cssVisualViewport.scale),
    pageZoomFactor: createPageZoomFactor(pageZoomFactor),
  };
}

export async function captureLayoutViewportScreenshotArtifact(
  controller: PageController,
  frame: FrameState,
  format: ScreenshotArtifact["format"],
): Promise<{
  readonly artifact: ScreenshotArtifact;
  readonly viewport: ViewportMetrics;
}> {
  const viewport = await getViewportMetricsFromCdp(controller);
  const clip = {
    x: viewport.visualViewport.origin.x,
    y: viewport.visualViewport.origin.y,
    width: viewport.visualViewport.size.width,
    height: viewport.visualViewport.size.height,
  };
  const bytes =
    format === "png" || format === "jpeg"
      ? await controller.page.screenshot({
          type: format,
          scale: "css",
          clip: {
            x: 0,
            y: 0,
            width: clip.width,
            height: clip.height,
          },
        })
      : Buffer.from(
          (
            await controller.cdp.send("Page.captureScreenshot", {
              format,
              clip: {
                ...clip,
                scale: 1 / Math.max(1, viewport.devicePixelRatio),
              },
              fromSurface: true,
            })
          ).data,
          "base64",
        );

  return {
    viewport,
    artifact: {
      pageRef: controller.pageRef,
      frameRef: frame.frameRef,
      documentRef: frame.currentDocument.documentRef,
      documentEpoch: frame.currentDocument.documentEpoch,
      payload: createBodyPayload(new Uint8Array(bytes), {
        mimeType: `image/${format}`,
      }),
      format,
      size: createSize(viewport.visualViewport.size.width, viewport.visualViewport.size.height),
      coordinateSpace: "layout-viewport-css",
    },
  };
}
