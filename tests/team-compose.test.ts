import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { teamInvitePagePrefix, teamSetupPagePath } from "../apps/host/src/team/setup-routes.js";

describe("team Compose contract", () => {
  it("keeps Host keys on its own data volume", async () => {
    const base = parse(await readFile(resolve("deploy/team/compose.yaml"), "utf8"));
    expect(base.services.host.environment).toMatchObject({
      OPENSTEER_HOST_PRIVATE_KEY_PATH: "/var/lib/opensteer/keys/host-private.pem",
      OPENSTEER_HOST_PUBLIC_KEY_PATH: "/var/lib/opensteer/keys/host-public.pem",
    });
    expect(base.services.files).toBeUndefined();
  });

  it("runs only team services with bounded private PostgreSQL", async () => {
    const compose: unknown = parse(await readFile(resolve("deploy/team/compose.yaml"), "utf8"));
    expect(compose).toMatchObject({
      services: {
        host: { environment: { OPENSTEER_DEPLOYMENT_KIND: "team" } },
        postgres: { mem_limit: "2g", memswap_limit: "2g", cpus: 2, networks: ["database"] },
      },
      networks: { database: { internal: true } },
    });
    const document = compose as { services: Record<string, { ports?: unknown }> };
    expect(Object.keys(document.services).sort()).toEqual(["gateway", "host", "postgres"]);
    expect(document.services.postgres?.ports).toBeUndefined();
  });

  it("runs the published team images, whose gateway proxies to a configurable Host", async () => {
    const compose = parse(await readFile(resolve("deploy/team/compose.yaml"), "utf8"));
    for (const [service, image] of [
      ["host", "opensteer-team-host"],
      ["gateway", "opensteer-team-gateway"],
    ] as const) {
      expect(compose.services[service].image).toBe(
        `ghcr.io/steerlabs/${image}:\${OPENSTEER_TEAM_VERSION:?required}`,
      );
      expect(compose.services[service].build).toBeUndefined();
    }
    expect(compose.services.gateway.volumes).toEqual(["caddy-data:/data"]);
    const caddyfile = await readFile(resolve("deploy/team/Caddyfile"), "utf8");
    expect(caddyfile.match(/reverse_proxy .+/gu)).toEqual([
      "reverse_proxy {$OPENSTEER_HOST_UPSTREAM:host:4310}",
    ]);
    // The Host serves the first-owner setup and invite pages; the web app must not shadow them.
    const api = caddyfile
      .match(/@api path ([^\n]+)/u)?.[1]
      ?.trim()
      .split(/\s+/u);
    expect(api).toEqual(expect.arrayContaining([teamSetupPagePath, `${teamInvitePagePrefix}*`]));
    const containerfile = await readFile(resolve("deploy/container/Containerfile"), "utf8");
    const gatewayStage = containerfile.slice(
      containerfile.indexOf(" AS team-gateway\n"),
      containerfile.indexOf("\nFROM ", containerfile.indexOf(" AS team-gateway\n")),
    );
    expect(gatewayStage).toContain("\nCOPY deploy/team/Caddyfile /etc/caddy/Caddyfile\n");
  });
});
