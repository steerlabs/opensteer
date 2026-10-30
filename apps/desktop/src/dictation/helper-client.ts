import { once } from "node:events";
import { unlink } from "node:fs/promises";
import type { Socket } from "node:net";
import { desktopDictationTeamId } from "./release-identity.js";
import { delay } from "@opensteer/shared/delay";
import {
  LengthPrefixedJsonReader,
  encodeLengthPrefixedJson,
} from "@opensteer/shared/lengthPrefixedJson";
import {
  DictationHelperReplySchema,
  DictationHelperRequestSchema,
  dictationHelperMaxFrameBytes,
  dictationHelperProtocolVersion,
  type DictationHelperMethod,
} from "@opensteer/protocol/dictation-helper";
import { DictationAvailabilitySchema, type DictationEvent } from "@opensteer/protocol/dictation";
import { ensureDictationBrokerInstalled, dictationBrokerIdentity } from "./install.js";
import { dictationBrokerLockPath, dictationBrokerSocketPath } from "./paths.js";
import {
  defaultSignedHelperRun,
  isSignedHelperSocketAbsent,
  openSignedHelperSocket,
  runSignedHelperPeerVerifier,
  signedHelperExecutablePath,
  withSignedHelperLifecycleLock,
  verifySignedHelperSignature,
  signedHelperSignaturePolicy,
} from "../signed-helpers/signed-helper.js";

export interface DictationHelperClient {
  call(method: DictationHelperMethod, session?: string): Promise<unknown>;
  subscribe(event: (value: DictationEvent) => void, lost: () => void): () => void;
  disconnect(): void;
  close(): void;
}

export class NativeDictationHelperClient implements DictationHelperClient {
  #socket: Socket | null = null;
  #opening: Promise<Socket> | null = null;
  #closed = false;
  #id = 0;
  #listeners = new Set<{ event: (value: DictationEvent) => void; lost: () => void }>();
  #pending = new Map<
    number,
    {
      method: DictationHelperMethod;
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  >();
  private readonly options: { development: boolean; bundledAppPath: string };
  constructor(options: { development: boolean; bundledAppPath: string }) {
    this.options = options;
  }
  subscribe(event: (value: DictationEvent) => void, lost: () => void): () => void {
    const listener = { event, lost };
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  disconnect(): void {
    this.#socket?.destroy();
  }
  close(): void {
    this.#closed = true;
    this.disconnect();
  }
  async #connect(): Promise<Socket> {
    if (this.#closed) throw new Error("Dictation is closed");
    if (this.#socket && !this.#socket.destroyed) return this.#socket;
    if (this.#socket?.destroyed) await once(this.#socket, "close");
    if (this.#opening) return this.#opening;
    this.#opening = this.#open();
    try {
      return await this.#opening;
    } finally {
      this.#opening = null;
    }
  }
  async #open(): Promise<Socket> {
    const { development, bundledAppPath } = this.options;
    const deadline = { at: Date.now() + 15_000 };
    const installed = await ensureDictationBrokerInstalled({
      development,
      bundledAppPath,
      deadline,
    });
    if (installed.protocolVersion !== dictationHelperProtocolVersion)
      throw new Error("Incompatible dictation helper");
    const identity = dictationBrokerIdentity(development);
    return withSignedHelperLifecycleLock(
      { identity, deadline, lockPath: dictationBrokerLockPath(development) },
      async () => {
        await verifySignedHelperSignature(
          defaultSignedHelperRun,
          installed.path,
          identity,
          signedHelperSignaturePolicy(desktopDictationTeamId(development)),
        );
        let launched = false;
        if (installed.launchFreshInstance) {
          await unlink(dictationBrokerSocketPath(development)).catch(() => undefined);
          await defaultSignedHelperRun("/usr/bin/open", ["-n", "-g", "-a", installed.path]);
          launched = true;
        }
        while (Date.now() < deadline.at) {
          if (this.#closed) throw new Error("Dictation is closed");
          const socket = await openSignedHelperSocket(
            dictationBrokerSocketPath(development),
            () => undefined,
          ).catch((error: unknown) => {
            if (!isSignedHelperSocketAbsent(error)) throw error;
            return null;
          });
          if (socket) {
            try {
              await runSignedHelperPeerVerifier(
                identity,
                signedHelperExecutablePath(identity, bundledAppPath),
                socket,
                Math.max(1, deadline.at - Date.now()),
              );
              if (this.#closed) throw new Error("Dictation is closed");
              this.#attach(socket);
              socket.resume();
              return socket;
            } catch (error) {
              socket.destroy();
              if (launched || this.#closed) throw error;
              await unlink(dictationBrokerSocketPath(development)).catch(() => undefined);
              await defaultSignedHelperRun("/usr/bin/open", ["-n", "-g", "-a", installed.path]);
              launched = true;
              continue;
            }
          }
          if (!launched) {
            await defaultSignedHelperRun("/usr/bin/open", ["-g", "-a", installed.path]);
            launched = true;
          }
          await delay(100);
        }
        throw new Error("Dictation helper did not start");
      },
    );
  }
  #attach(socket: Socket): void {
    this.#socket = socket;
    const reader = new LengthPrefixedJsonReader(dictationHelperMaxFrameBytes);
    socket.on("data", (chunk: Buffer) => {
      try {
        for (const frame of reader.push(chunk)) {
          const reply = DictationHelperReplySchema.parse(frame);
          if ("event" in reply) {
            for (const listener of this.#listeners) listener.event(reply.event);
          } else {
            const pending = this.#pending.get(reply.id);
            if (!pending) throw new Error("Unexpected reply");
            if (pending.method === "availability") DictationAvailabilitySchema.parse(reply.result);
            else if (reply.result !== null) throw new Error("Invalid command acknowledgement");
            this.#pending.delete(reply.id);
            pending.resolve(reply.result);
          }
        }
      } catch {
        socket.destroy();
      }
    });
    socket.on("error", () => socket.destroy());
    socket.once("close", () => {
      if (this.#socket !== socket) return;
      this.#socket = null;
      for (const pending of this.#pending.values())
        pending.reject(new Error("Dictation connection lost"));
      this.#pending.clear();
      for (const listener of this.#listeners) listener.lost();
    });
  }
  async call(method: DictationHelperMethod, session?: string): Promise<unknown> {
    const socket = await this.#connect();
    if (socket.destroyed) throw new Error("Dictation connection lost");
    const request = DictationHelperRequestSchema.parse({
      id: ++this.#id,
      method,
      params: session === undefined ? {} : { session },
    });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => socket.destroy(), 15_000);
      this.#pending.set(request.id, {
        method,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      socket.write(encodeLengthPrefixedJson(request, dictationHelperMaxFrameBytes));
    });
  }
}
