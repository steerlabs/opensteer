import type { Page } from "playwright";

/**
 * Mutable cursor state shared across a single engine instance so that each
 * humanized action starts from the position where the previous one left off.
 */
export interface CursorState {
  x: number;
  y: number;
}

// ---------------------------------------------------------------------------
// Mouse path generation — cubic Bézier with Gaussian jitter
// ---------------------------------------------------------------------------

interface PathPoint {
  readonly x: number;
  readonly y: number;
  /** Elapsed milliseconds from the start of the movement. */
  readonly t: number;
}

function gaussianRandom(): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
}

function cubicBezier(
  p0: { x: number; y: number },
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  p3: { x: number; y: number },
  t: number,
) {
  const inv = 1 - t;
  return {
    x: inv ** 3 * p0.x + 3 * inv ** 2 * t * p1.x + 3 * inv * t ** 2 * p2.x + t ** 3 * p3.x,
    y: inv ** 3 * p0.y + 3 * inv ** 2 * t * p1.y + 3 * inv * t ** 2 * p2.y + t ** 3 * p3.y,
  };
}

function generateMousePath(
  start: { x: number; y: number },
  end: { x: number; y: number },
): PathPoint[] {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const distance = Math.hypot(dx, dy);

  // Fast tech-savvy user: quick movements. Duration proportional to distance
  // but floored at 60 ms so very short moves still feel human.
  const durationMs = Math.max(60, Math.round(distance * 1.1 + 40));

  const fps = 60;
  const frameCount = Math.max(2, Math.round((durationMs / 1000) * fps));
  const normal = distance === 0 ? { x: 0, y: 1 } : { x: -dy / distance, y: dx / distance };
  // Random curvature so paths aren't all the same shape.
  const curvature = 0.15 + Math.random() * 0.25;
  const controlDist = distance * curvature;
  const control1 = {
    x: start.x + dx * 0.33 + normal.x * controlDist,
    y: start.y + dy * 0.33 + normal.y * controlDist,
  };
  const control2 = {
    x: start.x + dx * 0.66 - normal.x * controlDist * 0.6,
    y: start.y + dy * 0.66 - normal.y * controlDist * 0.6,
  };

  const jitter = Math.min(3, distance * 0.02);
  const points: PathPoint[] = [];
  for (let i = 0; i <= frameCount; i++) {
    const linear = i / frameCount;
    const eased = easeInOutCubic(linear);
    const base = cubicBezier(start, control1, control2, end, eased);
    const noise = i === 0 || i === frameCount ? 0 : gaussianRandom() * jitter;
    points.push({
      x: Math.round((base.x + normal.x * noise) * 10) / 10,
      y: Math.round((base.y + normal.y * noise) * 10) / 10,
      t: Math.round(linear * durationMs),
    });
  }
  return points;
}

// ---------------------------------------------------------------------------
// Humanized mouse move — dispatches intermediate points with real delays
// ---------------------------------------------------------------------------

export async function humanizedMouseMove(
  page: Page,
  cursor: CursorState,
  targetX: number,
  targetY: number,
): Promise<void> {
  const path = generateMousePath({ x: cursor.x, y: cursor.y }, { x: targetX, y: targetY });
  let prevT = 0;
  for (const pt of path) {
    const dt = pt.t - prevT;
    if (dt > 0) {
      await delay(dt);
    }
    await page.mouse.move(pt.x, pt.y);
    prevT = pt.t;
  }
  cursor.x = targetX;
  cursor.y = targetY;
}

// ---------------------------------------------------------------------------
// Humanized click — approach path + mousedown / hold / mouseup
// ---------------------------------------------------------------------------

export async function humanizedMouseClick(
  page: Page,
  cursor: CursorState,
  targetX: number,
  targetY: number,
  options?: {
    readonly button?: "left" | "right" | "middle";
    readonly clickCount?: number;
  },
): Promise<void> {
  // Approach the target with a realistic path.
  await humanizedMouseMove(page, cursor, targetX, targetY);

  // Brief dwell before pressing — hand settling on target.
  await delay(30 + Math.random() * 60);

  const btn = options?.button ?? "left";
  const count = options?.clickCount ?? 1;

  for (let c = 0; c < count; c++) {
    const clickCount = c + 1;
    await page.mouse.down({ button: btn, clickCount });
    // Hold the button down for a realistic duration (40-90 ms).
    await delay(40 + Math.random() * 50);
    await page.mouse.up({ button: btn, clickCount });
    if (c < count - 1) {
      // Inter-click gap for double/triple click.
      await delay(40 + Math.random() * 30);
    }
  }
}

// ---------------------------------------------------------------------------
// Humanized scroll — discrete wheel ticks with natural cadence
// ---------------------------------------------------------------------------

export async function humanizedMouseScroll(
  page: Page,
  deltaX: number,
  deltaY: number,
): Promise<void> {
  // Mouse wheel ticks are typically 100 px per notch.
  const tickSize = 100;
  const remainX = deltaX;
  const remainY = deltaY;

  const stepsX = remainX === 0 ? 0 : Math.max(1, Math.round(Math.abs(remainX) / tickSize));
  const stepsY = remainY === 0 ? 0 : Math.max(1, Math.round(Math.abs(remainY) / tickSize));
  const totalSteps = Math.max(stepsX, stepsY, 1);
  const perStepX = remainX / totalSteps;
  const perStepY = remainY / totalSteps;

  for (let i = 0; i < totalSteps; i++) {
    await page.mouse.wheel(Math.round(perStepX), Math.round(perStepY));
    if (i < totalSteps - 1) {
      // Inter-tick delay: fast but variable (30-80 ms).
      await delay(30 + Math.random() * 50);
    }
  }
}

// ---------------------------------------------------------------------------
// Humanized typing — per-character keydown/keyup with realistic cadence
// ---------------------------------------------------------------------------

export async function humanizedTextInput(page: Page, text: string): Promise<void> {
  const baseDelayMs = 55;
  const jitterMs = 25;
  const segments = splitGraphemes(text);

  for (let i = 0; i < segments.length; i++) {
    const char = segments[i]!;
    const prev = segments[i - 1];

    // Compute inter-key delay.
    const punctuationPause = /[.,!?;:]/.test(prev ?? "") ? 60 : 0;
    const whitespacePause = /\s/.test(char) ? 20 : 0;
    const hesitation = Math.random() < 0.06 ? 80 + Math.random() * 120 : 0;
    const jitter = (Math.random() * 2 - 1) * jitterMs;
    const interKeyDelay = Math.max(
      8,
      Math.round(baseDelayMs + punctuationPause + whitespacePause + hesitation + jitter),
    );

    if (i > 0) {
      await delay(interKeyDelay);
    }

    // Press the key with a realistic hold duration (40-80 ms).
    try {
      await page.keyboard.down(char);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("Unknown key:")) {
        throw error;
      }
      await page.keyboard.type(char);
      continue;
    }

    await delay(40 + Math.random() * 40);
    await page.keyboard.up(char);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function splitGraphemes(text: string): string[] {
  if (typeof Intl.Segmenter !== "function") {
    return Array.from(text);
  }
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  return Array.from(segmenter.segment(text), ({ segment }) => segment);
}
