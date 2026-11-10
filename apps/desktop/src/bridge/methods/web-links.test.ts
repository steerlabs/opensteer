import { createId, deploymentPolicy } from "@opensteer/core";
import { WebLinkDeliveryOwner } from "./web-links.js";
import { DesktopWebLinks } from "../../app/web-links.js";
import { expect, it, vi } from "vitest";
import type { DeploymentAccessSnapshot } from "@opensteer/protocol/desktop";
import { personalWebLinksAvailable } from "./web-links.js";
it("uses web-link policy rather than a connected attachment's display alias", () => {
  const snapshot = {
    selectedDeploymentId: "place",
    deployments: [{ id: "place", kind: "self-hosted", status: "connected" }],
  } as unknown as DeploymentAccessSnapshot;
  expect(
    personalWebLinksAvailable(snapshot, "place", {
      ...deploymentPolicy({ kind: "server", defaultWorkspaceBacking: "local-directory" }),
      nativeWebLinks: true,
    }),
  ).toBe(true);
});
it("only enables delivery and acknowledgement for the selected connected Personal attachment", () => {
  const snapshot = (
    kind: string,
    status: string,
    selectedDeploymentId: string | null = "personal",
  ) =>
    ({
      selectedDeploymentId,
      deployments: [{ id: "personal", kind, status }],
    }) as unknown as DeploymentAccessSnapshot;
  expect(
    personalWebLinksAvailable(snapshot("personal", "connected"), "personal", {
      nativeWebLinks: true,
    }),
  ).toBe(true);
  for (const status of ["starting", "needs-sign-in", "authorizing", "offline", "idle"])
    expect(
      personalWebLinksAvailable(snapshot("personal", status), "personal", { nativeWebLinks: true }),
    ).toBe(false);
  expect(
    personalWebLinksAvailable(snapshot("team", "connected"), "personal", { nativeWebLinks: false }),
  ).toBe(false);
  expect(
    personalWebLinksAvailable(snapshot("personal", "connected", null), "personal", {
      nativeWebLinks: true,
    }),
  ).toBe(false);
  expect(
    personalWebLinksAvailable(snapshot("personal", "connected"), "other", { nativeWebLinks: true }),
  ).toBe(false);
});
it("keeps delivering links across a route change, which Electron reports as a load", () => {
  const links = new DesktopWebLinks(() => undefined);
  const workspace = {
    send: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
    isDestroyed: () => false,
  };
  const owner = new WebLinkDeliveryOwner(
    links,
    (sender) => sender === workspace,
    () => true,
  );
  owner.handle(workspace, {
    deploymentId: createId("deployment"),
    userId: createId("user"),
    generation: crypto.randomUUID(),
    ready: true,
  });
  for (const [eventName, listener] of workspace.once.mock.calls)
    if (eventName === "did-start-loading") listener();
  links.accept("https://example.com/after-route-change");
  expect(workspace.send).toHaveBeenCalledOnce();
});
it("refuses another authorized app window and ignores stale generation cleanup and acknowledgements", async () => {
  const links = new DesktopWebLinks(() => undefined);
  const workspace = {
    send: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
    isDestroyed: () => false,
  };
  const panel = { ...workspace, send: vi.fn() };
  const owner = new WebLinkDeliveryOwner(
    links,
    (sender) => sender === workspace,
    () => true,
  );
  const first = {
    deploymentId: createId("deployment"),
    userId: createId("user"),
    generation: crypto.randomUUID(),
    ready: true,
  };
  const secondGeneration = crypto.randomUUID();
  links.accept("https://example.com/first");
  links.accept("https://example.com/next");
  expect(() => owner.handle(panel, first)).toThrow(/workspace/i);
  owner.handle(workspace, first);
  const id = workspace.send.mock.calls[0]![1].id;
  owner.handle(workspace, { ...first, userId: createId("user") });
  owner.handle(workspace, { ...first, deploymentId: createId("deployment") });
  expect(workspace.send).toHaveBeenCalledTimes(1);
  owner.handle(workspace, { ...first, generation: secondGeneration });
  owner.handle(workspace, { ...first, ready: false });
  owner.handle(workspace, { ...first, acknowledgedId: id });
  owner.handle(workspace, first);
  owner.handle(workspace, {
    ...first,
    generation: secondGeneration,
    userId: createId("user"),
    acknowledgedId: id,
  });
  owner.handle(workspace, {
    ...first,
    generation: secondGeneration,
    deploymentId: createId("deployment"),
    acknowledgedId: id,
  });
  expect(workspace.send).toHaveBeenCalledTimes(2);
  owner.handle(workspace, { ...first, generation: secondGeneration, acknowledgedId: id });
  expect(workspace.send.mock.calls[2]![1].url).toBe("https://example.com/next");
  expect(() =>
    owner.handle(panel, { ...first, generation: secondGeneration, acknowledgedId: id }),
  ).toThrow(/workspace/i);
  owner.dispose();
  links.dispose();
});
