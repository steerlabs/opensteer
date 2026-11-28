import { createId } from "@opensteer/core";
import { expect, it, vi } from "vitest";
import type { ConnectionCaller } from "../agent-caller.js";
import { SessionPersonTools } from "./session-person.js";

it("refuses saved_login_request without tabId as bad_request before querying sessions or tabs", async () => {
  const selectFrom = vi.fn();
  const connectionTab = vi.fn();
  const tools = new SessionPersonTools({
    sessions: {} as never,
    browser: { signInTarget: vi.fn() },
    tabs: { connectionTab },
    logins: { useSessionCredential: vi.fn(), replaySessionCredential: vi.fn() },
    store: { database: { selectFrom } } as never,
  });
  const caller = {
    kind: "connection",
    key: "connection:test",
    userId: createId("user"),
    connectionId: "agc_test",
    grant: { scope: "everything" },
    grantRevision: 1,
    accessMode: "full-access",
  } as unknown as ConnectionCaller;

  await expect(
    tools.credentials(
      {
        caller,
        input: { site: "example.com", reason: "Sign in" },
        operationKey: "k",
      } as never,
      "login",
    ),
  ).rejects.toMatchObject({ code: "bad_request" });
  expect(selectFrom).not.toHaveBeenCalled();
  expect(connectionTab).not.toHaveBeenCalled();
});
