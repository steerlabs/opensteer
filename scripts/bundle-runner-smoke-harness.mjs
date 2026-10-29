import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

// `yaml` is CommonJS internally. esbuild preserves its guarded `require(...)`
// calls in a Node ESM bundle, so give those calls the module-local require that
// Node ESM deliberately does not provide by default.
const esmRequireBanner =
  'import { createRequire as __opensteerCreateRequire } from "node:module"; const require = __opensteerCreateRequire(import.meta.url);';

export async function bundleRunnerSmokeHarness(input) {
  await execute(
    input.esbuild,
    [
      input.source,
      "--bundle",
      "--platform=node",
      "--format=esm",
      "--target=node24",
      `--banner:js=${esmRequireBanner}`,
      `--outfile=${input.output}`,
    ],
    { timeout: 60_000 },
  );
}
