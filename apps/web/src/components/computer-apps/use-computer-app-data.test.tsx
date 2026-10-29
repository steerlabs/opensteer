// @vitest-environment happy-dom

import { unwrapRpcResult, type HostClient } from "@opensteer/client/host";
import { MockHostClient } from "@opensteer/client/mock";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useComputerAppData } from "./computer-apps-section.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

type Platform = Awaited<ReturnType<HostClient["rpc"]["integration.platform.get"]>>;

function Probe({
  client,
  revision,
  onReady,
}: {
  readonly client: HostClient;
  readonly revision: number;
  readonly onReady: (reload: () => Promise<void>) => void;
}) {
  const { data, error, reload } = useComputerAppData(client, revision);
  useEffect(() => onReady(reload), [onReady, reload]);
  return (
    <>
      <output>{data ? data.definitions.map(({ id }) => id).join(",") : "Loading"}</output>
      <p role="alert">{error}</p>
      <button onClick={() => void reload().catch(() => undefined)} type="button">
        Reload
      </button>
    </>
  );
}

function mockPlatform(client: HostClient) {
  const mock = vi.fn(client.rpc["integration.platform.get"]);
  Object.defineProperty(client.rpc, "integration.platform.get", {
    configurable: true,
    value: mock,
  });
  return mock;
}

async function mount(client: HostClient) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  let reload = async () => {};
  const onReady = (next: () => Promise<void>) => {
    reload = next;
  };
  async function render(nextClient: HostClient, revision = 0) {
    await act(async () =>
      root.render(<Probe client={nextClient} onReady={onReady} revision={revision} />),
    );
  }
  await render(client);
  return { container, render, getReload: () => reload };
}

describe("computer app data refresh", () => {
  it("does not let an older refresh overwrite the post-change result", async () => {
    const client = new MockHostClient({ latencyMs: 0 });
    const platform = await client.rpc["integration.platform.get"]({});
    expect(unwrapRpcResult(platform).catalog.length).toBeGreaterThan(0);
    const older = Promise.withResolvers<Platform>();
    mockPlatform(client)
      .mockImplementationOnce(() => older.promise)
      .mockResolvedValueOnce({ ok: true, data: { ...unwrapRpcResult(platform), catalog: [] } });
    const { container, render } = await mount(client);
    await render(client, 1);
    expect(container.querySelector("output")?.textContent).toBe("");
    await act(async () => older.resolve(platform));
    expect(container.querySelector("output")?.textContent).toBe("");
  });

  it("clears a failed refresh after a successful retry", async () => {
    const client = new MockHostClient({ latencyMs: 0 });
    const platform = await client.rpc["integration.platform.get"]({});
    mockPlatform(client)
      .mockRejectedValueOnce(new Error("Computer apps could not be loaded."))
      .mockResolvedValueOnce(platform);
    const { container } = await mount(client);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("could not be loaded");
    await act(async () => container.querySelector("button")?.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("");
    expect(container.querySelector("output")?.textContent).not.toBe("Loading");
  });

  it("never presents data from the previous Host while the next one loads", async () => {
    const previous = new MockHostClient({ latencyMs: 0 });
    const next = new MockHostClient({ latencyMs: 0 });
    const platform = await next.rpc["integration.platform.get"]({});
    const pending = Promise.withResolvers<Platform>();
    mockPlatform(next).mockImplementationOnce(() => pending.promise);
    const { container, render } = await mount(previous);
    expect(container.querySelector("output")?.textContent).not.toBe("Loading");
    await render(next);
    expect(container.querySelector("output")?.textContent).toBe("Loading");
    await act(async () =>
      pending.resolve({ ok: true, data: { ...unwrapRpcResult(platform), catalog: [] } }),
    );
    expect(container.querySelector("output")?.textContent).toBe("");
  });

  it("ignores a completed mutation's reload callback after leaving its Host", async () => {
    const previous = new MockHostClient({ latencyMs: 0 });
    const next = new MockHostClient({ latencyMs: 0 });
    const platform = await next.rpc["integration.platform.get"]({});
    const previousLoad = mockPlatform(previous);
    const pending = Promise.withResolvers<Platform>();
    mockPlatform(next).mockImplementationOnce(() => pending.promise);
    const { container, render, getReload } = await mount(previous);
    const staleReload = getReload();
    await render(next);
    await act(async () => staleReload());
    expect(previousLoad).toHaveBeenCalledTimes(1);
    await act(async () =>
      pending.resolve({ ok: true, data: { ...unwrapRpcResult(platform), catalog: [] } }),
    );
    expect(container.querySelector("output")?.textContent).toBe("");
  });
});
