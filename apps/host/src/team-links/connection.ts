import { randomUUID } from "node:crypto";
import type { DeploymentId } from "@opensteer/core";
import { OpensteerError } from "@opensteer/core";
import { acceptsTeamApiVersion, teamApiVersion } from "@opensteer/deployment-authority";
import {
  readTeamFrame,
  TeamLinkClientFrameSchema,
  TeamLinkServerFrameViewSchema,
  type PersonalTeamRequest,
  type TeamLinkServerFrame,
} from "@opensteer/protocol";
import type { WebSocket } from "ws";
import {
  linkError,
  teamLinkMaxFrameBytes,
  type TeamLinkCallInput,
  type TeamLinkResult,
  type TeamLinkRpc,
} from "../team-link-endpoint/contracts.js";
import { teamLinkVersionError } from "./discovery.js";

export interface TeamLinkConnectionOptions {
  readonly teamId: DeploymentId;
  readonly open: (signal: AbortSignal) => Promise<WebSocket>;
  readonly terminalRequests: () => Promise<readonly PersonalTeamRequest[]>;
  readonly onReady: () => Promise<void>;
  readonly onFrame: (
    frame: Extract<TeamLinkServerFrame, { type: "requests" | "cancel" | "revoked" }>,
  ) => Promise<void>;
  readonly onState: (
    state: "active" | "unreachable" | "needs_update",
    error?: OpensteerError,
  ) => Promise<void>;
}

export class TeamLinkConnection implements TeamLinkRpc {
  readonly options: TeamLinkConnectionOptions;
  readonly #lifetime = new AbortController();
  readonly #calls = new Map<
    string,
    {
      resolve: (result: TeamLinkResult) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  #socket: WebSocket | null = null;
  #ready = false;
  #attempt = 0;
  #retry: ReturnType<typeof setTimeout> | undefined;
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  #lastPong = Date.now();
  #opening = false;
  constructor(options: TeamLinkConnectionOptions) {
    this.options = options;
  }

  start(): void {
    if (!this.#lifetime.signal.aborted && !this.#socket && !this.#retry && !this.#opening)
      void this.#connect().catch(() => this.#schedule());
  }
  stop(): void {
    this.#lifetime.abort();
    clearTimeout(this.#retry);
    clearInterval(this.#heartbeat);
    this.#ready = false;
    this.#socket?.terminate();
    this.#socket = null;
    for (const call of this.#calls.values()) {
      clearTimeout(call.timer);
      call.reject(linkError("runner_offline"));
    }
    this.#calls.clear();
  }

  async #connect(): Promise<void> {
    this.#opening = true;
    let paused = false;
    try {
      const socket = await this.options.open(this.#lifetime.signal);
      if (this.#lifetime.signal.aborted) {
        socket.terminate();
        return;
      }
      this.#socket = socket;
      let callbacks = Promise.resolve();
      let queuedFrames = 0;
      socket.on("message", (bytes, binary) => {
        if (binary || Buffer.byteLength(bytes.toString()) > teamLinkMaxFrameBytes) {
          socket.terminate();
          return;
        }
        let frame: TeamLinkServerFrame | null;
        try {
          frame = readTeamFrame(TeamLinkServerFrameViewSchema, JSON.parse(bytes.toString()));
        } catch {
          socket.terminate();
          return;
        }
        if (!frame) return;
        if (frame.type === "result" || frame.type === "error") {
          const pending = this.#calls.get(frame.id);
          if (pending) {
            this.#calls.delete(frame.id);
            clearTimeout(pending.timer);
            if (frame.type === "result") pending.resolve(frame.result);
            else
              pending.reject(
                new OpensteerError({
                  code: frame.error.retryable
                    ? "runner_offline"
                    : frame.error.code === "bad_message"
                      ? "bad_request"
                      : frame.error.code,
                  message: frame.error.message,
                  retryable: frame.error.retryable,
                  ...(frame.error.reason ? { reason: frame.error.reason } : {}),
                }),
              );
          }
          return;
        }
        if (frame.type === "pong") {
          this.#lastPong = Date.now();
          return;
        }
        if (++queuedFrames > 32) {
          socket.terminate();
          return;
        }
        callbacks = callbacks
          .then(async () => {
            if (this.#lifetime.signal.aborted || this.#socket !== socket) return;
            if (frame.type === "ready") {
              if (this.#ready) throw linkError("bad_request");
              if (!acceptsTeamApiVersion(frame.teamApiVersion)) {
                paused = true;
                await this.options.onState(
                  "needs_update",
                  teamLinkVersionError(frame.teamApiVersion),
                );
                socket.terminate();
                return;
              }
              this.#ready = true;
              this.#attempt = 0;
              await this.options.onState("active");
              await this.options.onReady();
            } else {
              if (!this.#ready) throw linkError("bad_request");
              if (frame.type === "revoked") this.stop();
              await this.options.onFrame(frame);
            }
          })
          .catch(() => socket.terminate())
          .finally(() => {
            queuedFrames--;
          });
      });
      socket.once("close", (code) => {
        if (this.#socket !== socket) return;
        clearInterval(this.#heartbeat);
        this.#ready = false;
        this.#socket = null;
        for (const call of this.#calls.values()) {
          clearTimeout(call.timer);
          call.reject(linkError("runner_offline"));
        }
        this.#calls.clear();
        if (code === 1008) {
          this.stop();
          void this.options.onFrame({ type: "revoked" }).catch(() => undefined);
        } else this.#schedule(paused);
      });
      socket.on("error", () => socket.terminate());
      const terminal = (await this.options.terminalRequests()).filter(
        (r) => r.terminalState !== null && r.publicationState === "pending",
      );
      socket.send(
        JSON.stringify({
          type: "hello",
          teamApiVersion,
          terminalRequests: terminal
            .slice(0, 32)
            .map(({ requestId, terminalState, publicationState }) => ({
              requestId,
              terminalState,
              publicationState,
            })),
        }),
      );
      this.#lastPong = Date.now();
      this.#heartbeat = setInterval(() => {
        if (Date.now() - this.#lastPong > 75_000) socket.terminate();
        else if (this.#ready) socket.send('{"type":"ping"}');
      }, 30_000);
      this.#heartbeat.unref();
    } catch (error) {
      this.#socket?.terminate();
      this.#socket = null;
      clearInterval(this.#heartbeat);
      if (this.#lifetime.signal.aborted) return;
      if (error instanceof OpensteerError && error.code === "unauthorized") {
        this.stop();
        await this.options.onFrame({ type: "revoked" });
        return;
      }
      if (error instanceof OpensteerError && error.reason === "unsupported-version") {
        await this.options.onState("needs_update", error);
        this.#schedule(true);
        return;
      }
      this.#schedule();
    } finally {
      this.#opening = false;
    }
  }

  #schedule(preserveState = false): void {
    if (this.#lifetime.signal.aborted || this.#retry) return;
    if (!preserveState) void this.options.onState("unreachable").catch(() => undefined);
    const ceiling = Math.min(30_000, 500 * 2 ** Math.min(this.#attempt++, 6));
    this.#retry = setTimeout(
      () => {
        this.#retry = undefined;
        void this.#connect().catch(() => this.#schedule());
      },
      Math.floor(ceiling * (0.5 + Math.random() * 0.5)),
    );
    this.#retry.unref();
  }

  call(input: TeamLinkCallInput): Promise<TeamLinkResult> {
    const socket = this.#socket;
    if (!this.#ready || !socket) return Promise.reject(linkError("runner_offline"));
    if (this.#calls.size >= 32 || socket.bufferedAmount > teamLinkMaxFrameBytes)
      return Promise.reject(linkError("resource_exhausted"));
    const id = randomUUID();
    const encoded = JSON.stringify(TeamLinkClientFrameSchema.parse({ ...input, id }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#calls.delete(id);
        reject(linkError("timeout"));
      }, 15_000);
      timer.unref();
      this.#calls.set(id, { resolve, reject, timer });
      socket.send(encoded, (error) => {
        if (error) {
          clearTimeout(timer);
          this.#calls.delete(id);
          reject(linkError("runner_offline"));
        }
      });
    });
  }
}
