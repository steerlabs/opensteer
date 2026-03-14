import { afterEach, describe, expect, test, vi } from "vitest";

import { createPageRef } from "../../packages/browser-core/src/index.js";
import { buildSelectChooserOptions } from "../../packages/engine-abp/src/action-events.js";
import {
  assertAllowedCdpMethod,
  PAGE_CDP_METHOD_ALLOWLIST,
} from "../../packages/engine-abp/src/cdp-transport.js";
import { AbpApiError, normalizeAbpError } from "../../packages/engine-abp/src/errors.js";
import { buildAbpLaunchCommand } from "../../packages/engine-abp/src/launcher.js";
import { AbpRestClient, assertUtf8RequestBody } from "../../packages/engine-abp/src/rest-client.js";
import {
  chooseNextActivePageRef,
  resolveTabOpeners,
  shouldClaimBootstrapTab,
  shouldParkPageAsBootstrap,
} from "../../packages/engine-abp/src/session-model.js";

function expectThrownCode(fn: () => unknown, code: string): void {
  let error: unknown;
  try {
    fn();
  } catch (caught) {
    error = caught;
  }

  expect(error).toMatchObject({ code });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("engine-abp internals", () => {
  test("enforces the read-only page CDP allowlist", () => {
    expect(() => assertAllowedCdpMethod("Page.enable", PAGE_CDP_METHOD_ALLOWLIST)).not.toThrow();
    expectThrownCode(
      () => assertAllowedCdpMethod("Runtime.evaluate", PAGE_CDP_METHOD_ALLOWLIST),
      "operation-failed",
    );
  });

  test("normalizes ABP HTTP errors into browser-core errors", () => {
    const pageRef = createPageRef("abp-test-page");
    expect(normalizeAbpError(new AbpApiError(408, "request timed out", {}), pageRef)).toMatchObject(
      {
        code: "timeout",
      },
    );
    expect(normalizeAbpError(new AbpApiError(404, "missing", {}), pageRef)).toMatchObject({
      code: "page-closed",
    });
    expect(normalizeAbpError(new AbpApiError(500, "boom", {}), pageRef)).toMatchObject({
      code: "operation-failed",
    });
  });

  test("rejects binary session HTTP request bodies", () => {
    expectThrownCode(
      () => assertUtf8RequestBody(new Uint8Array([0xff, 0xfe, 0xfd])),
      "unsupported-capability",
    );
    expect(assertUtf8RequestBody(new TextEncoder().encode("hello"))).toBe("hello");
  });

  test("normalizes ABP wire responses at the REST boundary", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            requests: [{ request_id: "req-1", url: "https://example.com", method: "GET" }],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status_code: 204,
            headers: { "content-type": "application/octet-stream" },
            body: "aGVsbG8=",
            body_is_base64: true,
            final_url: "https://example.com/final",
            redirected: true,
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );

    const client = new AbpRestClient("http://127.0.0.1:9222/api/v1");
    await expect(client.queryNetwork({ includeBodies: false })).resolves.toEqual([
      {
        request_id: "req-1",
        url: "https://example.com",
        method: "GET",
      },
    ]);
    await expect(
      client.curlTab("tab-1", {
        url: "https://example.com",
        method: "GET",
      }),
    ).resolves.toEqual({
      status: 204,
      headers: { "content-type": "application/octet-stream" },
      body: "aGVsbG8=",
      bodyEncoding: "base64",
      url: "https://example.com/final",
      redirected: true,
    });
  });

  test("rejects malformed ABP network responses instead of assuming wrapper fields", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ calls: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const client = new AbpRestClient("http://127.0.0.1:9222/api/v1");
    await expect(client.queryNetwork({ includeBodies: false })).rejects.toMatchObject({
      code: "operation-failed",
    });
  });

  test("models bootstrap-tab claiming and parking explicitly", () => {
    const openerPageRef = createPageRef("popup-opener");
    expect(shouldClaimBootstrapTab("tab-1", undefined)).toBe(true);
    expect(shouldClaimBootstrapTab("tab-1", openerPageRef)).toBe(false);
    expect(
      shouldParkPageAsBootstrap({
        launchOwned: true,
        remainingLogicalPages: 0,
      }),
    ).toBe(true);
    expect(
      shouldParkPageAsBootstrap({
        launchOwned: true,
        remainingLogicalPages: 1,
      }),
    ).toBe(false);
  });

  test("chooses the next active page deterministically", () => {
    const first = createPageRef("first");
    const second = createPageRef("second");

    expect(chooseNextActivePageRef([first, second], second)).toBe(second);
    expect(chooseNextActivePageRef([first, second], createPageRef("third"))).toBe(first);
    expect(chooseNextActivePageRef([])).toBeUndefined();
  });

  test("resolves opener relationships after adopted pages are registered", () => {
    const openerPageRef = createPageRef("opener");
    const popupPageRef = createPageRef("popup");
    const openerByTabId = resolveTabOpeners(
      [
        {
          targetId: "tab-1",
          type: "page",
          title: "Opener",
          url: "https://example.com",
          attached: true,
        },
        {
          targetId: "tab-2",
          type: "page",
          title: "Popup",
          url: "https://example.com/popup",
          attached: true,
          openerId: "tab-1",
        },
      ],
      new Map([
        ["tab-1", openerPageRef],
        ["tab-2", popupPageRef],
      ]),
    );

    expect(openerByTabId.get("tab-2")).toBe(openerPageRef);
  });

  test("maps ABP select popup items into chooser options", () => {
    expect(
      buildSelectChooserOptions(
        [
          { index: 0, type: "option", label: "Alpha", checked: false },
          { index: 1, type: "separator", label: "---" },
          { index: 2, type: "checkable_option", label: "Beta", checked: true },
          { index: 3, type: "option", tool_tip: "Gamma" },
        ],
        0,
      ),
    ).toEqual([
      {
        index: 0,
        label: "Alpha",
        value: "Alpha",
        selected: true,
      },
      {
        index: 2,
        label: "Beta",
        value: "Beta",
        selected: true,
      },
      {
        index: 3,
        label: "Gamma",
        value: "Gamma",
        selected: false,
      },
    ]);
  });

  test("builds distinct launch commands for the wrapper and browser-binary modes", () => {
    expect(
      buildAbpLaunchCommand({
        port: 8222,
        userDataDir: "/tmp/opensteer-user-data",
        sessionDir: "/tmp/opensteer-session",
        headless: true,
        args: ["--remote-debugging-port=0"],
        verbose: false,
      }),
    ).toEqual({
      executablePath: "agent-browser-protocol",
      args: [
        "--port",
        "8222",
        "--headless",
        "--user-data-dir",
        "/tmp/opensteer-user-data",
        "--session-dir",
        "/tmp/opensteer-session",
        "--",
        "--remote-debugging-port=0",
      ],
    });

    expect(
      buildAbpLaunchCommand({
        port: 8222,
        userDataDir: "/tmp/opensteer-user-data",
        sessionDir: "/tmp/opensteer-session",
        executablePath: "/Applications/ABP.app/Contents/MacOS/ABP",
        headless: true,
        args: ["--remote-debugging-port=0"],
        verbose: false,
      }),
    ).toEqual({
      executablePath: "/Applications/ABP.app/Contents/MacOS/ABP",
      args: [
        "--abp-port=8222",
        "--use-mock-keychain",
        "--headless=new",
        "--user-data-dir=/tmp/opensteer-user-data",
        "--abp-session-dir=/tmp/opensteer-session",
        "--remote-debugging-port=0",
      ],
    });
  });
});
