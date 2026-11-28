import { createDatabase, migrateToLatest } from "@opensteer/database";
import { hostApiVersion } from "@opensteer/deployment-authority";
import { hostApiVersionHeader } from "@opensteer/protocol";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  startPrivateMachineHost,
  type MachineAccessHost,
} from "../runtime/private-machine-host.test-support.js";

const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
// Skipped without the integration launcher's database: the walk needs a real Host.
const integration = databaseUrl ? describe : describe.skip;

/** Every route the Host serves, read from the server itself: a route added later is walked too. */
function routes(printed: string): { method: string; path: string }[] {
  const found = new Map<string, { method: string; path: string }>();
  for (const line of printed.split("\n")) {
    const match = /(\/\S*) \(([A-Z, ]+)\)/u.exec(line);
    if (!match) continue;
    const path = match[1]!.replace(/:[A-Za-z]+/gu, "x").replace(/\*$/u, "x");
    for (const method of match[2]!.split(/,\s*/u))
      if (["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method))
        found.set(`${method} ${path}`, { method, path });
  }
  return [...found.values()];
}

type Answer = { status: number; body: string };

/**
 * Where the Host opens sockets, each read once. The ones that take the person's cookie
 * (`/v1/realtime`, a browser session's connect, the two computer-use displays) authenticate it in
 * `HostAuthenticator.authenticateSession`, whose refusal `auth.origin.test.ts` walks; every other
 * takes a machine's token (a Runner, a bridge, an app tunnel, the shell, a connection drain, the
 * desktop supervisor's hello). A new file here is a socket to sort before this test passes again.
 * (A refused upgrade holds the Host's close in this harness, so sockets are not opened here.)
 */
const socketSources = [
  "apps/host/src/access/personal-remote-administration-routes.ts",
  "apps/host/src/apps/app-gateway.ts",
  "apps/host/src/apps/app-routes.ts",
  "apps/host/src/browser/standard-cdp-route.ts",
  "apps/host/src/browser/trigger-cdp-bridge.ts",
  "apps/host/src/computer-use/computer-use-display-routes.ts",
  "apps/host/src/server.ts",
  "apps/host/src/server/browser-source-registration.ts",
  "apps/host/src/server/connection-drain.ts",
  "apps/host/src/shell/shell-routes.ts",
];

describe("the Host's sockets are all sorted (q1)", () => {
  it("names every file that opens one", async () => {
    const { readdir, readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const root = join(import.meta.dirname, "../../../..");
    const found: string[] = [];
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
        const path = `${directory}/${entry.name}`;
        if (entry.isDirectory()) await walk(path);
        else if (
          entry.name.endsWith(".ts") &&
          !/\.(?:test|test-support|integration\.test)\.ts$/u.test(entry.name) &&
          /websocket: true|on\("upgrade"/u.test(await readFile(join(root, path), "utf8"))
        )
          found.push(path);
      }
    };
    await walk("apps/host/src");
    expect(found.sort()).toEqual([...socketSources].sort());
  });
});

integration("a cookie's request comes from the Home's own page, on every route (q1)", () => {
  let host: MachineAccessHost | undefined;

  beforeEach(async () => {
    const database = createDatabase({ connectionString: databaseUrl ?? "postgres://unconfigured" });
    await migrateToLatest(database);
    await sql`
      truncate table credential_vault_canaries, deployments, users, runners restart identity cascade
    `.execute(database);
    await sql`
      insert into principals(id, kind, user_id, display_name)
      values ('pri_00000000-0000-4000-8000-000000000001', 'system', null, 'Opensteer')
      on conflict (id) do nothing
    `.execute(database);
    await database.destroy();
  });

  afterEach(async () => {
    await host?.close();
  }, 120_000);

  it("answers a foreign page's request that carries the person's cookie as one without it", async () => {
    host = await startPrivateMachineHost(databaseUrl!, { remoteAccess: true });
    const origin = host.origin.origin;
    const cookie = host.ownerHeaders.cookie!;
    const table = routes(host.runtime.app.printRoutes({ commonPrefix: false }));
    expect(table.length).toBeGreaterThan(100);
    const ask = async (method: string, path: string, headers: Record<string, string>) => {
      const url = new URL(path, origin);
      if (path.startsWith("/v1/rpc/") && method === "GET") url.searchParams.set("input", "{}");
      const response = await fetch(url, {
        method,
        headers: {
          [hostApiVersionHeader]: String(hostApiVersion),
          // No connection outlives its request: the Host's close drains open ones.
          connection: "close",
          ...(method === "GET" ? {} : { "content-type": "application/json" }),
          ...headers,
        },
        ...(method === "GET" || method === "DELETE" ? {} : { body: "{}" }),
        redirect: "manual",
      });
      return { status: response.status, body: await response.text() } satisfies Answer;
    };
    const foreign = [
      { origin: "http://127.0.0.1:5173" },
      { "sec-fetch-site": "same-site" },
      { "sec-fetch-site": "cross-site", origin: "https://evil.example" },
    ];
    const accepted: string[] = [];
    // A machine's routes (a Runner's, a bridge's, a webhook's) take a token or a signature, never
    // the person's cookie, and some start work of their own on any request: they are not walked.
    const machine = /^\/(?:internal\/|v1\/runner\/|hooks\/)/u;
    for (const { method, path } of table.filter(({ path }) => !machine.test(path))) {
      const without = await ask(method, path, { "sec-fetch-site": "same-site" });
      for (const headers of foreign) {
        const withCookie = await ask(method, path, { ...headers, cookie });
        // A public route answers as it does for anyone; every other one refuses. Either way the
        // person's cookie changes nothing for a page that is not the Home's own.
        const same =
          withCookie.status === without.status &&
          (withCookie.status >= 400 || withCookie.body === without.body);
        if (!same && withCookie.status < 400)
          accepted.push(`${method} ${path} ${JSON.stringify(headers)}`);
      }
    }
    expect(accepted).toEqual([]);

    // What must keep working does: the Home's own page, the app, the address bar.
    const ownRead = await ask("GET", "/v1/auth/session", {
      cookie,
      "sec-fetch-site": "same-origin",
    });
    expect(ownRead.status).toBe(200);
    expect(ownRead.body).toContain('"user"');
    const typed = await ask("GET", "/v1/auth/session", { cookie, "sec-fetch-site": "none" });
    expect(typed.status).toBe(200);
    const desktop = await ask("GET", "/v1/rpc/personal.shell.get", { cookie, origin });
    expect(desktop.status).toBe(200);
    const update = await ask("GET", "/maintenance/v1/desktop-update", {
      cookie,
      origin,
      "sec-fetch-site": "same-origin",
    });
    expect(update.status).not.toBe(403);
  }, 600_000);
});
