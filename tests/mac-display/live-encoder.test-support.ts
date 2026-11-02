import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

const headerSchema = z.union([
  z.object({ clock: z.number() }),
  z.object({ drop: z.literal(true) }),
  z.object({
    key: z.boolean(),
    codec: z.string(),
    captureUs: z.number(),
    ptsUs: z.number(),
    width: z.number(),
    height: z.number(),
  }),
]);
export type EncoderRecord = z.infer<typeof headerSchema>;
export async function liveEncoderBinary(directory: string) {
  const native = join(
    import.meta.dirname,
    "../../apps/desktop/native/computer-use/Sources/ComputerUseCore/Observe",
  );
  const sources = [
    join(import.meta.dirname, "live-encoder.swift"),
    join(native, "MacVideoRate.swift"),
    join(native, "MacVideoEncoder.swift"),
  ];
  const hash = createHash("sha256");
  for (const source of sources) hash.update(await readFile(source));
  const digest = hash.digest("hex");
  const cache = join(directory, "encoder", digest);
  await mkdir(cache, { recursive: true });
  const binary = join(cache, "live-encoder");
  try {
    await access(binary);
  } catch {
    await promisify(execFile)("swiftc", ["-O", ...sources, "-o", `${binary}.partial`], {
      timeout: 120_000,
    });
    await rename(`${binary}.partial`, binary);
  }
  return { binary, hash: digest };
}
export function liveEncoder(
  binary: string,
  duration: number,
  record: (header: EncoderRecord, payload: Buffer) => void,
  error: (message: string) => void,
) {
  const child = spawn(binary, [String(duration)], { stdio: ["pipe", "pipe", "pipe"] });
  let stopped = false;
  let buffer = Buffer.alloc(0);
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.on("error", (e) => error(String(e)));
  child.stdin.on("error", (e) => {
    if (!stopped) error(String(e));
  });
  let exitError: Error | undefined;
  const closed = new Promise<void>((resolve) =>
    child.once("close", (code, signal) => {
      if (code !== 0) {
        exitError = new Error(`Encoder exited ${code ?? signal}: ${stderr}`);
        error(exitError.message);
      }
      resolve();
    }),
  );
  child.stdout.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32BE(0);
      if (length > 16 * 1024 * 1024) {
        error("Invalid encoder record length");
        child.kill();
        return;
      }
      if (buffer.length < length + 4) return;
      const body = buffer.subarray(4, length + 4);
      buffer = buffer.subarray(length + 4);
      const end = body.indexOf(10);
      try {
        record(
          headerSchema.parse(JSON.parse(body.subarray(0, end).toString())),
          body.subarray(end + 1),
        );
      } catch (e) {
        error(String(e));
      }
    }
  });
  const command = (value: object) => {
    if (stopped) return;
    child.stdin.write(`${JSON.stringify(value)}\n`);
    if ("stop" in value) {
      stopped = true;
      child.stdin.end();
    }
  };
  return {
    command,
    close: async () => {
      command({ stop: true });
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      try {
        await closed;
        if (exitError) throw exitError;
        if (buffer.length) throw new Error("Truncated encoder record");
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
