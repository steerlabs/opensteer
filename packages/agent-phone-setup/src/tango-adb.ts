import { agentPhonePackageName } from "@opensteer/protocol";
import { escapeArg, type Adb } from "@yume-chan/adb";
import { PackageManager } from "@yume-chan/android-bin";
import { ConcatBufferStream, ReadableStream } from "@yume-chan/stream-extra";
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
    getProp: (key) => adb.getProp(key),
    shell: async (argv) => {
      const shell = adb.subprocess.shellProtocol;
      // Every Android setup accepts has shell protocol v2; the version check
      // reads system properties without it, before any command needs it.
      if (!shell?.isSupported) throw new Error("This phone's ADB has no shell protocol.");
      // Tango joins the arguments with spaces for the phone's `sh`, so each
      // one is quoted here: a value from the phone can carry `$` or spaces.
      return shell.spawnWaitText(argv.map(escapeArg));
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
        return await sync.read(path).pipeThrough(new ConcatBufferStream());
      } finally {
        await sync.dispose();
      }
    },
  };
}
