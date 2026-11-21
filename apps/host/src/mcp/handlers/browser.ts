import {
  OpensteerError,
  TabIdSchema,
  agentGrantAccess,
  refused,
  requestOperationCallsMaxLength,
  type AgentOperationTarget,
  type BrowserProfileId,
  type DeviceId,
  type RunnerId,
  type TabId,
  type ThreadId,
  type UserId,
} from "@opensteer/core";
import type { StandardCdpMode } from "@opensteer/protocol/standard-cdp";
import {
  OperationOutcomeUnknown,
  type AgentSessionService,
  type DirectOperationContext,
  type DirectOperationResult,
} from "../../agent-sessions/agent-session-service.js";
import type { BrowserScriptService } from "../../browser-use/browser-script-service.js";
import { BrowserCdpConnectionEnded, type BrowserService } from "../../browser/browser-service.js";
import type { ChromeSharedTabs } from "../../browser/chrome-shared-tabs.js";
import type { CdpAuthority } from "../../browser/standard-cdp-tickets.js";
import type { BrowserBindingTabActor, TabServicePort } from "../../tabs/ports.js";
import type { TabService } from "../../tabs/tab-service.js";
import type { ConnectionCaller } from "../agent-caller.js";
import { browserEffect, failedScriptOutput, requireDirectWork, scriptFailure } from "./direct.js";
import type { ToolCall } from "./types.js";

/** How long one reviewed attachment may hold full control of a profile. */
export const browserConnectIntervalMs = 10 * 60_000;
export const browserConnectCompletedNext =
  "This connection was already handed out. Call browser_connect without the operationId for a new connection.";
const intervalWords = "10 minutes";

type ScriptTabs = Pick<TabService, "browserScriptPages" | "bindBrowserScript" | "open">;
type ScriptResult = Awaited<ReturnType<BrowserScriptService["runBrowserScript"]>>;

const tabNotFound = () => new OpensteerError({ code: "not_found", message: "Tab not found." });
const notShared = () =>
  refused(
    "forbidden",
    "That browser profile is not shared with this connected agent.",
    "Ask the person to share it from Connected agents.",
  );

/**
 * Keeps a connected agent's script inside the one profile its operation was reviewed for. The
 * script service reaches every profile the session's grant holds; this narrows each script to the
 * profile the person saw, so an approval of one profile never runs in another.
 */
export class BrowserScriptConfinement {
  readonly #running = new Map<string, { profileId: BrowserProfileId; scripts: number }>();

  async run<Result>(
    bindingId: string,
    profileId: BrowserProfileId,
    work: () => Promise<Result>,
  ): Promise<Result> {
    const current = this.#running.get(bindingId);
    if (current && current.profileId !== profileId)
      throw refused(
        "conflict",
        "Another script of this task is running in a different browser profile.",
        "Wait for it to finish, then call again.",
      );
    const entry = current ?? { profileId, scripts: 0 };
    entry.scripts++;
    this.#running.set(bindingId, entry);
    try {
      return await work();
    } finally {
      if (--entry.scripts === 0 && this.#running.get(bindingId) === entry)
        this.#running.delete(bindingId);
    }
  }

  /** The tab access a script service is built over, narrowed to the running script's profile. */
  tabs(tabs: ScriptTabs & Pick<TabService, "get">): ScriptTabs {
    const profileOf = (actor: BrowserBindingTabActor) => {
      const entry = this.#running.get(actor.authority.agentBindingId);
      if (!entry) throw refused("forbidden", "This browser task has ended.");
      return entry.profileId;
    };
    return {
      browserScriptPages: async function* (actor) {
        const profileId = profileOf(actor);
        for await (const row of tabs.browserScriptPages(actor))
          if (row.profileId === profileId) yield row;
      },
      bindBrowserScript: async (actor, tabId, options) => {
        const profileId = profileOf(actor);
        const tab = await tabs.get(actor.authority.ownerId, tabId).catch(() => null);
        if (tab?.kind !== "page" || tab.profile?.profileId !== profileId) throw tabNotFound();
        return tabs.bindBrowserScript(actor, tabId, options);
      },
      open: async (actor, target, key, ...rest) => {
        if (actor.kind !== "browser-binding")
          throw refused("forbidden", "This browser task has ended.");
        const profileId = profileOf(actor);
        if (target.kind !== "page" || !("profileId" in target) || target.profileId !== profileId)
          throw refused(
            "forbidden",
            "This script runs in one browser profile; open pages there.",
            "Run another browser_use call with that profile's tabId or profileId.",
          );
        return tabs.open(actor, target, key, ...rest);
      },
    };
  }
}

interface BrowserToolProfile {
  readonly id: BrowserProfileId;
  readonly name: string;
  readonly purpose?: "person" | "engine-sign-in";
  readonly home: { readonly runnerId: RunnerId; readonly name: string } | null;
}

export interface BrowserToolPorts {
  readonly sessions: AgentSessionService | undefined;
  readonly sharedChromeTabs?: Pick<ChromeSharedTabs, "issueStandardCdpTicket" | "shareGeneration">;
  readonly tabs: Pick<TabServicePort, "list" | "open" | "connectionTab"> &
    Pick<TabService, "bindBrowserScript">;
  readonly scripts: Pick<BrowserScriptService, "runBrowserScript">;
  readonly confinement: BrowserScriptConfinement;
  readonly profiles: (ownerId: UserId) => Promise<readonly BrowserToolProfile[]>;
  /** Refuses as the browser does for an agent: Device stopped, asleep, offline or switched off. */
  readonly requireDevice: (runnerId: RunnerId) => Promise<DeviceId>;
  readonly issueTicket: BrowserService["issueStandardCdpTicket"];
  readonly pooledBrowser?: BrowserService["pooledDirectBrowser"];
  readonly pooledTab?: TabService["connectionTab"];
  /** The Home's own origin, the one connected agents already reach it at. */
  readonly origin: URL;
}

type BrowserTarget = { readonly operation: AgentOperationTarget } & (
  | {
      readonly profileId: BrowserProfileId;
      readonly tabId: TabId | null;
      readonly generation: number | null;
      readonly runnerId: RunnerId;
    }
  | { readonly profileId: null; readonly tabId: TabId; readonly generation: string }
);

function sessionActor(context: DirectOperationContext): BrowserBindingTabActor {
  return {
    kind: "browser-binding",
    authority: { agentBindingId: context.bindingId, ownerId: context.ownerUserId },
    threadId: context.taskId,
    signal: context.signal,
  };
}

/** A stop or disconnect mid-script: the outcome is unknown, and the agent learns why. */
function interrupted(context: DirectOperationContext): OperationOutcomeUnknown {
  const reason = context.signal.reason;
  return new OperationOutcomeUnknown(
    reason instanceof OpensteerError ? reason.message : "This work ended before it finished.",
  );
}

function scriptOutput(
  outcome: DirectOperationResult<ScriptResult>,
  profileId: BrowserProfileId | null,
): {
  readonly content: ScriptResult["content"];
  readonly isError?: true;
  readonly structuredContent: Readonly<Record<string, unknown>>;
} {
  const { status, taskId, operationId } = outcome;
  if (outcome.status === "failed" && outcome.scriptError)
    return failedScriptOutput(
      {
        status: outcome.status,
        taskId,
        operationId,
        ...(profileId ? { profileId } : {}),
        next: outcome.next,
      },
      outcome.scriptError,
      outcome.result?.content,
    );
  const receipt = {
    status,
    taskId,
    operationId,
    ...(profileId ? { profileId } : {}),
    ...(outcome.status === "completed" ? { summary: outcome.summary } : {}),
  };
  if (outcome.status === "completed")
    return outcome.result
      ? {
          ...outcome.result,
          structuredContent: { ...outcome.result.structuredContent, ...receipt },
        }
      : {
          content: [{ type: "text", text: "This script already ran." }],
          structuredContent: receipt,
        };
  const extra = outcome.status === "pending" ? { requestId: outcome.requestId } : {};
  return {
    content: [{ type: "text", text: outcome.next }],
    structuredContent: { ...receipt, ...extra, next: outcome.next },
  };
}

/**
 * The browser for connected agents: one script with the native Page API (`browser_use`), or a
 * standard CDP endpoint for stock clients (`browser_connect`). Both act only in a browser profile
 * the grant holds, on that profile's home Device, as one reviewed operation of the agent's task.
 */
export class BrowserToolHandlers {
  readonly #ports: BrowserToolPorts;
  constructor(ports: BrowserToolPorts) {
    this.#ports = ports;
  }

  async browser_use({ caller, input, operationKey }: ToolCall<"browser_use">) {
    const connection = requireConnection(caller);
    const { code, tabId, profileId, taskId, reason } = input;
    if (code.length > requestOperationCallsMaxLength)
      throw refused(
        "bad_request",
        `Browser scripts can contain at most ${requestOperationCallsMaxLength.toLocaleString("en-US")} characters.`,
      );
    const target = await this.#target(connection, { tabId, profileId });
    const pooled = await this.#pooledTarget(connection, target);
    const outcome = await requireDirectWork(this.#ports.sessions).run({
      ownerUserId: connection.userId,
      agentConnectionId: connection.connectionId,
      taskId: taskId as ThreadId | undefined,
      reason,
      operationKey,
      tool: "browser_use",
      input,
      target: target.operation,
      targetGeneration:
        pooled?.generation ?? (target.generation === null ? null : String(target.generation)),
      ...(pooled ? { pooledBrowser: pooled } : {}),
      effect: "write",
      calls: code,
      execute: async (context) => {
        await context.recheck();
        await this.#checkTab(connection, target);
        const runScript = () =>
          browserEffect(() =>
            this.#ports.scripts.runBrowserScript({
              authority: { agentBindingId: context.bindingId, ownerId: context.ownerUserId },
              contextKey: target.profileId ?? `chrome:${target.tabId}`,
              ...(target.profileId === null ? { sharedChromeTabId: target.tabId } : {}),
              code,
              signal: context.signal,
              recheck: context.recheck,
              ...(context.browserSend ? { browserSend: context.browserSend } : {}),
            }),
          );
        const result =
          target.profileId === null
            ? await runScript()
            : await this.#ports.confinement.run(context.bindingId, target.profileId, runScript);
        if (context.signal.aborted) throw interrupted(context);
        const failure = result.structuredContent?.error;
        if (failure?.code === "outcome-unknown") throw new OperationOutcomeUnknown(failure.message);
        return result;
      },
      scriptFailure,
      summarize: (result) => ({
        texts: result.content.filter(({ type }) => type === "text").length,
        images: result.content.filter(({ type }) => type === "image").length,
        ...(result.structuredContent?.error ? { error: result.structuredContent.error.code } : {}),
      }),
    });
    return scriptOutput(outcome, target.profileId);
  }

  async browser_connect({ caller, input, operationKey }: ToolCall<"browser_connect">) {
    const connection = requireConnection(caller);
    const { tabId, profileId, taskId, reason } = input;
    const target = await this.#target(connection, { tabId, profileId });
    const pooled = await this.#pooledTarget(connection, target);
    const where = target.operation.device ? ` on ${target.operation.device.name}` : "";
    const outcome = await requireDirectWork(this.#ports.sessions).run({
      ownerUserId: connection.userId,
      agentConnectionId: connection.connectionId,
      taskId: taskId as ThreadId | undefined,
      reason,
      operationKey,
      tool: "browser_connect",
      input,
      target: target.operation,
      targetGeneration:
        pooled?.generation ?? (target.generation === null ? null : String(target.generation)),
      ...(pooled ? { pooledBrowser: pooled } : {}),
      effect: "write",
      calls:
        target.profileId === null
          ? `Control of the Chrome tab you shared${where} for up to ${intervalWords}, through CDP. The agent can navigate anywhere in the tab and access sites and cookies this Chrome is signed in to. Stop sharing in Chrome or stop this task to end access.`
          : `Control of the agent's own pages in the browser profile "${target.operation.name}"${where} for up to ${intervalWords}, through a raw browser connection (CDP), with access to every cookie and signed-in site in that profile. It ends when the time runs out, when you stop this task, or when you disconnect the agent.`,
      execute: async (context) => {
        await context.recheck();
        await this.#checkTab(connection, target);
        return browserEffect(() => this.#attach(context, target, pooled?.recheckTarget));
      },
      summarize: (result) => ({ tabId: result.tabId, mode: result.mode }),
    });
    const { status, taskId: task, operationId } = outcome;
    return {
      ...(outcome.status === "completed" && outcome.result ? outcome.result : {}),
      status,
      taskId: task,
      operationId,
      ...(outcome.status === "pending" ? { requestId: outcome.requestId } : {}),
      ...(outcome.status === "completed"
        ? outcome.result
          ? {}
          : { next: browserConnectCompletedNext }
        : { next: outcome.next }),
    };
  }

  async #checkTab(caller: ConnectionCaller, target: BrowserTarget) {
    if (!target.tabId) return;
    const generation =
      target.operation.grant.kind === "chrome-tabs"
        ? this.#ports.sharedChromeTabs?.shareGeneration(
            target.tabId,
            target.operation.grant.sourceId,
          )
        : (await this.#ports.tabs.connectionTab({ kind: "connection", caller }, target.tabId))
            .generation;
    if (generation !== target.generation) throw tabNotFound();
  }

  async #pooledTarget(caller: ConnectionCaller, target: BrowserTarget) {
    if (target.profileId === null) return;
    const pool = this.#ports.pooledBrowser?.(target.runnerId);
    if (!pool) return;
    const actor = { kind: "connection", caller } as const;
    const witness = async (tabId: TabId) => {
      const row = await this.#ports.pooledTab?.(actor, tabId);
      if (
        !row ||
        row.generation !== target.generation ||
        row.profileId !== target.profileId ||
        row.computerId !== target.operation.device?.id ||
        row.pageBinding?.surfaceId !== tabId
      )
        throw tabNotFound();
      const { sessionId, lineageId } = row.pageBinding;
      // Null: its session is being reattached and its document is not known yet.
      const document = pool.pageDocument(sessionId, tabId);
      if (document === undefined) throw tabNotFound();
      return { tab: JSON.stringify([row.generation, sessionId, lineageId]), document };
    };
    const seen = target.tabId ? await witness(target.tabId) : null;
    // A document not known when the call began is bound at the first check that knows it, once
    // the session is back; from then on, and at every send, it is compared as always.
    let document = seen?.document ?? null;
    return {
      ...pool,
      generation: seen
        ? JSON.stringify([...(JSON.parse(seen.tab) as unknown[]), seen.document])
        : null,
      recheckTarget: async () => {
        const profile = (await this.#ports.profiles(caller.userId)).find(
          ({ id }) => id === target.profileId,
        );
        if (
          profile?.home?.runnerId !== target.runnerId ||
          (await this.#ports.requireDevice(target.runnerId)) !== target.operation.device?.id
        )
          throw tabNotFound();
        if (!target.tabId || !seen) return;
        const now = await witness(target.tabId);
        if (now.tab !== seen.tab || (document !== null && now.document !== document))
          throw tabNotFound();
        document ??= now.document;
      },
    };
  }

  async #attach(
    context: DirectOperationContext,
    target: BrowserTarget,
    recheckPooledTarget?: () => Promise<void>,
  ) {
    const actor = sessionActor(context);
    const tabId =
      target.tabId ??
      (
        await this.#ports.tabs.open(
          context.browserSend ? { ...actor, browserSend: context.browserSend } : actor,
          { kind: "page", profileId: target.profileId!, url: "about:blank" },
          `operation:${context.operationId}`,
        )
      ).tab.tabId;
    const expiresAt = Date.now() + browserConnectIntervalMs;
    const authority: CdpAuthority = {
      agentBindingId: context.bindingId,
      ownerId: context.ownerUserId,
      expiresAt,
    };
    let issued: { readonly path: string; readonly mode: StandardCdpMode };
    try {
      if (target.profileId === null) {
        if (!this.#ports.sharedChromeTabs) throw tabNotFound();
        issued = await this.#ports.sharedChromeTabs.issueStandardCdpTicket({
          authority,
          tabId,
          expectedAccess: { accessMode: context.mode, grantRevision: context.grantRevision },
        });
      } else {
        if (target.tabId) {
          const tab = await this.#ports.tabs.connectionTab(actor, tabId);
          if (tab.openedBy === "person" || tab.openedBy?.taskId !== actor.threadId)
            throw tabNotFound();
        }
        const page = await this.#ports.tabs.bindBrowserScript(actor, tabId, {
          savedProfileOnly: true,
          ...(target.generation !== null ? { expectedGeneration: target.generation } : {}),
        });
        await context.recheck();
        issued = await this.#ports.issueTicket({
          authority,
          browserSessionId: page.sessionId,
          seedTabId: page.tabId,
          mode: "whole-context",
          operationWitness: {
            grantRevision: context.grantRevision,
            mode: context.mode,
            targetGeneration: target.generation,
          },
          ...(recheckPooledTarget
            ? {
                recheckPooledTarget: async () => {
                  await context.recheck();
                  await recheckPooledTarget();
                  context.signal.throwIfAborted();
                },
              }
            : {}),
        });
      }
    } catch (error) {
      // A refused attachment, including a browser with no root that keeps a raw client inside
      // this profile: never a narrower connection in its place. Its message is written for agents.
      if (error instanceof BrowserCdpConnectionEnded) throw refused("conflict", error.message);
      throw error;
    }
    const origin = new URL(this.#ports.origin);
    origin.protocol = origin.protocol === "https:" ? "wss:" : "ws:";
    return {
      endpoint: new URL(issued.path, origin).href,
      mode: issued.mode,
      connect:
        issued.mode === "whole-context"
          ? "chromium.connectOverCDP(endpoint)"
          : "chromium.connectOverCDP(endpoint, { noDefaults: true })",
      tabId,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  /**
   * The one granted, saved profile this call acts in, named for the person. A tab or profile the
   * grant does not reach reads exactly like one that does not exist.
   */
  async #target(
    caller: ConnectionCaller,
    place: { readonly tabId?: string | undefined; readonly profileId?: string | undefined },
  ): Promise<BrowserTarget> {
    const profiles = (await this.#ports.profiles(caller.userId)).filter(
      (profile) =>
        profile.purpose !== "engine-sign-in" &&
        agentGrantAccess(caller.grant, { kind: "browser-profile", profileId: profile.id }) ===
          "read-write",
    );
    let tabId: TabId | null = null;
    let generation: number | null = null;
    let profile: BrowserToolProfile | undefined;
    if (place.tabId !== undefined) {
      tabId = TabIdSchema.parse(place.tabId);
      const visible = await this.#ports.tabs.list({ kind: "connection", caller }, {});
      const tab = visible.tabs.find((entry) => entry.tabId === tabId);
      if (!tab) throw tabNotFound();
      if (tab.sharedByPerson) {
        if (!this.#ports.sharedChromeTabs || place.profileId !== undefined) throw tabNotFound();
        const generation = this.#ports.sharedChromeTabs.shareGeneration(
          tabId,
          tab.sharedByPerson.sourceId,
        );
        if (!generation) throw tabNotFound();
        return {
          profileId: null,
          tabId,
          generation,
          operation: {
            grant: { kind: "chrome-tabs", sourceId: tab.sharedByPerson.sourceId },
            name: `Chrome tab on ${tab.sharedByPerson.computerName}`,
            untrustedTitle: tab.title,
            device: { id: tab.computer.computerId, name: tab.sharedByPerson.computerName },
          },
        };
      }
      const row = await this.#ports.tabs.connectionTab({ kind: "connection", caller }, tabId);
      generation = row.generation;
      const owned = row.kind === "page" ? row.profileId : undefined;
      if (!owned)
        throw refused(
          "forbidden",
          "A connected agent works only in a browser profile shared with it, never in a Guest tab.",
        );
      profile = profiles.find(({ id }) => id === owned);
      if (!profile) throw tabNotFound();
      if (place.profileId !== undefined && place.profileId !== profile.id)
        throw refused("bad_request", "That tab is in a different browser profile.");
    } else if (place.profileId !== undefined) {
      profile = profiles.find(({ id }) => id === place.profileId);
      if (!profile) throw notShared();
    } else if (profiles.length === 1) {
      profile = profiles[0];
    } else if (profiles.length === 0) {
      throw refused(
        "forbidden",
        "No browser profile is shared with this connected agent.",
        "Ask the person to share one from Connected agents.",
      );
    } else {
      throw refused(
        "bad_request",
        "Several browser profiles are shared with you.",
        "Pass the profileId or a tabId of the one to use.",
      );
    }
    if (!profile) throw notShared();
    if (!profile.home)
      throw refused(
        "conflict",
        `The device that holds the browser profile "${profile.name}" is not available.`,
        "A profile opens only on its own device. Tell the person.",
      );
    const deviceId = await this.#ports.requireDevice(profile.home.runnerId);
    return {
      profileId: profile.id,
      tabId,
      generation,
      runnerId: profile.home.runnerId,
      operation: {
        grant: { kind: "browser-profile", profileId: profile.id },
        name: profile.name,
        device: { id: deviceId, name: profile.home.name },
      },
    };
  }
}

function requireConnection(caller: ToolCall<"browser_use">["caller"]): ConnectionCaller {
  if (caller.kind !== "connection")
    throw new OpensteerError({
      code: "forbidden",
      message: "This tool is for connected agents.",
    });
  return caller;
}
