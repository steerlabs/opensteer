import { describe, expect, test } from "vitest";

import { createPageRef } from "../../packages/browser-core/src/index.js";
import {
  assertAllowedCdpMethod,
  PAGE_CDP_METHOD_ALLOWLIST,
} from "../../packages/engine-abp/src/cdp-transport.js";
import { AbpApiError, normalizeAbpError } from "../../packages/engine-abp/src/errors.js";
import { assertUtf8RequestBody } from "../../packages/engine-abp/src/rest-client.js";
import {
  chooseNextActivePageRef,
  shouldClaimBootstrapTab,
  shouldParkPageAsBootstrap,
} from "../../packages/engine-abp/src/session-model.js";

describe("engine-abp internals", () => {
  test("enforces the read-only page CDP allowlist", () => {
    expect(() => assertAllowedCdpMethod("Page.enable", PAGE_CDP_METHOD_ALLOWLIST)).not.toThrow();

    try {
      assertAllowedCdpMethod("Runtime.evaluate", PAGE_CDP_METHOD_ALLOWLIST);
      throw new Error("expected Runtime.evaluate to be rejected");
    } catch (error) {
      expect(error).toMatchObject({
        code: "operation-failed",
      });
    }
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
    try {
      assertUtf8RequestBody(new Uint8Array([0xff, 0xfe, 0xfd]));
      throw new Error("expected binary request body to be rejected");
    } catch (error) {
      expect(error).toMatchObject({
        code: "unsupported-capability",
      });
    }

    expect(assertUtf8RequestBody(new TextEncoder().encode("hello"))).toBe("hello");
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
});
