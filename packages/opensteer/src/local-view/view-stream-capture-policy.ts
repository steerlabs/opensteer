import type { OpensteerViewport } from "@opensteer/protocol";

export interface RequestedStreamSize {
  readonly width: number;
  readonly height: number;
}

const MIN_CAPTURE_DIMENSION_PX = 100;
const MAX_CAPTURE_DIMENSION_PX = 8_192;
const CAPTURE_BUCKET_PX = 64;

export function selectScreencastSize(args: {
  readonly viewport: OpensteerViewport;
  readonly requestedSizes: readonly RequestedStreamSize[];
}): RequestedStreamSize | null {
  const viewport = normalizeViewport(args.viewport);
  if (!viewport) {
    return null;
  }

  let maxRequestedWidth = 0;
  let maxRequestedHeight = 0;
  for (const requestedSize of args.requestedSizes) {
    const normalized = normalizeRequestedSize(requestedSize);
    if (!normalized) {
      return null;
    }
    maxRequestedWidth = Math.max(maxRequestedWidth, normalized.width);
    maxRequestedHeight = Math.max(maxRequestedHeight, normalized.height);
  }

  if (
    maxRequestedWidth < MIN_CAPTURE_DIMENSION_PX ||
    maxRequestedHeight < MIN_CAPTURE_DIMENSION_PX
  ) {
    return null;
  }

  const desiredScale = Math.max(
    maxRequestedWidth / viewport.width,
    maxRequestedHeight / viewport.height,
  );
  if (desiredScale >= 1) {
    return viewport;
  }

  const landscape = viewport.width >= viewport.height;
  const sourcePrimary = landscape ? viewport.width : viewport.height;
  const sourceSecondary = landscape ? viewport.height : viewport.width;
  const nextPrimary = bucketDimension(sourcePrimary * desiredScale);
  const nextSecondary = clampDimension(Math.round((nextPrimary / sourcePrimary) * sourceSecondary));
  if (!nextSecondary) {
    return null;
  }

  return landscape
    ? { width: nextPrimary, height: nextSecondary }
    : { width: nextSecondary, height: nextPrimary };
}

function normalizeViewport(viewport: OpensteerViewport): RequestedStreamSize | null {
  const width = clampDimension(viewport.width);
  const height = clampDimension(viewport.height);
  return width && height ? { width, height } : null;
}

function normalizeRequestedSize(requestedSize: RequestedStreamSize): RequestedStreamSize | null {
  const width = clampDimension(requestedSize.width);
  const height = clampDimension(requestedSize.height);
  return width && height ? { width, height } : null;
}

function clampDimension(value: number): number | null {
  if (!Number.isFinite(value)) {
    return null;
  }

  const normalized = Math.floor(value);
  if (normalized < MIN_CAPTURE_DIMENSION_PX) {
    return null;
  }

  return Math.min(MAX_CAPTURE_DIMENSION_PX, normalized);
}

function bucketDimension(value: number): number {
  const bucketed =
    Math.ceil(Math.max(MIN_CAPTURE_DIMENSION_PX, value) / CAPTURE_BUCKET_PX) * CAPTURE_BUCKET_PX;
  return Math.min(MAX_CAPTURE_DIMENSION_PX, bucketed);
}
