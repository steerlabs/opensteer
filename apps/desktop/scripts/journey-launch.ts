import { setPrivateFileMode } from "@opensteer/shared/privateFiles";
import { createServer, type Socket } from "node:net";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { bindPath, realPathIO, validatePathBinding, type PathBinding } from "./journey-paths.js";
import { registerLaunchedApp, AppInspectionSchema } from "./journey-app-registration.js";
import { execFileSync, spawn, fork, type ChildProcess } from "node:child_process";
import { closeSync, openSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { realProcessIO, type ProcessIdentity } from "./journey-processes.js";
const messageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("waiting") }),
  z.object({ type: z.literal("result"), code: z.number().int() }),
]);
export interface LaunchOptions {
  command: string;
  log: string;
  env?: NodeJS.ProcessEnv;
  register(identity: ProcessIdentity): Promise<void>;
  identity?: (pid: number) => ProcessIdentity;
  interrupted?: () => boolean;
  applicationRoot?: PathBinding | undefined;
}
/** A closed IPC channel before registration makes the wrapper exit without starting work. */
export async function launchRegisteredWorkload(options: LaunchOptions): Promise<number> {
  let wrapper: ProcessIdentity | undefined;
  const token = randomBytes(32).toString("hex");
  const socketPath = options.applicationRoot
    ? path.join(options.env!.TMPDIR!, "app-registration.sock")
    : undefined;
  const peerTool = fileURLToPath(new URL("../.electron-smoke/journey-peer", import.meta.url));
  const connections = new Set<Socket>();
  const server = socketPath
    ? createServer((socket) => {
        connections.add(socket);
        socket.on("close", () => connections.delete(socket));
        socket.on("error", () => socket.destroy());
        let input = "";
        socket.on("data", (chunk: Buffer) => {
          input += chunk.toString();
          if (input.length > 8192) {
            socket.destroy();
            return;
          }
          if (!input.endsWith("\n")) return;
          socket.removeAllListeners("data");
          void (async () => {
            try {
              if (!wrapper) throw Error("Wrapper is not registered");
              const value = z
                .object({ token: z.literal(token), claim: z.unknown() })
                .parse(JSON.parse(input));
              const probe = spawn(peerTool, ["peer"], {
                stdio: ["ignore", "pipe", "pipe", socket],
              });
              let peerText = "";
              probe.stdout!.setEncoding("utf8").on("data", (data: string) => {
                peerText += data;
              });
              const [probeCode] = await once(probe, "close");
              if (probeCode !== 0) throw Error("Cannot verify socket peer");
              const peer = Number(peerText.trim());
              await registerLaunchedApp(peer, wrapper, options.applicationRoot!, value.claim, {
                paths: realPathIO,
                processes: realProcessIO.processes,
                inspect: (pid) =>
                  AppInspectionSchema.parse(
                    JSON.parse(
                      execFileSync(peerTool, ["inspect", String(pid)], { encoding: "utf8" }),
                    ),
                  ),
                register: options.register,
                terminate: (pid) => {
                  realProcessIO.signal(pid, "SIGTERM");
                },
              });
              socket.end(JSON.stringify({ ok: true }) + "\n");
            } catch (error) {
              socket.end(JSON.stringify({ ok: false, error: String(error) }) + "\n");
            }
          })();
        });
      })
    : undefined;
  if (server) {
    validatePathBinding(options.applicationRoot!);
    bindPath(socketPath!);
    server.listen(socketPath!);
    await once(server, "listening");
    await setPrivateFileMode(socketPath!);
  }
  try {
    const fd = openSync(options.log, "a");
    let child: ChildProcess;
    try {
      child = fork(
        fileURLToPath(new URL("./journey-workload.cjs", import.meta.url)),
        [options.command],
        {
          detached: true,
          execArgv: [],
          env: options.env ?? process.env,
          stdio: ["ignore", fd, fd, "ipc"],
        },
      );
    } finally {
      closeSync(fd);
    }
    let registered = false;
    return await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? 1));
      child.on("message", (raw) => {
        const parsed = messageSchema.safeParse(raw);
        if (!parsed.success) return;
        if (parsed.data.type === "result") {
          resolve(parsed.data.code);
          return;
        }
        if (registered) return;
        registered = true;
        void (async () => {
          try {
            const identity =
              options.identity?.(child.pid!) ??
              realProcessIO.processes().find((row) => row.pid === child.pid);
            if (!identity || identity.pid !== identity.pgid)
              throw Error("Missing workload group identity");
            await options.register(identity);
            wrapper = identity;
            if (options.interrupted?.()) {
              child.disconnect();
              resolve(1);
              return;
            }
            child.send({ type: "go", socketPath, token });
          } catch (error) {
            if (child.connected) child.disconnect();
            reject(error);
          }
        })();
      });
    });
  } finally {
    for (const socket of connections) socket.destroy();
    server?.close();
    if (socketPath) rmSync(socketPath, { force: true });
  }
}
