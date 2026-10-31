import { agentPhonePackageName } from "@opensteer/protocol";
import { escapeArg, type Adb } from "@yume-chan/adb";
import { PackageManager } from "@yume-chan/android-bin";
import { ConcatBufferStream, ReadableStream, TransformStream } from "@yume-chan/stream-extra";
import type { AgentPhoneAdb } from "./setup-agent-phone.js";

/**
 * The package manager's own refusal, which Tango's `PackageManager` throws as
 * the error's message. Everything else thrown while installing is the
 * connection failing, which is not the package manager's answer.
 */
const packageManagerVerdict = /^(?:Failure|Error|Exception)\b/u;

/** Setup's view of a Tango `Adb`, whichever transport connected it. */
export function agentPhoneAdb(adb: Adb): AgentPhoneAdb {
  const packageManager = new PackageManager(adb);
  return {
    getProp: async (key) => {
      const process = await adb.subprocess.noneProtocol.spawn(["getprop", escapeArg(key)]);
      try {
        return new TextDecoder().decode(await boundedPhoneBytes(process.output, 65_536)).trim();
      } catch (error) {
        await process.kill();
        throw error;
      }
    },
    shell: async (argv) => {
      const shell = adb.subprocess.shellProtocol;
      // Every Android setup accepts has shell protocol v2; the version check
      // reads system properties without it, before any command needs it.
      if (!shell?.isSupported) throw new Error("This phone's ADB has no shell protocol.");
      // Tango joins the arguments with spaces for the phone's `sh`, so each
      // one is quoted here: a value from the phone can carry `$` or spaces.
      const process = await shell.spawn(argv.map(escapeArg));
      try {
        const [stdout, stderr, exitCode] = await Promise.all([
          boundedPhoneBytes(process.stdout, 1_024 * 1_024),
          boundedPhoneBytes(process.stderr, 1_024 * 1_024),
          process.exited,
        ]);
        return {
          stdout: new TextDecoder().decode(stdout),
          stderr: new TextDecoder().decode(stderr),
          exitCode,
        };
      } catch (error) {
        await process.kill();
        throw error;
      }
    },
    install: async (apk) => {
      try {
        await packageManager.installStream(
          apk.byteLength,
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(apk);
              controller.close();
            },
          }),
          { installerPackageName: agentPhonePackageName },
        );
        return { ok: true };
      } catch (error) {
        if (error instanceof Error && packageManagerVerdict.test(error.message)) {
          return { ok: false, output: error.message };
        }
        throw error;
      }
    },
    readFile: async (path, maxBytes) => {
      const sync = await adb.sync();
      try {
        if ((await sync.stat(path)).size > BigInt(maxBytes)) return null;
        return await boundedPhoneBytes(sync.read(path), maxBytes);
      } finally {
        await sync.dispose();
      }
    },
  };
}

async function boundedPhoneBytes(
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
): Promise<Uint8Array> {
  let size = 0;
  return await stream
    .pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          size += chunk.byteLength;
          if (size > maximumBytes)
            throw new Error("The phone's setup response exceeded its size limit.");
          controller.enqueue(chunk);
        },
      }),
    )
    .pipeThrough(new ConcatBufferStream());
}
