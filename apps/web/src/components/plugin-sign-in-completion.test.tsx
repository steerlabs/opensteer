// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { HostClient } from "@opensteer/client/host";
import type { PluginOAuthStatus } from "@opensteer/client/plugins";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const waitForPluginAuthorization = vi.hoisted(() => vi.fn());

vi.mock("@opensteer/client/plugins", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@opensteer/client/plugins")>()),
  waitForPluginAuthorization,
}));

import { PluginSignInCompletion } from "./plugin-sign-in-completion.js";

const attemptId = "ioa_00000000-0000-4000-8000-000000000001";
const client = { rpc: {} } as Pick<HostClient, "rpc">;
const roots: Root[] = [];

beforeEach(() => {
  waitForPluginAuthorization.mockReset();
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  vi.useRealTimers();
});

describe("PluginSignInCompletion", () => {
  it("waits quietly while the source tab creates the authorization attempt", async () => {
    const container = await render(null);

    expect(container.textContent).toContain("Opening authorization…");
    expect(waitForPluginAuthorization).not.toHaveBeenCalled();
  });

  it("stops waiting for a source tab that never starts an attempt", async () => {
    vi.useFakeTimers();
    const container = await render(null);

    await act(async () => vi.advanceTimersByTimeAsync(45_000));

    expect(container.textContent).toContain("Authorization didn’t open");
    expect(container.textContent).toContain("Return to your original Opensteer tab and try again.");
    expect(container.textContent).toContain("did not cancel an authorization");
    expect(waitForPluginAuthorization).not.toHaveBeenCalled();
  });

  it("clears the opening timeout when the page unmounts", async () => {
    vi.useFakeTimers();
    await render(null);
    expect(vi.getTimerCount()).toBe(1);

    const root = roots.pop();
    act(() => root?.unmount());

    expect(vi.getTimerCount()).toBe(0);
  });

  it("shows completion only after the authenticated Host reports completed", async () => {
    const result = deferred<PluginOAuthStatus>();
    waitForPluginAuthorization.mockReturnValue(result.promise);
    const container = await render(attemptId);

    expect(container.textContent).toContain("Finishing authorization…");
    expect(container.textContent).not.toContain("Account authorization complete");

    await act(async () => result.resolve(status("completed")));

    expect(container.textContent).toContain("Account authorization complete");
    expect(container.textContent).toContain("The account is linked.");
    expect(container.textContent).toContain("You can close this tab.");
  });

  it("says how a sign-in ended that did not complete", async () => {
    waitForPluginAuthorization.mockResolvedValue(status("denied"));
    const container = await render(attemptId);

    expect(container.textContent).toContain("Authorization wasn’t completed");
    expect(container.textContent).toContain("You didn't approve access at the service.");
    expect(container.textContent).not.toContain("Try again");
  });

  it("retries a failed status read for the same attempt", async () => {
    waitForPluginAuthorization
      .mockRejectedValueOnce(new Error("The Host is unreachable."))
      .mockResolvedValueOnce(status("completed"));
    const container = await render(attemptId);

    expect(container.textContent).toContain("We couldn’t check the authorization");
    expect(container.textContent).toContain("Couldn't load authorization status.");

    const retry = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Try again",
    );
    expect(retry).toBeDefined();
    await act(async () => retry?.click());

    expect(container.textContent).toContain("Account authorization complete");
    expect(waitForPluginAuthorization).toHaveBeenCalledTimes(2);
    expect(waitForPluginAuthorization.mock.calls[0]?.[0]).toMatchObject({ attemptId });
    expect(waitForPluginAuthorization.mock.calls[1]?.[0]).toMatchObject({ attemptId });
  });

  it("does not ask the Host about an invalid callback identifier", async () => {
    const container = await render("not-an-attempt");

    expect(container.textContent).toContain("This authorization link is invalid");
    expect(waitForPluginAuthorization).not.toHaveBeenCalled();
  });
});

async function render(integrationAttempt: string | null): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(<PluginSignInCompletion client={client} integrationAttempt={integrationAttempt} />);
  });
  return container;
}

function status(value: PluginOAuthStatus["status"]): PluginOAuthStatus {
  return {
    attemptId,
    connection: "con_1",
    account: value === "completed" ? "acc_1" : null,
    expiresAt: "2030-01-01T00:00:00.000Z",
    failureCode: null,
    status: value,
  } as PluginOAuthStatus;
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
