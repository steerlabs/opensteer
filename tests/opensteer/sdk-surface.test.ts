import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const runtimeState = vi.hoisted(() => {
  const ownedRuntime = {
    open: vi.fn(async (input = {}) => ({
      sessionRef: "session:test",
      pageRef: "page:test",
      url: (input as { readonly url?: string }).url ?? "about:blank",
      title: "Owned Runtime",
    })),
    close: vi.fn(async () => ({ closed: true })),
  };
  const attachedRuntime = {
    open: vi.fn(async (input = {}) => ({
      sessionRef: "session:attached",
      pageRef: "page:attached",
      url: (input as { readonly url?: string }).url ?? "about:blank",
      title: "Attached Runtime",
    })),
    close: vi.fn(async () => ({ closed: true })),
    disconnect: vi.fn(async () => undefined),
  };

  return {
    ownedRuntime,
    attachedRuntime,
    createRuntime: vi.fn(() => ownedRuntime),
    attachFactory: vi.fn(function (
      options: Record<string, unknown>,
    ) {
      void options;
      return attachedRuntime;
    }),
  };
});

vi.mock("../../packages/opensteer/src/sdk/runtime-resolution.js", () => ({
  createOpensteerSemanticRuntime: runtimeState.createRuntime,
}));

vi.mock("../../packages/opensteer/src/session-service/local-session-proxy.js", () => ({
  LocalOpensteerSessionProxy: runtimeState.attachFactory,
}));

import { Opensteer } from "../../packages/opensteer/src/sdk/opensteer.js";

describe("Opensteer SDK surface", () => {
  beforeEach(() => {
    runtimeState.createRuntime.mockClear();
    runtimeState.attachFactory.mockClear();
    runtimeState.ownedRuntime.open.mockClear();
    runtimeState.ownedRuntime.close.mockClear();
    runtimeState.attachedRuntime.open.mockClear();
    runtimeState.attachedRuntime.close.mockClear();
    runtimeState.attachedRuntime.disconnect.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test("open forwards full session-open input to the owned runtime", async () => {
    const opensteer = new Opensteer({
      name: "sdk-surface-owned",
      rootDir: "/tmp/sdk-surface-owned",
    });

    await opensteer.open({
      url: "https://example.com",
      browser: {
        headless: true,
      },
      context: {
        viewport: {
          width: 960,
          height: 720,
        },
      },
    });

    expect(runtimeState.createRuntime).toHaveBeenCalledTimes(1);
    expect(runtimeState.ownedRuntime.open).toHaveBeenCalledWith({
      url: "https://example.com",
      browser: {
        headless: true,
      },
      context: {
        viewport: {
          width: 960,
          height: 720,
        },
      },
    });
  });

  test("owned disconnect delegates to destructive close", async () => {
    const opensteer = new Opensteer();

    await opensteer.disconnect();

    expect(runtimeState.ownedRuntime.close).toHaveBeenCalledTimes(1);
  });

  test("attach uses the local session proxy and attached disconnect is non-destructive", async () => {
    const opensteer = Opensteer.attach({
      name: "sdk-surface-attached",
      rootDir: "/tmp/sdk-surface-attached",
    });

    expect(runtimeState.attachFactory).toHaveBeenCalledWith({
      name: "sdk-surface-attached",
      rootDir: "/tmp/sdk-surface-attached",
    });

    await expect(
      opensteer.open({
        url: "https://example.com",
        browser: {
          headless: true,
        },
      }),
    ).rejects.toThrow("open() may only receive url when attached");
    expect(runtimeState.attachedRuntime.open).not.toHaveBeenCalled();

    await opensteer.disconnect();
    expect(runtimeState.attachedRuntime.disconnect).toHaveBeenCalledTimes(1);
    expect(runtimeState.attachedRuntime.close).not.toHaveBeenCalled();
  });
});
