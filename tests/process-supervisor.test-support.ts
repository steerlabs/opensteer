import { arch, platform } from "node:os";
import path from "node:path";

/** Where `pnpm --filter @opensteer/desktop build:process-supervisor` writes this machine's build. */
export const builtProcessSupervisor = path.resolve(
  import.meta.dirname,
  "../apps/desktop/generated-native",
  `${platform() === "win32" ? "windows" : platform()}-${arch() === "x64" ? "amd64" : arch()}`,
  platform() === "win32" ? "opensteer-process-supervisor.exe" : "opensteer-process-supervisor",
);
