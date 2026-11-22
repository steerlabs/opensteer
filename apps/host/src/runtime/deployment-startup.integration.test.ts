import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createId } from "@opensteer/core";
import { parseHostConfig } from "@opensteer/config";
import {
  hostApiVersion,
  hostApiVersionHeader,
  minimumHostApiVersion,
} from "@opensteer/deployment-authority";
import {
  cloneTestDatabase,
  ownTestDatabaseProducer,
} from "@opensteer/database/test-support/database";
import { createHostRuntime, type HostRuntime } from "./runtime.js";

const constructions = vi.hoisted(() => [] as string[]);
vi.mock("@opensteer/orchestration", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@opensteer/orchestration")>();
  return {
    ...actual,
    RunnerRegistry: class extends actual.RunnerRegistry {
      constructor(...args: ConstructorParameters<typeof actual.RunnerRegistry>) {
        super(...args);
        constructions.push("RunnerRegistry");
      }
    },
  };
});
vi.mock("../browser/browser-service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../browser/browser-service.js")>();
  return {
    ...actual,
    BrowserService: class extends actual.BrowserService {
      constructor(...args: ConstructorParameters<typeof actual.BrowserService>) {
        super(...args);
        constructions.push("BrowserService");
      }
    },
  };
});
vi.mock("../devices/device-service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../devices/device-service.js")>();
  return {
    ...actual,
    DeviceService: class extends actual.DeviceService {
      constructor(...args: ConstructorParameters<typeof actual.DeviceService>) {
        super(...args);
        constructions.push("DeviceService");
      }
    },
  };
});

vi.mock("../agents/memory-pass-service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agents/memory-pass-service.js")>();
  return {
    ...actual,
    MemoryPassService: class extends actual.MemoryPassService {
      constructor(...args: ConstructorParameters<typeof actual.MemoryPassService>) {
        super(...args);
        constructions.push("MemoryPassService");
      }
    },
  };
});

vi.mock("../channels/channel-service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../channels/channel-service.js")>();
  return {
    ...actual,
    ChannelService: class extends actual.ChannelService {
      constructor(...args: ConstructorParameters<typeof actual.ChannelService>) {
        super(...args);
        constructions.push("ChannelService");
      }
    },
  };
});

vi.mock("../browser/password-sign-in-service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../browser/password-sign-in-service.js")>();
  return {
    ...actual,
    PasswordSignInService: class extends actual.PasswordSignInService {
      constructor(...args: ConstructorParameters<typeof actual.PasswordSignInService>) {
        super(...args);
        constructions.push("PasswordSignInService");
      }
    },
  };
});

it("cold starts and shuts down a fresh personal Host with independent version admission", async () => {
  const kind = "personal" as const;
  const database = await cloneTestDatabase("host");
  const directory = await mkdtemp(join(tmpdir(), "opensteer-deployment-start-"));
  let runtime: HostRuntime | undefined;
  constructions.length = 0;
  try {
    const config = parseHostConfig({
      OPENSTEER_MODE: "development",
      OPENSTEER_DEPLOYMENT_KIND: kind,
      OPENSTEER_INITIAL_MESSAGING_RUNNER_ENROLLMENT_TOKEN: "m".repeat(48),
      OPENSTEER_DATABASE_URL: database.url,
      OPENSTEER_AUTH_SECRET: "s".repeat(48),
      OPENSTEER_HOST_DATA_DIR: directory,
      OPENSTEER_CANONICAL_ORIGIN: "http://127.0.0.1:4310",
      OPENSTEER_BIND_ADDRESS: "127.0.0.1",
      OPENSTEER_PORT: "4310",
      OPENSTEER_LOCAL_OWNER_CLAIM_TOKEN: "c".repeat(48),
      OPENSTEER_HOSTING_ENVIRONMENT_ID: createId("environment"),
      OPENSTEER_AGENT_HOME: join(directory, "agent-home"),
      OPENSTEER_LOCAL_PASSWORD_ENABLED: "false",
    });
    const owned = await ownTestDatabaseProducer(database.url, async () => {
      const host = await createHostRuntime(config);
      return { host, close: () => host.close() };
    });
    runtime = owned.host;
    expect(runtime.kind).toBe(kind);
    const descriptor = await runtime.app.inject({ method: "GET", url: "/.well-known/opensteer" });
    expect(descriptor.statusCode).toBe(200);
    expect(descriptor.json()).toMatchObject({
      kind,
      apiVersion: minimumHostApiVersion,
      authority: { document: { deploymentShape: { kind } } },
    });
    for (const version of ["999", "1&opensteer_api_version=1"]) {
      const refused = await runtime.app.inject({
        method: "GET",
        url: `/v1/realtime?opensteer_api_version=${version}`,
        headers: { upgrade: "websocket", connection: "Upgrade" },
      });
      expect(refused.statusCode).toBe(400);
    }
    const admitted = await runtime.app.inject({
      method: "GET",
      url: `/v1/realtime?opensteer_api_version=${hostApiVersion}`,
      headers: {
        upgrade: "websocket",
        connection: "Upgrade",
        origin: config.canonicalOrigin.origin,
      },
    });
    expect(admitted.statusCode).toBe(401);
    {
      expect(constructions).toEqual(
        expect.arrayContaining(["RunnerRegistry", "BrowserService", "DeviceService"]),
      );
      const refused = await runtime.app.inject({
        method: "POST",
        url: "/v1/rpc/commands.dispatch",
        headers: {
          "content-type": "application/json",
          [hostApiVersionHeader]: String(minimumHostApiVersion - 1),
        },
        payload: "{invalid",
      });
      expect(refused.statusCode).toBe(400);
      expect(refused.json()).toMatchObject({
        ok: false,
        error: { reason: "unsupported-version" },
      });
      expect(runtime.kind).toBe("personal");
      if (runtime.kind === "personal") {
        const tables = await runtime.store.database.introspection.getTables();
        const names = new Set(tables.map((table) => table.name));
        for (const removed of [
          "workspaces",
          "workspace_memberships",
          "workspace_tabs",
          "projects",
          "channel_conversation_contexts",
          "deployment_event_state",
          "deployment_events",
        ])
          expect(names.has(removed)).toBe(false);
        for (const required of [
          "personal_settings",
          "client_sync_state",
          "client_changes",
          "team_access_state",
          "team_channels",
        ])
          expect(names.has(required)).toBe(true);
      }
    }
  } finally {
    await runtime?.close();
    await database.drop();
    await rm(directory, { recursive: true, force: true });
  }
});
