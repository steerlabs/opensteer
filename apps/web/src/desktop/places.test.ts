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

it("names the Mac an Opensteer lives on when it differs from the Opensteer", () => {
  const ids = [createId("deployment"), createId("deployment"), createId("deployment")];
  const deployment = (id: string, name: string) => ({
    id,
    name,
    kind: "personal",
    availableActions: ["select"],
    canonicalOrigin: "http://127.0.0.1:1",
    onThisComputer: false,
    accountAccess: "owner",
    source: "account",
    status: "idle",
    statusInfo: placeStatus.unavailable("host-too-old", name),
  });
  const facts = (homeName: string | null) => ({ homeName, needsYou: 0, teams: [], unread: false });
  const rows = placeRows(
    {
      account: { available: true, status: "signed-in" },
      deployments: [
        deployment(ids[0]!, "Tim’s Opensteer"),
        deployment(ids[1]!, "Mac mini"),
        deployment(ids[2]!, "Studio"),
      ],
      selectedDeploymentId: null,
      unavailable: [],
    } as unknown as DeploymentAccessSnapshot,
    {
      thisComputer: "This Mac",
      facts: new Map([
        [ids[0]!, facts("Mac mini")],
        [ids[1]!, facts("Mac mini")],
        [ids[2]!, facts(null)],
      ]),
    },
  );
  expect(Object.fromEntries(rows.map((row) => [row.name, row.detail]))).toEqual({
    "Tim’s Opensteer": "Home: Mac mini",
    "Mac mini": "Your computer",
    Studio: "Your computer",
  });
});

it("badges the Home an organization pays for, by the Home the Account pinned", () => {
  const work = createId("deployment");
  const mine = createId("deployment");
  const deployment = (id: string, name: string) => ({
    id,
    name,
    kind: "personal",
    availableActions: ["select"],
    canonicalOrigin: "https://w3r8.cloud.opensteer.example",
    onThisComputer: false,
    accountAccess: "owner",
    source: "account",
    status: "idle",
    statusInfo: placeStatus.unavailable("host-too-old", name),
  });
  const rows = placeRows(
    {
      account: { available: true, status: "signed-in" },
      deployments: [deployment(work, "Acme work"), deployment(mine, "Mine")],
      selectedDeploymentId: null,
      unavailable: [],
    } as unknown as DeploymentAccessSnapshot,
    { thisComputer: "This Mac", work: new Map([[work, "Work · Acme Robotics"]]) },
  );
  expect(Object.fromEntries(rows.map((row) => [row.name, row.work]))).toEqual({
    "Acme work": "Work · Acme Robotics",
    Mine: undefined,
  });
});

it("calls a Cloud Computer a Cloud Computer, with the cloud, never a laptop", () => {
  const cloud = createId("deployment");
  const mac = createId("deployment");
  const here = createId("deployment");
  const deployment = (id: string, name: string, onThisComputer = false) => ({
    id,
    name,
    kind: "personal",
    availableActions: ["select"],
    canonicalOrigin: "https://w3r8.cloud.opensteer.example",
    onThisComputer,
    accountAccess: "owner",
    source: "account",
    status: "idle",
    statusInfo: placeStatus.unavailable("host-too-old", name),
  });
  const rows = placeRows(
    {
      account: { available: true, status: "signed-in" },
      deployments: [
        deployment(cloud, "Mine in the cloud"),
        deployment(mac, "Studio"),
        deployment(here, "Here", true),
      ],
      selectedDeploymentId: null,
      unavailable: [],
    } as unknown as DeploymentAccessSnapshot,
    { thisComputer: "This Mac", cloud: new Set([cloud]) },
  );
  expect(Object.fromEntries(rows.map((row) => [row.name, [row.detail, row.icon]]))).toEqual({
    "Mine in the cloud": ["Cloud Computer", "cloud"],
    Studio: ["Your computer", "laptop"],
    Here: ["This Mac", "laptop"],
  });
});
