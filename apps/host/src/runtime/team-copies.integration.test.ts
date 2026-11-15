import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parseHostConfig } from "@opensteer/config";
import { createTeamFixture } from "@opensteer/database/test-support/team";
import { teamApiVersion, teamApiVersionHeader } from "@opensteer/deployment-authority";
import { createHostRuntime, type TeamHostRuntime } from "./runtime.js";

const integration = process.env.OPENSTEER_TEST_DATABASE_URL ? describe : describe.skip;

integration("team Host copies", () => {
  let team: Awaited<ReturnType<typeof createTeamFixture>>;
  let directory: string;
  const copies: TeamHostRuntime[] = [];
  beforeAll(async () => {
    team = await createTeamFixture();
    directory = await realpath(await mkdtemp(join(tmpdir(), "team-copies-")));
    const identity = await (
      await import("../identity/host-instance.js")
    ).loadOrCreateHostInstance(directory);
    await team.database
      .updateTable("deployments")
      .set({ activeHostInstanceId: identity.hostInstanceId })
      .where("id", "=", team.deploymentId)
      .execute();
    const config = parseHostConfig({
      OPENSTEER_MODE: "development",
      OPENSTEER_DEPLOYMENT_KIND: "team",
      OPENSTEER_DATABASE_URL: team.databaseUrl,
      OPENSTEER_AUTH_SECRET: randomUUID().repeat(2),
      OPENSTEER_HOST_DATA_DIR: directory,
      OPENSTEER_CANONICAL_ORIGIN: "https://team.example.invalid",
      OPENSTEER_BIND_ADDRESS: "127.0.0.1",
      OPENSTEER_PORT: "4310",
    });
    // A rollout starts the next copy while the current one still serves the same database.
    for (let index = 0; index < 2; index++) {
      const runtime = await createHostRuntime(config, { teamDrainDelayMs: 0 });
      if (runtime.kind !== "team") throw new Error("Expected a team Host");
      copies.push(runtime);
    }
  }, 60_000);
  afterAll(async () => {
    for (const copy of copies) await copy.close();
    await team?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  const ready = async (copy: TeamHostRuntime) =>
    (await copy.app.inject({ url: "/readyz" })).statusCode;

  it("serves one database from two copies, and a draining copy steps aside for the other", async () => {
    const [current, next] = copies as [TeamHostRuntime, TeamHostRuntime];
    await vi.waitFor(
      async () => {
        expect(await ready(current), "first copy never became ready").toBe(200);
        expect(await ready(next), "second copy never became ready").toBe(200);
      },
      { timeout: 10_000, interval: 50 },
    );

    await current.drain();
    expect(await ready(current)).toBe(503);
    const health = await current.app.inject({ url: "/healthz" });
    expect(health.statusCode).toBe(200);
    // A proxy's pooled connection to the draining copy is retired with its next response.
    expect(health.headers.connection).toBe("close");
    const upgrade = await current.app.inject({
      url: "/v1/realtime",
      headers: {
        upgrade: "websocket",
        connection: "Upgrade",
        [teamApiVersionHeader]: String(teamApiVersion),
      },
    });
    expect(upgrade.statusCode).toBe(503);

    expect(await ready(next)).toBe(200);
    expect((await next.app.inject({ url: "/healthz" })).headers.connection).not.toBe("close");
  });
});
