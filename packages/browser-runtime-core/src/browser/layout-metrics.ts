import { z } from "zod";

export const visualViewportMetricsSchema = z.object({
  cssVisualViewport: z.object({
    pageX: z.number().finite(),
    pageY: z.number().finite(),
    scale: z.number().positive(),
    zoom: z.number().positive().default(1),
  }),
});
