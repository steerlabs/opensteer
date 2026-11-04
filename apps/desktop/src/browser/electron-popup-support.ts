import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import path from "node:path";

// The private owner has no version probe. Admit only the qualified integrated
// framework; an owner factory or an Electron version alone also matches older APIs.
const qualifiedFramework = "cd27bf449f28ed9054d97574e49aade020f09d4c9edda5cb3a4d0853d51370f4";
let supported: Promise<1 | undefined> | undefined;
export function electronPopupVersion(): Promise<1 | undefined> {
  supported ??= (async () => {
    if (process.platform !== "darwin" || process.versions.electron !== "44.9.2") return undefined;
    try {
      const hash = createHash("sha256");
      const framework = path.resolve(
        path.dirname(process.execPath),
        "../Frameworks/Electron Framework.framework/Versions/A/Electron Framework",
      );
      for await (const bytes of createReadStream(framework)) hash.update(bytes);
      return hash.digest("hex") === qualifiedFramework ? 1 : undefined;
    } catch {
      return undefined;
    }
  })();
  return supported;
}
