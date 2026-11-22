import { execFile, execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { request } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  opensteerAccountOAuthScopes,
  opensteerDesktopAccountOAuthCallback,
  opensteerDesktopOAuthClientId,
} from "../../packages/core/src/index.js";
import { createControlPlaneDatabase } from "../../apps/control-plane/src/database/database.js";
import {
  journeyAccount,
  startJourneyAccountService,
  type JourneyAccountService,
} from "./account-service.js";
import { journeyAccountName } from "./account-tls.js";
import { signInAtAccount } from "./browser.js";

/*
 * The first-run journey's account service as the guest serves it, run here: under the fixture
 * name over HTTPS, with a certificate from a fixture authority made by the same script the guest
 * step uses (`scripts/test-vm/fixture-authority-files.sh`). This Mac has no hosts-file line for the
 * name, so each request here is sent to loopback by hand, as that line would send it.
 *
 * What the journey's later steps need of it, checked before a VM runs them: the stand-in browser
 * signs in through it; the code is exchanged for tokens; the tokens name the HTTPS origin as their
 * issuer, which is what the Host checks (`RemotePersonalAccountGrantVerifier`); the Host's key
 * fetch (`/api/auth/jwks`) answers over TLS; and a Node process given only NODE_EXTRA_CA_CERTS,
 * as the Mac app gives its Host, trusts the certificate.
 */

const databaseUrl = process.env.OPENSTEER_CONTROL_PLANE_TEST_DATABASE_URL;
// It needs the account service's PostgreSQL, which only pnpm test:integration provides.
const integration = databaseUrl ? describe : describe.skip;
const repositoryRoot = path.resolve(import.meta.dirname, "../..");

integration("the first-run journey's account service over HTTPS", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "first-run-authority-"));
  let account: JourneyAccountService;
  let ca: string;

  beforeAll(async () => {
    execFileSync("/bin/bash", [
      path.join(repositoryRoot, "scripts/test-vm/fixture-authority-files.sh"),
      directory,
      "Opensteer journey fixture authority",
      journeyAccountName,
    ]);
    ca = readFileSync(path.join(directory, "ca.pem"), "utf8");
    account = await startJourneyAccountService({
      databaseUrl: databaseUrl!,
      tls: {
        cert: readFileSync(path.join(directory, "account.pem"), "utf8"),
        key: readFileSync(path.join(directory, "account.key"), "utf8"),
        name: journeyAccountName,
      },
    });
  });

  afterAll(async () => {
    await account?.close();
    const database = createControlPlaneDatabase({ connectionString: databaseUrl! });
    try {
      await sql`delete from users where email = ${journeyAccount.email}`.execute(database);
    } finally {
      await database.destroy();
    }
  });

  /** One HTTPS request to the account service, trusting the fixture authority, sent to loopback. */
  function fetchJson(url: URL, init: { method?: string; body?: string } = {}) {
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
      const outgoing = request(
        url,
        {
          ca,
          headers: init.body
            ? {
                "content-length": String(Buffer.byteLength(init.body)),
                "content-type": "application/x-www-form-urlencoded",
              }
            : {},
          lookup: (_host, options, callback) =>
            (options as { all?: boolean }).all
              ? (callback as (e: null, a: { address: string; family: number }[]) => void)(null, [
                  { address: "127.0.0.1", family: 4 },
                ])
              : callback(null, "127.0.0.1", 4),
          method: init.method ?? "GET",
        },
        (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
          incoming.on("end", () =>
            resolve({
              body: Buffer.concat(chunks).toString("utf8"),
              status: incoming.statusCode ?? 0,
            }),
          );
        },
      );
      outgoing.on("error", reject);
      outgoing.end(init.body);
    });
  }

  it("is a bare public HTTPS origin under the fixture name", () => {
    const origin = new URL(account.origin);
    expect(origin.protocol).toBe("https:");
    expect(origin.hostname).toBe(journeyAccountName);
  });

  it("signs the journey in, issues tokens that name its HTTPS origin, and serves its keys over TLS", async () => {
    const verifier = randomBytes(48).toString("base64url");
    const state = randomUUID();
    const authorize = new URL("/api/auth/oauth2/authorize", account.origin);
    authorize.searchParams.set("client_id", opensteerDesktopOAuthClientId);
    authorize.searchParams.set(
      "code_challenge",
      createHash("sha256").update(verifier).digest("base64url"),
    );
    authorize.searchParams.set("code_challenge_method", "S256");
    authorize.searchParams.set("prompt", "login");
    authorize.searchParams.set("redirect_uri", opensteerDesktopAccountOAuthCallback);
    authorize.searchParams.set("resource", account.origin);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("scope", opensteerAccountOAuthScopes.join(" "));
    authorize.searchParams.set("state", state);

    const signedIn = await signInAtAccount({
      authorizeUrl: authorize.toString(),
      email: journeyAccount.email,
      password: journeyAccount.password,
      tls: { address: "127.0.0.1", ca },
    });
    const code = new URL(signedIn.callback).searchParams.get("code");
    expect(code).toBeTruthy();

    const token = await fetchJson(new URL("/api/auth/oauth2/token", account.origin), {
      body: new URLSearchParams({
        client_id: opensteerDesktopOAuthClientId,
        code: code!,
        code_verifier: verifier,
        grant_type: "authorization_code",
        redirect_uri: opensteerDesktopAccountOAuthCallback,
        resource: account.origin,
      }).toString(),
      method: "POST",
    });
    expect(token.status, token.body).toBe(200);
    const accessToken = (JSON.parse(token.body) as { access_token: string }).access_token;
    const [header, payload] = accessToken
      .split(".")
      .slice(0, 2)
      .map(
        (part) =>
          JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>,
      );
    // What the Host checks a token against: its issuer is the account service's HTTPS origin.
    expect(payload!["iss"]).toBe(account.origin);

    // The key the Host fetches to verify it, over TLS, from the issuer.
    const keys = await fetchJson(new URL("/api/auth/jwks", account.origin));
    expect(keys.status).toBe(200);
    const kids = (JSON.parse(keys.body) as { keys: { kid: string }[] }).keys.map(({ kid }) => kid);
    expect(kids).toContain(header!["kid"]);
  });

  it("is trusted by a Node process given only NODE_EXTRA_CA_CERTS, as the Host is", async () => {
    const port = new URL(account.origin).port;
    const probe = `
      const request = require("node:https").request({
        host: "127.0.0.1", port: ${port}, path: "/api/auth/jwks", servername: "${journeyAccountName}",
        headers: { host: "${journeyAccountName}:${port}" },
      }, (answer) => { process.stdout.write(String(answer.statusCode)); answer.resume(); });
      request.on("error", (error) => { process.stdout.write(error.code ?? error.message); });
      request.end();`;
    // Not synchronously: this process serves the account service the probe calls.
    const run = (environment: NodeJS.ProcessEnv) =>
      new Promise<string>((resolve) =>
        execFile(
          process.execPath,
          ["-e", probe],
          { env: environment, timeout: 15_000 },
          (_e, out) => resolve(String(out)),
        ),
      );
    expect(await run({ NODE_EXTRA_CA_CERTS: path.join(directory, "ca.pem") })).toBe("200");
    // Without it, Node's bundled roots alone refuse it: what the Host saw before.
    expect(await run({})).toBe("UNABLE_TO_VERIFY_LEAF_SIGNATURE");
  });
});
