import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createId } from "@opensteer/core";
import { parseHostConfig } from "@opensteer/config";
import {
  hostApiVersion,
  hostApiVersionHeader,
  teamApiVersion,
  teamApiVersionHeader,
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
vi.mock("../integrations/integration-platform-service.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../integrations/integration-platform-service.js")>();
  return {
    ...actual,
    IntegrationPlatformService: class extends actual.IntegrationPlatformService {
      constructor(...args: ConstructorParameters<typeof actual.IntegrationPlatformService>) {
        super(...args);
        constructions.push("IntegrationPlatformService");
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

it.each(["personal", "team"] as const)(
  "cold starts and shuts down a fresh %s Host with independent version admission",
  async (kind) => {
    const database = await cloneTestDatabase("host");
    const directory = await mkdtemp(join(tmpdir(), "opensteer-deployment-start-"));
    let runtime: HostRuntime | undefined;
    constructions.length = 0;
    try {
      const config = parseHostConfig({
        OPENSTEER_MODE: "development",
        OPENSTEER_DEPLOYMENT_KIND: kind,
        ...(kind === "personal"
          ? { OPENSTEER_INITIAL_MESSAGING_RUNNER_ENROLLMENT_TOKEN: "m".repeat(48) }
          : {}),
        OPENSTEER_DATABASE_URL: database.url,
        OPENSTEER_AUTH_SECRET: "s".repeat(48),
        OPENSTEER_HOST_DATA_DIR: directory,
        OPENSTEER_CANONICAL_ORIGIN:
          kind === "personal" ? "http://127.0.0.1:4310" : "https://team.example.invalid",
        OPENSTEER_BIND_ADDRESS: "127.0.0.1",
        OPENSTEER_PORT: "4310",
        ...(kind === "personal"
          ? {
              OPENSTEER_LOCAL_OWNER_CLAIM_TOKEN: "c".repeat(48),
              OPENSTEER_HOSTING_ENVIRONMENT_ID: createId("environment"),
              OPENSTEER_AGENT_HOME: join(directory, "agent-home"),
              OPENSTEER_LOCAL_PASSWORD_ENABLED: "false",
            }
          : { OPENSTEER_INITIAL_OWNER_ENROLLMENT_TOKEN: "t".repeat(48) }),
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
        apiVersion: kind === "team" ? teamApiVersion : hostApiVersion,
        authority: { document: { deploymentShape: { kind } } },
      });
      for (const version of [kind === "team" ? "0" : "999", "1&opensteer_api_version=1"]) {
        const refused = await runtime.app.inject({
          method: "GET",
          url: `/v1/realtime?opensteer_api_version=${version}`,
          headers: { upgrade: "websocket", connection: "Upgrade" },
        });
        expect(refused.statusCode).toBe(kind === "team" ? 409 : 400);
      }
      const admitted = await runtime.app.inject({
        method: "GET",
        url: `/v1/realtime?opensteer_api_version=${kind === "team" ? teamApiVersion : hostApiVersion}`,
        headers: {
          upgrade: "websocket",
          connection: "Upgrade",
          origin: config.canonicalOrigin.origin,
        },
      });
      expect(admitted.statusCode).toBe(401);
      if (kind === "team") {
        for (const url of [
          "/v1/auth/oidc/callback?state=ost-team-api-0.fake",
          "/v1/auth/native/oauth2/authorize?opensteer_team_api_version=0",
        ]) {
          const refused = await runtime.app.inject({ method: "GET", url });
          expect(refused.statusCode).toBe(409);
        }

        expect(constructions).toEqual([]);
        for (const url of [
          "/v1/rpc/team.bootstrap.get",
          "/v1/rpc/commands.dispatch",
          "/v1/team/setup/exchange",
          "/v1/team/files/upload/not-a-channel",
          "/internal/v1/team/link/redeem",
        ]) {
          const refused = await runtime.app.inject({
            method: "POST",
            url,
            headers: {
              "content-type": "application/json",
              [hostApiVersionHeader]: String(hostApiVersion),
            },
            payload: "{invalid",
          });
          expect(refused.statusCode).toBe(url.startsWith("/internal/") ? 426 : 409);
          expect(refused.body).toContain("version");
        }
        const personal = await runtime.app.inject({
          method: "POST",
          url: "/v1/rpc/bootstrap.get",
          headers: { [teamApiVersionHeader]: String(teamApiVersion) },
          payload: {},
        });
        expect(personal.statusCode).toBe(404);
      } else {
        expect(constructions).toEqual(
          expect.arrayContaining([
            "RunnerRegistry",
            "BrowserService",
            "IntegrationPlatformService",
          ]),
        );
        const refused = await runtime.app.inject({
          method: "POST",
          url: "/v1/rpc/commands.dispatch",
          headers: {
            "content-type": "application/json",
            [hostApiVersionHeader]: String(hostApiVersion - 1),
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
          ])
            expect(names.has(removed)).toBe(false);
          for (const required of [
            "personal_settings",
            "deployment_event_state",
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
  },
);
