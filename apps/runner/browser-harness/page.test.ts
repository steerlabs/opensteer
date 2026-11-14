import { expect, it, vi } from "vitest";
// @ts-expect-error The standalone Harness runs directly as JavaScript.
import { createPage } from "./page.mjs";

it("awaits a failed lookup's release after CDP answers beyond the action deadline", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const query = Promise.withResolvers<{ nodes: unknown[] }>();
  const release = Promise.withResolvers<void>();
  const methods: string[] = [];
  const harness = createPage({
    bind: async () => ({ sessionId: "session" }),
    command: async (method: string) => {
      methods.push(method);
      if (method === "Runtime.evaluate") return { result: { objectId: "document" } };
      if (method === "Accessibility.queryAXTree") return query.promise;
      if (method === "Runtime.releaseObjectGroup") return release.promise;
      throw new Error(`Unexpected CDP command: ${method}`);
    },
  });
  let leaving: Promise<void> | undefined;
  try {
    const failed = harness.page
      .getByRole("button", { name: "Missing action" })
      .click({ timeout: 300 })
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(methods).toContain("Accessibility.queryAXTree");
    await vi.advanceTimersByTimeAsync(300);
    expect(methods, "The action never reached release at its 300 ms deadline").toContain(
      "Runtime.releaseObjectGroup",
    );
    expect(await failed).toMatchObject({
      message:
        'page.getByRole("button", {"name":"Missing action"}).click(): Timeout 300ms: waiting for CDP Accessibility.queryAXTree',
    });
    query.resolve({ nodes: [] });
    await vi.advanceTimersByTimeAsync(0);
    let settled = false;
    leaving = harness
      .settleInput("session", { open: () => null, onChange: () => () => {} })
      .then(() => {
        settled = true;
      });
    await vi.advanceTimersByTimeAsync(2_001);
    expect(settled, "A responsive page must acknowledge its release before leaving").toBe(false);
    release.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(settled, "Release acknowledgement never unblocked the departing session").toBe(true);
    expect(methods.filter((method) => method.startsWith("Input."))).toEqual([]);
    expect(methods.filter((method) => method === "Runtime.releaseObjectGroup")).toHaveLength(1);
  } finally {
    query.resolve({ nodes: [] });
    release.resolve();
    await leaving;
    vi.useRealTimers();
  }
});
