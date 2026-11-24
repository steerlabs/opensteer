import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import type { RequestOptions } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  assertAccountAddressPublic,
  journeyAccountAddress,
  journeyAccountName,
  type JourneyAccountTls,
} from "./account-tls.js";

/*
 * Run on e7080ea31: the journey signed in and stopped at linking the Home
 * (`personal-account-link-completion-grant-rejected`). The walker's reading: the Host fetches the
 * account service's keys through a resolver that refuses any name answering a non-public address,
 * and the guest's hosts line put the fixture name on 127.0.0.1.
 *
 * Here the Host's own verifier is given the journey's configuration: the issuer the account
 * service names itself by, served over TLS with the fixture authority's certificate, trusted as
 * the Host trusts it (the authority added to Node's roots, as NODE_EXTRA_CA_CERTS adds it). Only
 * what the name resolves to differs between the two runs, as a hosts line would answer it.
 */

const resolver = vi.hoisted(() => ({ answer: "127.0.0.1" }));
const network = vi.hoisted(() => ({
  ca: "",
  /** Where the guest's loopback alias takes a connection to its address: this test's server. */
  loopbackPort: 0,
  dialled: [] as string[],
}));

vi.mock("node:dns/promises", async (original) => ({
  ...(await original<typeof import("node:dns/promises")>()),
  // As the guest's resolver answers the name once the hosts line is in.
  lookup: async (hostname: string) => {
    if (hostname !== journeyAccountName) throw new Error(`unexpected lookup of ${hostname}`);
    return [{ address: resolver.answer, family: 4 }];
  },
}));

vi.mock("node:https", async (original) => {
  const https = await original<typeof import("node:https")>();
  return {
    ...https,
    request: (options: RequestOptions, ...rest: unknown[]) => {
      network.dialled.push(String(options.hostname));
      // The guest's loopback alias: a connection to that address is answered on this machine.
      const local =
        options.hostname === journeyAccountAddress
          ? { hostname: "127.0.0.1", port: network.loopbackPort }
          : {};
      return (https.request as (...a: unknown[]) => unknown)(
        { ...options, ...local, ca: network.ca },
        ...rest,
      );
    },
  };
});

const { RemotePersonalAccountGrantVerifier } =
  await import("../../apps/host/src/access/personal-account-grant-verifier.js");
const { isPublicIp, resolvePublicAddresses } =
  await import("../../packages/access/src/public-network.js");
const { createServer } = await import("node:https");

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const step = readFileSync(path.join(repositoryRoot, "scripts/test-vm/fixture-keychain.sh"), "utf8");

describe("the Host's account key fetch, given the first-run journey's configuration", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "first-run-account-address-"));
  const keys = generateKeyPairSync("ed25519");
  const kid = "journey-key";
  let server: ReturnType<typeof createServer>;
  let issuer: URL;
  let fetched = 0;

  beforeAll(async () => {
    execFileSync("/bin/bash", [
      path.join(repositoryRoot, "scripts/test-vm/fixture-authority-files.sh"),
      directory,
      "Opensteer journey fixture authority",
      journeyAccountName,
    ]);
    network.ca = readFileSync(path.join(directory, "ca.pem"), "utf8");
    const jwks = JSON.stringify({
      keys: [{ ...keys.publicKey.export({ format: "jwk" }), alg: "EdDSA", kid, use: "sig" }],
    });
    server = createServer(
      {
        cert: readFileSync(path.join(directory, "account.pem"), "utf8"),
        key: readFileSync(path.join(directory, "account.key"), "utf8"),
      },
      (incoming, outgoing) => {
        fetched += 1;
        if (incoming.url !== "/api/auth/jwks") outgoing.writeHead(404).end();
        else outgoing.writeHead(200, { "content-type": "application/json" }).end(jwks);
      },
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    network.loopbackPort = (server.address() as { port: number }).port;
    // The account service's origin as the journey serves it: its TLS front's port, the fixture name.
    issuer = new URL(`https://${journeyAccountName}:${network.loopbackPort}`);
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  /** A grant the account service signed for this Home: its issuer, its audience, its key. */
  const grant = (audience: string) => {
    const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const now = Math.floor(Date.now() / 1_000);
    const signed = `${part({ alg: "EdDSA", kid })}.${part({
      aud: audience,
      exp: now + 120,
      iat: now,
      iss: issuer.origin,
      jti: randomUUID(),
      tokenUse: "opensteer-personal-host-account-link",
    })}`;
    return `${signed}.${sign(null, Buffer.from(signed), keys.privateKey).toString("base64url")}`;
  };

  /** What the verifier refused a grant for, through each cause, innermost last. */
  async function refusal(answer: string): Promise<string[]> {
    resolver.answer = answer;
    network.dialled.length = 0;
    const audience = "https://home.first-run.opensteer.example";
    const verifier = new RemotePersonalAccountGrantVerifier({ audience, issuer });
    try {
      await verifier.verifyLink(grant(audience));
      return [];
    } catch (error) {
      const reasons: string[] = [];
      for (let cause: unknown = error; cause instanceof Error; cause = cause.cause)
        reasons.push(cause.name === "ZodError" ? "the grant's claims" : cause.message);
      return reasons;
    }
  }

  it("refuses the name on loopback, as e7080ea31's hosts line put it, for its address alone", async () => {
    const before = fetched;
    expect(await refusal("127.0.0.1")).toEqual([
      "Account-link completion grant is invalid or expired",
      "Egress destination resolved to a non-public address",
    ]);
    // Refused before it dialled anything: no TLS, no key fetch.
    expect(network.dialled).toEqual([]);
    expect(fetched).toBe(before);
  });

  it("fetches the keys and verifies the grant's signature, issuer and audience at the guest's address", async () => {
    const before = fetched;
    // Past the address, the certificate, the key fetch, the signature, the issuer, the audience
    // and the grant's age: what is left is the shape of its claims, which this test does not make.
    expect(await refusal(journeyAccountAddress)).toEqual([
      "Account-link completion grant is invalid or expired",
      "the grant's claims",
    ]);
    expect(network.dialled).toEqual([journeyAccountAddress]);
    expect(fetched).toBe(before + 1);
  });
});

describe("the guest's address for the account service's name", () => {
  it("is one the Host's resolver counts as public", async () => {
    expect(isPublicIp(journeyAccountAddress)).toBe(true);
    resolver.answer = journeyAccountAddress;
    await expect(resolvePublicAddresses(journeyAccountName)).resolves.toEqual([
      { address: journeyAccountAddress, family: 4 },
    ]);
  });

  // The journey's own check before it launches anything: what the run on e7080ea31 needed.
  it("is what the journey checks the name resolves to before it launches anything", async () => {
    const tls = { address: journeyAccountAddress, name: journeyAccountName } as JourneyAccountTls;
    resolver.answer = "127.0.0.1";
    await expect(assertAccountAddressPublic(tls)).rejects.toThrow(
      `The Host would refuse ${journeyAccountName}: Egress destination resolved to a non-public address. scripts/test-vm/fixture-keychain.sh puts it on ${journeyAccountAddress}.`,
    );
    resolver.answer = journeyAccountAddress;
    await expect(assertAccountAddressPublic(tls)).resolves.toBeUndefined();
  });

  // 192.88.99.0/24 was the 6to4 relay anycast prefix, deprecated by RFC 7526: no destination a
  // guest reaches lives there, and the alias takes only its one address, inside the guest.
  it("is in the deprecated 6to4 relay prefix, and is what the guest step puts the name on", () => {
    expect(journeyAccountAddress).toMatch(/^192\.88\.99\.\d{1,3}$/u);
    expect(step).not.toContain(`hosts_line="127.0.0.1 `);
    expect(step).toContain(`account_address="${journeyAccountAddress}"`);
    expect(step).toContain('hosts_line="$account_address $account_name');
  });
});
