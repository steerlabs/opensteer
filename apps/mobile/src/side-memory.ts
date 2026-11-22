import { CommonActions, StackActions, type NavigationAction } from "@react-navigation/native";
import { isRecord } from "@opensteer/shared/isRecord";
import { presentedFrom } from "./navigation-presentations.js";
import type { StackView, TopLevelTarget } from "./top-level.js";

type SideRoute = {
  readonly name: string;
  readonly key?: string;
  readonly params?: object | undefined;
};

const landingParams = new Set(["messageId", "requestId", "replyId", "pendingBrowserTab"]);

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

/** One account/Deployment's warm navigation address above Home, never persisted. */
export class SideMemory {
  #account: string | null | undefined;
  #deployment: string | null = null;
  #chain: readonly SideRoute[] = [];

  account(subject: string | null): boolean {
    if (this.#account === subject) return false;
    const changed = this.#account !== undefined;
    this.#account = subject;
    this.clear();
    return changed;
  }

  clear(): void {
    this.#chain = [];
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
    this.#chain = state.routes.slice(1, end).map(remember);
  }

  /** An explicit entry replaces the remembered address. */
  enter(state: StackView, target: TopLevelTarget): NavigationAction | null {
    this.record(state);
    if (state.routes[0]?.name !== "Home") return null;
    if (presentedFrom({ index: 0, routes: [target] }) === 0)
      return this.#reset(state, [...this.#chain, target]);
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
    const chain = target.name === "Home" ? [] : [target];
    this.#chain = chain.map(remember);
    if (target.name === "Home") return StackActions.popToTop();
    return this.#reset(state, chain);
  }

  /** Only confirmed removal trims history; list absence is not invalidity. */
  trim(state: StackView, invalid: (route: SideRoute) => boolean): NavigationAction | null {
    this.record(state);
    const index = this.#chain.findIndex(invalid);
    if (index < 0) return null;
    this.#chain = this.#chain.slice(0, index);
    return this.#reset(state, this.#chain);
  }

  #reset(state: StackView, chain: readonly SideRoute[]): NavigationAction | null {
    const home = state.routes[0];
    if (home?.name !== "Home") return null;
    const action = CommonActions.reset({ index: chain.length, routes: [home, ...chain] });
    return { type: action.type, payload: action.payload ?? {} };
  }
}

export const sideMemory = new SideMemory();
