export interface MousePathPoint {
  readonly x: number;
  readonly y: number;
  readonly t: number;
}

export interface MousePath {
  readonly points: readonly MousePathPoint[];
  readonly durationMs: number;
}

export function generateMousePath(input: {
  readonly start: { readonly x: number; readonly y: number };
  readonly end: { readonly x: number; readonly y: number };
  readonly durationMs?: number;
  readonly fps?: number;
  readonly jitter?: number;
  readonly curvature?: number;
}): MousePath {
  const dx = input.end.x - input.start.x;
  const dy = input.end.y - input.start.y;
  const distance = Math.hypot(dx, dy);
  const durationMs = input.durationMs ?? Math.max(180, Math.round(distance * 2.2));
  const fps = input.fps ?? 60;
  const jitter = input.jitter ?? 3;
  const curvature = input.curvature ?? 0.3;
  const frameCount = Math.max(2, Math.round((durationMs / 1000) * fps));
  const normal = distance === 0 ? { x: 0, y: 1 } : { x: -dy / distance, y: dx / distance };
  const controlDistance = distance * curvature;
  const control1 = {
    x: input.start.x + dx * 0.33 + normal.x * controlDistance,
    y: input.start.y + dy * 0.33 + normal.y * controlDistance,
  };
  const control2 = {
    x: input.start.x + dx * 0.66 - normal.x * controlDistance * 0.6,
    y: input.start.y + dy * 0.66 - normal.y * controlDistance * 0.6,
  };

  const points: MousePathPoint[] = [];
  for (let index = 0; index <= frameCount; index += 1) {
    const linear = index / frameCount;
    const eased = easeInOutCubic(linear);
    const base = cubicBezier(input.start, control1, control2, input.end, eased);
    const noise =
      index === 0 || index === frameCount
        ? 0
        : gaussianRandom() * jitter;
    points.push({
      x: base.x + normal.x * noise,
      y: base.y + normal.y * noise,
      t: Math.round(linear * durationMs),
    });
  }
  return {
    points,
    durationMs,
  };
}

export function generateDragTrail(input: {
  readonly start: { readonly x: number; readonly y: number };
  readonly end: { readonly x: number; readonly y: number };
  readonly durationMs?: number;
  readonly fps?: number;
}): MousePath {
  return generateMousePath({
    start: input.start,
    end: input.end,
    ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
    ...(input.fps === undefined ? {} : { fps: input.fps }),
    jitter: 1.5,
    curvature: 0.18,
  });
}

function cubicBezier(
  start: { readonly x: number; readonly y: number },
  control1: { readonly x: number; readonly y: number },
  control2: { readonly x: number; readonly y: number },
  end: { readonly x: number; readonly y: number },
  t: number,
) {
  const inverse = 1 - t;
  return {
    x:
      inverse ** 3 * start.x +
      3 * inverse ** 2 * t * control1.x +
      3 * inverse * t ** 2 * control2.x +
      t ** 3 * end.x,
    y:
      inverse ** 3 * start.y +
      3 * inverse ** 2 * t * control1.y +
      3 * inverse * t ** 2 * control2.y +
      t ** 3 * end.y,
  };
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
}

function gaussianRandom(): number {
  let u = 0;
  let v = 0;
  while (u === 0) {
    u = Math.random();
  }
  while (v === 0) {
    v = Math.random();
  }
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
