import { describe, expect, it } from "vitest";
import {
  shareFailure,
  tailscaleHandoffMilliseconds,
  TailscaleCommandError,
  TailscaleShare,
  type TailscaleCommand,
  type TailscaleServeConfig,
} from "./tailscale.js";

const host = "studio.tail1234.ts.net";
const hostOrigin = "http://127.0.0.1:4100";
const recordPath = "/data/tailscale-share.json";

describe("TailscaleShare", () => {
  it.each([
    { path: "share", applied: false },
    { path: "share", applied: true },
    { path: "ensure", applied: false },
    { path: "ensure", applied: true },
  ])(
    "persists $path re-points before applying (apply then fail: $applied) and recovers both crash targets",
    async ({ path, applied }) => {
      const tailnet = share({ appliedThenFailed: applied });
      tailnet.writeRecord({ origin: `https://${host}`, port: 443, target: hostOrigin });
      tailnet.serve.Web = { [`${host}:443`]: { Handlers: { "/": { Proxy: hostOrigin } } } };
      const nextTarget = "http://127.0.0.1:4200";
      let transition: unknown;
      const survivingHandlers: boolean[] = [];
      tailnet.state.beforeServe = async () => {
        transition = tailnet.record();
        for (const target of [hostOrigin, nextTarget, "http://127.0.0.1:9999"]) {
          tailnet.serve.Web = { [`${host}:443`]: { Handlers: { "/": { Proxy: target } } } };
          await tailnet.restart().stop();
          survivingHandlers.push(tailnet.serve.Web?.[`${host}:443`] !== undefined);
        }
      };
      if (path === "share") {
        expect(await tailnet.tailscale.share(nextTarget)).toMatchObject({ ok: !applied });
      } else {
        const result = tailnet.tailscale.reconcile({
          authoritative: false,
          hostOrigin: nextTarget,
          routeOrigin: `https://${host}`,
        });
        if (applied) await expect(result).rejects.toThrow("timed out");
        else await result;
      }
      expect(transition).toMatchObject({ target: nextTarget, previousTarget: hostOrigin });
      expect(survivingHandlers).toEqual([false, false, true]);
      if (!applied)
        expect(tailnet.record()).toEqual({
          origin: `https://${host}`,
          port: 443,
          schemaVersion: 1,
          target: nextTarget,
        });
      await tailnet
        .restart()
        .reconcile({ authoritative: false, hostOrigin: nextTarget, routeOrigin: null });
      expect(tailnet.serve.Web?.[`${host}:443`]).toBeUndefined();
      expect(tailnet.record()).toBeNull();
    },
  );

  it("does not adopt a foreign handler just because it matches the moved Host port", async () => {
    const tailnet = share();
    tailnet.writeRecord({ origin: `https://${host}`, port: 443, target: hostOrigin });
    const target = "http://127.0.0.1:9999";
    tailnet.serve.Web = { [`${host}:443`]: { Handlers: { "/": { Proxy: target } } } };
    await tailnet.tailscale.reconcile({
      authoritative: false,
      hostOrigin: target,
      routeOrigin: `https://${host}`,
    });
    await tailnet
      .restart()
      .reconcile({ authoritative: true, hostOrigin: target, routeOrigin: null });
    expect(tailnet.serve.Web?.[`${host}:443`]).toEqual({ Handlers: { "/": { Proxy: target } } });
  });

  it("reports whether Tailscale is installed, signed in, and still serving what Opensteer shared", async () => {
    expect(await share({ installed: false }).tailscale.status()).toEqual({
      state: "not-installed",
    });
    expect(await share({ platform: "win32" }).tailscale.status()).toEqual({
      state: "not-installed",
    });
    expect(await share({ backend: "NeedsLogin" }).tailscale.status()).toEqual({
      state: "not-running",
    });
    expect(await share({ daemonDown: true }).tailscale.status()).toEqual({
      state: "not-running",
    });

    const tailnet = share();
    expect(await tailnet.tailscale.status()).toEqual({
      dnsName: host,
      sharedOrigin: null,
      state: "ready",
    });
    await tailnet.tailscale.share(hostOrigin);
    expect(await tailnet.tailscale.status()).toMatchObject({ sharedOrigin: `https://${host}` });
    // Someone pointed the port elsewhere: it is no longer what Opensteer shared.
    tailnet.serve.Web![`${host}:443`] = { Handlers: { "/": { Proxy: "http://127.0.0.1:9999" } } };
    expect(await tailnet.tailscale.status()).toMatchObject({ sharedOrigin: null });
  });

  it("takes 443, else 8443, around anything else served or funneled, and never Funnel itself", async () => {
    const free = share();
    expect(await free.tailscale.share(hostOrigin)).toEqual({
      ok: true,
      origin: `https://${host}`,
    });
    expect(free.calls.at(-1)).toEqual(["serve", "--bg", "--https=443", "http://127.0.0.1:4100"]);
    expect(free.record()).toEqual({
      origin: `https://${host}`,
      port: 443,
      schemaVersion: 1,
      target: "http://127.0.0.1:4100",
    });

    const theirs = share({
      serve: {
        Web: { [`${host}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } } },
      },
    });
    expect(await theirs.tailscale.share(hostOrigin)).toEqual({
      ok: true,
      origin: `https://${host}:8443`,
    });
    expect(theirs.serve.Web![`${host}:443`]).toEqual({
      Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } },
    });

    const busy = share({
      serve: {
        Foreground: { session: { TCP: { "8443": { HTTPS: true } } } },
        TCP: { "443": { TCPForward: "127.0.0.1:22" } },
      },
    });
    expect(await busy.tailscale.share(hostOrigin)).toMatchObject({
      ok: false,
      reason: "ports-busy",
    });
    expect(busy.calls.some((args) => args.includes("--bg"))).toBe(false);
    expect(busy.record()).toBeNull();

    expect(free.calls.flat().some((argument) => /funnel/iu.test(argument))).toBe(false);
  });

  it("re-points its own handler on its own port rather than taking another", async () => {
    const tailnet = share();
    tailnet.serve.TCP = { "8443": { HTTPS: true } };
    tailnet.serve.Web = {
      [`${host}:8443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:4000" } } },
    };
    tailnet.writeRecord({
      origin: `https://${host}:8443`,
      port: 8443,
      target: "http://127.0.0.1:4000",
    });

    expect(await tailnet.tailscale.share(hostOrigin)).toEqual({
      ok: true,
      origin: `https://${host}:8443`,
    });
    expect(tailnet.serve.Web[`${host}:8443`]).toEqual({
      Handlers: { "/": { Proxy: "http://127.0.0.1:4100" } },
    });
    expect(tailnet.serve.Web[`${host}:443`]).toBeUndefined();
    expect(tailnet.record()).toMatchObject({ port: 8443, target: "http://127.0.0.1:4100" });
  });

  it("says what to fix when Tailscale refuses, and keeps no record of a handler it never made", async () => {
    const disabled = share({
      serveFailure: {
        stderr: "",
        stdout:
          "Serve is not enabled on your tailnet.\nTo enable, visit:\n\n  https://login.tailscale.com/f/serve?node=n1\n",
      },
    });
    expect(await disabled.tailscale.share(hostOrigin)).toEqual({
      message: "Turn on HTTPS certificates in your Tailscale admin console, then try again.",
      ok: false,
      reason: "https-disabled",
    });
    expect(disabled.record()).toBeNull();

    expect(shareFailure({ stderr: "error: not logged in", stdout: "" })).toMatchObject({
      reason: "not-running",
    });
    expect(
      shareFailure({ stderr: "Access denied: serve config denied", stdout: "" }),
    ).toMatchObject({ reason: "failed" });
    expect(await share({ installed: false }).tailscale.share(hostOrigin)).toMatchObject({
      reason: "not-installed",
    });
  });

  it("keeps its handler exactly while the Host's Private route is its origin, at the Host's current port", async () => {
    const tailnet = share();
    await tailnet.tailscale.share(hostOrigin);
    const origin = `https://${host}`;

    // The Host was recreated on another port while Opensteer was quit.
    await tailnet.tailscale.stop();
    expect(tailnet.serve.Web?.[`${host}:443`]).toBeUndefined();
    expect(tailnet.record()).not.toBeNull();
    const next = tailnet.restart();
    await next.reconcile({
      authoritative: false,
      hostOrigin: "http://127.0.0.1:4200",
      routeOrigin: origin,
    });
    expect(tailnet.serve.Web?.[`${host}:443`]).toEqual({
      Handlers: { "/": { Proxy: "http://127.0.0.1:4200" } },
    });
    expect(tailnet.record()).toMatchObject({ target: "http://127.0.0.1:4200" });

    // Another device turned Private mode off.
    await next.reconcile({ authoritative: true, hostOrigin, routeOrigin: null });
    expect(tailnet.calls.at(-1)).toEqual(["serve", "--https=443", "off"]);
    expect(tailnet.serve.Web?.[`${host}:443`]).toBeUndefined();
    expect(tailnet.record()).toBeNull();
  });

  it("leaves a handler just shared until the Host's route is chosen, but not past this run", async () => {
    const tailnet = share();
    await tailnet.tailscale.share(hostOrigin);
    // A startup reconcile that lands before the page asks the Host for the route.
    await tailnet.tailscale.reconcile({ authoritative: false, hostOrigin, routeOrigin: null });
    expect(tailnet.serve.Web?.[`${host}:443`]).toBeDefined();
    expect(tailnet.record()).not.toBeNull();

    await tailnet.restart().reconcile({ authoritative: false, hostOrigin, routeOrigin: null });
    expect(tailnet.serve.Web?.[`${host}:443`]).toBeUndefined();
    expect(tailnet.record()).toBeNull();
  });

  it("keeps owning a handler whose command failed after Tailscale applied it", async () => {
    const tailnet = share({ appliedThenFailed: true });
    expect(await tailnet.tailscale.share(hostOrigin)).toMatchObject({ ok: false });
    expect(tailnet.serve.Web?.[`${host}:443`]).toBeDefined();
    expect(tailnet.record()).not.toBeNull();
    // Quitting still takes down what Opensteer made.
    await tailnet.tailscale.stop();
    expect(tailnet.serve.Web?.[`${host}:443`]).toBeUndefined();
  });

  it("takes down a handler shared for setup once its route can no longer be coming", async () => {
    const tailnet = share();
    await tailnet.tailscale.share(hostOrigin);
    // Within the hand-off the page may still be asking the Host for the route.
    await tailnet.tailscale.reconcile({ authoritative: false, hostOrigin, routeOrigin: null });
    expect(tailnet.serve.Web?.[`${host}:443`]).toBeDefined();
    // The page gave up (closed, chose another way, or its request failed).
    tailnet.state.now += tailscaleHandoffMilliseconds;
    await tailnet.tailscale.reconcile({ authoritative: false, hostOrigin, routeOrigin: null });
    expect(tailnet.serve.Web?.[`${host}:443`]).toBeUndefined();
    expect(tailnet.record()).toBeNull();
  });

  it("never touches a handler someone else put in its place, and keeps its record while it cannot look", async () => {
    const replaced = share();
    await replaced.tailscale.share(hostOrigin);
    replaced.serve.Web![`${host}:443`] = { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } };
    await replaced.tailscale.reconcile({ authoritative: true, hostOrigin, routeOrigin: null });
    expect(replaced.calls.some((args) => args.at(-1) === "off")).toBe(false);
    expect(replaced.serve.Web![`${host}:443`]).toEqual({
      Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } },
    });
    expect(replaced.record()).toBeNull();

    const stopped = share();
    await stopped.tailscale.share(hostOrigin);
    stopped.state.backend = "Stopped";
    await stopped.tailscale.reconcile({ authoritative: true, hostOrigin, routeOrigin: null });
    expect(stopped.record()).not.toBeNull();
  });
});

function share(
  options: {
    readonly appliedThenFailed?: boolean;
    readonly backend?: string;
    readonly daemonDown?: boolean;
    readonly installed?: boolean;
    readonly platform?: NodeJS.Platform;
    readonly serve?: TailscaleServeConfig;
    readonly serveFailure?: { readonly stderr: string; readonly stdout: string };
  } = {},
) {
  const state = {
    backend: options.backend ?? "Running",
    now: 1_000_000,
    beforeServe: undefined as (() => Promise<void>) | undefined,
  };
  const serve: { -readonly [Key in keyof TailscaleServeConfig]: TailscaleServeConfig[Key] } =
    structuredClone(options.serve ?? {});
  const files = new Map<string, string>();
  const calls: string[][] = [];
  const command: TailscaleCommand = async (_executable, args) => {
    calls.push([...args]);
    if (options.installed === false)
      throw new TailscaleCommandError({ stderr: "", stdout: "" }, true);
    const joined = args.join(" ");
    if (joined === "status --json") {
      if (options.daemonDown) {
        throw new TailscaleCommandError(
          { stderr: "failed to connect to local tailscaled", stdout: "" },
          false,
        );
      }
      return {
        stderr: "",
        stdout: JSON.stringify({ BackendState: state.backend, Self: { DNSName: `${host}.` } }),
      };
    }
    if (joined === "serve status --json") return { stderr: "", stdout: JSON.stringify(serve) };
    const port = args.find((argument) => argument.startsWith("--https="))?.slice("--https=".length);
    if (args[0] === "serve" && port && args.at(-1) === "off") {
      delete serve.TCP?.[port];
      delete serve.Web?.[`${host}:${port}`];
      return { stderr: "", stdout: "" };
    }
    if (args[0] === "serve" && args[1] === "--bg" && port) {
      await state.beforeServe?.();
      if (options.serveFailure) throw new TailscaleCommandError(options.serveFailure, false);
      serve.TCP = { ...serve.TCP, [port]: { HTTPS: true } };
      serve.Web = {
        ...serve.Web,
        [`${host}:${port}`]: { Handlers: { "/": { Proxy: args.at(-1) } } },
      };
      // The daemon applied it, but the command's answer never came back.
      if (options.appliedThenFailed) throw new Error("Tailscale timed out");
      return { stderr: "", stdout: "" };
    }
    throw new Error(`Unexpected tailscale ${joined}`);
  };
  const create = () =>
    new TailscaleShare({
      command,
      executableExists: async () => true,
      files: {
        readFile: async (path) => {
          const value = files.get(path);
          return value === undefined ? null : new TextEncoder().encode(value);
        },
        removeFile: async (path) => files.delete(path),
        writeFileAtomic: async (path, content) => {
          files.set(
            path,
            typeof content === "string" ? content : new TextDecoder().decode(content),
          );
        },
      },
      now: () => state.now,
      platform: options.platform ?? "darwin",
      recordPath,
    });
  return {
    calls,
    record: () => {
      const value = files.get(recordPath);
      return value === undefined ? null : (JSON.parse(value) as unknown);
    },
    /** The same computer after Opensteer restarts: the record survives, nothing else. */
    restart: create,
    serve,
    state,
    tailscale: create(),
    writeRecord: (record: { origin: string; port: number; target: string }) =>
      files.set(recordPath, JSON.stringify({ ...record, schemaVersion: 1 })),
  };
}
