import type { RunnerId } from "@opensteer/core";
import type { OpensteerStore } from "@opensteer/database";
import { AgentPhoneUpdateStatusSchema, RunnerUpdateProofSchema } from "@opensteer/protocol";
import { z } from "zod";
import type { WebSocket } from "ws";
import type { RunnerAuthenticator } from "../agents/runner-authenticator.js";
import type { AgentPhoneUpdateRelease } from "./update-release.js";

const Download = z.strictObject({
  type: z.literal("phone.update.download"),
  apkSha256: z.string().regex(/^[a-f0-9]{64}$/u),
});
type State = "downloading" | "installing" | "awaiting-user" | "failed";
interface Progress {
  readonly apkSha256: string;
  readonly connectionGeneration: number;
  readonly startedAt: number;
  state: State;
}

/** A separate, stable channel remains usable when integrations admission refuses an old app. */
export class AgentPhoneUpdateHub {
  readonly #progress = new Map<RunnerId, Progress>();
  readonly #sockets = new Set<WebSocket>();
  readonly #expiry: ReturnType<typeof setInterval>;

  readonly #options: {
    readonly authenticator: RunnerAuthenticator;
    readonly store: Pick<OpensteerStore, "runnerForAuthentication">;
    readonly release: () => AgentPhoneUpdateRelease | null;
    readonly changed: () => void;
  };

  constructor(options: {
    readonly authenticator: RunnerAuthenticator;
    readonly store: Pick<OpensteerStore, "runnerForAuthentication">;
    readonly release: () => AgentPhoneUpdateRelease | null;
    readonly changed: () => void;
  }) {
    this.#options = options;
    this.#expiry = setInterval(() => {
      let changed = false;
      for (const [id, entry] of this.#progress) {
        const age = Date.now() - entry.startedAt;
        if (age > 24 * 60 * 60_000) this.#progress.delete(id);
        else if (age > 10 * 60_000 && entry.state !== "failed") {
          entry.state = "failed";
          changed = true;
        }
      }
      if (changed) this.#options.changed();
    }, 10_000);
    this.#expiry.unref();
  }

  projection(runnerId: RunnerId, generation: number, connected: boolean) {
    const entry = this.#progress.get(runnerId);
    if (!entry) return null;
    if (connected || entry.connectionGeneration !== generation) {
      this.#progress.delete(runnerId);
      return null;
    }
    return entry.state;
  }

  close(): void {
    clearInterval(this.#expiry);
    for (const socket of this.#sockets) socket.close(1001, "Host closing");
    this.#sockets.clear();
  }

  attach(socket: WebSocket, releaseChallenge: () => void): void {
    if (this.#sockets.size >= 256) {
      releaseChallenge();
      socket.close(1013, "Phone update capacity reached");
      return;
    }
    this.#sockets.add(socket);
    const challenge = this.#options.authenticator.issueChallenge();
    let authenticated = false;
    let downloaded = false;
    let proof: z.infer<typeof RunnerUpdateProofSchema> | null = null;
    let release: AgentPhoneUpdateRelease | null = null;
    let progress: Progress | null = null;
    let runnerId: RunnerId | null = null;
    const timeout = setTimeout(
      () => socket.close(1008, "Phone update authentication timeout"),
      15_000,
    );
    timeout.unref();
    const lifetime = setTimeout(
      () => socket.close(1008, "Phone update deadline exceeded"),
      10 * 60_000,
    );
    lifetime.unref();
    const send = (data: string | Buffer) =>
      new Promise<void>((resolve, reject) => {
        if (socket.readyState !== socket.OPEN)
          return reject(new Error("Phone update socket closed"));
        socket.send(data, (error) => (error ? reject(error) : resolve()));
      });
    const authorize = async () => {
      if (!runnerId || !progress) throw new Error("Phone update is not authenticated");
      const runner = await this.#options.store.runnerForAuthentication(runnerId);
      if (
        !runner ||
        runner.revokedAt ||
        runner.connectionGeneration !== progress.connectionGeneration
      )
        throw new Error("Phone update identity is no longer current");
    };
    let queued = 0;
    let lane = Promise.resolve();
    socket.on("message", (raw, binary) => {
      if (binary || raw.toString().length > 16_384 || ++queued > 4) {
        socket.close(1008, "Invalid phone update frame");
        return;
      }
      const text = raw.toString();
      lane = lane
        .then(async () => {
          if (socket.readyState !== socket.OPEN) return;
          const frame: unknown = JSON.parse(text);
          if (!authenticated) {
            proof = RunnerUpdateProofSchema.parse(frame);
            const identity = await this.#options.authenticator.authenticateUpdateRefusal(
              challenge,
              proof,
            );
            const phone = z
              .object({
                device: z.object({ form: z.literal("phone") }),
                modules: z.object({ integrations: z.object({ platform: z.literal("android") }) }),
              })
              .safeParse(proof.descriptor);
            if (!phone.success) throw new Error("Only an enrolled phone may update");
            authenticated = true;
            releaseChallenge();
            clearTimeout(timeout);
            runnerId = identity.runnerId;
            release = this.#options.release();
            await send(
              JSON.stringify({
                type: "host.agent-phone.update",
                protocolVersion: 1,
                release: release
                  ? { manifestJson: release.manifestJson, receipt: release.receipt }
                  : null,
              }),
            );
            if (!release) socket.close(1000, "No phone release available");
            progress = {
              apkSha256: release?.manifest.apkSha256 ?? "",
              connectionGeneration: identity.connectionGeneration,
              startedAt: Date.now(),
              state: "downloading",
            };
            return;
          }
          if (!release || !progress || !runnerId || !proof)
            throw new Error("No phone release available");
          await authorize();
          const download = Download.safeParse(frame);
          if (download.success) {
            if (downloaded || download.data.apkSha256 !== release.manifest.apkSha256)
              throw new Error("Invalid phone release request");
            downloaded = true;
            if (this.#progress.size >= 256 && !this.#progress.has(runnerId))
              throw new Error("Phone update capacity reached");
            this.#progress.set(runnerId, progress);
            this.#options.changed();
            // Await each write so a slow tunnel never queues the whole APK per phone.
            for (let offset = 0; offset < release.apk.byteLength; offset += 65_536) {
              if (offset % 1_048_576 === 0) await authorize();
              await send(release.apk.subarray(offset, offset + 65_536));
            }
            await send(JSON.stringify({ type: "host.agent-phone.update.downloaded" }));
            return;
          }
          const status = AgentPhoneUpdateStatusSchema.parse(frame);
          if (status.apkSha256 !== release.manifest.apkSha256)
            throw new Error("Phone update release changed");
          if (progress.state === "failed") return;
          progress.state = status.state;
          this.#progress.set(runnerId, progress);
          this.#options.changed();
        })
        .catch(() => {
          socket.close(1008, "Phone update refused");
        })
        .finally(() => {
          queued -= 1;
        });
    });
    socket.once("close", () => {
      releaseChallenge();
      clearTimeout(timeout);
      clearTimeout(lifetime);
      this.#sockets.delete(socket);
      if (downloaded && progress?.state === "downloading") {
        progress.state = "failed";
        this.#options.changed();
      }
    });
    socket.on("error", () => socket.close());
    void send(JSON.stringify(challenge)).catch(() => socket.close());
  }
}
