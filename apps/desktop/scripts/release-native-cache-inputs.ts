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
  try {
    const proof = await nativeReleaseInputs(root, kind, ["arm64", "x86_64"]);
    if (proof) {
      await appendFile(output, `${kind}=${proof.digest}\n`);
      continue;
    }
  } catch {
    // Input identity is optional; the build takes the uncached path if unavailable.
  }
  process.stdout.write(`Native compiler cache disabled (${kind})\n`);
}
