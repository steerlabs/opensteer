import { CommonActions, StackActions, type NavigationAction } from "@react-navigation/native";
import { isRecord } from "@opensteer/shared/isRecord";
import { presentedFrom } from "./navigation-presentations.js";
import type { StackView, TopLevelTarget } from "./top-level.js";

export type SideId = "tasks" | (string & {});
type SideRoute = {
  readonly name: string;
  readonly key?: string;
  readonly params?: object | undefined;
};

// Routes may carry landing instructions or capabilities; memory keeps only addresses.
const addressParams = new Set([
  "deploymentId",
  "teamId",
  "threadId",
  "channelId",
  "rootId",
  "topicId",
  "noteId",
  "groupId",
  "sessionId",
  "tabId",
  "machineId",
  "computerSessionId",
  "appKey",
  "appId",
  "viewId",
  "generation",
  "windowId",
  "phone",
  "scope",
  "nodeId",
  "entryId",
  "turnKey",
]);

export function routeSide(route: SideRoute | undefined): SideId {
  const teamId = isRecord(route?.params) ? route.params["teamId"] : undefined;
  return typeof teamId === "string" ? teamId : "tasks";
}

function remember(route: SideRoute): SideRoute {
  const params = isRecord(route.params)
    ? Object.fromEntries(
        Object.entries(route.params).filter(
          ([key, value]) =>
            addressParams.has(key) &&
            (typeof value === "string" || typeof value === "number" || typeof value === "boolean"),
        ),
      )
    : undefined;
  return {
    name: route.name,
    ...(route.key === undefined ? {} : { key: route.key }),
    ...(params === undefined ? {} : { params }),
  };
}

function teamRoot(teamId: string): SideRoute {
  return { name: "TeamHome", params: { teamId } };
}

function destinationChain(target: SideRoute): SideRoute[] {
  const side = routeSide(target);
  if (target.name === "Home") return [];
  if (side === "tasks" || target.name === "TeamHome") return [target];
  const chain = [teamRoot(side)];
  if (target.name === "TeamThread" && isRecord(target.params))
    chain.push({
      name: "TeamChannel",
      params: { teamId: side, channelId: target.params["channelId"] },
    });
  return [...chain, target];
}

/** One account/Deployment's warm navigation addresses, never persisted. */
export class SideMemory {
  #account: string | null | undefined;
  #deployment: string | null = null;
  #chains = new Map<SideId, readonly SideRoute[]>();
  #active: SideId = "tasks";

  get active(): SideId {
    return this.#active;
  }

  account(subject: string | null): boolean {
    if (this.#account === subject) return false;
    const changed = this.#account !== undefined;
    this.#account = subject;
    this.clear();
    return changed;
  }

  clear(): void {
    this.#chains.clear();
    this.#active = "tasks";
    this.#deployment = null;
  }

  record(state: StackView): void {
    const home = state.routes[0];
    if (home?.name !== "Home") {
      this.clear();
      return;
    }
    const deployment = isRecord(home.params) ? home.params["deploymentId"] : undefined;
    if (typeof deployment !== "string") return;
    if (this.#deployment !== deployment) {
      this.clear();
      this.#deployment = deployment;
    }
    const presented = presentedFrom(state);
    const end = presented < 0 ? state.index + 1 : presented;
    const chain = state.routes.slice(1, end).map(remember);
    this.#active = routeSide(chain[0]);
    this.#chains.set(this.#active, chain);
  }

  resume(state: StackView, side: SideId): NavigationAction | null {
    this.record(state);
    if (this.#active === side) return null;
    this.#active = side;
    return this.#reset(state, this.#chains.get(side) ?? (side === "tasks" ? [] : [teamRoot(side)]));
  }

  back(state: StackView): NavigationAction | null {
    return state.routes[1]?.name === "TeamHome" ? this.resume(state, "tasks") : null;
  }

  /** Explicit entries replace only their destination side; pushes stay inside that side. */
  enter(state: StackView, target: TopLevelTarget, push = false): NavigationAction | null {
    this.record(state);
    const side = routeSide(target);
    if (presentedFrom({ index: 0, routes: [target] }) === 0) {
      const base = this.#chains.get(this.#active) ?? [];
      return this.#reset(state, [...base, target]);
    }
    const presented = presentedFrom(state);
    const routes = state.routes.slice(1, presented < 0 ? state.index + 1 : presented);
    const params = isRecord(target.params) ? target.params : {};
    const landing = ["messageId", "requestId", "replyId"].some((key) => params[key] !== undefined);
    const existing =
      !landing && side === this.#active
        ? routes.findIndex((route) => {
            const current = isRecord(route.params) ? route.params : {};
            return (
              route.name === target.name &&
              Object.entries(target.params).every(([key, value]) => current[key] === value)
            );
          })
        : -1;
    const chain =
      existing >= 0
        ? routes.slice(0, existing + 1)
        : push && side === this.#active && presented < 0
          ? [...routes, target]
          : destinationChain(target);
    if (existing === routes.length - 1 && existing >= 0 && presented < 0) return null;
    if (target.name === "Home" && state.index === 0) return null;
    const previous = this.#active;
    this.#active = side;
    // A presented entry (such as agent authorization) never becomes a remembered address.
    if (presentedFrom({ index: chain.length - 1, routes: chain }) < 0)
      this.#chains.set(side, chain.map(remember));
    if (existing >= 0 && presented < 0) return StackActions.pop(state.index - existing - 1);
    if (target.name === "Home" && previous === "tasks") return StackActions.popToTop();
    return this.#reset(state, chain);
  }

  /** Only an authoritative refusal/deletion calls this; list absence is not invalidity. */
  trim(state: StackView, invalid: (route: SideRoute) => boolean): NavigationAction | null {
    this.record(state);
    let activeChanged = false;
    for (const [side, chain] of this.#chains) {
      const index = chain.findIndex(invalid);
      if (index < 0) continue;
      this.#chains.set(
        side,
        side === "tasks" ? chain.slice(0, index) : [chain[0] ?? teamRoot(side)],
      );
      if (side === this.#active) activeChanged = true;
    }
    return activeChanged ? this.#reset(state, this.#chains.get(this.#active) ?? []) : null;
  }

  forget(state: StackView, teamId: string): NavigationAction | null {
    this.record(state);
    this.#chains.delete(teamId);
    if (this.#active !== teamId && routeSide(state.routes[state.index]) !== teamId) return null;
    this.#active = "tasks";
    return this.#reset(state, this.#chains.get("tasks") ?? []);
  }

  #reset(state: StackView, chain: readonly SideRoute[]): NavigationAction | null {
    const home = state.routes[0];
    if (home?.name !== "Home") return null;
    const action = CommonActions.reset({ index: chain.length, routes: [home, ...chain] });
    return { type: action.type, payload: action.payload ?? {} };
  }
}

export const sideMemory = new SideMemory();
