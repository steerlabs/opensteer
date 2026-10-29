import {
  BrowserSurfaceIdSchema,
  BrowserTabGroupIdSchema,
  BrowserTabMoveSchema,
  groupBrowserTabs,
  ungroupBrowserTabs,
  moveBrowserTabs,
  type BrowserTabOrderTab,
} from "@opensteer/core";
import { arrangedBrowserTabLayout, browserTabArrangement } from "./browser-tab-order.js";
import type { BrowserTabLayout, HostApiClient } from "@opensteer/protocol";
import type { HostClient } from "./client.js";
import { mutationIdempotencyKey, unwrapRpcResult } from "./host-session-client.js";

type LayoutPatch = (
  layout: BrowserTabLayout,
  tabs: readonly BrowserTabOrderTab[],
) => BrowserTabLayout;
export function removeGroupedTabs(
  layout: BrowserTabLayout,
  tabIds: readonly string[],
): BrowserTabLayout {
  const removed = new Set(tabIds);
  return {
    ...layout,
    groups: layout.groups.flatMap((group) => {
      const ids = group.tabIds.filter((id) => !removed.has(id));
      return ids.length === group.tabIds.length
        ? [group]
        : ids.length
          ? [{ ...group, tabIds: ids }]
          : [];
    }),
  };
}

/** Pending edits replay over the newest Host layout, including while other edits fail. */
export class BrowserTabGroupClient {
  #base: BrowserTabLayout | undefined;
  #scope = -1;
  readonly #pending = new Map<object, LayoutPatch>();
  #tail: Promise<void> = Promise.resolve();
  readonly rpc: HostApiClient;
  readonly publish: (layout: BrowserTabLayout | undefined) => void;
  readonly authority: () => number;
  readonly tabs: () => readonly BrowserTabOrderTab[];
  constructor(
    rpc: HostApiClient,
    publish: (layout: BrowserTabLayout | undefined) => void,
    authority: () => number,
    tabs: () => readonly BrowserTabOrderTab[],
  ) {
    this.rpc = rpc;
    this.publish = publish;
    this.authority = authority;
    this.tabs = tabs;
  }
  receive(layout: BrowserTabLayout | undefined): BrowserTabLayout | undefined {
    if (this.#scope !== this.authority()) {
      this.#scope = this.authority();
      this.#pending.clear();
      this.#base = undefined;
      this.#tail = Promise.resolve();
    }
    if (!layout) {
      this.#base = undefined;
      this.#pending.clear();
    } else if (!this.#base || layout.revision >= this.#base.revision) this.#base = layout;
    return this.project();
  }
  project() {
    let layout = this.#base;
    if (layout && this.#pending.size) {
      const tabs = this.tabs();
      for (const patch of this.#pending.values()) layout = patch(layout, tabs);
    }
    return layout;
  }
  async #change<T extends { layout: BrowserTabLayout }>(
    patch: LayoutPatch | null,
    send: () => Promise<T>,
  ): Promise<T> {
    const scope = this.authority();
    const token = {};
    if (patch && this.#base) {
      this.#pending.set(token, patch);
      this.publish(this.project());
    }
    const request = this.#tail.then(async () => {
      if (scope !== this.authority())
        throw new Error("The signed-in account changed while editing tab groups.");
      try {
        const result = await send();
        if (scope !== this.authority())
          throw new Error("The signed-in account changed while editing tab groups.");
        this.#pending.delete(token);
        // A refresh can remove closed members without advancing the organization revision.
        if (!this.#base || result.layout.revision > this.#base.revision) this.#base = result.layout;
        this.publish(this.project());
        return result;
      } catch (error) {
        if (scope === this.authority()) {
          this.#pending.delete(token);
          this.publish(this.project());
        }
        throw error;
      }
    });
    this.#tail = request.then(
      () => undefined,
      () => undefined,
    );
    return request;
  }
  readonly moveBrowserTabs: HostClient["moveBrowserTabs"] = async (input) => {
    const move = BrowserTabMoveSchema.parse(input);
    await this.#change(
      (layout, tabs) => {
        if (layout.order === undefined) return layout;
        const result = moveBrowserTabs(browserTabArrangement(layout, tabs), move);
        return result.ok ? arrangedBrowserTabLayout(layout, result.arrangement) : layout;
      },
      async () => {
        const result = unwrapRpcResult(
          await this.rpc["commands.dispatch"]({
            type: "workspace.tabs.move",
            ...move,
            idempotencyKey: mutationIdempotencyKey("tab-move"),
          }),
        );
        if (result.type !== "workspace.tabs.move") throw new Error("Unexpected tab move result.");
        return result;
      },
    );
  };
  readonly groupBrowserTabs: HostClient["groupBrowserTabs"] = async (tabIds, target) => {
    const ids = tabIds.map((id) => BrowserSurfaceIdSchema.parse(id));
    const result = await this.#change(
      "groupId" in target
        ? (layout, tabs) => {
            if (!layout.groups.some((group) => group.id === target.groupId)) return layout;
            if (layout.order !== undefined)
              return arrangedBrowserTabLayout(
                layout,
                groupBrowserTabs(browserTabArrangement(layout, tabs), ids, target.groupId),
              );
            return {
              ...layout,
              groups: layout.groups.flatMap((group) => {
                const tabIds = group.tabIds.filter((id) => !ids.includes(id));
                if (group.id === target.groupId) tabIds.push(...ids);
                return tabIds.length ? [{ ...group, tabIds }] : [];
              }),
            };
          }
        : null,
      async () => {
        const result = unwrapRpcResult(
          await this.rpc["commands.dispatch"]({
            type: "workspace.tabs.group",
            tabIds: ids,
            ...target,
            ...("groupId" in target
              ? { groupId: BrowserTabGroupIdSchema.parse(target.groupId) }
              : {}),
            idempotencyKey: mutationIdempotencyKey("tab-group"),
          }),
        );
        if (result.type !== "workspace.tabs.group") throw new Error("Unexpected tab group result.");
        return result;
      },
    );
    return result.groupId;
  };
  readonly ungroupBrowserTabs: HostClient["ungroupBrowserTabs"] = async (tabIds) => {
    await this.#change(
      (layout, tabs) =>
        layout.order === undefined
          ? removeGroupedTabs(layout, tabIds)
          : arrangedBrowserTabLayout(
              layout,
              ungroupBrowserTabs(browserTabArrangement(layout, tabs), tabIds),
            ),
      async () => {
        const result = unwrapRpcResult(
          await this.rpc["commands.dispatch"]({
            type: "workspace.tabs.ungroup",
            tabIds: tabIds.map((id) => BrowserSurfaceIdSchema.parse(id)),
            idempotencyKey: mutationIdempotencyKey("tab-group"),
          }),
        );
        if (result.type !== "workspace.tabs.ungroup") throw new Error("Unexpected ungroup result.");
        return result;
      },
    );
  };
  readonly updateBrowserTabGroup: HostClient["updateBrowserTabGroup"] = async (groupId, update) => {
    await this.#change(
      (layout) => ({
        ...layout,
        groups: layout.groups.map((group) =>
          group.id === groupId ? { ...group, ...update } : group,
        ),
      }),
      async () => {
        const result = unwrapRpcResult(
          await this.rpc["commands.dispatch"]({
            type: "workspace.tabGroup.update",
            groupId: BrowserTabGroupIdSchema.parse(groupId),
            ...update,
            idempotencyKey: mutationIdempotencyKey("tab-group"),
          }),
        );
        if (result.type !== "workspace.tabGroup.update")
          throw new Error("Unexpected tab group update result.");
        return result;
      },
    );
  };
  removeClosed(tabIds: readonly string[]) {
    if (this.#base)
      this.#base = {
        ...removeGroupedTabs(this.#base, tabIds),
        ...(this.#base.order === undefined
          ? {}
          : { order: this.#base.order.filter((id) => !tabIds.includes(id)) }),
      };
    this.publish(this.project());
  }
}
