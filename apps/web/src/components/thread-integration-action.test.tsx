// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { controlledClientSession } from "@opensteer/client/test-support";
import { resolveIntegrationAccess, type LoadedAccessRequest } from "@opensteer/client/integrations";
import type { HostSnapshot } from "@opensteer/client/host";
import type { Request } from "@opensteer/core";
import { ThreadIntegrationAction } from "./thread-integration-action.js";

const shellState = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("./app-shell.js", () => ({ useShell: () => shellState.current }));

const mountedRoots: Root[] = [];
const macMini = "rnr_11111111-1111-4111-8111-111111111111";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  for (const root of mountedRoots.splice(0)) act(() => root.unmount());
  shellState.current = null;
  vi.restoreAllMocks();
});

describe("ThreadIntegrationAction computer access", () => {
  it("requires an explicit computer ceiling upgrade before granting optional write access", async () => {
    const loaded = computerRequest();
    const dispatch = vi.fn(async (command: { readonly type: string }) =>
      command.type === "integration.computer.setup.request"
        ? {
            connection: {
              ...loaded.dashboard.connections[0]!,
              computer: { access: "read-write", runnerId: macMini },
            },
            type: command.type,
          }
        : { type: command.type },
    );
    const hostClient = {
      connection: controlledClientSession().connection,
      dispatch,
      getSnapshot: () => shellSnapshot(),
      refresh: async () => undefined,
      rpc: {
        "integration.platform.get": async () => ({ data: loaded.platform, ok: true as const }),
        "integrations.get": async () => ({ data: loaded.dashboard, ok: true as const }),
      },
    };
    shellState.current = {
      hostClient,
      reportActionError: vi.fn(),
      snapshot: shellSnapshot(),
    };
    const container = await mountThreadAction(computerRequestRecord());

    await openDetails(container);
    expect(notes(container)).toContain(
      "Agents can search and read your conversations, and send messages as you.",
    );
    expect(buttonWithText(container, "Allow")).not.toBeNull();

    const optionalWrite = container.querySelector<HTMLButtonElement>(
      '.connect-card__access [data-value="read-write"]',
    );
    if (optionalWrite?.textContent !== "Read and send")
      throw new Error("Missing computer app write-access choice");
    await act(async () => optionalWrite.click());

    expect(buttonWithText(container, "Request sending access on Mac mini")).not.toBeNull();
    expect(buttonWithText(container, "Allow")).toBeNull();

    await act(async () => buttonWithText(container, "Request sending access on Mac mini")?.click());

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ access: "read-write", runnerId: macMini }),
        type: "integration.computer.setup.request",
      }),
    );
    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: "request.respond" }));
  });
});

describe("ThreadIntegrationAction for a local server", () => {
  it("allows a server that needs no account in one tap", async () => {
    const loaded = localServerRequest();
    const dispatch = vi.fn(async (command: { readonly type: string }) => ({ type: command.type }));
    shellState.current = {
      hostClient: {
        connection: controlledClientSession().connection,
        dispatch,
        getSnapshot: () => shellSnapshot(),
        refresh: async () => undefined,
        rpc: {
          "integration.platform.get": async () => ({ data: loaded.platform, ok: true as const }),
          "integrations.get": async () => ({ data: loaded.dashboard, ok: true as const }),
        },
      },
      snapshot: shellSnapshot(),
    };
    const container = await mountThreadAction(requestRecord(loaded, "Use TV remote"));

    await act(async () => buttonWithText(container, "Allow")?.click());

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "request.respond",
        response: {
          kind: "external",
          value: expect.objectContaining({ access: "read-write", decision: "fulfilled" }),
        },
      }),
    );
    await vi.waitFor(() => expect(container.textContent).toContain("Request answered"));
  });
});

describe("resolveIntegrationAccess", () => {
  it("sends the full grant decision", async () => {
    const dispatch = vi.fn(async () => ({ type: "request.respond" as const }));

    await resolveIntegrationAccess(
      { dispatch },
      {
        access: "read",
        accountsCount: 1,
        installationTitle: "Calendar",
        expectedRevision: "20",
        requestId: "request-project",
        selectedAccount: {
          accountIdentifier: null,
          displayName: "Client",
          id: "connection-client",
        },
      },
    );

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "request-project",
        response: {
          kind: "external",
          value: {
            access: "read",
            alias: "Client",
            connectionId: "connection-client",
            decision: "fulfilled",
            isDefault: true,
          },
        },
        type: "request.respond",
      }),
    );
  });
});

function notes(container: HTMLElement): readonly string[] {
  return [
    ...container.querySelectorAll(".connect-card__scope, .connect-card__details p, .action-note"),
  ].map((note) => note.textContent ?? "");
}

/** Opens what the scope line stands for, as a person would before deciding. */
async function openDetails(container: HTMLElement): Promise<void> {
  const toggle = container.querySelector<HTMLButtonElement>(
    'button.connect-card__scope[aria-expanded="false"]',
  );
  if (toggle) await act(async () => toggle.click());
}

async function mountThreadAction(request: Request) {
  const shell = shellState.current as {
    hostClient: { rpc: Record<string, unknown> };
  };
  shell.hostClient.rpc["thread.requests.list"] ??= async () => ({
    ok: true,
    data: { requests: [], window: { hasMore: false, nextBefore: null } },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  await act(async () => {
    root.render(
      <MemoryRouter>
        <ThreadIntegrationAction request={request} threadId="thr_test" />
      </MemoryRouter>,
    );
  });
  // The loaded card is the one with an answer row.
  await vi.waitFor(() => expect(container.querySelector(".connect-card__foot")).not.toBeNull());
  return container;
}

function buttonWithText(container: HTMLElement, label: string): HTMLButtonElement | null {
  return (
    [...container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === label,
    ) ?? null
  );
}

function computerRequest(): LoadedAccessRequest {
  const definition = {
    adapter: "computer",
    authMethods: [{ id: "computer", kind: "computer", label: "This Mac" }],
    computerApp: {
      accessLabels: { read: "Read only", readWrite: "Read and send" },
      accessLevels: ["read", "read-write"],
      operations: [
        { name: "query_messages", effect: "read" },
        { name: "export_attachment", effect: "read" },
        { name: "send_message", effect: "write" },
      ],
      accessSummaries: {
        read: "Agents can search and read your conversations.",
        readWrite: "Agents can search and read your conversations, and send messages as you.",
      },
      platforms: ["darwin"],
    },
    description: "Search, read, and send Messages through an enrolled Mac.",
    id: "apple-messages",
    name: "Messages",
    provider: "apple-messages",
  };
  const connection = {
    accountIdentifier: null,
    computer: { access: "read", runnerId: macMini },
    createdAt: "2026-09-17T12:00:00.000Z",
    definitionId: "apple-messages",
    displayName: "Mac mini",
    id: "con_messages_mac_mini",
    status: "connected",
  };
  return {
    dashboard: { connections: [connection] },
    platform: {
      connections: [],
      installations: [
        {
          installation: {
            id: "iin_messages",
            manifest: { definition },
            title: "Messages",
          },
          servers: [
            {
              connectionRequirement: { definitionId: "apple-messages", kind: "computer" },
              id: "isv_messages",
              status: "active",
            },
          ],
          skills: [],
          // The read-only ceiling materialises no send tool. The catalog still
          // declares that the connection can deliberately be widened.
          tools: [
            {
              annotations: { readOnlyHint: true },
              connectionId: connection.id,
              id: "itl_export_attachment",
              serverId: "isv_messages",
              status: "active",
            },
          ],
        },
      ],
    },
    request: {
      access: "read",
      installationId: "iin_messages",
      kind: "integration.access",
      reason: "Read Messages",
      requestedConnectionId: null,
      requestedServerId: "isv_messages",
    },
  } as unknown as LoadedAccessRequest;
}

function requestRecord(loaded: LoadedAccessRequest, title: string) {
  return {
    createdAt: "2026-09-18T00:00:00.000Z",
    id: "req_00000000-0000-4000-8000-000000000001",
    kind: "integration.access",
    mode: "live",
    payload: loaded.request,
    reviewedRevision: "17",
    presentation: { kind: "external", title },
    status: "pending",
  } as unknown as Request;
}

function computerRequestRecord() {
  return {
    createdAt: "2026-09-18T00:00:00.000Z",
    id: "req_00000000-0000-4000-8000-000000000001",
    kind: "integration.access",
    mode: "live",
    payload: computerRequest().request,
    reviewedRevision: "17",
    presentation: { kind: "external", title: "Connect Messages" },
    status: "pending",
  } as never;
}

function shellSnapshot() {
  return { machines: [] } as unknown as HostSnapshot;
}

function localServerRequest(): LoadedAccessRequest {
  return {
    dashboard: { connections: [], isAdministrator: true },
    platform: {
      connections: [],
      installations: [
        {
          installation: { id: "iin_tv", manifest: {}, title: "TV remote" },
          servers: [
            { connectionRequirement: { kind: "none" }, id: "isv_tv", name: "tv", status: "active" },
          ],
          tools: [
            {
              annotations: { readOnlyHint: false },
              connectionId: null,
              id: "itl_pair",
              serverId: "isv_tv",
              status: "active",
            },
          ],
        },
      ],
    },
    request: {
      access: "read-write",
      installationId: "iin_tv",
      kind: "integration.access",
      manifest: null,
      reason: "Pair the TV",
      requestedConnectionId: null,
      requestedServerId: "isv_tv",
    },
  } as unknown as LoadedAccessRequest;
}
