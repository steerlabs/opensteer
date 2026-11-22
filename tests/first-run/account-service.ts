import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { sql } from "kysely";
import { freePort } from "../../packages/shared/src/loopbackPort.test-support.js";
import { loadControlPlaneConfig } from "../../apps/control-plane/src/config.js";
import { createControlPlaneDatabase } from "../../apps/control-plane/src/database/database.js";
import { startControlPlane } from "../../apps/control-plane/src/server/runtime.js";
import { MemoryConnectProvider } from "../../apps/control-plane/src/account/memory-connect-provider.test-support.js";

/**
 * The account service as the first-run journey runs it: the real account code, configured the
 * way a deployment configures it (`loadControlPlaneConfig` over an environment), on a PostgreSQL
 * of its own, with one difference: its tunnel provider is `MemoryConnectProvider`. Sign-in is the
 * account service's own App Review form, which needs no identity provider.
 */

/** The App Review sign-in the journey uses: a test account that exists only in this database. */
export const journeyAccount = {
  email: "first-run-journey@opensteer.test",
  password: "first-run-journey-password-not-a-real-credential",
} as const;

/**
 * The environment `loadControlPlaneConfig` reads. Every value is a test value: the Google and
 * Cloudflare fields satisfy the configuration's shape and are never used (nobody presses Google,
 * and the tunnel provider is handed in instead of built from them).
 */
export function accountServiceEnvironment(input: {
  readonly databaseUrl: string;
  readonly port: number;
}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "development",
    OPENSTEER_CONTROL_PLANE_DATABASE_URL: input.databaseUrl,
    OPENSTEER_CONTROL_PLANE_HOST: "127.0.0.1",
    OPENSTEER_CONTROL_PLANE_PORT: String(input.port),
    // Loopback is allowed for HTTP outside production; the portal answers on the same server
    // under a host name of its own.
    OPENSTEER_CONTROL_PLANE_PUBLIC_URL: `http://127.0.0.1:${input.port}`,
    OPENSTEER_PORTAL_ORIGIN: `http://localhost:${input.port}`,
    OPENSTEER_CONTROL_PLANE_AUTH_SECRET: randomBytes(32).toString("base64url"),
    OPENSTEER_ADOPTION_OPERATION_KEY: randomBytes(32).toString("base64url"),
    OPENSTEER_PERSONAL_ACCOUNT_LINK_OPERATION_KEY: randomBytes(32).toString("base64url"),
    OPENSTEER_APP_REVIEW_EMAIL: journeyAccount.email,
    OPENSTEER_APP_REVIEW_PASSWORD: journeyAccount.password,
    OPENSTEER_GOOGLE_CLIENT_ID: "first-run-journey-unused",
    OPENSTEER_GOOGLE_CLIENT_SECRET: "first-run-journey-unused",
    OPENSTEER_CONNECT_DOMAIN: "connect.opensteer.test",
    OPENSTEER_CONNECT_CLOUDFLARE_ACCOUNT_ID: "0".repeat(32),
    OPENSTEER_CONNECT_CLOUDFLARE_ZONE_ID: "0".repeat(32),
    OPENSTEER_CONNECT_CLOUDFLARE_API_TOKEN: "first-run-journey-unused-cloudflare-token",
    OPENSTEER_CONNECT_CREDENTIAL_DERIVATION_SECRET: randomBytes(32).toString("base64url"),
  };
}

export interface JourneyAccountService {
  readonly origin: string;
  readonly portalOrigin: string;
  readonly provider: MemoryConnectProvider;
  close(): Promise<void>;
}

export async function startJourneyAccountService(input: {
  readonly databaseUrl: string;
  readonly port?: number;
}): Promise<JourneyAccountService> {
  const port = input.port ?? (await freePort());
  const config = loadControlPlaneConfig(
    accountServiceEnvironment({ databaseUrl: input.databaseUrl, port }),
  );
  const provider = new MemoryConnectProvider();
  const runtime = await startControlPlane(config, { connectProvider: provider });
  return {
    close: runtime.close,
    origin: config.publicOrigin.origin,
    portalOrigin: config.portalOrigin.origin,
    provider,
  };
}

/** A PostgreSQL of the journey's own, from the binaries the Home's runtime ships. */
export interface JourneyPostgres {
  readonly pid: number;
  /** A URL for a fresh, empty database on it. */
  database(name: string): Promise<string>;
  stop(): Promise<void>;
}

export async function startJourneyPostgres(input: {
  readonly binDirectory: string;
  readonly dataDirectory: string;
}): Promise<JourneyPostgres> {
  const binary = (name: string) => path.join(input.binDirectory, name);
  await mkdir(path.dirname(input.dataDirectory), { recursive: true });
  run(binary("initdb"), [
    "--auth=trust",
    "--encoding=UTF8",
    "--no-locale",
    "--username=opensteer",
    "-D",
    input.dataDirectory,
  ]);
  const port = await freePort();
  const child: ChildProcess = spawn(
    binary("postgres"),
    // TCP on loopback only: no Unix socket, whose path macOS limits to 104 bytes.
    ["-D", input.dataDirectory, "-h", "127.0.0.1", "-p", String(port), "-k", ""],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  if (child.pid === undefined) throw new Error("PostgreSQL did not start");
  const pid = child.pid;
  // PostgreSQL says when it is ready: wait for that line, or for it to exit first.
  await new Promise<void>((resolve, reject) => {
    let said = "";
    const listen = (chunk: Buffer) => {
      said += chunk.toString("utf8");
      if (said.includes("database system is ready to accept connections")) {
        child.stderr?.off("data", listen);
        child.stderr?.resume();
        resolve();
      }
    };
    child.stderr?.on("data", listen);
    child.once("exit", (code) => reject(new Error(`PostgreSQL exited (${code}): ${said}`)));
  });
  return {
    pid,
    database: async (name) => {
      if (!/^[a-z][a-z0-9_]{0,40}$/u.test(name)) throw new Error("Unsafe database name");
      const server = `postgresql://opensteer@127.0.0.1:${port}`;
      const admin = createControlPlaneDatabase({ connectionString: `${server}/postgres` });
      try {
        await sql.raw(`create database ${name}`).execute(admin);
      } finally {
        await admin.destroy();
      }
      return `${server}/${name}`;
    },
    stop: async () => {
      // By its PID, and wait for it: a fast shutdown, as pg_ctl's "fast" mode sends.
      if (child.exitCode !== null) return;
      const exited = new Promise((resolve) => child.once("exit", resolve));
      process.kill(pid, "SIGINT");
      await exited;
    },
  };
}

function run(file: string, args: readonly string[]): void {
  const result = spawnSync(file, [...args], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${path.basename(file)} failed: ${result.stderr || result.stdout}`);
  }
}
