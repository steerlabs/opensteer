// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { Request } from "@opensteer/core";
import { ThreadBrowserRequestAction } from "./thread-browser-access-action.js";

const shell = vi.hoisted(() => ({
  hostClient: {
    // Connected: the answer goes out rather than being held as not sent.
    connection: {
      getSnapshot: () => ({
        phase: "ready",
        network: "online",
        scope: {
          authorityKey: "host",
          deploymentId: "deployment",
          viewerId: "viewer",
          loginId: "login",
        },
        readyRevision: 1,
        showInterruption: false,
        issue: null,
        trying: false,
      }),
      subscribe: () => () => undefined,
      retry: () => undefined,
    },
    dispatch: vi.fn(),
  },
  reportActionError: vi.fn(),
  snapshot: {
    browserProfiles: [{ id: "personal", name: "Personal", revision: 1 }],
  },
}));
vi.mock("./app-shell.js", () => ({ useShell: () => shell }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  vi.clearAllMocks();
});

it("keeps a failed approval beside the selected profile and retries without an extra error banner", async () => {
  shell.hostClient.dispatch.mockRejectedValueOnce(new Error("Connection interrupted. Try again."));
  shell.hostClient.dispatch.mockResolvedValue({ type: "request.respond" });
  const container = document.createElement("div");
  root = createRoot(container);
  const request = {
    id: "request",
    reviewedRevision: "17",
    payload: { kind: "browser.access", suggestion: { kind: "existing", profileId: "personal" } },
  } as unknown as Request;
  await act(async () => root?.render(<ThreadBrowserRequestAction request={request} />));
  const selected = () => container.querySelector<HTMLInputElement>('input[type="radio"]:checked');
  const submit = () => {
    const button = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Use profile",
    );
    if (!button) throw new Error("Missing Use profile button");
    return button;
  };
  expect(selected()).not.toBeNull();
  await act(async () => submit().click());
  // A lost answer is said honestly, never in the exception's own words.
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "Couldn't confirm your answer was sent.",
  );
  expect(selected()).not.toBeNull();
  expect(shell.reportActionError).not.toHaveBeenCalled();
  await act(async () => submit().click());
  expect(shell.hostClient.dispatch).toHaveBeenCalledTimes(2);
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(
    [...container.querySelectorAll("input, button")].every((element) =>
      element.hasAttribute("disabled"),
    ),
  ).toBe(true);
});
