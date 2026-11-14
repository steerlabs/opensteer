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

const landingParams = new Set(["messageId", "requestId", "replyId"]);

export function routeSide(route: SideRoute | undefined): SideId {
  const teamId = isRecord(route?.params) ? route.params["teamId"] : undefined;
  return typeof teamId === "string" ? teamId : "tasks";
}

function remember(route: SideRoute): SideRoute {
  const params = isRecord(route.params)
    ? Object.fromEntries(Object.entries(route.params).filter(([key]) => !landingParams.has(key)))
    : undefined;
  return {
    name: route.name,
    ...(route.key === undefined ? {} : { key: route.key }),
    ...(params === undefined ? {} : { params }),
  };
}

export function isTeamSideRoot(state: StackView, key: string): boolean {
  return (
    state.routes[0]?.name === "Home" &&
    state.routes[1]?.key === key &&
    routeSide(state.routes[1]) !== "tasks" &&
    presentedFrom(state) !== 1
  );
}

/** One account/Deployment's warm navigation addresses, never persisted. */
export class SideMemory {
  #account: string | null | undefined;
  #deployment: string | null = null;
  #chains = new Map<SideId, readonly SideRoute[]>();
  #active: SideId = "tasks";

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
    const chain = this.#chains.get(side);
    if (chain === undefined && side !== "tasks") return null;
    this.#active = side;
    return this.#reset(state, chain ?? []);
  }

  back(state: StackView): NavigationAction | null {
    const root = state.routes[1];
    return root && isTeamSideRoot(state, root.key) ? this.resume(state, "tasks") : null;
  }

  /** Explicit entries replace only their destination side. */
  enter(state: StackView, target: TopLevelTarget): NavigationAction | null {
    this.record(state);
    if (state.routes[0]?.name !== "Home") return null;
    const side = routeSide(target);
    if (presentedFrom({ index: 0, routes: [target] }) === 0) {
      const base = this.#chains.get(this.#active) ?? [];
      return this.#reset(state, [...base, target]);
    }
    const presented = presentedFrom(state);
    const routes = state.routes.slice(1, presented < 0 ? state.index + 1 : presented);
    const current = routes[0];
    const params = isRecord(current?.params) ? current.params : {};
    if (
      current?.name === target.name &&
      Object.entries(target.params).every(
        ([key, value]) => !landingParams.has(key) && params[key] === value,
      )
    )
      return state.index === 1 ? null : StackActions.pop(state.index - 1);
    if (target.name === "Home" && state.index === 0) return null;
    const previous = this.#active;
    this.#active = side;
    const chain = target.name === "Home" ? [] : [target];
    this.#chains.set(side, chain.map(remember));
    if (target.name === "Home" && previous === "tasks") return StackActions.popToTop();
    return this.#reset(state, chain);
  }

  /** Only confirmed removal trims history; list absence is not invalidity. */
  trim(state: StackView, invalid: (route: SideRoute) => boolean): NavigationAction | null {
    this.record(state);
    let activeChanged = false;
    for (const [side, chain] of this.#chains) {
      const index = chain.findIndex(invalid);
      if (index < 0) continue;
      if (index === 0 && side !== "tasks") this.#chains.delete(side);
      else this.#chains.set(side, chain.slice(0, index));
      if (side === this.#active) activeChanged = true;
    }
    if (!activeChanged) return null;
    this.#active = "tasks";
    return this.#reset(state, this.#chains.get(this.#active) ?? []);
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
