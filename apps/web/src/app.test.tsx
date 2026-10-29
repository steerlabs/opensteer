import type { DependencyList, EffectCallback, MutableRefObject, SetStateAction } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createId } from "@opensteer/core";
import { rpcSuccess } from "@opensteer/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostSnapshot } from "@opensteer/client/host";

const hooks = vi.hoisted(() => {
  const slots: unknown[] = [];
  const effectDependencies = new Map<number, DependencyList | undefined>();
  let cursor = 0;
  let effects: EffectCallback[] = [];

  return {
    beginRender() {
      cursor = 0;
      effects = [];
    },
    reset() {
      slots.length = 0;
      effectDependencies.clear();
      cursor = 0;
      effects = [];
    },
    takeEffects() {
      const current = effects;
      effects = [];
      return current;
    },
    useEffect(effect: EffectCallback, dependencies?: DependencyList) {
      const slot = cursor;
      cursor += 1;
      const previous = effectDependencies.get(slot);
      const changed =
        !effectDependencies.has(slot) ||
        dependencies === undefined ||
        previous === undefined ||
        dependencies.length !== previous.length ||
        dependencies.some((value, index) => !Object.is(value, previous[index]));
      effectDependencies.set(slot, dependencies);
      if (changed) effects.push(effect);
    },
    useRef<Value>(initialValue: Value): MutableRefObject<Value> {
      const slot = cursor;
      cursor += 1;
      if (!(slot in slots)) slots[slot] = { current: initialValue };
      return slots[slot] as MutableRefObject<Value>;
    },
    useState<Value>(initialValue: Value | (() => Value)) {
      const slot = cursor;
      cursor += 1;
      if (!(slot in slots)) {
        slots[slot] =
          typeof initialValue === "function" ? (initialValue as () => Value)() : initialValue;
      }
      const setValue = (next: SetStateAction<Value>) => {
        const previous = slots[slot] as Value;
        slots[slot] =
          typeof next === "function" ? (next as (value: Value) => Value)(previous) : next;
      };
      return [slots[slot] as Value, setValue] as const;
    },
  };
});

vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return {
    ...react,
    useEffect: hooks.useEffect,
    useRef: hooks.useRef,
    useState: hooks.useState,
  };
});

let snapshot: HostSnapshot;

vi.mock("@opensteer/client/react", () => ({
  useHostSnapshot: () => ({
    loadError: null,
    reload: async () => undefined,
    snapshot,
  }),
}));

import { App, startHostOidcSignIn } from "./app.js";
import { MockHostClient } from "@opensteer/client/mock";

const identityConfig = {
  deployment: { cloud: false, kind: "self-hosted" as const, name: null },
  emailDeliveryAvailable: false,
  localPasswordEnabled: false,
  machineOwner: false,
  oidcProviders: [{ id: "opensteer-account", label: "Opensteer Account", type: "oidc" as const }],
  passkeysEnabled: false,
  exposure: "networked" as const,
  portalOrigin: null,
  publicOrigin: "https://host.opensteer.test",
  setupState: "complete" as const,
  signupPolicy: "invite-only" as const,
};

beforeEach(() => {
  hooks.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("App automatic OIDC sign-in", () => {
  it("renders the splash and starts the sole provider once before redirecting", async () => {
    const browser = installWindow();
    const client = createClient();
    const beginOidcSignIn = spyOnBeginOidc(client).mockResolvedValue(
      rpcSuccess({ redirectUrl: "https://beta.opensteer.test/authorize" }),
    );

    const markup = renderApp(client);

    expect(markup).toContain("Signing you in…");
    expect(markup).not.toContain("Sign in to this Opensteer");
    await runEffectsTwice();
    expect(beginOidcSignIn).toHaveBeenCalledTimes(1);
    expect(beginOidcSignIn).toHaveBeenCalledWith({
      providerId: "opensteer-account",
      returnPath: "/",
    });
    expect(browser.assign).toHaveBeenCalledWith("https://beta.opensteer.test/authorize");
    expect(Number(browser.values.get("opensteer.oidc.auto-attempt"))).toBeGreaterThan(0);
  });

  it("shows manual sign-in without starting OIDC when the attempt marker is fresh", async () => {
    const browser = installWindow(String(Date.now()));
    const client = createClient();
    const beginOidcSignIn = spyOnBeginOidc(client);

    const markup = renderApp(client);
    await runEffectsTwice();

    expect(markup).toContain("Welcome back");
    expect(markup).toContain("Continue with Opensteer Account");
    expect(beginOidcSignIn).not.toHaveBeenCalled();
    expect(browser.assign).not.toHaveBeenCalled();
  });

  it("falls back to manual sign-in with the error when the automatic attempt rejects", async () => {
    const browser = installWindow();
    const client = createClient();
    const beginOidcSignIn = spyOnBeginOidc(client).mockRejectedValue(
      new Error("Account sign-in is unavailable."),
    );

    expect(renderApp(client)).toContain("Signing you in…");
    await runEffectsTwice();
    const markup = renderApp(client);

    expect(beginOidcSignIn).toHaveBeenCalledTimes(1);
    expect(browser.assign).not.toHaveBeenCalled();
    expect(markup).toContain("Welcome back");
    expect(markup).toContain("Account sign-in is unavailable.");
    expect(browser.values.get("opensteer.oidc.auto-attempt")).toBeDefined();
  });
});

describe("Host OIDC sign-in surface", () => {
  it("finishes a Desktop sign-in natively instead of through a blocked redirect", async () => {
    const client = createClient();
    const beginOidcSignIn = spyOnBeginOidc(client);
    const deploymentId = createId("deployment");
    const select = vi.fn(async () => undefined);
    const navigate = vi.fn();

    await expect(
      startHostOidcSignIn({
        deploymentId,
        desktopBridge: { select },
        hostClient: client,
        navigate,
        oauthQuery: null,
        providerId: "opensteer-account",
      }),
    ).resolves.toBe(false);

    expect(select).toHaveBeenCalledWith({ deploymentId });
    expect(beginOidcSignIn).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("keeps the browser redirect when no Desktop bridge is present", async () => {
    const client = createClient();
    const beginOidcSignIn = spyOnBeginOidc(client).mockResolvedValue(
      rpcSuccess({ redirectUrl: "https://host.opensteer.test/authorize" }),
    );
    const navigate = vi.fn();

    await expect(
      startHostOidcSignIn({
        deploymentId: null,
        desktopBridge: null,
        hostClient: client,
        navigate,
        oauthQuery: "state=abc",
        providerId: "opensteer-account",
      }),
    ).resolves.toBe(true);

    expect(beginOidcSignIn).toHaveBeenCalledWith({
      oauthQuery: "state=abc",
      providerId: "opensteer-account",
      returnPath: "/",
    });
    expect(navigate).toHaveBeenCalledWith("https://host.opensteer.test/authorize");
  });
});

function createClient(): MockHostClient {
  const client = new MockHostClient({ latencyMs: 0 });
  snapshot = {
    ...client.getSnapshot(),
    identityConfig,
    session: "authentication-required",
    user: null,
  };
  return client;
}

function spyOnBeginOidc(client: MockHostClient) {
  const mock = vi.fn(client.rpc["auth.oidc.begin"]);
  Object.defineProperty(client.rpc, "auth.oidc.begin", { configurable: true, value: mock });
  return mock;
}

function renderApp(client: MockHostClient): string {
  hooks.beginRender();
  return renderToStaticMarkup(<App hostClient={client} />);
}

async function runEffectsTwice(): Promise<void> {
  for (const effect of hooks.takeEffects()) {
    effect();
    effect();
  }
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function installWindow(marker?: string) {
  const values = new Map<string, string>();
  if (marker !== undefined) values.set("opensteer.oidc.auto-attempt", marker);
  const assign = vi.fn();
  vi.stubGlobal("window", {
    history: { replaceState: vi.fn() },
    location: {
      assign,
      hash: "",
      pathname: "/",
      replace: vi.fn(),
      search: "",
    },
    sessionStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  return { assign, values };
}
