import { expect, it, vi } from "vitest";
import { DeploymentConnectionSchema } from "@opensteer/client/connections";
import type { MockTeamHost } from "@opensteer/client/team";
import { mockDeploymentConnections } from "../client/mock-mode.js";
import { mockTeamReaderId, mockTeamTransport, networkTeamTransport } from "./team-transport.js";

it("keeps both busy mock teams and their conversations across phone sessions", async () => {
  const hosts = new Map<string, MockTeamHost>();
  const transport = mockTeamTransport(hosts);
  const teams = mockDeploymentConnections().filter((row) => row.kind === "team");
  expect(teams.map((team) => team.name)).toEqual(["Acme", "Family"]);
  for (const row of teams) {
    const connection = DeploymentConnectionSchema.parse({
      ...row,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      lastUsedAt: null,
      preferredEndpointOrigin: null,
    });
    const scope = {
      teamDeploymentId: connection.authority.document.deploymentId,
      userId: mockTeamReaderId,
    };
    const first = transport(connection, scope);
    const host = hosts.get(scope.teamDeploymentId)!;
    expect(host.members).toHaveLength(7);
    const channelId = [...host.channels.values()][0]!.id;
    const message = host.post({ channelId, bodyMarkdown: "Back on my phone." });
    const next = transport(connection, scope);
    expect(next.rpc).toBe(first.rpc);
    const page = await next.rpc["team.messages.page"]({ channelId, page: { direction: "newest" } });
    expect(page.ok && page.data.messages.at(-1)?.id).toBe(message.id);
  }
});

it("forces one team refresh for concurrent 401s on a phone", async () => {
  const { DeploymentCatalogSchema } = await import("@opensteer/client/connections");
  const connection = DeploymentConnectionSchema.parse({
    ...mockDeploymentConnections().find((row) => row.kind === "team"),
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    lastUsedAt: null,
    preferredEndpointOrigin: null,
  });
  let token = "Bearer rejected";
  const recoverHostAuthorization = vi.fn(async () => {
    token = "Bearer renewed";
    return true;
  });
  const oauth = {
    subscribeAccountIdentityChanges: () => () => undefined,
    recoverHostAuthorization,
    subscribe: () => () => undefined,
    subscribeHostCredentials: () => () => undefined,
  } as unknown as import("@opensteer/client/auth").NativeOAuthManager;
  const requests: string[] = [];
  const transport = networkTeamTransport({
    catalog: {
      load: async () =>
        DeploymentCatalogSchema.parse({
          deployments: [connection],
          selectedDeploymentId: connection.authority.document.deploymentId,
          revision: 1,
          schemaVersion: DeploymentCatalogSchema.shape.schemaVersion.value,
          updatedAt: new Date(0).toISOString(),
        }),
      subscribe: () => () => undefined,
    },
    credentials: { authorizationHeader: async () => token },
    oauth,
    network: {
      request: async (input) => {
        requests.push(input.authorization!);
        return Response.json(
          {
            ok: false,
            error: {
              code: input.authorization === "Bearer renewed" ? "forbidden" : "unauthorized",
              message: "Test refusal",
              retryable: false,
            },
          },
          { status: input.authorization === "Bearer renewed" ? 403 : 401 },
        );
      },
      openWebSocket: () => {
        throw new Error("No socket expected");
      },
    },
  })(connection, {
    teamDeploymentId: connection.authority.document.deploymentId,
    userId: mockTeamReaderId,
  });
  const results = await Promise.all([
    transport.rpc["auth.config"]({}),
    transport.rpc["auth.config"]({}),
  ]);
  expect(results).toEqual([
    expect.objectContaining({ error: expect.objectContaining({ code: "forbidden" }) }),
    expect.objectContaining({ error: expect.objectContaining({ code: "forbidden" }) }),
  ]);
  expect(recoverHostAuthorization).toHaveBeenCalledOnce();
  expect(requests).toEqual([
    "Bearer rejected",
    "Bearer rejected",
    "Bearer renewed",
    "Bearer renewed",
  ]);
});

it.each(["rpc", "rpc-decode", "original", "preview", "upload", "realtime"] as const)(
  "withholds %s delivery when the credential lease expires at the response handoff",
  async (path) => {
    const { DeploymentCatalogSchema } = await import("@opensteer/client/connections");
    const { TeamFileSchema } = await import("@opensteer/protocol");
    const { createId } = await import("@opensteer/core");
    const connection = DeploymentConnectionSchema.parse({
      ...mockDeploymentConnections().find((row) => row.kind === "team"),
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      lastUsedAt: null,
      preferredEndpointOrigin: null,
    });
    const file = TeamFileSchema.parse({
      id: createId("teamBlob"),
      channelId: createId("teamChannel"),
      filename: "test",
      mediaType: "text/plain",
      sizeBytes: 1,
      sha256: "a".repeat(64),
      preview: { mediaType: "image/png", sizeBytes: 1 },
    });
    let current = true;
    let events: import("@opensteer/client/connections").HostNetworkSocketEvents | undefined;
    const transport = networkTeamTransport({
      catalog: {
        load: async () =>
          DeploymentCatalogSchema.parse({
            deployments: [connection],
            selectedDeploymentId: connection.authority.document.deploymentId,
            revision: 1,
            schemaVersion: DeploymentCatalogSchema.shape.schemaVersion.value,
            updatedAt: new Date(0).toISOString(),
          }),
        subscribe: () => () => {},
      },
      credentials: {
        authorizationHeader: async () => "Bearer team",
        teamEntryLease: () => ({
          assertCurrent: () => {
            if (!current) throw new Error("Account changed");
          },
        }),
      },
      oauth: {
        subscribeHostCredentials: () => () => {},
        subscribe: () => () => {},
        subscribeAccountIdentityChanges: () => () => {},
      } as unknown as import("@opensteer/client/auth").NativeOAuthManager,
      network: {
        request: async () => {
          const data =
            path === "upload"
              ? JSON.stringify(file)
              : path === "rpc" || path === "rpc-decode"
                ? JSON.stringify({ ok: true, data: { members: [], hasMore: false } })
                : "x";
          const response = new Response(
            new ReadableStream({
              pull(controller) {
                controller.enqueue(new TextEncoder().encode(data));
                controller.close();
                if (path !== "rpc-decode") current = false;
              },
            }),
            {
              headers: {
                "content-type": path === "preview" ? "image/png" : "application/octet-stream",
              },
            },
          );
          if (path === "original" || path === "preview") {
            const blob = response.blob.bind(response);
            response.blob = async () => {
              const result = await blob();
              current = false;
              return result;
            };
          }
          return response;
        },
        openWebSocket: (_input, bound) => {
          events = bound;
          return { close: () => {}, send: () => {} };
        },
      },
    })(connection, {
      teamDeploymentId: connection.authority.document.deploymentId,
      userId: mockTeamReaderId,
    });
    if (path === "realtime") {
      const socket = transport.connect();
      const receive = vi.fn();
      const close = vi.fn();
      socket.addEventListener("message", receive);
      socket.addEventListener("close", close);
      try {
        await vi.waitFor(() => expect(events, "socket did not open").toBeDefined(), {
          timeout: 1000,
        });
        current = false;
        events!.message("private data");
        expect(receive).not.toHaveBeenCalled();
        events!.close(1000, "private close reason");
        expect(close).toHaveBeenCalledWith(
          expect.objectContaining({ reason: "Deployment changed" }),
        );
      } finally {
        socket.close();
      }
    } else if (path === "rpc" || path === "rpc-decode") {
      const parse = JSON.parse;
      const spy = vi.spyOn(JSON, "parse").mockImplementation((text: string) => {
        const value: unknown = parse(text);
        if (
          path === "rpc-decode" &&
          text === JSON.stringify({ ok: true, data: { members: [], hasMore: false } })
        )
          current = false;
        return value;
      });
      try {
        const result = await transport.rpc["team.members.list"]({});
        expect(result.ok).toBe(false);
        expect(result).not.toHaveProperty("data");
      } finally {
        spy.mockRestore();
      }
    } else {
      const pending =
        path === "upload"
          ? transport.uploadFile({
              channelId: file.channelId,
              original: new Blob(["x"]),
              preview: new Blob(["x"]),
              metadata: {
                clientUploadId: crypto.randomUUID(),
                filename: file.filename,
                mediaType: file.mediaType,
                sizeBytes: 1,
                sha256: file.sha256,
                previewSizeBytes: 1,
              },
            })
          : transport.readFile(file, path);
      await expect(pending).rejects.toMatchObject({ code: "deployment-changed" });
    }
  },
);
