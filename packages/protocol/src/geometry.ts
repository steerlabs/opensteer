export type {
  Point,
  Size,
  Rect,
  Quad,
  ScrollOffset,
  CoordinateSpace,
  LayoutViewport,
  VisualViewport,
  DevicePixelRatio,
  PageScaleFactor,
  PageZoomFactor,
  ViewportMetrics,
} from "@opensteer/browser-core";

import { arraySchema, enumSchema, numberSchema, objectSchema, type JsonSchema } from "./json.js";

export const pointSchema: JsonSchema = objectSchema(
  {
    x: numberSchema(),
    y: numberSchema(),
  },
  {
    title: "Point",
    required: ["x", "y"],
  },
);

export const sizeSchema: JsonSchema = objectSchema(
  {
    width: numberSchema({ minimum: 0 }),
    height: numberSchema({ minimum: 0 }),
  },
  {
    title: "Size",
    required: ["width", "height"],
  },
);

export const rectSchema: JsonSchema = objectSchema(
  {
    x: numberSchema(),
    y: numberSchema(),
    width: numberSchema({ minimum: 0 }),
    height: numberSchema({ minimum: 0 }),
  },
  {
    title: "Rect",
    required: ["x", "y", "width", "height"],
  },
);

export const quadSchema: JsonSchema = arraySchema(pointSchema, {
  title: "Quad",
  minItems: 4,
  maxItems: 4,
});

export const scrollOffsetSchema: JsonSchema = objectSchema(
  {
    x: numberSchema(),
    y: numberSchema(),
  },
  {
    title: "ScrollOffset",
    required: ["x", "y"],
  },
);

export const coordinateSpaceSchema: JsonSchema = enumSchema(
  [
    "document-css",
    "layout-viewport-css",
    "visual-viewport-css",
    "window",
    "screen",
    "device-pixel",
  ] as const,
  {
    title: "CoordinateSpace",
  },
);

export const layoutViewportSchema: JsonSchema = objectSchema(
  {
    origin: pointSchema,
    size: sizeSchema,
  },
  {
    title: "LayoutViewport",
    required: ["origin", "size"],
  },
);

export const visualViewportSchema: JsonSchema = objectSchema(
  {
    origin: pointSchema,
    offsetWithinLayoutViewport: scrollOffsetSchema,
    size: sizeSchema,
  },
  {
    title: "VisualViewport",
    required: ["origin", "offsetWithinLayoutViewport", "size"],
  },
);

export const viewportMetricsSchema: JsonSchema = objectSchema(
  {
    layoutViewport: layoutViewportSchema,
    visualViewport: visualViewportSchema,
    scrollOffset: scrollOffsetSchema,
    contentSize: sizeSchema,
    devicePixelRatio: numberSchema({ exclusiveMinimum: 0 }),
    pageScaleFactor: numberSchema({ exclusiveMinimum: 0 }),
    pageZoomFactor: numberSchema({ exclusiveMinimum: 0 }),
  },
  {
    title: "ViewportMetrics",
    required: [
      "layoutViewport",
      "visualViewport",
      "scrollOffset",
      "contentSize",
      "devicePixelRatio",
      "pageScaleFactor",
      "pageZoomFactor",
    ],
  },
);
