import sharp from "sharp";
import {
  createDevicePixelRatio,
  createPageScaleFactor,
  createPageZoomFactor,
  createPoint,
  createScrollOffset,
  createSize,
  type Point,
  type Size,
  type ViewportMetrics,
} from "@opensteer/browser-core";
import {
  createBodyPayload,
  opensteerComputerAnnotationNames,
  type OpensteerComputerAction,
  type OpensteerComputerAnnotation,
  type OpensteerComputerDisplayScale,
  type OpensteerComputerTraceEnrichment,
  type ScreenshotArtifact,
} from "@opensteer/protocol";

export const OPENSTEER_COMPUTER_DISPLAY_PROFILE = {
  preferredViewport: {
    width: 1280,
    height: 800,
  },
  maxImageDimension: 1568,
  maxImagePixels: 1.15 * 1024 * 1024,
  defaultScreenshotFormat: "webp" as const,
  defaultIncludeCursor: true,
  defaultAnnotations: opensteerComputerAnnotationNames,
};

export interface ComputerDisplayTransform {
  readonly nativeSize: Size;
  readonly displaySize: Size;
  readonly nativeToDisplay: OpensteerComputerDisplayScale;
  readonly displayToNative: OpensteerComputerDisplayScale;
}

export function createComputerDisplayTransform(
  nativeViewport: ViewportMetrics,
): ComputerDisplayTransform {
  const nativeSize = nativeViewport.visualViewport.size;
  const pixels = nativeSize.width * nativeSize.height;
  const shrink = Math.min(
    OPENSTEER_COMPUTER_DISPLAY_PROFILE.maxImageDimension / nativeSize.width,
    OPENSTEER_COMPUTER_DISPLAY_PROFILE.maxImageDimension / nativeSize.height,
    Math.sqrt(OPENSTEER_COMPUTER_DISPLAY_PROFILE.maxImagePixels / pixels),
    1,
  );
  const displayWidth = Math.max(1, Math.round(nativeSize.width * shrink));
  const displayHeight = Math.max(1, Math.round(nativeSize.height * shrink));
  const nativeToDisplay = {
    x: roundScale(displayWidth / nativeSize.width),
    y: roundScale(displayHeight / nativeSize.height),
  } satisfies OpensteerComputerDisplayScale;
  const displayToNative = {
    x: roundScale(nativeSize.width / displayWidth),
    y: roundScale(nativeSize.height / displayHeight),
  } satisfies OpensteerComputerDisplayScale;

  return {
    nativeSize,
    displaySize: createSize(displayWidth, displayHeight),
    nativeToDisplay,
    displayToNative,
  };
}

export function toDisplayViewportMetrics(
  nativeViewport: ViewportMetrics,
  transform: ComputerDisplayTransform,
): ViewportMetrics {
  return {
    layoutViewport: {
      origin: scalePoint(nativeViewport.layoutViewport.origin, transform.nativeToDisplay),
      size: createSize(
        scaleNumber(nativeViewport.layoutViewport.size.width, transform.nativeToDisplay.x),
        scaleNumber(nativeViewport.layoutViewport.size.height, transform.nativeToDisplay.y),
      ),
    },
    visualViewport: {
      origin: scalePoint(nativeViewport.visualViewport.origin, transform.nativeToDisplay),
      offsetWithinLayoutViewport: createScrollOffset(
        scaleNumber(
          nativeViewport.visualViewport.offsetWithinLayoutViewport.x,
          transform.nativeToDisplay.x,
        ),
        scaleNumber(
          nativeViewport.visualViewport.offsetWithinLayoutViewport.y,
          transform.nativeToDisplay.y,
        ),
      ),
      size: createSize(transform.displaySize.width, transform.displaySize.height),
    },
    scrollOffset: createScrollOffset(
      scaleNumber(nativeViewport.scrollOffset.x, transform.nativeToDisplay.x),
      scaleNumber(nativeViewport.scrollOffset.y, transform.nativeToDisplay.y),
    ),
    contentSize: createSize(
      scaleNumber(nativeViewport.contentSize.width, transform.nativeToDisplay.x),
      scaleNumber(nativeViewport.contentSize.height, transform.nativeToDisplay.y),
    ),
    devicePixelRatio: createDevicePixelRatio(1),
    pageScaleFactor: createPageScaleFactor(1),
    pageZoomFactor: createPageZoomFactor(1),
  };
}

export function toNativeComputerAction(
  action: OpensteerComputerAction,
  transform: ComputerDisplayTransform,
): OpensteerComputerAction {
  switch (action.type) {
    case "click":
      return {
        ...action,
        ...scaleXY(action, transform.displayToNative),
      };
    case "move":
      return {
        ...action,
        ...scaleXY(action, transform.displayToNative),
      };
    case "scroll":
      return {
        ...action,
        ...scaleXY(action, transform.displayToNative),
        deltaX: scaleNumber(action.deltaX, transform.displayToNative.x),
        deltaY: scaleNumber(action.deltaY, transform.displayToNative.y),
      };
    case "drag":
      return {
        ...action,
        start: scalePoint(action.start, transform.displayToNative),
        end: scalePoint(action.end, transform.displayToNative),
      };
    case "key":
    case "screenshot":
    case "type":
    case "wait":
      return action;
  }
}

export function toDisplayComputerTrace(
  trace: OpensteerComputerTraceEnrichment | undefined,
  transform: ComputerDisplayTransform,
): OpensteerComputerTraceEnrichment | undefined {
  if (trace === undefined) {
    return undefined;
  }

  return {
    points: trace.points.map((entry) => ({
      ...entry,
      point: scalePoint(entry.point, transform.nativeToDisplay),
    })),
  };
}

export async function normalizeComputerScreenshot(input: {
  readonly screenshot: ScreenshotArtifact;
  readonly transform: ComputerDisplayTransform;
}): Promise<ScreenshotArtifact> {
  const source = Buffer.from(input.screenshot.payload.data, "base64");

  let pipeline = sharp(source, {
    failOn: "error",
  });
  if (
    input.transform.displaySize.width !== input.transform.nativeSize.width ||
    input.transform.displaySize.height !== input.transform.nativeSize.height
  ) {
    pipeline = pipeline.resize(
      input.transform.displaySize.width,
      input.transform.displaySize.height,
    );
  }

  const normalized = await pipeline.webp({ quality: 80 }).toBuffer();

  return {
    ...input.screenshot,
    payload: createBodyPayload(normalized.toString("base64"), {
      mimeType: "image/webp",
    }),
    format: "webp",
    size: input.transform.displaySize,
    coordinateSpace: "computer-display-css",
  };
}

export function resolveComputerAnnotations(
  disableAnnotations: readonly OpensteerComputerAnnotation[] | undefined,
): readonly OpensteerComputerAnnotation[] {
  const disabled = new Set(disableAnnotations ?? []);
  return OPENSTEER_COMPUTER_DISPLAY_PROFILE.defaultAnnotations.filter(
    (annotation) => !disabled.has(annotation),
  );
}

function scaleXY(
  point: {
    readonly x: number;
    readonly y: number;
  },
  scale: OpensteerComputerDisplayScale,
): {
  readonly x: number;
  readonly y: number;
} {
  return {
    x: scaleNumber(point.x, scale.x),
    y: scaleNumber(point.y, scale.y),
  };
}

function scalePoint(point: Point, scale: OpensteerComputerDisplayScale): Point {
  return createPoint(scaleNumber(point.x, scale.x), scaleNumber(point.y, scale.y));
}

function scaleNumber(value: number, scale: number): number {
  return roundScale(value * scale);
}

function roundScale(value: number): number {
  return Number(value.toFixed(6));
}
