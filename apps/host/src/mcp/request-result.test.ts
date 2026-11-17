import { createId, type Request } from "@opensteer/core";
import { expect, it } from "vitest";
import {
  card_request,
  chrome_cookies_request,
  saved_login_request,
} from "@opensteer/agent-tools/tools";
import {
  savedLoginAgentResult,
  cardAgentResult,
  chromeCookiesAgentResult,
} from "../browser/agent-request-results.js";
import { requestResult } from "./request-result.js";

it("preserves persisted request identity and status independently of credential availability", () => {
  for (const status of ["pending", "fulfilled", "declined", "withdrawn", "cancelled"] as const) {
    const request = {
      id: createId("request"),
      kind: "browser.password-sign-in",
      status,
    } as Request;
    expect(
      savedLoginAgentResult(
        { status: "unavailable", site: "https://example.com", reason: "expired" },
        request,
      ),
    ).toMatchObject({
      requestId: request.id,
      kind: request.kind,
      status,
      loginStatus: "unavailable",
      reason: "expired",
    });
    expect(requestResult({ ...request, kind: "person.question" }, "Continue").kind).toBe(
      "person.question",
    );
  }
});
it("reports direct cookie delivery without inventing a Request", () => {
  expect(
    chromeCookiesAgentResult(
      { status: "copied", site: "https://example.com", sourceName: "Chrome", profileName: null },
      null,
    ),
  ).toMatchObject({
    requestId: null,
    kind: "browser.sign-in",
    status: "fulfilled",
    cookiesStatus: "copied",
    next: expect.stringContaining("reload"),
  });
});

const site = "https://example.com";
const unavailable = { status: "unavailable", site, reason: "unsupported" } as const;

it.each([
  [saved_login_request, savedLoginAgentResult, "loginStatus"],
  [card_request, cardAgentResult, "cardStatus"],
  [chrome_cookies_request, chromeCookiesAgentResult, "cookiesStatus"],
] as const)("reports %s unavailable without inventing fulfillment", (tool, result, field) => {
  const output = result(unavailable, null);
  expect(output).toMatchObject({
    requestId: null,
    status: "blocked",
    [field]: "unavailable",
    reason: "unsupported",
  });
  expect(tool.output.safeParse(output).success).toBe(true);
  expect(tool.output.safeParse({ ...output, status: "fulfilled" }).success).toBe(false);
});

it("distinguishes a ready card from delegated approval and a remembered decline", () => {
  const ready = cardAgentResult(
    { status: "ready", site, cardRef: `crd_${"a".repeat(32)}`, brand: "Visa", lastFour: "4242" },
    null,
  );
  expect(ready).toMatchObject({ requestId: null, status: "fulfilled", cardStatus: "ready" });
  expect(card_request.output.safeParse(ready).success).toBe(true);
  for (const status of ["needs-approval", "declined"] as const) {
    const blocked = cardAgentResult({ status, site }, null);
    expect(blocked).toMatchObject({ requestId: null, status: "blocked", cardStatus: status });
    expect(card_request.output.safeParse(blocked).success).toBe(true);
    expect(card_request.output.safeParse({ ...ready, cardStatus: status }).success).toBe(false);
  }
  expect(
    card_request.output.safeParse({
      ...ready,
      requestId: createId("request"),
      status: "pending",
      cardStatus: "pending",
    }).success,
  ).toBe(false);
});

it("preserves credential pending when approval settles before the handler reads its Request", () => {
  const request = {
    id: createId("request"),
    kind: "browser.password-sign-in",
    status: "fulfilled",
  } as Request;
  const result = { status: "pending", requestId: request.id, site, replayed: false } as const;
  for (const [tool, output, field] of [
    [saved_login_request, savedLoginAgentResult(result, request), "loginStatus"],
    [card_request, cardAgentResult(result, request), "cardStatus"],
    [
      chrome_cookies_request,
      chromeCookiesAgentResult(result, { ...request, kind: "browser.sign-in" }),
      "cookiesStatus",
    ],
  ] as const) {
    expect(output).toMatchObject({
      requestId: request.id,
      status: "fulfilled",
      [field]: "pending",
    });
    expect(tool.output.safeParse(output).success).toBe(true);
  }
});
