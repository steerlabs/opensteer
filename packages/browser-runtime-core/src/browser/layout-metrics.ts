import { z } from "zod";
import type { CdpParameters } from "@opensteer/browser-core";

export const layoutMetricsSchema = z.object({
  layoutViewport: z.object({ clientWidth: z.number().positive() }),
  cssLayoutViewport: z.object({ clientWidth: z.number().positive() }),
  cssVisualViewport: z.unknown().optional(),
});

export const visualViewportSchema = z.object({
  pageX: z.number().finite(),
  pageY: z.number().finite(),
  clientWidth: z.number().positive(),
  clientHeight: z.number().positive(),
});

export function screenshotDensity(
  metrics: z.infer<typeof layoutMetricsSchema>,
  agent: CdpParameters | null | undefined,
): number {
  const native = metrics.layoutViewport.clientWidth / metrics.cssLayoutViewport.clientWidth;
  const requested = agent?.deviceScaleFactor;
  const agentScale = typeof requested === "number" && requested > 0 ? requested : null;
  return agentScale ?? native;
}
