import { createId } from "@opensteer/core";
import { WebLinkDeliveryOwner } from "./web-links.js";
import { DesktopWebLinks } from "../../app/web-links.js";
import { expect, it, vi } from "vitest";
import type { DeploymentAccessSnapshot } from "@opensteer/protocol/desktop";
import { personalWebLinksAvailable } from "./web-links.js";
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
  expect(personalWebLinksAvailable(snapshot("personal", "connected"), "personal")).toBe(true);
  for (const status of ["starting", "needs-sign-in", "authorizing", "offline", "idle"])
    expect(personalWebLinksAvailable(snapshot("personal", status), "personal")).toBe(false);
  expect(personalWebLinksAvailable(snapshot("team", "connected"), "personal")).toBe(false);
  expect(personalWebLinksAvailable(snapshot("personal", "connected", null), "personal")).toBe(
    false,
  );
  expect(personalWebLinksAvailable(snapshot("personal", "connected"), "other")).toBe(false);
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
