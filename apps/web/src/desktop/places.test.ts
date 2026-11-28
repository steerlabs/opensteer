import { createId } from "@opensteer/core";
import { placeStatus } from "@opensteer/protocol/deployment-status";
import type { DeploymentAccessSnapshot } from "@opensteer/protocol/desktop";
import { describe, expect, it } from "vitest";
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

it('calls a Home on a Mac "Mac" under its own name, from the one table of kinds', () => {
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
  const facts = (homeName: string | null) => ({ homeName, needsYou: 0, unread: false });
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
    "Tim’s Opensteer": "Mac",
    "Mac mini": "Mac",
    Studio: "Mac",
  });
});

describe("what kind of Home a row is", () => {
  const cloud = createId("deployment");
  const mac = createId("deployment");
  const server = createId("deployment");
  const here = createId("deployment");
  const gone = createId("deployment");
  const deployment = (id: string, name: string, origin: string, onThisComputer = false) => ({
    id,
    name,
    kind: "personal",
    availableActions: ["select"],
    canonicalOrigin: origin,
    onThisComputer,
    accountAccess: "owner",
    source: "account",
    status: "idle",
    statusInfo: placeStatus.unavailable("host-too-old", name),
  });
  const rows = (known: ReadonlySet<string> | null) =>
    placeRows(
      {
        account: { available: true, status: "signed-in" },
        deployments: [
          deployment(cloud, "Mine in the cloud", "https://w3r8.cloud.opensteer.example"),
          deployment(mac, "Studio", "http://127.0.0.1:4310"),
          deployment(server, "Basement", "https://home.example.net"),
          deployment(here, "Here", "http://127.0.0.1:4311", true),
        ],
        selectedDeploymentId: null,
        unavailable: [
          { accountAccess: "owner", deploymentId: gone, name: "Away", reason: "host-unavailable" },
        ],
      } as unknown as DeploymentAccessSnapshot,
      { thisComputer: "This Mac", cloud: known },
    );
  const kinds = (list: ReturnType<typeof rows>) =>
    Object.fromEntries(list.map((row) => [row.name, [row.detail, row.icon]]));

  it("calls a Cloud Computer a Cloud Computer, with the cloud, never a laptop", () => {
    expect(kinds(rows(new Set([cloud, gone])))).toEqual({
      "Mine in the cloud": ["Cloud Computer", "cloud"],
      Studio: ["Mac", "laptop"],
      Basement: ["Server", "server"],
      Here: ["This Mac", "laptop"],
      // A Home this app cannot reach is named what the Account says it is, too.
      Away: ["Cloud Computer", "cloud"],
    });
  });

  it("gives a personal Home on a server the server icon, and no kind while the Account can't say", () => {
    expect(kinds(rows(new Set()))).toMatchObject({
      "Mine in the cloud": ["Server", "server"],
      Basement: ["Server", "server"],
      Away: ["In your account", "server"],
    });
    // The read failed or hasn't answered: an address and no kind, never a wrong one.
    expect(kinds(rows(null))).toMatchObject({
      "Mine in the cloud": ["w3r8.cloud.opensteer.example", "globe"],
      Basement: ["home.example.net", "globe"],
      // A Mac is a Mac whatever that read says.
      Studio: ["Mac", "laptop"],
      Here: ["This Mac", "laptop"],
    });
  });
});
