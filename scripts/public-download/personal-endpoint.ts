import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
const manifest = z.object({
  deploymentId: z.string().min(1),
  hostPort: z.number().int().min(1024).max(65535),
  postgresPort: z.number().int().min(1024).max(65535),
});
export function personalEndpoint(
  data: string,
): { deploymentId: string; hostPort: number; origin: string } | undefined {
  const file = path.join(data, "personal-deployment.v1.json");
  if (!existsSync(file)) return undefined;
  const parsed = manifest.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success) return undefined;
  return {
    deploymentId: parsed.data.deploymentId,
    hostPort: parsed.data.hostPort,
    origin: `http://127.0.0.1:${parsed.data.hostPort}`,
  };
}
