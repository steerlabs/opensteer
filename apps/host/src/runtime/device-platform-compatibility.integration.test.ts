import {
  hostApiCurrentHeader,
  hostApiVersionHeader,
  minimumHostApiVersion,
} from "@opensteer/deployment-authority";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testRpcRequest } from "../server/test-host-api-request.js";
import {
  createMachineAccessDatabase,
  startMachineAccessWireHost,
} from "./machine-access-protocol.test-support.js";

const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("device platform release compatibility", () => {
  let database: Awaited<ReturnType<typeof createMachineAccessDatabase>>;
  beforeAll(async () => {
    database = await createMachineAccessDatabase(databaseUrl!);
  }, 120_000);
  afterAll(async () => {
    await database?.drop();
  }, 120_000);

  it("refuses the retired v60 device window and serves the current minimum", async () => {
    const host = await startMachineAccessWireHost(database.url, { remoteAccess: true });
    try {
      const retired = await testRpcRequest(
        host.origin,
        "machines.list",
        {},
        {
          headers: {
            ...host.ownerHeaders,
            [hostApiVersionHeader]: "60",
            [hostApiCurrentHeader]: "60",
          },
        },
      );
      expect(retired.status).toBe(400);
      expect(await retired.json()).toMatchObject({
        ok: false,
        error: { reason: "unsupported-version" },
      });
      const current = await testRpcRequest(
        host.origin,
        "machines.list",
        {},
        {
          headers: {
            ...host.ownerHeaders,
            [hostApiVersionHeader]: String(minimumHostApiVersion),
            [hostApiCurrentHeader]: String(minimumHostApiVersion),
          },
        },
      );
      expect(current.status).toBe(200);
      expect(await current.json()).toMatchObject({
        ok: true,
        data: { machines: expect.any(Array) },
      });
    } finally {
      await host.close();
    }
  });
});
