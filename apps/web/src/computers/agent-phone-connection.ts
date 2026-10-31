import { agentPhoneAdb, type AgentPhoneAdb } from "@opensteer/agent-phone-setup";
import {
  agentPhoneCredentialStore,
  connectAgentPhone,
  type AgentPhoneUsbDevice,
} from "@opensteer/agent-phone-setup/webusb";
import type { DesktopAgentPhoneAdbBridge } from "@opensteer/protocol/desktop";

type PhoneConnection =
  | { readonly kind: "connected"; readonly adb: AgentPhoneAdb; close(): Promise<void> }
  | { readonly kind: "busy" | "unauthorized" };

/** Connection ownership is resolved here; setup never needs to know who holds USB. */
export async function connectPhoneForSetup(
  device: AgentPhoneUsbDevice,
  options: {
    readonly native: DesktopAgentPhoneAdbBridge | undefined;
    readonly signal: AbortSignal;
    readonly onAuthorizePrompt: () => void;
  },
): Promise<PhoneConnection> {
  const { signal, native, onAuthorizePrompt } = options;
  signal.throwIfAborted();
  if (native && device.serial) {
    const sessionId = crypto.randomUUID();
    let retained = false;
    const close = async () => {
      signal.removeEventListener("abort", abort);
      await native.close({ sessionId });
    };
    const abort = () => {
      void close().catch(() => undefined);
    };
    const unsubscribe = native.onAuthorize((event) => {
      if (event.sessionId === sessionId && !signal.aborted) onAuthorizePrompt();
    });
    signal.addEventListener("abort", abort, { once: true });
    try {
      const mode = await native.open({
        sessionId,
        device: {
          vendorId: device.raw.vendorId,
          productId: device.raw.productId,
          serialNumber: device.serial,
        },
      });
      signal.throwIfAborted();
      if (mode === "connected") {
        retained = true;
        return { kind: "connected", adb: nativePhoneAdb(native, sessionId), close };
      }
    } finally {
      unsubscribe();
      if (!retained) await close().catch(() => undefined);
    }
  }
  signal.throwIfAborted();
  const connection = await connectAgentPhone(device, {
    credentialStore: agentPhoneCredentialStore(),
    onAuthorizePrompt,
    signal,
  });
  if (signal.aborted) {
    if (connection.kind === "connected") await connection.adb.close().catch(() => undefined);
    signal.throwIfAborted();
  }
  if (connection.kind !== "connected") return connection;
  return {
    kind: "connected",
    adb: agentPhoneAdb(connection.adb),
    close: () => connection.adb.close(),
  };
}

function nativePhoneAdb(native: DesktopAgentPhoneAdbBridge, sessionId: string): AgentPhoneAdb {
  const unexpected = () => new Error("The phone returned an unexpected setup response.");
  return {
    getProp: async (key) => {
      const result = await native.call({ sessionId, kind: "getProp", key });
      if (result.kind !== "getProp") throw unexpected();
      return result.value;
    },
    shell: async (argv) => {
      const result = await native.call({ sessionId, kind: "shell", argv: [...argv] });
      if (result.kind !== "shell") throw unexpected();
      return result.value;
    },
    install: async (bytes) => {
      const result = await native.call({
        sessionId,
        kind: "install",
        bytes: new Uint8Array(bytes),
      });
      if (result.kind !== "install") throw unexpected();
      return result.value;
    },
    readFile: async (path, maxBytes) => {
      const result = await native.call({ sessionId, kind: "readFile", path, maxBytes });
      if (result.kind !== "readFile") throw unexpected();
      return result.value;
    },
  };
}
