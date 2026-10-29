import path from "node:path";
import { z } from "zod";
import { validatePathBinding, bindPath, type PathBinding, type PathIO } from "./journey-paths.js";
import { sameProcess, type ProcessIdentity, type ProcessRow } from "./journey-processes.js";
export const AppClaimSchema = z.object({
  pid: z.number().int().min(2),
  bundle: z.string(),
  startSeconds: z.number().int().nonnegative(),
  startMicroseconds: z.number().int().nonnegative(),
});
export const AppInspectionSchema = AppClaimSchema.omit({ bundle: true }).extend({
  pgid: z.number().int().min(2),
  executable: z.string(),
});
export interface AppRegistrationPorts {
  paths: PathIO;
  processes(): ProcessRow[];
  inspect(pid: number): z.infer<typeof AppInspectionSchema>;
  register(identity: ProcessIdentity): Promise<void>;
  terminate(pid: number): void;
}
/** Peer credentials come from LOCAL_PEERPID, never the request payload. */
export async function registerLaunchedApp(
  peer: number,
  wrapper: ProcessIdentity,
  root: PathBinding,
  input: unknown,
  ports: AppRegistrationPorts,
): Promise<void> {
  if (peer !== wrapper.pid || !ports.processes().some((row) => sameProcess(wrapper, row)))
    throw Error("App registration requires the registered wrapper peer");
  const claim = AppClaimSchema.parse(input);
  validatePathBinding(root, ports.paths);
  const bundle = bindPath(claim.bundle, ports.paths);
  if (path.dirname(bundle.path) !== root.path || path.extname(bundle.path) !== ".app")
    throw Error("App bundle is outside the registered work root");
  const before = ports.processes().find((row) => row.pid === claim.pid);
  const actual = { ...ports.inspect(claim.pid) };
  if (
    !before ||
    actual.pid !== claim.pid ||
    actual.pgid !== claim.pid ||
    before.pgid !== actual.pgid ||
    actual.startSeconds !== claim.startSeconds ||
    actual.startMicroseconds !== claim.startMicroseconds
  )
    throw Error("App process identity changed");
  const executable = ports.paths.realpath(actual.executable);
  if (!executable.startsWith(bundle.realPath + path.sep))
    throw Error("App executable is outside its registered bundle");
  const current = () => {
    try {
      validatePathBinding(root, ports.paths);
      validatePathBinding(bundle, ports.paths);
      const next = ports.inspect(claim.pid);
      return (
        next.pid === actual.pid &&
        next.pgid === actual.pgid &&
        next.startSeconds === actual.startSeconds &&
        next.startMicroseconds === actual.startMicroseconds &&
        ports.paths.realpath(next.executable) === executable &&
        ports.processes().some((row) => sameProcess(before, row))
      );
    } catch {
      return false;
    }
  };
  if (!current()) throw Error("App process identity changed");
  try {
    await ports.register(before);
    if (!current()) throw Error("App process identity changed during registration");
  } catch (error) {
    // A failed journal write grants no group authority. Only this verified launch PID may be stopped.
    if (current()) ports.terminate(claim.pid);
    throw error;
  }
}
