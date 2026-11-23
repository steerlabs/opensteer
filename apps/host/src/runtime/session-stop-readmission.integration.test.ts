import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { AgentConnectionStore } from "@opensteer/database";
import type { MachineAccessPolicy } from "@opensteer/protocol";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  connectionCredentialPrefix,
  credentialHash,
} from "../mcp/connections/connection-authenticator.js";
import { mcpResourcePath } from "../mcp/connections/connection-oauth.js";
import {
  activeSessionId,
  createMachineAccessDatabase,
  resetMachineAccessDatabase,
  shellSessionRows,
  startShellAccessScenario,
  startShim,
  stopShellSession,
  type ShellAccessScenario,
} from "./machine-access-protocol.test-support.js";

/** What runs between the door's admission and its last admission, set by the test below. */
const between = vi.hoisted(() => ({ hook: undefined as (() => Promise<void>) | undefined }));
vi.mock("../commands/agent-door.js", async (original) => {
  const module = await original<typeof import("../commands/agent-door.js")>();
  return {
    ...module,
    agentCommandDoor: (input: Parameters<typeof module.agentCommandDoor>[0]) => {
      const door = module.agentCommandDoor(input);
      return {
        ...door,
        admit: async (...args: Parameters<typeof door.admit>) => {
          const admission = await door.admit(...args);
          await between.hook?.();
          return admission;
        },
      };
    },
  };
});

const baseDatabaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
// Integration tests run only against a test database (OPENSTEER_TEST_DATABASE_URL).
const integration = baseDatabaseUrl ? describe : describe.skip;
let database: Awaited<ReturnType<typeof createMachineAccessDatabase>> | undefined;
let databaseUrl = "postgres://unconfigured";
const openPolicy: MachineAccessPolicy = {
  commands: true,
  forwarding: false,
  reach: "owner",
  shares: [],
};

integration("a connection's Stop of a live shell session (G3)", () => {
  beforeAll(async () => {
    database = await createMachineAccessDatabase(baseDatabaseUrl ?? "");
    databaseUrl = database.url;
  }, 120_000);
  afterAll(async () => {
    await database?.drop();
  }, 120_000);
  let scenario: ShellAccessScenario | undefined;
  beforeEach(async () => resetMachineAccessDatabase(databaseUrl));
  afterEach(async () => {
    between.hook = undefined;
    await scenario?.close();
    scenario = undefined;
  }, 120_000);

  it("is admitted once more just before it ends the session: revoked meanwhile, nothing ends", async () => {
    scenario = await startShellAccessScenario(databaseUrl, { policy: openPolicy });
    const { alias, host, launch, target } = scenario;
    const long = startShim(launch, "ssh", [alias, "sleep 60"]);
    let exited = false;
    void long.exited.then(() => {
      exited = true;
    });
    const sessionId = await activeSessionId(host, target.runnerId);

    // A connected agent with everything, at Full access, over MCP.
    const connections = new AgentConnectionStore(host.store.database);
    const record = await connections.create({
      userId: host.ownerId,
      label: "Stop agent",
      clientName: "Stop agent",
      accessMode: "full-access",
      resource: new URL(mcpResourcePath, host.origin).href,
      expiresAt: new Date(Date.now() + 60 * 60_000),
      grant: { scope: "everything" },
    });
    const token = `${connectionCredentialPrefix}${randomBytes(32).toString("base64url")}`;
    await connections.activate(record.id, credentialHash(token));
    const client = new Client({ name: "session-stop", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(mcpResourcePath, host.origin), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }) as unknown as Transport,
    );
    try {
      // The person disconnects it after the door admitted the Stop, before it acts.
      between.hook = async () => {
        between.hook = undefined;
        await connections.revoke(host.ownerId, record.id);
      };
      const stopped = (await client.callTool({
        name: "opensteer_command",
        arguments: { command: { type: "machine.access.session.stop", sessionId } },
      })) as { isError?: boolean; structuredContent?: { error?: { code?: string } } };
      expect(stopped.isError).toBe(true);
      // Nothing ended: the session's process is still running and its row is live.
      expect(exited).toBe(false);
      expect((await shellSessionRows(host)).map((row) => [row.id, row.state])).toEqual([
        [sessionId, "active"],
      ]);
      // No attempt was recorded for it either.
      expect(
        await host.store.database
          .selectFrom("commandAttempts")
          .select("id")
          .where("connectionId", "=", record.id)
          .execute(),
      ).toEqual([]);
    } finally {
      await client.close().catch(() => undefined);
      await stopShellSession(host, { key: "owner-stop", sessionId }).catch(() => undefined);
      await long.exited.catch(() => undefined);
    }
  }, 180_000);
});
