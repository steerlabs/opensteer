/**
 * The agent's one channel into a guest: Firecracker's vsock, host-initiated, to the guest
 * helper. A command is one byte (and a fixed payload); the answer is one byte, compared with
 * the expected acknowledgement and discarded. Nothing else from the guest is ever read.
 */
import { connect } from "node:net";

export const helperPort = 1024;
const ack = 0x4b; // "K"

export type HelperCommand =
  | { readonly kind: "ping" }
  | { readonly kind: "sync" }
  /** The host time is read when the channel is open, just before it is written. */
  | { readonly kind: "time" }
  /** The instance's bridge token: 32 bytes, never on the command line. */
  | { readonly kind: "token"; readonly token: string };

export function helperCall(
  udsPath: string,
  command: HelperCommand,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const socket = connect(udsPath);
    let stage: "connect" | "answer" = "connect";
    let header = "";
    const fail = (error: Error) => {
      socket.destroy();
      reject(error);
    };
    const abort = () =>
      fail(signal.reason instanceof Error ? signal.reason : new Error("Aborted."));
    signal.addEventListener("abort", abort, { once: true });
    socket.once("connect", () => socket.write(`CONNECT ${helperPort}\n`));
    socket.on("data", (chunk: Buffer) => {
      if (stage === "connect") {
        header += chunk.toString("latin1");
        if (header.length > 32) return fail(new Error("The vsock handshake was malformed."));
        const end = header.indexOf("\n");
        if (end < 0) return;
        if (!/^OK [0-9]{1,10}$/u.test(header.slice(0, end)))
          return fail(new Error("The guest helper is not listening."));
        const rest = Buffer.from(header.slice(end + 1), "latin1");
        stage = "answer";
        socket.write(encode(command));
        if (rest.length) settle(rest);
        return;
      }
      settle(chunk);
    });
    const settle = (chunk: Buffer) => {
      signal.removeEventListener("abort", abort);
      socket.destroy();
      if (chunk.length === 1 && chunk[0] === ack) resolve();
      else reject(new Error("The guest helper did not acknowledge."));
    };
    socket.once("error", (error) => {
      signal.removeEventListener("abort", abort);
      fail(error);
    });
    socket.once("close", () => {
      signal.removeEventListener("abort", abort);
      reject(new Error("The guest helper closed the channel."));
    });
  });
}

function encode(command: HelperCommand): Buffer {
  if (command.kind === "ping") return Buffer.from("P");
  if (command.kind === "sync") return Buffer.from("S");
  if (command.kind === "token") {
    const token = Buffer.from(command.token, "hex");
    if (token.length !== 32 || token.toString("hex") !== command.token.toLowerCase())
      throw new Error("A bridge token is 32 bytes of hex.");
    return Buffer.concat([Buffer.from("B"), token]);
  }
  const unixNs = hostNowNs();
  const message = Buffer.alloc(17);
  message.write("T", 0, "latin1");
  message.writeBigInt64LE(unixNs / 1_000_000_000n, 1);
  message.writeBigInt64LE(unixNs % 1_000_000_000n, 9);
  return message;
}

/** The host's wall clock in nanoseconds, read as late as possible before it is sent. */
export function hostNowNs(): bigint {
  return BigInt(Date.now()) * 1_000_000n;
}

/** Retries the helper until it answers or the signal ends: the guest is still booting. */
export async function waitForHelper(udsPath: string, signal: AbortSignal): Promise<void> {
  for (;;) {
    try {
      await helperCall(udsPath, { kind: "ping" }, signal);
      return;
    } catch (error) {
      if (signal.aborted) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}
