import {
  OpensteerError,
  type TeamSource,
  type TeamActor,
  type TeamAgentRequestId,
  type TeamLinkId,
  type UserId,
} from "@opensteer/core";
import { teamApiVersion } from "@opensteer/deployment-authority";
import type { TeamRequestStorePort } from "@opensteer/database/team-requests-port";
import {
  readTeamFrame,
  TeamLinkClientFrameViewSchema,
  TeamLinkServerFrameSchema,
  TeamLinkResultSchema,
  type TeamLinkServerFrame,
} from "@opensteer/protocol";
import type { WebSocket } from "ws";
import {
  checkTeamVersion,
  linkError,
  teamLinkMaxFrameBytes,
  type TeamLinkCall,
  type TeamLinkResult,
  type TeamMachineDataPort,
} from "./contracts.js";
import { auditTeamMachineCall } from "./audit.js";
import { TeamEndpointLinks } from "./links.js";
import { TeamLinkLifetimes } from "./lifetimes.js";
import { boundTeamReadPage } from "./read-page.js";
import { TeamKnowledgeFailure } from "../knowledge/team-knowledge.js";
import type { TeamAccessResolver, TeamAccessLockPort } from "../team/access-port.js";

export interface TeamLinkEndpointOptions {
  readonly links: TeamEndpointLinks;
  readonly requests: TeamRequestStorePort;
  readonly data: TeamMachineDataPort;
  readonly access: TeamAccessLockPort;
  readonly lifetimes: TeamLinkLifetimes;
  readonly resolver: TeamAccessResolver;
  readonly onPresence?: (ownerUserId: UserId, online: boolean) => void;
}
interface MachineResult {
  readonly result: TeamLinkResult;
  readonly reauthorize?: () => Promise<boolean>;
}
type KnowledgeCall = Extract<TeamLinkCall, { type: `knowledge.${string}` }>;
const isKnowledgeCall = (frame: TeamLinkCall): frame is KnowledgeCall =>
  frame.type.startsWith("knowledge.");

export class TeamLinkEndpoint {
  readonly options: TeamLinkEndpointOptions;
  readonly #online = new Map<UserId, number>();
  readonly #sockets = new Map<
    TeamLinkId,
    Set<{
      ownerUserId: UserId;
      online: boolean;
      deliver(): Promise<void>;
      cancel(id: TeamAgentRequestId): void;
    }>
  >();
  constructor(options: TeamLinkEndpointOptions) {
    this.options = options;
  }

  async attach(socket: WebSocket, linkId: TeamLinkId): Promise<void> {
    const { links, requests, access, lifetimes } = this.options;
    const link = await links.assertActive(linkId);
    let active = true;
    let hello = false;
    let work = Promise.resolve();
    let queued = 0;
    const offline = () => {
      if (!subscriber.online) return;
      subscriber.online = false;
      const count = (this.#online.get(link.ownerUserId) ?? 1) - 1;
      if (count) this.#online.set(link.ownerUserId, count);
      else {
        this.#online.delete(link.ownerUserId);
        this.options.onPresence?.(link.ownerUserId, false);
      }
    };
    const close = (revoked = false) => {
      if (!active) return;
      active = false;
      offline();
      socket.close(revoked ? 1008 : 1012, "Team link ended");
      const deadline = setTimeout(() => socket.terminate(), 1000);
      deadline.unref();
      socket.once("close", () => clearTimeout(deadline));
    };
    const unregister = lifetimes.register({
      linkId,
      userId: link.ownerUserId,
      channelIds: [],
      cancel: close,
    });
    const write = (frame: TeamLinkServerFrame) => {
      if (!active || socket.bufferedAmount > teamLinkMaxFrameBytes)
        throw linkError("resource_exhausted");
      const encoded = JSON.stringify(TeamLinkServerFrameSchema.parse(frame));
      if (Buffer.byteLength(encoded) > teamLinkMaxFrameBytes) throw linkError("resource_exhausted");
      socket.send(encoded);
    };
    const send = async (frame: TeamLinkServerFrame) => {
      const revision = access.revision;
      await links.assertActive(linkId);
      await access.handoff(
        revision,
        async () => {
          await links.assertActive(linkId);
          return true;
        },
        () => write(frame),
      );
    };
    const subscriber = {
      ownerUserId: link.ownerUserId,
      online: false,
      deliver: async () => {
        if (!hello || !active) return;
        const revision = access.revision;
        const pending = await requests.pending(linkId);
        const batches: (typeof pending)[number][][] = [];
        let batch: (typeof pending)[number][] = [];
        for (const request of pending) {
          const next = [...batch, request];
          if (
            batch.length &&
            (batch.length === 32 ||
              Buffer.byteLength(JSON.stringify({ type: "requests", requests: next })) >
                teamLinkMaxFrameBytes)
          ) {
            batches.push(batch);
            batch = [];
          }
          batch.push(request);
        }
        if (batch.length) batches.push(batch);
        for (const batch of batches) {
          await access.handoff(
            revision,
            async () => {
              const current = await requests.pending(linkId);
              return batch.every((item) =>
                current.some((entry) => entry.request.id === item.request.id),
              );
            },
            () => write({ type: "requests", requests: batch }),
          );
        }
      },
      cancel: (requestId: TeamAgentRequestId) => {
        void send({ type: "cancel", requestId }).catch(() => close());
      },
    };
    const sockets = this.#sockets.get(linkId) ?? new Set();
    sockets.add(subscriber);
    this.#sockets.set(linkId, sockets);
    socket.once("close", () => {
      active = false;
      offline();
      unregister();
      sockets.delete(subscriber);
      if (!sockets.size) this.#sockets.delete(linkId);
    });
    socket.on("error", () => close());
    const deadline = setTimeout(() => {
      if (!hello) close();
    }, 10_000);
    deadline.unref();
    socket.once("close", () => clearTimeout(deadline));
    socket.on("message", (bytes, binary) => {
      if (binary || Buffer.byteLength(bytes.toString()) > teamLinkMaxFrameBytes || ++queued > 32) {
        close();
        return;
      }
      work = work.then(async () => {
        try {
          const raw: unknown = JSON.parse(bytes.toString());
          if (typeof raw === "object" && raw !== null && "type" in raw && raw.type === "hello")
            checkTeamVersion("teamApiVersion" in raw ? raw.teamApiVersion : undefined);
          const frame = readTeamFrame(TeamLinkClientFrameViewSchema, raw);
          if (!frame) return;
          await links.assertActive(linkId);
          if (frame.type === "hello") {
            if (hello) throw linkError("bad_request");
            checkTeamVersion(String(frame.teamApiVersion));
            hello = true;
            clearTimeout(deadline);
            await links.seen(linkId);
            await send({
              type: "ready",
              teamApiVersion,
              link: links.view(link),
              accessRevision: access.revision,
            });
            if (active) {
              const count = this.#online.get(link.ownerUserId) ?? 0;
              subscriber.online = true;
              this.#online.set(link.ownerUserId, count + 1);
              if (!count) this.options.onPresence?.(link.ownerUserId, true);
            }
            // Personal reconciles these even when they are absent from pending().
            for (const terminal of frame.terminalRequests) {
              if (terminal.terminalState && terminal.publicationState === "pending")
                await requests.receipt(linkId, terminal.requestId);
            }
            await subscriber.deliver();
          } else if (!hello) {
            throw linkError("bad_request");
          } else if (frame.type === "ping") {
            await links.seen(linkId);
            await send({ type: "pong" });
          } else {
            try {
              await this.call(linkId, frame, (result) =>
                write({ type: "result", id: frame.id, result }),
              );
            } catch (error) {
              await send({
                type: "error",
                id: frame.id,
                error: {
                  code:
                    error instanceof TeamKnowledgeFailure && error.code === "bad_request"
                      ? "bad_message"
                      : error instanceof OpensteerError && error.code === "forbidden"
                        ? "forbidden"
                        : error instanceof OpensteerError && error.code === "not_found"
                          ? "not_found"
                          : error instanceof OpensteerError && error.code === "conflict"
                            ? "conflict"
                            : "internal",
                  message:
                    error instanceof TeamKnowledgeFailure
                      ? [error.message, error.next].filter(Boolean).join("\n").slice(0, 2000)
                      : "Team request is unavailable",
                  retryable:
                    !(error instanceof OpensteerError) ||
                    error.retryable ||
                    ["timeout", "runner_offline"].includes(error.code),
                },
              });
            }
          }
        } catch {
          close();
        } finally {
          queued--;
        }
      });
    });
  }

  async deliver(linkId: TeamLinkId): Promise<void> {
    await Promise.all([...(this.#sockets.get(linkId) ?? [])].map((socket) => socket.deliver()));
  }

  isOnline(ownerUserId: UserId): boolean {
    return this.#online.has(ownerUserId);
  }

  cancel(linkId: TeamLinkId, requestId: TeamAgentRequestId): void {
    for (const socket of this.#sockets.get(linkId) ?? []) socket.cancel(requestId);
  }

  async call(linkId: TeamLinkId, frame: TeamLinkCall): Promise<TeamLinkResult>;
  async call<Value>(
    linkId: TeamLinkId,
    frame: TeamLinkCall,
    deliver: (result: TeamLinkResult) => Value,
  ): Promise<Value>;
  async call<Value>(
    linkId: TeamLinkId,
    frame: TeamLinkCall,
    deliver?: (result: TeamLinkResult) => Value,
  ): Promise<Value | TeamLinkResult> {
    const { links, requests, access } = this.options;
    const revision = access.revision;
    const link = await links.assertActive(linkId);
    const buffered = await this.#perform(linkId, frame);
    const result = TeamLinkResultSchema.parse(buffered.result);
    const sources: TeamSource[] =
      result.kind === "read"
        ? [result.result.source]
        : result.kind === "search"
          ? result.result.results.map((r) => r.source)
          : result.kind === "context"
            ? [result.context.source]
            : [];
    const authorize = async () => {
      await links.assertActive(linkId);
      if (
        ["accept", "context", "status", "receipt"].includes(frame.type) &&
        "requestId" in frame &&
        frame.requestId
      ) {
        if (["accept", "receipt", "status"].includes(frame.type))
          await requests.receipt(linkId, frame.requestId);
        else await requests.authorize(linkId, frame.requestId, "read");
      }
      if (result.kind === "channels")
        await links.database.transaction().execute(async (tx) => {
          for (const channel of result.result.channels) {
            const rights = await this.options.resolver.channel(
              tx,
              { kind: "agent", userId: link.ownerUserId },
              channel.id,
            );
            if (!rights.read || rights.peopleOnly) throw linkError();
          }
        });
      if (buffered.reauthorize && !(await buffered.reauthorize())) throw linkError();
      for (const source of sources) await this.#source(link.ownerUserId, source);
      return true;
    };
    try {
      for (const source of sources) await this.#source(link.ownerUserId, source);
      return await access.handoff(revision, authorize, () => (deliver ? deliver(result) : result));
    } catch (error) {
      if (!isKnowledgeCall(frame) && frame.type !== "revoke")
        await this.#audit(linkId, frame, "denied");
      throw error;
    }
  }

  async #source(userId: TeamActor["userId"], source: TeamSource): Promise<void> {
    await this.options.links.database.transaction().execute(async (tx) => {
      const rights = await this.options.resolver.channel(
        tx,
        { kind: "agent", userId },
        source.channelId,
      );
      if (!rights.read || rights.peopleOnly) throw linkError();
    });
  }

  async #perform(linkId: TeamLinkId, frame: TeamLinkCall): Promise<MachineResult> {
    const { links, requests, data } = this.options;
    const link = await links.assertActive(linkId);
    if (frame.type === "revoke") {
      await links.revoke(linkId);
      return { result: { kind: "ok" } };
    }
    if (frame.type === "receipt")
      return {
        result: { kind: "receipt", messageId: await requests.receipt(linkId, frame.requestId) },
      };
    if (frame.type === "accept")
      return {
        result: {
          kind: "accepted",
          request: await requests.accept(linkId, frame.requestId, frame.decision),
        },
      };
    // Knowledge acts as the link's owner and records its own audit.
    if (isKnowledgeCall(frame)) return data.knowledge(linkId, link.ownerUserId, frame);
    const actor: TeamActor = { kind: "agent", userId: link.ownerUserId };
    try {
      let result: TeamLinkResult;
      switch (frame.type) {
        case "reconcile":
          result = {
            kind: "reconciled",
            requests: [...(await requests.reconcile(linkId, frame.requestIds))],
          };
          break;
        case "channels":
          result = { kind: "channels", result: await data.channels(actor, linkId, frame) };
          break;
        case "context":
          result = { kind: "context", context: await requests.context(linkId, frame.requestId) };
          break;
        case "status":
          await requests.status(linkId, frame.requestId, frame);
          result = { kind: "ok" };
          break;
        case "post": {
          const posted = await requests.post(linkId, {
            ...frame,
            publication: frame.publication ?? false,
          });
          result = {
            kind: "receipt",
            messageId: posted.messageId,
            ...(posted.askOutcomes.length ? { askOutcomes: [...posted.askOutcomes] } : {}),
          };
          break;
        }
        case "read":
          result = {
            kind: "read",
            result: boundTeamReadPage(
              await data.read(actor, linkId, frame),
              frame.after ? "after" : frame.before ? "before" : "newest",
            ),
          };
          break;
        case "search":
          result = { kind: "search", result: await data.search(actor, linkId, frame) };
          break;
      }
      if (frame.type === "context" || frame.type === "status")
        await this.#audit(linkId, frame, "allowed");
      return { result };
    } catch (error) {
      await this.#audit(linkId, frame, "denied");
      throw error;
    }
  }

  async #audit(
    linkId: TeamLinkId,
    frame: Exclude<TeamLinkCall, { type: "revoke" } | KnowledgeCall>,
    outcome: "allowed" | "denied",
  ): Promise<void> {
    await auditTeamMachineCall(this.options.links.database, {
      linkId,
      requestId: "requestId" in frame ? frame.requestId : undefined,
      ...("runId" in frame ? { runId: frame.runId } : {}),
      operationId:
        frame.type === "post"
          ? frame.clientMessageId
          : (("operationId" in frame ? frame.operationId : undefined) ?? frame.id),
      action: `agent.${frame.type}`,
      outcome,
      ...(frame.type === "read" || frame.type === "post" ? { channelId: frame.channelId } : {}),
    });
  }
}
