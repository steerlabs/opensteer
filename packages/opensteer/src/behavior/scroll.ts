export interface ScrollPatternPoint {
  readonly deltaY: number;
  readonly t: number;
}

export interface ScrollPattern {
  readonly points: readonly ScrollPatternPoint[];
  readonly durationMs: number;
}

export function generateScrollPattern(input: {
  readonly distancePx: number;
  readonly durationMs?: number;
  readonly fps?: number;
}): ScrollPattern {
  const durationMs =
    input.durationMs ?? Math.max(220, Math.round(Math.abs(input.distancePx) * 0.9));
  const fps = input.fps ?? 60;
  const frames = Math.max(2, Math.round((durationMs / 1000) * fps));
  let previousDistance = 0;
  const points: ScrollPatternPoint[] = [];
  for (let index = 0; index <= frames; index += 1) {
    const progress = easeInOutQuad(index / frames);
    const currentDistance = progress * input.distancePx;
    points.push({
      deltaY: Math.round(currentDistance - previousDistance),
      t: Math.round((index / frames) * durationMs),
    });
    previousDistance = currentDistance;
  }
  return {
    points,
    durationMs,
  };
}

function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}
