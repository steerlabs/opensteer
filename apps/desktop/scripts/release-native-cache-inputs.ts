import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { generateAppleDataContracts } from "../../../scripts/generate-apple-data-contracts.js";
import { nativeReleaseInputs } from "./native-build-cache.js";

const root = path.resolve(import.meta.dirname, "../../..");
const directory = process.env.OPENSTEER_NATIVE_BUILD_CACHE_DIRECTORY;
const output = process.env.GITHUB_OUTPUT;
if (!directory || !output) throw Error("Native cache directory and Actions output are required");
await mkdir(directory, { recursive: true, mode: 0o700 });
await generateAppleDataContracts();
for (const kind of ["computer-use", "passwords", "dictation"] as const) {
  await mkdir(path.join(directory, kind), { recursive: true, mode: 0o700 });
  // The cache is optional: without a proof the build compiles from source.
  const reason = await nativeReleaseInputs(root, kind, ["arm64", "x86_64"]).then(
    async (proof) => {
      if (!proof) return "ambient compiler settings";
      await appendFile(output, `${kind}=${proof.digest}\n`);
      return undefined;
    },
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
  if (reason)
    process.stdout.write(`::warning::Native compiler cache disabled (${kind}): ${reason}\n`);
}
