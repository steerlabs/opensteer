import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { runIntegrationTests } from "./test-integration.js";
import { browserStreamOptions } from "../tests/browser-stream/metrics.test-support.js";

const { values } = parseArgs({
  options: {
    producer: { type: "string", default: "jpeg" },
    decoder: { type: "string", default: "prefer-software" },
    viewer: { type: "string", default: "web" },
    devices: { type: "string", default: "2" },
    "source-profile": { type: "string", default: "lan" },
    executable: { type: "string" },
    profile: { type: "string", default: "all" },
    scenario: { type: "string", default: "all" },
    runs: { type: "string", default: "1" },
    duration: { type: "string", default: "4" },
    out: { type: "string", default: join(tmpdir(), `opensteer-browser-stream-${Date.now()}.json`) },
  },
});
const options = browserStreamOptions.parse({
  ...values,
  sourceProfile: values["source-profile"],
  out: resolve(values.out!),
});
const environment = { ...process.env, OPENSTEER_BROWSER_STREAM_BENCH: JSON.stringify(options) };
if (
  environment.OPENSTEER_TEST_DATABASE_URL &&
  !environment.OPENSTEER_CONTROL_PLANE_TEST_DATABASE_URL
)
  environment.OPENSTEER_CONTROL_PLANE_TEST_DATABASE_URL = environment.OPENSTEER_TEST_DATABASE_URL;
try {
  if (options.producer === "fixture-h264")
    await (
      await import("../tests/browser-stream/video-bench.test-support.js")
    ).runBrowserVideoFixtureBenchmark(options);
  else if (options.producer !== "jpeg") {
    if (!options.executable)
      throw new Error(
        "Supply the qualified custom executable with --executable; stock Chromium/Electron cannot produce this stream.",
      );
    throw new Error(
      "Custom producer qualification belongs in the disposable VM with the private owner or authenticated Runner pipe. The Runner pipe is not installed by this integration.",
    );
  } else
    await runIntegrationTests({ config: "scripts/browser-stream.vitest.config.ts", environment });
} catch (error) {
  console.error(error instanceof z.ZodError ? error.message : String(error));
  process.exitCode ||= 1;
}
