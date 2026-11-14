import {
  BrowserAgentTabListQuerySchema,
  BrowserAgentTabListResultSchema,
  browserAgentResponseMaxBytes,
  type BrowserAgentTabListQuery,
  type BrowserAgentTabListResult,
} from "@opensteer/protocol/browser-agent";
import { safeMessage } from "@opensteer/shared/safeMessage";
import {
  OpensteerError,
  refused,
  UserIdSchema,
  type UserId,
  type ThreadId,
  type BrowserTabGroupId,
} from "@opensteer/core";
import { BrowserTabGroupStore, OpensteerStore } from "@opensteer/database";
import {
  BrowserSurfaceIdSchema,
  BrowserTabWriteInputSchema,
  BrowserTabMoveSchema,
  type BrowserTabMove,
  browserTabRestoreMaxTabs,
  type BrowserSessionId,
  type BrowserTabWriteInput,
  type BrowserTabWriteResult,
} from "@opensteer/protocol";
import { z } from "zod";
import { createHash } from "node:crypto";
import type { BrowserService } from "./browser-service.js";

export type BrowserTabActor =
  | { readonly kind: "person"; readonly ownerId: UserId }
  | {
      readonly kind: "agent";
      readonly ownerId: UserId;
      readonly threadId: ThreadId;
      readonly agentBindingId: string;
    };
type AgentActor = Extract<BrowserTabActor, { kind: "agent" }>;
const CursorSchema = z.strictObject({
  queryFingerprint: z.string().length(64),
  ownerId: UserIdSchema,
  tabIdHash: z.string().length(64),
});
const cursorTabKey = (tabId: string) => createHash("sha256").update(tabId).digest("hex");
const restartCursorNext = "Repeat Browser Harness listTabs() without a cursor.";

function badRequest(message: string, next?: string): never {
  throw refused("bad_request", message, next);
}
function unreachable(): never {
  throw new OpensteerError({
    code: "forbidden",
    message: "A tab is not a saved tab you can reach.",
    next: "Use a tabId from Browser Harness listTabs().",
  });
}

export class BrowserTabGroupService {
  readonly #groups: BrowserTabGroupStore;
  readonly #browser: BrowserService;
  readonly #publish: (ownerIds: UserId[]) => void;
  constructor(options: {
    readonly groups: BrowserTabGroupStore;
    readonly browser: BrowserService;
    readonly publish: (ownerIds: UserId[]) => void;
  }) {
    this.#groups = options.groups;
    this.#browser = options.browser;
    this.#publish = options.publish;
  }

  #reach(
    actor: AgentActor,
    database = this.#groups.database,
    access: "read" | "read-write" = "read",
  ) {
    const sessions = this.#browser.agentReachableSavedSessions(
      actor,
      access,
      new OpensteerStore(database),
    );
    return async (sessionId: BrowserSessionId) => (await sessions).get(sessionId) ?? null;
  }
  async #authorize(
    actor: BrowserTabActor,
    tabIds: readonly string[],
    database = this.#groups.database,
    includeClosed = false,
  ) {
    const rows = await this.#groups.tabs(
      actor.ownerId,
      [...new Set(tabIds)],
      database,
      includeClosed,
    );
    if (rows.length !== new Set(tabIds).size) unreachable();
    if (actor.kind === "agent") {
      const mayReach = this.#reach(actor, database, "read-write");
      if (
        (await Promise.all(rows.map((row) => mayReach(row.latestSessionId)))).some(
          (reachable) => !reachable,
        )
      )
        unreachable();
    }
    return rows;
  }
  async #visibleGroups(
    actor: AgentActor,
    mayReach = this.#reach(actor),
    snapshot?: Awaited<ReturnType<BrowserTabGroupStore["groups"]>>,
  ) {
    const groups = snapshot ?? (await this.#groups.groups(actor.ownerId));
    const visible = await Promise.all(
      groups.map(async (group) =>
        (await Promise.all(group.sessionIds.map(mayReach))).every(Boolean) ? group : null,
      ),
    );
    return visible.filter((group) => group !== null);
  }

  async read(
    actor: AgentActor,
    input: Omit<BrowserAgentTabListQuery, "limit"> & { limit?: number },
  ): Promise<BrowserAgentTabListResult> {
    const parsed = BrowserAgentTabListQuerySchema.parse(input);
    await this.#browser.admitAgentBrowser(actor, "read");
    await this.#browser.flushPendingTabDescriptors();
    const query = parsed.query?.normalize("NFKC").toLowerCase();
    const queryFingerprint = createHash("sha256")
      .update(JSON.stringify([query ?? null, parsed.state ?? null]))
      .digest("hex");
    let cursor: z.infer<typeof CursorSchema> | undefined;
    if (parsed.cursor) {
      try {
        cursor = CursorSchema.parse(
          JSON.parse(Buffer.from(parsed.cursor, "base64url").toString("utf8")),
        );
      } catch {
        badRequest("Invalid tab cursor.", restartCursorNext);
      }
      if (cursor.ownerId !== actor.ownerId || cursor.queryFingerprint !== queryFingerprint)
        badRequest("This tab cursor belongs to a different reader or search.", restartCursorNext);
    }
    const [ordered, sessions, profiles, computers] = await Promise.all([
      this.#groups.orderedTabs(actor.ownerId),
      this.#browser.agentReachableSavedSessions(actor),
      this.#browser.listAgentProfiles(actor.ownerId),
      this.#browser.agentBrowserComputers(actor.ownerId),
    ]);
    const profileOf = new Map(
      profiles.map((profile) => [profile.id, { id: profile.id, name: profile.name }]),
    );
    const computerOf = new Map(computers.map((computer) => [computer.id, computer.name]));
    const groups = ordered.groups.filter((group) =>
      group.sessionIds.every((id) => sessions.has(id)),
    );
    const membership = new Map(
      groups.flatMap((group) => group.tabIds.map((id) => [id, group] as const)),
    );
    const rows = new Map(ordered.tabs.map((tab) => [tab.id, tab]));
    const matching: BrowserAgentTabListResult["tabs"] = [];
    for (const id of ordered.arrangement.order) {
      const row = rows.get(id);
      const session = row && sessions.get(row.latestSessionId);
      if (!row || !session) continue;
      const tabId = BrowserSurfaceIdSchema.parse(row.id);
      const group = membership.get(tabId);
      const profile = session.profileId ? profileOf.get(session.profileId) : null;
      if (session.profileId && !profile) continue;
      const state =
        row.state === "live"
          ? this.#browser.tabStateOf(session.id, tabId) === "suspended"
            ? "asleep"
            : "open"
          : row.state === "restoring"
            ? "opening"
            : "asleep";
      if (parsed.state && state !== parsed.state) continue;
      if (
        query &&
        ![row.title, row.url, group?.title ?? "", profile?.name ?? "Guest"].some((field) =>
          field.normalize("NFKC").toLowerCase().includes(query),
        )
      )
        continue;
      const occupants =
        row.state === "live" ? this.#browser.tabOccupants(actor.ownerId, session.id, tabId) : [];
      matching.push({
        tabId,
        title: row.title.slice(0, 256),
        url: row.url,
        profile: profile ?? null,
        computer: computerOf.get(session.runnerId) ?? null,
        state,
        groupId: group?.id ?? null,
        usedByThisTask: occupants.some((o) => o.threadId === actor.threadId),
        usedByOtherTask: occupants.some((o) => o.threadId !== actor.threadId),
      });
    }
    const after = cursor
      ? matching.findIndex((tab) => cursorTabKey(tab.tabId) === cursor.tabIdHash) + 1
      : 0;
    if (cursor && after === 0)
      badRequest("This tab cursor is no longer available.", restartCursorNext);
    const tabs: BrowserAgentTabListResult["tabs"] = [];
    let bytes = 1024;
    for (const tab of matching.slice(after, after + parsed.limit)) {
      const size = Buffer.byteLength(JSON.stringify(tab), "utf8") + 1;
      if (bytes + size > browserAgentResponseMaxBytes) break;
      tabs.push(tab);
      bytes += size;
    }
    await this.#browser.admitAgentBrowser(actor, "read");
    return BrowserAgentTabListResultSchema.parse({
      tabs,
      groups: groups.map((group) => ({
        groupId: group.id,
        title: group.title,
        color: group.color,
        collapsed: group.collapsed,
        tabCount: group.tabIds.length,
        createdBy:
          group.createdByThreadId === null
            ? "person"
            : group.createdByThreadId === actor.threadId
              ? "this-task"
              : "another-task",
      })),
      total: matching.length,
      nextCursor:
        after + tabs.length < matching.length && tabs.length
          ? Buffer.from(
              JSON.stringify({
                ownerId: actor.ownerId,
                queryFingerprint,
                tabIdHash: cursorTabKey(tabs.at(-1)!.tabId),
              }),
            ).toString("base64url")
          : null,
    });
  }

  async authorizeShow(actor: AgentActor, tabId: string): Promise<void> {
    await this.#browser.flushPendingTabDescriptors();
    await this.#authorize(actor, [tabId]);
  }

  async group(
    actor: BrowserTabActor,
    input: Omit<BrowserTabWriteInput, "action"> & { readonly idempotencyKey: string },
  ) {
    const { idempotencyKey, ...fields } = input;
    const parsed = this.#validate({ ...fields, action: "group" });
    const mutation = {
      ...parsed,
      idempotencyKey,
      ...(actor.kind === "agent" ? { createdByThreadId: actor.threadId } : {}),
    };
    if (actor.kind === "agent") await this.#browser.flushPendingTabDescriptors();
    await this.#authorize(actor, parsed.tabIds!);
    const result = await this.#groups.group(
      actor.ownerId,
      mutation,
      actor.kind === "agent"
        ? async (ids, database) => {
            await this.#authorize(actor, ids, database);
          }
        : undefined,
    );
    this.#changed(actor);
    return result;
  }
  async ungroup(
    actor: BrowserTabActor,
    tabIds: readonly z.infer<typeof BrowserSurfaceIdSchema>[],
    idempotencyKey: string,
  ) {
    if (actor.kind === "agent") await this.#browser.flushPendingTabDescriptors();
    await this.#authorize(actor, tabIds);
    const layout = await this.#groups.ungroup(
      actor.ownerId,
      { tabIds, idempotencyKey },
      actor.kind === "agent"
        ? async (ids, database) => {
            await this.#authorize(actor, ids, database);
          }
        : undefined,
    );
    this.#changed(actor);
    return layout;
  }
  async move(actor: BrowserTabActor, input: BrowserTabMove & { readonly idempotencyKey: string }) {
    if (actor.kind === "agent") await this.#browser.flushPendingTabDescriptors();
    const move = BrowserTabMoveSchema.parse({ item: input.item, to: input.to });
    const layout = await this.#groups.move(
      actor.ownerId,
      { ...move, idempotencyKey: input.idempotencyKey },
      async (ids, database) => {
        await this.#authorize(actor, ids, database);
      },
    );
    this.#changed(actor);
    return layout;
  }
  async update(
    actor: BrowserTabActor,
    input: Omit<BrowserTabWriteInput, "action"> & {
      readonly groupId: BrowserTabGroupId;
      readonly idempotencyKey: string;
    },
  ) {
    const { idempotencyKey, ...fields } = input;
    this.#validate({ ...fields, action: "update_group" });
    const group = (
      actor.kind === "agent"
        ? await this.#visibleGroups(actor)
        : await this.#groups.groups(actor.ownerId)
    ).find((g) => g.id === input.groupId);
    if (!group)
      throw refused(
        "not_found",
        "Tab group not found.",
        "Get current group IDs from Browser Harness listTabs().",
      );
    await this.#authorize(actor, group.tabIds);
    const layout = await this.#groups.update(
      actor.ownerId,
      { ...fields, idempotencyKey },
      actor.kind === "agent"
        ? async (ids, database) => {
            await this.#authorize(actor, ids, database);
          }
        : undefined,
    );
    this.#changed(actor);
    return layout;
  }
  async close(actor: BrowserTabActor, tabIds: readonly z.infer<typeof BrowserSurfaceIdSchema>[]) {
    if (actor.kind === "agent") await this.#browser.flushPendingTabDescriptors();
    await this.#authorize(actor, tabIds, this.#groups.database, true);
    const closed: z.infer<typeof BrowserSurfaceIdSchema>[] = [];
    const failed: Array<{ tabId: z.infer<typeof BrowserSurfaceIdSchema>; message: string }> = [];
    for (const tabId of new Set(tabIds)) {
      try {
        await this.#authorize(actor, [tabId], this.#groups.database, true);
        await this.#browser.closePersonalTab(
          actor.ownerId,
          tabId,
          actor.kind === "person",
          actor.kind === "agent" ? actor : undefined,
        );
        closed.push(tabId);
      } catch (error) {
        failed.push({
          tabId,
          message: safeMessage(error, {
            fallback: "Could not close this tab.",
            maximumLength: 1000,
          }),
        });
      }
    }
    this.#changed(actor);
    return { closed, failed };
  }
  #changed(actor: BrowserTabActor) {
    this.#publish([actor.ownerId]);
  }

  #validate(input: BrowserTabWriteInput): BrowserTabWriteInput {
    const parsed = BrowserTabWriteInputSchema.parse(input);
    const allowed: Record<BrowserTabWriteInput["action"], readonly string[]> = {
      group: ["tabIds", "groupId", "title", "color"],
      ungroup: ["tabIds"],
      update_group: ["groupId", "title", "color", "collapsed"],
      close: ["tabIds"],
      restore: ["tabIds"],
      move: ["tabIds", "groupId", "toGroupId", "before"],
    };
    for (const key of Object.keys(parsed))
      if (key !== "action" && !allowed[parsed.action].includes(key))
        badRequest(`${key} is not valid for ${parsed.action}.`);
    if (parsed.action === "update_group") {
      if (!parsed.groupId) badRequest("update_group requires groupId.");
      if (
        parsed.title === undefined &&
        parsed.color === undefined &&
        parsed.collapsed === undefined
      )
        badRequest("update_group requires title, color or collapsed.");
    } else if (parsed.action === "move") {
      if (Boolean(parsed.tabIds?.length) === Boolean(parsed.groupId))
        badRequest("move requires either tabIds or groupId.");
    } else if (!parsed.tabIds?.length) badRequest(`${parsed.action} requires tabIds.`);
    if (
      parsed.action === "group" &&
      parsed.groupId &&
      (parsed.title !== undefined || parsed.color !== undefined)
    )
      badRequest("Joining groupId cannot also set title or color; use update_group.");
    if (parsed.action === "restore" && parsed.tabIds!.length > browserTabRestoreMaxTabs)
      badRequest("restore accepts at most 8 tabs.");
    return parsed;
  }
  async write(
    actor: AgentActor,
    input: BrowserTabWriteInput,
    idempotencyKey: string,
  ): Promise<BrowserTabWriteResult> {
    const parsed = this.#validate(input);
    switch (parsed.action) {
      case "move": {
        const groups = await this.#groups.groups(actor.ownerId);
        const beforeGroup = groups.find((group) => group.id === parsed.before);
        await this.move(actor, {
          item: parsed.groupId ? { groupId: parsed.groupId } : { tabIds: parsed.tabIds! },
          to: {
            groupId: parsed.toGroupId ?? null,
            before:
              parsed.before === undefined
                ? null
                : beforeGroup
                  ? { groupId: beforeGroup.id }
                  : { tabId: BrowserSurfaceIdSchema.parse(parsed.before) },
          },
          idempotencyKey,
        });
        return { action: "move" };
      }
      case "group": {
        const result = await this.group(actor, { ...parsed, idempotencyKey });
        return { action: "group", groupId: result.groupId };
      }
      case "ungroup":
        await this.ungroup(actor, parsed.tabIds!, idempotencyKey);
        return { action: "ungroup" };
      case "update_group":
        await this.update(actor, { ...parsed, groupId: parsed.groupId!, idempotencyKey });
        return { action: "update_group" };
      case "close":
        return { action: "close", ...(await this.close(actor, parsed.tabIds!)) };
      case "restore": {
        await this.#browser.flushPendingTabDescriptors();
        await this.#authorize(actor, parsed.tabIds!);
        const restored = [];
        for (const id of new Set(parsed.tabIds))
          restored.push(await this.#browser.restoreAgentPersonalTab(actor, id));
        this.#changed(actor);
        return { action: "restore", restored };
      }
    }
  }
}
