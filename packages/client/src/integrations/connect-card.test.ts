import { describe, expect, it } from "vitest";
import type { LoadedAccessRequest } from "./access-request.js";
import { mockMessagesDefinition } from "../mock/mock-integration-fixtures.js";
import {
  collapsedAccountRows,
  connectCard,
} from "./connect-card.js";

/** An access Request for Messages on a computer, or for a local server needing no account. */
function loaded(kind: "computer" | "none" | "provider" = "computer", count = 0) {
  const connections = Array.from({ length: count }, (_, i) => ({
    id: `connection-${i}`,
    definitionId: mockMessagesDefinition.id,
    accountIdentifier: null,
    displayName: `Mac ${i}`,
    createdAt: "2026-01-01T00:00:00Z",
    status: "connected",
    computer: { access: "read", runnerId: `runner-${i}` },
  }));
  return {
    request: {
      kind: "integration.access",
      access: "read",
      reason: "Read the latest message",
      installationId: "installation",
      requestedServerId: "server",
      requestedConnectionId: null,
      manifest: null,
    },
    dashboard: { connections, isAdministrator: true },
    platform: {
      connections: [],
      installations: [
        {
          installation: {
            id: "installation",
            title: "Messages",
            manifest: kind === "computer" ? { definition: mockMessagesDefinition } : {},
          },
          servers: [
            {
              id: "server",
              name: "messages",
              status: "active",
              connectionRequirement:
                kind === "computer"
                  ? { kind, definitionId: mockMessagesDefinition.id }
                  : kind === "provider"
                    ? {
                        kind,
                        definitionId: "gmail",
                        provider: "google",
                        providerApplicationRequired: true,
                      }
                    : { kind },
            },
          ],
          tools: connections.flatMap(({ id }) => [
            { connectionId: id, serverId: "server", annotations: { readOnlyHint: true } },
          ]),
        },
      ],
    },
  } as unknown as LoadedAccessRequest;
}

function catalogInstall(administrator: boolean): LoadedAccessRequest {
  const value = loaded();
  return {
    ...value,
    dashboard: { ...value.dashboard, isAdministrator: administrator },
    request: {
      ...value.request,
      installationId: null,
      requestedServerId: null,
      manifest: { kind: "catalog", definition: mockMessagesDefinition, digest: "a".repeat(43) },
    },
  } as unknown as LoadedAccessRequest;
}

const name = mockMessagesDefinition.name;

describe("connectCard", () => {
  it("asks for a computer before an app on a computer can be allowed", () => {
    expect(connectCard({ loaded: loaded() })).toMatchObject({
      phase: "needs-form",
      form: "computer",
      primary: { kind: "connect", label: "Choose a computer" },
      title: `Connect ${name}`,
    });
  });

  it.each([1, 3])("offers a row per computer and one Allow with %i computers", (count) => {
    const card = connectCard({ loaded: loaded("computer", count) });
    expect(card.accounts).toHaveLength(count);
    expect(card.accounts[0]).toMatchObject({ label: "Mac 0", selected: true });
    expect(card).toMatchObject({ primary: { kind: "use", label: "Allow" }, title: `Use ${name}` });
  });

  it("keeps the computer's own ceiling separate from what the Request asks", () => {
    const card = connectCard({ loaded: loaded("computer", 1), allowChanges: true });
    expect(card).toMatchObject({
      phase: "needs-form",
      form: "computer",
      primary: { kind: "upgrade", label: "Request sending access on Mac 0" },
      upgrade: { runnerId: "runner-0" },
    });
  });

  it("allows a local server that needs no account without inventing one", () => {
    expect(connectCard({ loaded: loaded("none") })).toMatchObject({
      phase: "ask",
      primary: { kind: "use", label: "Allow" },
      accounts: [],
    });
  });

  it("installs a catalog device app first, or names who must", () => {
    expect(connectCard({ loaded: catalogInstall(true) })).toMatchObject({
      primary: { kind: "install", label: "Continue" },
      name,
    });
    expect(connectCard({ loaded: catalogInstall(false) })).toMatchObject({
      phase: "needs-admin",
      primary: null,
    });
  });

  it("shows failures, committed success and answered states in place", () => {
    expect(connectCard({ loaded: loaded("none"), error: "Offline" })).toMatchObject({
      phase: "failed",
      primary: { kind: "retry" },
    });
    expect(
      connectCard({
        loaded: loaded("computer", 1),
        connectedAccount: { accountIdentifier: null, displayName: "Mac 0" },
      }),
    ).toMatchObject({ phase: "connected", success: `${name} connected · Mac 0` });
    expect(connectCard({ loaded: loaded("none"), answered: true })).toMatchObject({
      phase: "answered",
      primary: null,
    });
  });
});

describe("collapsedAccountRows", () => {
  const rows = (count: number, selected = 0) =>
    Array.from({ length: count }, (_, id) => ({ id, selected: id === selected }));
  it("shows a list at most one past the limit whole", () => {
    expect(collapsedAccountRows(rows(4), 3)).toEqual({ rows: rows(4), hidden: 0 });
  });
  it("keeps the selected account on screen when the list collapses", () => {
    const collapsed = collapsedAccountRows(rows(8, 6), 3);
    expect(collapsed.hidden).toBe(5);
    expect(collapsed.rows.map(({ id }) => id)).toEqual([0, 1, 6]);
  });
});
