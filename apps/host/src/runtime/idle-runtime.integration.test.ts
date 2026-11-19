import pg from "pg";
import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  connectCallerMachine,
  createMachineAccessDatabase,
  startMachineAccessWireHost,
  type CallerMachine,
  type MachineAccessWireHost,
} from "./machine-access-protocol.test-support.js";

const baseDatabaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
// Needs the PostgreSQL that `pnpm test:integration` provides.
const integration = baseDatabaseUrl ? describe : describe.skip;

/**
 * The idle proof for the whole personal runtime: Request deadlines, the Run
 * finish drain, triggers, retries and the connected Runner's heartbeats all
 * run, and none of them touches PostgreSQL while nothing happens.
 */
integration("An idle personal Host", () => {
  let database: Awaited<ReturnType<typeof createMachineAccessDatabase>> | undefined;
  let host: MachineAccessWireHost | undefined;
  let runner: CallerMachine | undefined;
  let restoreQuery = () => {};
  afterEach(async () => {
    restoreQuery();
    vi.useRealTimers();
    await runner?.close();
    await host?.close();
    await database?.drop();
  }, 120_000);

  it("runs no PostgreSQL statements for five minutes with a connected Runner", async () => {
    // Faked before the Host starts, so every timer it arms is on this clock;
    // shouldAdvanceTime lets startup run in real time.
    vi.useFakeTimers({
      shouldAdvanceTime: true,
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    });
    database = await createMachineAccessDatabase(baseDatabaseUrl!);
    host = await startMachineAccessWireHost(database.url, { manualRunner: true });
    runner = await connectCallerMachine(host, {
      name: "Hosting computer",
      token: host.hostingRunnerEnrollmentToken,
    });
    let renewals = 0;
    runner.primary.socket.on("message", (frame: WebSocket.RawData) => {
      if (
        (JSON.parse(frame.toString()) as { type: string }).type === "host.connection.lease-renewed"
      )
        renewals++;
    });
    const statements: string[] = [];
    // Every statement any pg client in this process sends, by its text.
    const prototype = pg.Client.prototype as unknown as { query: (...args: unknown[]) => unknown };
    const query = prototype.query;
    restoreQuery = () => {
      prototype.query = query;
    };
    prototype.query = function (this: pg.Client, ...args: unknown[]): unknown {
      const [text] = args as [string | { text?: string } | undefined];
      statements.push(typeof text === "string" ? text : (text?.text ?? "?"));
      return query.apply(this, args);
    };

    // One heartbeat interval at a time, with each heartbeat answered, until
    // two whole minutes pass with no statement: registration's tail (catalog
    // capture, watch reconcile, first passes) has finished.
    const heartbeat = async () => {
      const before = renewals;
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.waitFor(() => expect(renewals).toBeGreaterThan(before), {
        timeout: 10_000,
        interval: 50,
      });
    };
    let quiet = 0;
    for (let interval = 0; interval < 40 && quiet < 8; interval++) {
      const before = statements.length;
      await heartbeat();
      quiet = statements.length === before ? quiet + 1 : 0;
    }
    expect(quiet).toBe(8);
    statements.length = 0;
    // Every heartbeat in the window is answered, so the Host handled each one.
    for (let elapsed = 0; elapsed < 5 * 60_000; elapsed += 15_000) await heartbeat();
    expect(statements).toEqual([]);
  }, 180_000);
});
