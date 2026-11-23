// @vitest-environment happy-dom
import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { MockHostClient } from "@opensteer/client/mock";
import type { HostClient } from "@opensteer/client/host";
import { AppsPage } from "./apps-page.js";

const harness = vi.hoisted(() => ({ client: null as unknown as HostClient }));
vi.mock("../app-shell.js", () => ({
  useShell: () => ({
    hostClient: harness.client,
    snapshot: useSyncExternalStore(harness.client.subscribe, harness.client.getSnapshot),
    openMobileNavigation: () => {},
  }),
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
let client: MockHostClient | undefined;
afterEach(() => {
  act(() => root?.unmount());
  client?.dispose();
  document.body.replaceChildren();
});

it("renders every app with its origin chat without rereading the snapshot forever", async () => {
  client = new MockHostClient({ latencyMs: 0 });
  await client.load();
  harness.client = client;
  const errors: unknown[] = [];
  const node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node, { onUncaughtError: (error) => errors.push(error) });
  await act(async () =>
    root!.render(
      <MemoryRouter>
        <AppsPage />
      </MemoryRouter>,
    ),
  );
  await vi.waitFor(
    () => {
      if (errors.length) throw new Error(`The Apps page failed to render: ${String(errors[0])}`);
      expect(node.textContent).toContain("Ferry tracker");
    },
    { timeout: 2_000 },
  );
  expect(errors).toEqual([]);
  // Only a server says whether it runs; an HTML app has nothing to run.
  const badge = (name: string) =>
    [...node.querySelectorAll(".app-row")]
      .find((row) => row.textContent?.includes(name))
      ?.querySelector(".chip")?.textContent ?? null;
  expect(badge("Trip budget")).toBeNull();
  expect(badge("Ferry tracker")).toBe("Running");
  expect(badge("Inventory sync")).toBe("Stopped");
});

it("says a failed read of the apps in its own words, never the failure's text", async () => {
  client = new MockHostClient({ latencyMs: 0 });
  await client.load();
  harness.client = client;
  vi.spyOn(client, "listApps").mockRejectedValueOnce(new Error("ECONNRESET /Users/tim/secret"));
  const node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  await act(async () =>
    root!.render(
      <MemoryRouter>
        <AppsPage />
      </MemoryRouter>,
    ),
  );
  await vi.waitFor(() => expect(node.querySelector('[role="alert"]')).not.toBeNull());
  expect(node.textContent).not.toContain("ECONNRESET");
  expect(node.querySelector('[role="alert"]')?.textContent).toContain("Something went wrong.");
});
