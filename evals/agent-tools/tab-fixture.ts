import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import type { ToolError } from "@opensteer/core";
import { isRecord } from "@opensteer/shared/isRecord";
import type { BrowserFixture } from "./cases.js";

/** Tab state shared by the fake Host's tab tools and the fake Browser Harness. */
export type TabState = BrowserFixture & { nextTab?: number };
type FixtureTab = BrowserFixture["tabs"][number];
export type FixtureToolResult = { result: Record<string, unknown> } | { error: ToolError };

const otherTaskId = "thr_00000000-0000-4000-8000-0000000000aa";
const fixtureTime = "2026-01-01T00:00:00.000Z";
export const tabFixtureTools = new Set([
  "tab_list",
  "tab_open",
  "tab_close",
  "tab_organize",
  "tab_group_update",
  "person_show",
]);

function failure(code: string, message: string, next: string | null = null): FixtureToolResult {
  return { error: { code, message, next } };
}

function derivedId(prefix: string, seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex");
  return `${prefix}_${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Answers tab tools from one state file that Browser Harness scripts also read
 * and write, so an agent sees the same tabs through MCP, `opensteer.callTool`
 * and `openPage`. Before a state file is attached, the state stays in memory.
 */
export class TabFixture {
  #path: string | undefined;
  #memory: TabState;
  readonly #taskId: string;

  constructor(initial: BrowserFixture, taskId: string) {
    this.#memory = structuredClone(initial);
    this.#taskId = taskId;
  }

  attach(path: string) {
    this.#path = path;
  }

  read(): TabState {
    return this.#path ? (JSON.parse(readFileSync(this.#path, "utf8")) as TabState) : this.#memory;
  }

  #write(state: TabState) {
    if (this.#path) writeFileSync(this.#path, JSON.stringify(state));
    else this.#memory = state;
  }

  computerId(state: TabState, name: string): string {
    if (/^rnr_[0-9a-f-]{36}$/u.test(name)) return name;
    return (
      state.computers.find((computer) => computer.name === name)?.computerId ??
      derivedId("rnr", `computer:${name}`)
    );
  }

  #computerName(state: TabState, computerId: string | undefined): string | undefined {
    if (computerId === undefined) return state.hostingComputer;
    const names = new Set([
      ...state.tabs.map((tab) => tab.computer),
      ...state.profiles.flatMap((profile) => (profile.computer ? [profile.computer] : [])),
      ...state.windows.map((window) => window.computer),
      ...state.phones.map((phone) => phone.computer),
      ...state.apps.map((app) => app.computer),
      state.hostingComputer,
    ]);
    return [...names].find((name) => this.computerId(state, name) === computerId);
  }

  project(state: TabState, tab: FixtureTab) {
    const task = (who: "this-task" | "other-task") =>
      who === "this-task" ? this.#taskId : otherTaskId;
    return {
      tabId: tab.tabId,
      kind: tab.kind,
      title: tab.title,
      computer: { computerId: this.computerId(state, tab.computer), name: tab.computer },
      groupId: tab.groupId,
      state: tab.state,
      ...(tab.state === "unavailable"
        ? { unavailableCode: "runtime-failed", unavailableReason: tab.unavailableReason }
        : {}),
      openedBy: tab.openedBy === "person" ? "person" : { taskId: task(tab.openedBy) },
      usedBy: [...new Set(tab.usedBy)].map((who) => ({ taskId: task(who) })),
      createdAt: fixtureTime,
      updatedAt: fixtureTime,
      ...(tab.kind === "page" ? { url: tab.url, profile: tab.profile ?? null } : {}),
      ...(tab.kind === "window" ? { appName: tab.appName, bundleId: tab.bundleId } : {}),
      ...(tab.kind === "app" ? { appId: tab.appId } : {}),
    };
  }

  #groups(state: TabState) {
    return state.groups.map((group) => ({
      ...group,
      tabIds: state.tabs.filter((tab) => tab.groupId === group.groupId).map((tab) => tab.tabId),
    }));
  }

  #reachable(state: TabState, computer: string): FixtureToolResult | undefined {
    const computerId = this.computerId(state, computer);
    if (state.offlineComputers.includes(computer))
      return failure(
        "computer_offline",
        `${computer} is offline.`,
        `Reconnect ${computer} (computerId=${computerId}); no other computer can stand in.`,
      );
    if (state.accessRequiredComputers.includes(computer))
      return failure(
        "access_denied",
        `Browser access is off on ${computer}.`,
        `Use computer_access_request with computerId=${computerId} and access=browser.`,
      );
    return undefined;
  }

  #add(state: TabState, tab: Omit<FixtureTab, "tabId">) {
    state.nextTab = (state.nextTab ?? 0) + 1;
    const created = { ...tab, tabId: `eval-tab-${state.nextTab}` } as FixtureTab;
    state.tabs.push(created);
    return created;
  }

  call(name: string, args: Record<string, unknown>): FixtureToolResult {
    const state = this.read();
    const result = this.#call(state, name, args);
    if ("result" in result) this.#write(state);
    return result;
  }

  #call(state: TabState, name: string, args: Record<string, unknown>): FixtureToolResult {
    const findTab = (tabId: unknown) => state.tabs.find((tab) => tab.tabId === tabId);
    const opened = {
      openedBy: "this-task" as const,
      usedBy: ["this-task" as const],
      groupId: null,
      state: "open" as const,
      backend: "cdp" as const,
      outcomeUnknown: [],
    };
    const result = (tab: FixtureTab) => ({ result: { tab: this.project(state, tab) } });
    switch (name) {
      case "tab_list": {
        const query = typeof args.query === "string" ? args.query.toLowerCase() : "";
        const tabs = state.tabs.filter(
          (tab) =>
            (args.kind === undefined || tab.kind === args.kind) &&
            [
              tab.title,
              tab.url,
              tab.profile?.name,
              tab.appName,
              tab.computer,
              state.groups.find((group) => group.groupId === tab.groupId)?.name,
            ].some((value) => (value ?? "").toLowerCase().includes(query)),
        );
        return {
          result: {
            tabs: tabs.slice(0, 50).map((tab) => this.project(state, tab)),
            groups: this.#groups(state),
            nextCursor: null,
          },
        };
      }
      case "tab_open": {
        const target = isRecord(args.target) ? args.target : {};
        if (target.kind === "page") {
          const url = String(target.url);
          let profile: FixtureTab["profile"] = null;
          let computer: string | undefined;
          if (typeof target.profileId === "string") {
            const found = state.profiles.find((candidate) => candidate.id === target.profileId);
            if (!found) return failure("not_found", "That profile is not available.", null);
            profile = { profileId: found.id, name: found.name };
            computer = found.computer ?? state.hostingComputer;
          } else {
            computer = this.#computerName(
              state,
              typeof target.computerId === "string" ? target.computerId : undefined,
            );
            if (!computer) return failure("not_found", "That computer is not available.", null);
          }
          const refused = this.#reachable(state, computer);
          if (refused) return refused;
          return result(
            this.#add(state, {
              ...opened,
              kind: "page",
              title: url,
              url,
              profile,
              computer,
              pageText: state.tabs.find((tab) => tab.url === url)?.pageText ?? "Fixture page",
            }),
          );
        }
        if (target.kind === "window") {
          const window = state.windows.find(
            (candidate) =>
              this.computerId(state, candidate.computer) === target.computerId &&
              (candidate.windowId === target.windowId || candidate.bundleId === target.bundleId),
          );
          if (!window) return failure("not_found", "That window is not available.", null);
          const existing = state.tabs.find((tab) => tab.windowId === window.windowId);
          if (existing) return result(existing);
          const refused = this.#reachable(state, window.computer);
          if (refused) return refused;
          return result(this.#add(state, { ...opened, kind: "window", ...window }));
        }
        if (target.kind === "phone") {
          const phone = state.phones.find(
            (candidate) => this.computerId(state, candidate.computer) === target.computerId,
          );
          if (!phone) return failure("not_found", "That computer has no Agent Phone.", null);
          const existing = state.tabs.find(
            (tab) => tab.kind === "phone" && tab.computer === phone.computer,
          );
          if (existing) return result(existing);
          return result(
            this.#add(state, {
              ...opened,
              kind: "phone",
              title: phone.name,
              computer: phone.computer,
            }),
          );
        }
        if (target.kind === "app") {
          const app = state.apps.find((candidate) => candidate.appId === target.appId);
          if (!app) return failure("not_found", "That app is not available.", null);
          const existing = state.tabs.find((tab) => tab.kind === "app" && tab.appId === app.appId);
          if (existing) return result(existing);
          return result(
            this.#add(state, {
              ...opened,
              kind: "app",
              title: app.name,
              appId: app.appId,
              computer: app.computer,
            }),
          );
        }
        return failure("invalid_input", "Unknown tab target.", null);
      }
      case "tab_close": {
        const tabIds = Array.isArray(args.tabIds) ? args.tabIds : [];
        const closed = tabIds.filter((tabId) => findTab(tabId));
        state.tabs = state.tabs.filter((tab) => !closed.includes(tab.tabId));
        return {
          result: {
            closed,
            failed: tabIds
              .filter((tabId) => !closed.includes(tabId))
              .map((tabId) => ({
                tabId,
                error: { code: "not_found", message: "Tab not found.", next: null },
              })),
          },
        };
      }
      case "tab_organize": {
        const tabs = (Array.isArray(args.tabIds) ? args.tabIds : []).map(findTab);
        if (tabs.some((tab) => !tab)) return failure("not_found", "A tab was not found.", null);
        let groupId: string | null = null;
        if (isRecord(args.group) && typeof args.group.groupId === "string") {
          groupId = args.group.groupId;
          if (!state.groups.some((group) => group.groupId === groupId))
            return failure("conflict", "That group no longer exists.", "Use tab_list for groups.");
        } else if (isRecord(args.group)) {
          groupId = `tgp_${randomUUID()}`;
          state.groups.push({
            groupId,
            name: String(args.group.name),
            color: String(args.group.color),
            collapsed: false,
          });
        }
        const moved = tabs as FixtureTab[];
        for (const tab of moved) tab.groupId = groupId;
        state.tabs = state.tabs.filter((tab) => !moved.includes(tab));
        const before = state.tabs.findIndex((tab) => tab.tabId === args.beforeTabId);
        state.tabs.splice(before < 0 ? state.tabs.length : before, 0, ...moved);
        return {
          result: {
            tabs: moved.map((tab) => this.project(state, tab)),
            groups: this.#groups(state),
          },
        };
      }
      case "tab_group_update": {
        const group = state.groups.find((candidate) => candidate.groupId === args.groupId);
        if (!group) return failure("not_found", "Group not found.", "Use tab_list for groups.");
        if (typeof args.name === "string") group.name = args.name;
        if (typeof args.color === "string") group.color = args.color;
        if (typeof args.collapsed === "boolean") group.collapsed = args.collapsed;
        return { result: { group: this.#groups(state).find((g) => g.groupId === group.groupId) } };
      }
      case "person_show": {
        const target = isRecord(args.target) ? args.target : {};
        if (typeof target.tabId === "string") {
          const tab = findTab(target.tabId);
          if (!tab)
            return failure(
              "not_found",
              "That tab is closed or unavailable.",
              "Tell the person; showing another tab would be a different target.",
            );
          if (tab.state === "unavailable")
            return failure("conflict", tab.unavailableReason ?? "That tab is unavailable.", null);
        }
        return { result: { status: "sent-unconfirmed", connectedDevices: 1 } };
      }
    }
    return failure("not_found", "Unknown fixture tool.", null);
  }
}
