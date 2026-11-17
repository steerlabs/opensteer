import { createId, type Request } from "@opensteer/core";
import { expect, it } from "vitest";
import {
  savedLoginAgentResult,
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
