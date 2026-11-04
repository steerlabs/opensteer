import { createId } from "@opensteer/core";
import { placeStatus } from "@opensteer/protocol/deployment-status";
import type { DeploymentAccessSnapshot } from "@opensteer/protocol/desktop";
import { expect, it } from "vitest";
import { placeRows } from "./places.js";

it("offers an update only where this app holds a route to the computer", () => {
  const reachable = createId("deployment");
  const listed = createId("deployment");
  const statusInfo = placeStatus.unavailable("host-too-old", "Studio Mac");
  const rows = placeRows(
    {
      account: { available: true, status: "signed-in" },
      deployments: [
        {
          id: reachable,
          name: "Studio Mac",
          kind: "personal",
          availableActions: [],
          canonicalOrigin: "http://127.0.0.1:1",
          onThisComputer: false,
          accountAccess: "owner",
          source: "manual",
          status: "idle",
          statusInfo,
        },
      ],
      selectedDeploymentId: null,
      unavailable: [
        { accountAccess: "owner", deploymentId: listed, name: "Lab", reason: "host-too-old" },
      ],
    } as unknown as DeploymentAccessSnapshot,
    { thisComputer: "This Mac" },
  );
  expect(Object.fromEntries(rows.map((row) => [row.id, row.updatable]))).toEqual({
    [reachable]: true,
    [listed]: false,
  });
});
