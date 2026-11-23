import { randomUUID } from "node:crypto";
import { outsideName } from "@opensteer/shared/outsideName";
import {
  OpensteerError,
  TabIdSchema,
  type BrowserSourceId,
  type DeviceId,
  type Tab,
  type ThreadId,
  type UserId,
} from "@opensteer/core";
import {
  authorizeTarget,
  executionAccess,
  withDatabaseOperationSignal,
  type ExecutionAuthority,
  type OpensteerStore,
  type sharedChromeAttempts,
  type AuthoritySubject,
} from "@opensteer/database";
import { createBrowserSessionId, type BrowserSessionId } from "@opensteer/protocol";
import {
  type BrowserSourceTabPart,
  type BrowserSourceTabShared,
  type BrowserSourceTabUnshared,
} from "@opensteer/browser-source-wire/frames";
import {
  boundedJsonSize,
  SessionCdpRouter,
  SessionCdpRouterError,
  type StandardCdpAttachment,
} from "@opensteer/browser-runtime-core";
import {
  BrowserUseCdpError,
  type BrowserUseBudget,
  type BrowserUseCall,
  type BrowserUsePort,
  type BrowserUseTarget,
} from "../browser-use/browser-repl-service.js";
import { BrowserCdpConnectionEnded } from "./browser-service.js";
import { ChromeTabBackend, ChromeTabReplyLost } from "./chrome-tab-backend.js";
import {
  StandardCdpTickets,
  standardCdpConnectPrefix,
  type CdpAuthority,
  type StandardCdpFacts,
  type StandardCdpTicketClaims,
} from "./standard-cdp-tickets.js";
import { routerStandardTransport, standardCdpAdmissionMs } from "./standard-cdp-transport.js";

type ChromeAccessWitness = Pick<StandardCdpFacts, "accessMode" | "grantRevision">;

type SourceFrame =
  | BrowserSourceTabPart<"tab.event" | "tab.result">
  | BrowserSourceTabShared
  | BrowserSourceTabUnshared
  | { type: "tab.detached"; shareId: string };
type ChromeSource = {
  readonly sourceId: BrowserSourceId;
  readonly ownerId: UserId;
  readonly name: string;
  readonly deviceId?: DeviceId;
  readonly detachReceipts?: boolean;
  readonly detachReplay?: boolean;
  readonly detaching: Map<
    string,
    {
      evidence: PromiseWithResolvers<boolean>;
      finished: Promise<void>;
      group: Group;
    }
  >;
  readonly backend: ChromeTabBackend;
  readonly router: SessionCdpRouter;
  readonly shares: Map<string, Share>;
  stopping: boolean;
};
type Share = {
  info: BrowserSourceTabShared;
  readonly generation: string;
  readonly createdAt: string;
  updatedAt: string;
  readonly source: ChromeSource;
  readonly group: Group;
  readonly clients: Set<StandardCdpAttachment>;
};
type Group = {
  readonly root: string;
  readonly sessionId: BrowserSessionId;
  readonly clients: Set<StandardCdpAttachment>;
  binding?: string;
  taskId?: ThreadId;
  attempt?: ChromeAttempt;
  closing: Set<Promise<void>>;
  opening: number;
  readonly detaching: Set<Promise<void>>;
  readonly pendingDetach: Set<string>;
  rootDetachIncomplete: boolean;
  popupDetachUnconfirmed: boolean;
};

type ChromeAttempt = {
  readonly id: string;
  readonly connectionId: string;
  readonly grantRevision: number;
  readonly source: ChromeSource;
  readonly root: string;
  readonly ready: Promise<void>;
  finishing?: Promise<void>;
};
type DeviceAccess = (
  ownerId: UserId,
  deviceId: DeviceId,
  list: boolean,
  person: boolean,
) => Promise<string>;

export interface ChromeSharedTab {
  readonly tabId: string;
  readonly sourceId: BrowserSourceId;
  readonly chromeName: string;
  readonly title: string;
  readonly url: string;
  readonly occupiedBy: string | null;
}

type ReplTarget = BrowserUseTarget & {
  readonly client: StandardCdpAttachment;
  readonly share: Share;
  /** Opened for work under a connection's authority. */
  readonly connection: boolean;
};

const forbidden = (message: string) => new OpensteerError({ code: "forbidden", message });
const unavailable = () => forbidden("This Chrome tab is no longer shared.");
const maxSharesPerChrome = 64;

export class ChromeSharedTabs {
  readonly standardCdpTickets = new StandardCdpTickets();
  readonly #sources = new Map<BrowserSourceId, ChromeSource>();
  readonly #shares = new Map<string, Share>();
  readonly #attempts = new Map<string, ChromeAttempt>();
  readonly #store: Pick<OpensteerStore, "admitExecution">;
  readonly #receipts: ReturnType<typeof sharedChromeAttempts> | undefined;
  readonly #device: DeviceAccess;
  readonly #changed: (ownerId: UserId) => void;
  readonly #onError: (error: unknown) => void;

  constructor(
    store: Pick<OpensteerStore, "admitExecution">,
    options: {
      readonly attempts?: ReturnType<typeof sharedChromeAttempts>;
      readonly device?: DeviceAccess;
      readonly changed?: (ownerId: UserId) => void;
      readonly onError?: (error: unknown) => void;
    } = {},
  ) {
    this.#store = store;
    this.#receipts = options.attempts;
    this.#device =
      options.device ??
      (async () => {
        throw unavailable();
      });
    this.#changed = options.changed ?? (() => {});
    this.#onError =
      options.onError ?? ((error) => console.error("Shared Chrome cleanup failed", error));
  }

  connectSource(options: {
    sourceId: BrowserSourceId;
    ownerId: UserId;
    name: string;
    deviceId?: DeviceId;
    detachReceipts?: boolean;
    detachReplay?: boolean;
    write: (frame: BrowserSourceTabPart<"tab.command">) => boolean;
    fail: () => void;
  }): { receive(frame: SourceFrame): void | Promise<void>; close(): void } {
    this.closeForSource(options.sourceId);
    const backend = new ChromeTabBackend(options.write, options.fail);
    const source: ChromeSource = {
      ...options,
      backend,
      router: new SessionCdpRouter(backend),
      shares: new Map(),
      detaching: new Map(),
      stopping: false,
    };
    this.#sources.set(options.sourceId, source);
    return {
      receive: (frame): void | Promise<void> => {
        if (this.#sources.get(source.sourceId) !== source) return;
        if (frame.type === "tab.shared") {
          if (!source.stopping) this.#share(source, frame);
        } else if (frame.type === "tab.unshared") void this.#unshare(source, frame.shareId);
        else if (frame.type === "tab.detached") {
          return source.detachReceipts ? this.#recordDetach(source, frame.shareId) : undefined;
        } else backend.read(frame);
        return;
      },
      close: () => {
        if (this.#sources.get(source.sourceId) === source) this.closeForSource(source.sourceId);
      },
    };
  }

  async listForBinding(authority: CdpAuthority): Promise<readonly ChromeSharedTab[]> {
    const entries = await this.#visible(authority.ownerId, this.#subject(authority));
    return entries
      .filter(
        ({ share }) => !share.group.binding || share.group.binding === authority.agentBindingId,
      )
      .map(({ share, computerName }) => ({
        tabId: share.info.shareId,
        sourceId: share.source.sourceId,
        chromeName: computerName ?? share.source.name,
        title: share.info.title,
        url: share.info.url,
        occupiedBy: share.group.binding ?? null,
      }));
  }

  async tabPlaces(ownerId: UserId, subject: AuthoritySubject): Promise<Tab[]> {
    if (this.#shares.size === 0) return [];
    return (await this.#visible(ownerId, subject)).flatMap(({ share, computerName, execution }) => {
      const computerId = share.source.deviceId;
      if (!computerId || !computerName) return [];
      const { group } = share;
      if (
        execution.actor === "agent" &&
        group.binding &&
        (subject.kind === "binding"
          ? group.binding !== subject.bindingId
          : group.attempt?.connectionId !== execution.agentConnection?.agentConnectionId)
      )
        return [];
      const taskId = group.taskId;
      return [
        {
          tabId: TabIdSchema.parse(share.info.shareId),
          kind: "page",
          title: share.info.title,
          url: share.info.url,
          profile: null,
          computer: { computerId, name: computerName },
          sharedByPerson: { sourceId: share.source.sourceId, computerName },
          groupId: null,
          state: "open",
          usedBy:
            taskId && (execution.actor === "person" || execution.threadId === taskId)
              ? [{ taskId }]
              : [],
          openedBy: "person",
          createdAt: share.createdAt,
          updatedAt: share.updatedAt,
        },
      ];
    });
  }

  async #visible(ownerId: UserId, subject: AuthoritySubject) {
    const execution = await this.#store.admitExecution({ ownerUserId: ownerId, subject });
    const sources = await Promise.all(
      [...this.#sources.values()].map(async (source) => {
        try {
          return { source, computerName: await this.#authorizeSource(execution, source, true) };
        } catch (error) {
          if (error instanceof OpensteerError && error.code !== "internal") return null;
          throw error;
        }
      }),
    );
    return sources.flatMap((entry) =>
      entry && this.#sources.get(entry.source.sourceId) === entry.source
        ? [...entry.source.shares.values()].map((share) => ({
            share,
            execution,
            computerName: entry.computerName,
          }))
        : [],
    );
  }

  shareGeneration(tabId: string, sourceId: BrowserSourceId): string | null {
    const share = this.#shares.get(tabId);
    return share?.source.sourceId === sourceId ? share.generation : null;
  }

  async issueStandardCdpTicket(input: {
    readonly authority: CdpAuthority;
    readonly tabId: string;
    readonly ttl?: number;
    readonly expectedAccess?: ChromeAccessWitness;
  }): Promise<{ readonly ticket: string; readonly path: string; readonly mode: "session" }> {
    const share = this.#shares.get(input.tabId);
    const execution = await this.#requireAccess(input.authority, share, input.expectedAccess);
    const { source, info, group } = share!;
    const ticket = this.standardCdpTickets.issue({
      ...input,
      browserSessionId: group.sessionId,
      mode: "session",
      sharedChromeTab: { sourceId: source.sourceId, tabId: info.shareId },
      facts: {
        profileId: null,
        profileBindingId: null,
        runtimeId: source.sourceId,
        placementKey: info.shareId,
        grantRevision: execution.agentConnection?.grantRevision ?? null,
        agentConnectionId: execution.agentConnection?.agentConnectionId ?? null,
        ...(execution.agentConnection ? { accessMode: execution.mode } : {}),
      },
    });
    return { ticket, path: `${standardCdpConnectPrefix}${ticket}`, mode: "session" };
  }

  async attachStandardCdpForAgent(
    claims: StandardCdpTicketClaims,
    signal: AbortSignal,
    admissionSignal?: AbortSignal,
  ) {
    const named = claims.sharedChromeTab;
    const share = named && this.#shares.get(named.tabId);
    if (
      !share ||
      share.source.sourceId !== named.sourceId ||
      share.group.sessionId !== claims.browserSessionId
    )
      throw unavailable();
    const verify = async (check: AbortSignal, expiresAt: number) => {
      check.throwIfAborted();
      const execution = await withDatabaseOperationSignal(check, expiresAt, () =>
        this.#requireAccess(claims.authority, share, claims.facts),
      );
      if ((execution.agentConnection?.agentConnectionId ?? null) !== claims.facts.agentConnectionId)
        throw unavailable();
      check.throwIfAborted();
      return execution;
    };
    const admitting = AbortSignal.any([
      signal,
      admissionSignal ?? AbortSignal.timeout(standardCdpAdmissionMs),
    ]);
    const execution = await verify(admitting, Date.now() + standardCdpAdmissionMs);
    const overflow = new AbortController();
    const client = await this.#open(
      share,
      claims.authority.agentBindingId,
      execution,
      admitting,
      () => overflow.abort(1013),
    );
    const life = AbortSignal.any([signal, overflow.signal, client.signal]);
    const close = () => client.close();
    life.addEventListener("abort", close, { once: true });
    if (life.aborted) close();
    const transport = routerStandardTransport(client, "session", life);
    const reauthorize = async (check = AbortSignal.timeout(1_000)) => {
      await verify(AbortSignal.any([life, check]), Date.now() + 1_000);
    };
    return {
      ...transport,
      reauthorize,
      send: async (frame: Buffer) => {
        await reauthorize();
        life.throwIfAborted();
        await transport.send(frame);
      },
    };
  }

  browserUsePort(
    authorityForContext: (contextKey: string) => Promise<CdpAuthority>,
    rootTabId?: string,
  ): BrowserUsePort<ReplTarget> {
    const openPages = new Map<string, Map<string, ReplTarget>>();
    const within = (share: Share) =>
      !rootTabId || share.group === this.#shares.get(rootTabId)?.group;
    const access = async (call: BrowserUseCall, share?: Share) => {
      call.signal.throwIfAborted();
      const authority = await authorityForContext(call.contextKey);
      const execution =
        share && within(share) ? await this.#requireAccess(authority, share) : undefined;
      if (share && !execution) throw unavailable();
      call.signal.throwIfAborted();
      return { authority, execution };
    };
    return {
      listPages: async (call) => {
        const list = await this.listForBinding((await access(call)).authority);
        const pages = list
          .filter(({ tabId }) => {
            const share = this.#shares.get(tabId);
            return share && within(share);
          })
          .map((tab) => ({
            tabId: tab.tabId,
            url: tab.url,
            title: tab.title,
            profile: `Chrome · ${tab.chromeName}`,
          }));
        this.#serialize(pages, call);
        return pages;
      },
      openPage: async (tabId, call) => {
        const share = this.#shares.get(tabId);
        if (!share) throw unavailable();
        const { authority, execution } = await access(call, share);
        const existing = openPages.get(call.contextKey)?.get(tabId);
        if (existing) return existing;
        const client = await this.#open(share, authority.agentBindingId, execution!, call.signal);
        try {
          const target = (await client.send({
            method: "Target.attachToTarget",
            parameters: { targetId: share.info.targetId, flatten: true },
          })) as { sessionId: string };
          call.signal.throwIfAborted();
          if (client.signal.aborted) throw unavailable();
          const opened = {
            tabId,
            targetId: share.info.targetId,
            sessionId: target.sessionId,
            client,
            share,
            // A connection's work is told the router's own sentence, the same at every door.
            connection: execution!.agentConnection !== null,
          };
          const entries = openPages.get(call.contextKey) ?? new Map<string, ReplTarget>();
          const current = entries.get(tabId);
          if (current) {
            client.close();
            return current;
          }
          entries.set(tabId, opened);
          openPages.set(call.contextKey, entries);
          client.signal.addEventListener(
            "abort",
            () => {
              entries.delete(tabId);
              if (!entries.size) openPages.delete(call.contextKey);
            },
            { once: true },
          );
          return opened;
        } catch (error) {
          client.close();
          throw error;
        }
      },
      newPage: async () => {
        throw forbidden("A shared Chrome tab cannot create a new tab.");
      },
      command: async (target, method, params, sessionId, call) => {
        await access(call, target.share);
        this.#serialize(params ?? {}, call);
        if (target.client.signal.aborted) throw unavailable();
        try {
          const result = await target.client.send({
            method,
            ...(params ? { parameters: params } : {}),
            ...(sessionId === undefined && method === "Browser.getVersion"
              ? {}
              : { sessionId: sessionId ?? target.sessionId }),
            replyBudget: {
              maxBytes: call.maxBytes,
              maxDepth: call.maxDepth,
              maxEntries: call.maxEntries,
            },
          });
          call.signal.throwIfAborted();
          return this.#serialize(result ?? null, call);
        } catch (error) {
          if (error instanceof ChromeTabReplyLost || target.client.signal.aborted)
            throw new OpensteerError({
              code: "conflict",
              reason: "outcome-unknown",
              message: "Chrome did not confirm the command outcome.",
            });
          if (call.signal.aborted) throw call.signal.reason;
          if (error instanceof BrowserUseCdpError) throw error;
          if (error instanceof SessionCdpRouterError && error.code === "forbidden")
            throw forbidden(
              target.connection
                ? error.message
                : "This CDP operation is unavailable on a shared Chrome tab.",
            );
          throw new Error("Shared Chrome command failed.", { cause: error });
        }
      },
      release: (target) => target.client.close(),
      subscribe: (target, onEvent, onEnd, budget) => {
        const remove = target.client.onEvent((event) => {
          try {
            onEvent({
              method: event.method,
              paramsJson: this.#serialize(event.parameters, budget),
              ...(event.sessionId ? { sessionId: event.sessionId } : {}),
            });
          } catch {
            target.client.close();
          }
        });
        target.client.signal.addEventListener("abort", onEnd, { once: true });
        if (target.client.signal.aborted) onEnd();
        return () => {
          remove();
          target.client.signal.removeEventListener("abort", onEnd);
          target.client.close();
        };
      },
    };
  }

  async closeForBinding(agentBindingId: string, _reason: string): Promise<void> {
    this.standardCdpTickets.revoke(agentBindingId);
    await Promise.all(
      [...this.#shares.values()]
        .filter(
          ({ group, info }) => group.binding === agentBindingId && group.root === info.shareId,
        )
        .map(({ source, group }) => {
          source.backend.stopSharing(group.root);
          return this.#unshare(source, group.root);
        }),
    );
  }

  async stopAttempt(id: string): Promise<void> {
    const attempt = this.#attempts.get(id);
    if (!attempt) return;
    if (attempt.finishing) return attempt.finishing;
    attempt.source.backend.stopSharing(attempt.root);
    await this.#unshare(attempt.source, attempt.root);
  }

  async stopSource(sourceId: BrowserSourceId): Promise<void> {
    const source = this.#sources.get(sourceId);
    if (!source) return;
    source.stopping = true;
    const closing: Promise<void>[] = [];
    for (const attempt of this.#attempts.values()) {
      if (attempt.source === source && attempt.finishing) closing.push(attempt.finishing);
    }
    for (const { info, group } of source.shares.values()) {
      if (info.shareId !== group.root) continue;
      source.backend.stopSharing(group.root);
      closing.push(this.#unshare(source, group.root));
    }
    await Promise.all(closing);
  }

  closeForSource(sourceId: BrowserSourceId): void {
    const source = this.#sources.get(sourceId);
    if (!source) return;
    this.#sources.delete(sourceId);
    for (const receipt of source.detaching.values()) receipt.evidence.resolve(false);
    for (const share of source.shares.values())
      if (share.info.shareId === share.group.root) void this.#unshare(source, share.info.shareId);
    source.detaching.clear();
    source.backend.close();
    void source.router.close();
  }

  close(): void {
    for (const id of this.#sources.keys()) this.closeForSource(id);
  }

  async #recordDetach(source: ChromeSource, shareId: string): Promise<void> {
    if (source.shares.has(shareId)) return;
    const waiting = source.detaching.get(shareId);
    if (waiting) {
      const { group, evidence, finished } = waiting;
      const last = group.pendingDetach.delete(shareId) && group.pendingDetach.size === 0;
      evidence.resolve(true);
      await finished;
      if (!source.detachReplay) {
        source.detaching.delete(shareId);
        const attempt = group.attempt;
        if (last && attempt?.finishing && !source.shares.has(group.root)) {
          await attempt.finishing;
          if (group.rootDetachIncomplete)
            await this.#receipts!.finish(attempt.connectionId, attempt.id, true);
        }
        return;
      }
      if (shareId !== group.root || (await evidence.promise)) return;
    }
    if (!source.detachReplay) return;
    await this.#receipts?.recordDetach({
      ownerId: source.ownerId,
      sourceId: source.sourceId,
      shareId,
    });
  }

  #subject(authority: CdpAuthority): AuthoritySubject {
    if (authority.expiresAt !== undefined && authority.expiresAt <= Date.now()) throw unavailable();
    return { kind: "binding", bindingId: authority.agentBindingId };
  }

  async #authorizeSource(execution: ExecutionAuthority, source: ChromeSource, list: boolean) {
    if (
      source.stopping ||
      source.ownerId !== execution.ownerUserId ||
      authorizeTarget(execution, { kind: "chrome-tabs", sourceId: source.sourceId }) !==
        "read-write"
    )
      throw unavailable();
    if (
      execution.actor !== "person" &&
      ((execution.runId && !execution.runMode) ||
        (!execution.agentConnection && execution.mode !== "full-access") ||
        (execution.agentConnection && !list && executionAccess(execution) !== "read-write"))
    )
      throw forbidden("This task's access mode does not allow shared Chrome control.");
    if (
      execution.agentConnection &&
      (!source.deviceId || !source.detachReceipts || !this.#receipts)
    )
      throw unavailable();
    return source.deviceId
      ? this.#device(source.ownerId, source.deviceId, list, execution.actor === "person")
      : null;
  }

  async #requireAccess(
    authority: CdpAuthority,
    expected: Share | undefined,
    witness?: ChromeAccessWitness,
  ): Promise<ExecutionAuthority> {
    if (!expected || expected.source.ownerId !== authority.ownerId) throw unavailable();
    const execution = await this.#store.admitExecution({
      ownerUserId: authority.ownerId,
      subject: this.#subject(authority),
    });
    if (
      witness &&
      ((witness.accessMode !== undefined && execution.mode !== witness.accessMode) ||
        (execution.agentConnection?.grantRevision ?? null) !== witness.grantRevision)
    )
      throw new BrowserCdpConnectionEnded(
        "This browser authority changed. Request a new attachment.",
      );
    await this.#authorizeSource(execution, expected.source, false);
    if (this.#shares.get(expected.info.shareId) !== expected) throw unavailable();
    if (expected.group.binding && expected.group.binding !== authority.agentBindingId)
      throw forbidden("Another agent is using this shared Chrome tab.");
    if (
      expected.group.attempt &&
      expected.group.attempt.grantRevision !== execution.agentConnection?.grantRevision
    )
      throw unavailable();
    return execution;
  }

  async #open(
    share: Share,
    binding: string,
    execution: ExecutionAuthority,
    signal: AbortSignal,
    onOverflow?: () => void,
  ): Promise<StandardCdpAttachment> {
    const { source, group } = share;
    const check = () => {
      signal.throwIfAborted();
      if (this.#shares.get(share.info.shareId) !== share) throw unavailable();
      if (group.binding && group.binding !== binding)
        throw forbidden("Another agent is using this shared Chrome tab.");
    };
    check();
    if (group.attempt?.finishing) throw unavailable();
    group.opening++;
    group.binding = binding;
    if (execution.threadId) group.taskId = execution.threadId;
    const connection = execution.agentConnection;
    if (connection && !group.attempt) {
      const { agentConnectionId: connectionId, grantRevision } = connection;
      const id = randomUUID();
      const attempt = {
        id,
        connectionId,
        grantRevision,
        source,
        root: group.root,
        ready: this.#receipts!.open({
          id,
          connectionId,
          grantRevision,
          ownerId: source.ownerId,
          sourceId: source.sourceId,
          shareId: group.root,
          mode: execution.mode,
          threadId: execution.threadId,
        }),
      };
      group.attempt = attempt;
      this.#attempts.set(id, attempt);
    }
    try {
      await group.attempt?.ready;
      await Promise.all(group.closing);
      check();
      if (group.attempt?.finishing) throw unavailable();
      const client = source.router.openStandardClient(group.sessionId, {
        wholeContext: false,
        ...(connection ? { connection: true } : {}),
        ...(onOverflow ? { onOverflow } : {}),
      });
      group.clients.add(client);
      share.clients.add(client);
      this.#changed(source.ownerId);
      client.signal.addEventListener(
        "abort",
        () => {
          group.clients.delete(client);
          share.clients.delete(client);
          group.closing.add(client.settled);
          void client.settled
            .then(() => {
              group.closing.delete(client.settled);
              return this.#releaseGroup(source, group);
            })
            .catch(this.#onError);
        },
        { once: true },
      );
      return client;
    } finally {
      group.opening--;
      void this.#releaseGroup(source, group).catch(this.#onError);
    }
  }

  async #releaseGroup(source: ChromeSource, group: Group): Promise<void> {
    if (
      group.opening ||
      group.clients.size ||
      group.closing.size ||
      group.detaching.size ||
      !source.shares.has(group.root)
    )
      return;
    if (group.attempt) {
      const detached =
        !group.popupDetachUnconfirmed &&
        !group.pendingDetach.size &&
        [...source.shares.values()]
          .filter((share) => share.group === group)
          .map((share) => source.backend.detachedCleanly(share.info.shareId))
          .every(Boolean);
      if (!detached) {
        source.backend.stopSharing(group.root);
        await this.#unshare(source, group.root);
        return;
      }
      await this.#finish(group.attempt, Promise.resolve(true));
      if (group.clients.size || group.closing.size) return;
    }
    delete group.attempt;
    delete group.binding;
    delete group.taskId;
    this.#changed(source.ownerId);
  }

  #finish(attempt: ChromeAttempt, evidence: Promise<boolean>): Promise<void> {
    attempt.finishing ??= (async () => {
      try {
        await attempt.ready;
      } catch {
        return;
      }
      await this.#receipts!.finish(attempt.connectionId, attempt.id, await evidence);
    })().then(() => {
      this.#attempts.delete(attempt.id);
    });
    return attempt.finishing;
  }

  #share(source: ChromeSource, info: BrowserSourceTabShared): void {
    info = { ...info, title: outsideName(info.title, 1024) };
    const old = this.#shares.get(info.shareId);
    if (old) {
      if (
        old.source !== source ||
        old.info.targetId !== info.targetId ||
        old.info.openerShareId !== info.openerShareId
      )
        throw unavailable();
      old.info = info;
      old.updatedAt = new Date().toISOString();
      this.#changed(source.ownerId);
      source.backend.update(info);
      return;
    }
    if (source.detaching.has(info.shareId)) throw unavailable();
    if (
      source.shares.size >= maxSharesPerChrome ||
      (!source.detachReplay && source.shares.size + source.detaching.size >= 2 * maxSharesPerChrome)
    )
      throw forbidden("Too many shared Chrome tabs.");
    const opener = info.openerShareId ? source.shares.get(info.openerShareId) : undefined;
    if (info.openerShareId && !opener) return;
    const group = opener?.group ?? {
      root: info.shareId,
      sessionId: createBrowserSessionId(),
      clients: new Set<StandardCdpAttachment>(),
      closing: new Set<Promise<void>>(),
      opening: 0,
      detaching: new Set<Promise<void>>(),
      pendingDetach: new Set<string>(),
      rootDetachIncomplete: false,
      popupDetachUnconfirmed: false,
    };
    if (!opener)
      source.router.registerSession(group.sessionId, info.targetId, async () => false, "/");
    const createdAt = new Date().toISOString();
    const share = {
      info,
      generation: randomUUID(),
      group,
      source,
      createdAt,
      updatedAt: createdAt,
      clients: new Set<StandardCdpAttachment>(),
    };
    source.shares.set(info.shareId, share);
    this.#shares.set(info.shareId, share);
    source.backend.update(info);
    this.#changed(source.ownerId);
  }

  #unshare(source: ChromeSource, tabId: string): Promise<void> {
    const share = source.shares.get(tabId);
    if (!share) return Promise.resolve();
    const { group } = share;
    const root = group.root === tabId;
    const attempt = group.attempt;
    const evidence = attempt && Promise.withResolvers<boolean>();
    source.shares.delete(tabId);
    this.#shares.delete(tabId);
    for (const client of share.clients) client.close();
    if (root) void source.router.unregisterSession(group.sessionId);
    for (const child of source.shares.values())
      if (child.info.openerShareId === tabId) void this.#unshare(source, child.info.shareId);
    source.backend.detachedCleanly(tabId);
    source.backend.remove(tabId);
    this.#changed(source.ownerId);
    if (!attempt || !evidence) return Promise.resolve();
    const legacy = !source.detachReplay;
    if (legacy) group.pendingDetach.add(tabId);
    const timer = setTimeout(() => evidence.resolve(false), 10_000);
    timer.unref();
    if (this.#sources.get(source.sourceId) !== source) evidence.resolve(false);
    const observed = evidence.promise.finally(() => clearTimeout(timer));
    // Replay-capable companions include previously unshared popups in the root receipt.
    const rootEvidence = legacy
      ? Promise.all([observed, ...group.detaching]).then(([detached]) => {
          const confirmed = detached === true && !group.pendingDetach.size;
          group.rootDetachIncomplete = !confirmed;
          return confirmed;
        })
      : observed;
    const settled = root
      ? this.#finish(attempt, rootEvidence)
      : observed.then((detached) => {
          if (!legacy && !detached) group.popupDetachUnconfirmed = true;
          group.detaching.delete(settled);
          void this.#releaseGroup(source, group).catch(this.#onError);
        });
    source.detaching.set(tabId, { evidence, finished: settled, group });
    if (!root) group.detaching.add(settled);
    void settled
      .finally(() => {
        if (!legacy || !group.pendingDetach.has(tabId)) source.detaching.delete(tabId);
      })
      .catch(this.#onError);
    return settled;
  }

  #serialize(value: unknown, budget: BrowserUseBudget): string {
    if (boundedJsonSize(value, budget) === undefined)
      throw new BrowserUseCdpError(-32000, "Chrome CDP exceeded the REPL message budget.");
    return JSON.stringify(value);
  }
}
