import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { runIntegrationTests } from "./test-integration.js";
import { browserStreamOptions } from "../tests/browser-stream/metrics.test-support.js";

const { values } = parseArgs({
  options: {
    profile: { type: "string", default: "all" },
    scenario: { type: "string", default: "all" },
    runs: { type: "string", default: "1" },
    duration: { type: "string", default: "4" },
    out: { type: "string", default: join(tmpdir(), `opensteer-browser-stream-${Date.now()}.json`) },
  },
});
const options = browserStreamOptions.parse({ ...values, out: resolve(values.out!) });
const environment = { ...process.env, OPENSTEER_BROWSER_STREAM_BENCH: JSON.stringify(options) };
if (
  environment.OPENSTEER_TEST_DATABASE_URL &&
  !environment.OPENSTEER_CONTROL_PLANE_TEST_DATABASE_URL
)
  environment.OPENSTEER_CONTROL_PLANE_TEST_DATABASE_URL = environment.OPENSTEER_TEST_DATABASE_URL;
try {
  await runIntegrationTests({ config: "scripts/browser-stream.vitest.config.ts", environment });
} catch (error) {
  console.error(error instanceof z.ZodError ? error.message : String(error));
  process.exitCode ||= 1;
}
