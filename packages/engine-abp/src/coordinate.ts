import {
  createBrowserCoreError,
  createPoint,
  createRect,
  type CoordinateSpace,
  type Point,
  type Rect,
  type ViewportMetrics,
} from "@opensteer/browser-core";

function unsupportedCoordinateSpace(coordinateSpace: CoordinateSpace): never {
  throw createBrowserCoreError(
    "unsupported-capability",
    `coordinate space ${coordinateSpace} is not supported by this backend`,
    {
      details: { coordinateSpace },
    },
  );
}

export function toDocumentPoint(
  metrics: ViewportMetrics,
  point: Point,
  coordinateSpace: CoordinateSpace,
): Point {
  switch (coordinateSpace) {
    case "document-css":
      return point;
    case "layout-viewport-css":
      return createPoint(point.x + metrics.scrollOffset.x, point.y + metrics.scrollOffset.y);
    case "visual-viewport-css":
      return createPoint(
        point.x + metrics.visualViewport.origin.x,
        point.y + metrics.visualViewport.origin.y,
      );
    case "device-pixel":
      return createPoint(
        point.x / metrics.devicePixelRatio + metrics.scrollOffset.x,
        point.y / metrics.devicePixelRatio + metrics.scrollOffset.y,
      );
    case "computer-display-css":
    case "screen":
    case "window":
      unsupportedCoordinateSpace(coordinateSpace);
  }
}

export function toViewportPoint(
  metrics: ViewportMetrics,
  point: Point,
  coordinateSpace: CoordinateSpace,
): Point {
  switch (coordinateSpace) {
    case "layout-viewport-css":
    case "visual-viewport-css":
      return point;
    case "document-css":
      return createPoint(point.x - metrics.scrollOffset.x, point.y - metrics.scrollOffset.y);
    case "device-pixel":
      return createPoint(point.x / metrics.devicePixelRatio, point.y / metrics.devicePixelRatio);
    case "computer-display-css":
    case "screen":
    case "window":
      unsupportedCoordinateSpace(coordinateSpace);
  }
}
