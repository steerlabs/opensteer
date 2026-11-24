import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:https";
import type { LookupFunction } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { journeyAccountName } from "./account-tls.js";
import { presentedCertificate } from "./tls-evidence.js";

/*
 * What the journey records when its sign-in refuses a certificate, held to the two cases the
 * guest's "self-signed certificate" could be: the account service's own certificate (from the
 * guest step's script), and a self-signed server certificate from elsewhere. The authority's own
 * certificate served in its place is refused otherwise ("unsuitable certificate purpose"), so the
 * guest's refusal was not that. The name is sent to loopback, as the guest's hosts line sends it.
 */

const script = path.resolve(
  import.meta.dirname,
  "../../scripts/test-vm/fixture-authority-files.sh",
);
function authorityFiles(): (name: string) => string {
  const directory = mkdtempSync(path.join(tmpdir(), "first-run-tls-evidence-"));
  execFileSync("/bin/bash", [
    script,
    directory,
    "Opensteer journey fixture authority",
    journeyAccountName,
  ]);
  return (name) => readFileSync(path.join(directory, name), "utf8");
}
/** A server certificate for the name that is its own issuer, as a server of something else has. */
function selfSignedServerCertificate(): [cert: string, key: string] {
  const directory = mkdtempSync(path.join(tmpdir(), "first-run-self-signed-"));
  const config = path.join(directory, "self.cnf");
  writeFileSync(
    config,
    `[req]\ndistinguished_name = dn\nprompt = no\n[dn]\nCN = elsewhere\n[server]\nbasicConstraints = critical, CA:false\nkeyUsage = critical, digitalSignature, keyEncipherment\nextendedKeyUsage = serverAuth\nsubjectAltName = DNS:${journeyAccountName}\n`,
  );
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-new",
      "-nodes",
      "-newkey",
      "rsa:2048",
      "-days",
      "1",
      "-keyout",
      path.join(directory, "key.pem"),
      "-out",
      path.join(directory, "cert.pem"),
      "-config",
      config,
      "-extensions",
      "server",
    ],
    { stdio: "ignore" },
  );
  return [
    readFileSync(path.join(directory, "cert.pem"), "utf8"),
    readFileSync(path.join(directory, "key.pem"), "utf8"),
  ];
}
const loopback: LookupFunction = (_host, options, callback) =>
  (options as { all?: boolean }).all
    ? (callback as (e: null, a: { address: string; family: number }[]) => void)(null, [
        { address: "127.0.0.1", family: 4 },
      ])
    : callback(null, "127.0.0.1", 4);

describe("what the journey records of a refused certificate", () => {
  const job = authorityFiles();
  const servers: Server[] = [];
  let account: string;
  let selfSigned: string;

  async function serve(cert: string, key: string): Promise<string> {
    const server = createServer({ cert, key }, (_incoming, outgoing) => outgoing.end("ok"));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    return `https://${journeyAccountName}:${port}`;
  }

  beforeAll(async () => {
    account = await serve(job("account.pem"), job("account.key"));
    selfSigned = await serve(...selfSignedServerCertificate());
  });
  afterAll(() => {
    for (const server of servers) server.close();
  });

  it("is not what the authority's own certificate in the leaf's place is refused as", async () => {
    const authorityAsLeaf = await serve(job("ca.pem"), job("ca.key"));
    expect(await signInClient(authorityAsLeaf)).toBe("unsuitable certificate purpose");
  });

  /** The journey's sign-in client, trusting the job's authority: its error, or its status. */
  function signInClient(origin: string): Promise<string> {
    return new Promise((resolve) => {
      const outgoing = request(
        new URL("/api", origin),
        { ca: job("ca.pem"), lookup: loopback },
        (answer) => {
          answer.resume();
          resolve(String(answer.statusCode));
        },
      );
      outgoing.on("error", (error) => resolve(error.message));
      outgoing.end();
    });
  }

  it("names the account service's own certificate, from loopback, when that is what answered", async () => {
    expect(await signInClient(account)).toBe("200");
    const presented = await presentedCertificate(account, job("account.pem"), loopback);
    expect(presented).toMatchObject({
      accountCertificate: true,
      address: "127.0.0.1",
      selfIssued: false,
    });
  });

  it("names a self-signed certificate that is not the account service's, the guest's refusal word for word", async () => {
    expect(await signInClient(selfSigned)).toMatch(/^self-signed certificate/u);
    const presented = await presentedCertificate(selfSigned, job("account.pem"), loopback);
    expect(presented).toMatchObject({
      accountCertificate: false,
      address: "127.0.0.1",
      selfIssued: true,
    });
    expect(presented.subject).toBe("CN=elsewhere");
  });
});
