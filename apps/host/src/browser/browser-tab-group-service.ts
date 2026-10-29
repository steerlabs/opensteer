import { safeMessage } from "@opensteer/shared/safeMessage";
import {
  OpensteerError,
  UserIdSchema,
  WorkspaceIdSchema,
  type UserId,
  type WorkspaceId,
  type ThreadId,
  type BrowserTabGroupId,
} from "@opensteer/core";
import { BrowserTabGroupStore, OpensteerStore } from "@opensteer/database";
import {
  BrowserSurfaceIdSchema,
  BrowserSessionIdSchema,
  BrowserTabReadResultSchema,
  BrowserTabWriteInputSchema,
  BrowserTabMoveSchema,
  type BrowserTabMove,
  browserPageSite,
  browserTabRestoreMaxTabs,
  agentControlResponseMaxSerializedBytes,
  type BrowserSessionId,
  type BrowserTabReadInput,
  type BrowserTabReadResult,
  type BrowserTabWriteInput,
  type BrowserTabWriteResult,
} from "@opensteer/protocol";
import { z } from "zod";
import type { BrowserService, BrowserSessionRecord } from "./browser-service.js";

export type BrowserTabActor =
  | { readonly kind: "person"; readonly ownerId: UserId }
  | {
      readonly kind: "agent";
      readonly ownerId: UserId;
      readonly workspaceId: WorkspaceId;
      readonly threadId: ThreadId;
      readonly agentBindingId: string;
    };
type AgentActor = Extract<BrowserTabActor, { kind: "agent" }>;
const CursorSchema = z.strictObject({
  ownerId: UserIdSchema,
  workspaceId: WorkspaceIdSchema,
  createdAt: z.iso.datetime({ precision: 6 }),
  lineageId: BrowserSessionIdSchema,
  tabId: BrowserSurfaceIdSchema,
});
function badRequest(message: string): never {
  throw new OpensteerError({ code: "bad_request", message });
}
function unreachable(): never {
  throw new OpensteerError({
    code: "forbidden",
    message: "A tab is not a saved tab you can reach.",
  });
}

export class BrowserTabGroupService {
  readonly #groups: BrowserTabGroupStore;
  readonly #browser: BrowserService;
  readonly #publish: (workspaceId: WorkspaceId, ownerIds: UserId[]) => void;
  constructor(options: {
    readonly groups: BrowserTabGroupStore;
    readonly browser: BrowserService;
    readonly publish: (workspaceId: WorkspaceId, ownerIds: UserId[]) => void;
  }) {
    this.#groups = options.groups;
    this.#browser = options.browser;
    this.#publish = options.publish;
  }

  #reach(actor: AgentActor, database = this.#groups.database) {
    const repository = new OpensteerStore(database);
    const sessions = new Map<BrowserSessionId, Promise<BrowserSessionRecord | null>>();
    return (sessionId: BrowserSessionId) => {
      let result = sessions.get(sessionId);
      if (!result) {
        result = this.#browser.agentReachableSavedSession(actor, sessionId, repository);
        sessions.set(sessionId, result);
      }
      return result;
    };
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
      const mayReach = this.#reach(actor, database);
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

  async read(actor: AgentActor, input: BrowserTabReadInput): Promise<BrowserTabReadResult> {
    await this.#browser.flushPendingTabDescriptors();
    let cursor: z.infer<typeof CursorSchema> | undefined;
    if (input.cursor) {
      try {
        cursor = CursorSchema.parse(
          JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")),
        );
      } catch {
        badRequest("Invalid saved-tab cursor.");
      }
      if (cursor.ownerId !== actor.ownerId || cursor.workspaceId !== actor.workspaceId)
        badRequest("This saved-tab cursor belongs to a different reader.");
    }
    const mayReach = this.#reach(actor);
    const ordered = await this.#groups.orderedTabs(actor.ownerId);
    const reachable = await Promise.all(ordered.tabs.map((tab) => mayReach(tab.latestSessionId)));
    const reachableIds = new Set(
      ordered.tabs.filter((_, index) => reachable[index]).map((tab) => tab.id),
    );
    const positions = new Map(
      ordered.arrangement.order
        .filter((id) => reachableIds.has(id))
        .map((id, position) => [id, position]),
    );
    const visibleGroups = await this.#visibleGroups(actor, mayReach, ordered.groups);
    const groups = visibleGroups.map((group) => ({
      id: group.id,
      title: group.title,
      color: group.color,
      collapsed: group.collapsed,
      createdBy:
        group.createdByThreadId === null
          ? ("person" as const)
          : group.createdByThreadId === actor.threadId
            ? ("this-task" as const)
            : ("another-task" as const),
      tabCount: group.tabIds.length,
    }));
    const membership = new Map(
      visibleGroups.flatMap((group) => group.tabIds.map((tabId) => [tabId, group.id] as const)),
    );
    // Positions need the full visible order; page that same snapshot instead of rescanning it.
    const candidates = ordered.tabs
      .filter(
        (row) =>
          reachableIds.has(row.id) &&
          (!cursor ||
            row.lineageTimestamp < cursor.createdAt ||
            (row.lineageTimestamp === cursor.createdAt &&
              (row.groupId < cursor.lineageId ||
                (row.groupId === cursor.lineageId && row.id > cursor.tabId)))),
      )
      .sort((a, b) =>
        a.lineageTimestamp !== b.lineageTimestamp
          ? a.lineageTimestamp < b.lineageTimestamp
            ? 1
            : -1
          : a.groupId !== b.groupId
            ? a.groupId < b.groupId
              ? 1
              : -1
            : a.id < b.id
              ? -1
              : a.id > b.id
                ? 1
                : 0,
      )
      .slice(0, 65);
    const exhausted = candidates.length < 65;
    const tabs: BrowserTabReadResult["tabs"] = [];
    let bytes = Buffer.byteLength(JSON.stringify({ groups, tabs, nextCursor: null }), "utf8");
    for (const row of candidates.slice(0, 64)) {
      const tabId = BrowserSurfaceIdSchema.parse(row.id);
      const session = await mayReach(row.latestSessionId);
      if (!session) unreachable();
      const occupants =
        row.state === "live"
          ? this.#browser.tabOccupants(actor.ownerId, row.latestSessionId, tabId)
          : [];
      const tab: BrowserTabReadResult["tabs"][number] = {
        tabId,
        title: row.title.slice(0, 256),
        site: browserPageSite(row.url).slice(0, 2048),
        state: row.state === "live" ? "open" : row.state === "restoring" ? "opening" : "asleep",
        sessionId: row.state === "live" ? row.latestSessionId : null,
        profileId: session.profileId,
        groupId: membership.get(tabId) ?? null,
        position: positions.get(tabId),
        usedByThisTask: occupants.some((o) => o.threadId === actor.threadId),
        usedByOtherTask: occupants.some((o) => o.threadId !== actor.threadId),
      };
      const addedBytes = Buffer.byteLength(JSON.stringify(tab), "utf8") + 1;
      // Reserve the cursor and agent-control envelope within the shared tool response budget.
      if (bytes + addedBytes > agentControlResponseMaxSerializedBytes - 1024) break;
      tabs.push(tab);
      bytes += addedBytes;
    }
    const last = candidates[tabs.length - 1];
    return BrowserTabReadResultSchema.parse({
      groups,
      tabs,
      nextCursor:
        last && (!exhausted || candidates.length > tabs.length)
          ? Buffer.from(
              JSON.stringify({
                ownerId: actor.ownerId,
                workspaceId: actor.workspaceId,
                createdAt: last.lineageTimestamp,
                lineageId: last.groupId,
                tabId: last.id,
              }),
            ).toString("base64url")
          : null,
    });
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
    const rows = await this.#authorize(actor, parsed.tabIds!);
    const result = await this.#groups.group(
      actor.ownerId,
      mutation,
      actor.kind === "agent"
        ? async (ids, database) => {
            await this.#authorize(actor, ids, database);
          }
        : undefined,
    );
    this.#changed(actor, rows[0]!.workspaceId);
    return result;
  }
  async ungroup(
    actor: BrowserTabActor,
    tabIds: readonly z.infer<typeof BrowserSurfaceIdSchema>[],
    idempotencyKey: string,
  ) {
    if (actor.kind === "agent") await this.#browser.flushPendingTabDescriptors();
    const rows = await this.#authorize(actor, tabIds);
    const layout = await this.#groups.ungroup(
      actor.ownerId,
      { tabIds, idempotencyKey },
      actor.kind === "agent"
        ? async (ids, database) => {
            await this.#authorize(actor, ids, database);
          }
        : undefined,
    );
    this.#changed(actor, rows[0]!.workspaceId);
    return layout;
  }
  async move(actor: BrowserTabActor, input: BrowserTabMove & { readonly idempotencyKey: string }) {
    if (actor.kind === "agent") await this.#browser.flushPendingTabDescriptors();
    const move = BrowserTabMoveSchema.parse({ item: input.item, to: input.to });
    let workspaceId: WorkspaceId | undefined;
    const layout = await this.#groups.move(
      actor.ownerId,
      { ...move, idempotencyKey: input.idempotencyKey },
      async (ids, database) => {
        const rows = await this.#authorize(actor, ids, database);
        workspaceId = rows[0]?.workspaceId;
      },
    );
    if (workspaceId) this.#changed(actor, workspaceId);
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
    if (!group) throw new OpensteerError({ code: "not_found", message: "Tab group not found." });
    const rows = await this.#authorize(actor, group.tabIds);
    const layout = await this.#groups.update(
      actor.ownerId,
      { ...fields, idempotencyKey },
      actor.kind === "agent"
        ? async (ids, database) => {
            await this.#authorize(actor, ids, database);
          }
        : undefined,
    );
    this.#changed(actor, rows[0]!.workspaceId);
    return layout;
  }
  async close(actor: BrowserTabActor, tabIds: readonly z.infer<typeof BrowserSurfaceIdSchema>[]) {
    if (actor.kind === "agent") await this.#browser.flushPendingTabDescriptors();
    const rows = await this.#authorize(actor, tabIds, this.#groups.database, true);
    const closed: z.infer<typeof BrowserSurfaceIdSchema>[] = [];
    const failed: Array<{ tabId: z.infer<typeof BrowserSurfaceIdSchema>; message: string }> = [];
    for (const tabId of new Set(tabIds)) {
      try {
        await this.#browser.closeWorkspaceTab(actor.ownerId, tabId, actor.kind === "person");
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
    this.#changed(actor, rows[0]!.workspaceId);
    return { closed, failed };
  }
  #changed(actor: BrowserTabActor, workspaceId: WorkspaceId) {
    // Clients invalidate all browser data; the first affected tab supplies the notice's required Workspace.
    this.#publish(workspaceId, [actor.ownerId]);
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
        const rows = await this.#authorize(actor, parsed.tabIds!);
        const restored = [];
        for (const id of new Set(parsed.tabIds))
          restored.push(await this.#browser.restoreAgentWorkspaceTab(actor, id));
        this.#changed(actor, rows[0]!.workspaceId);
        return { action: "restore", restored };
      }
    }
  }
}
