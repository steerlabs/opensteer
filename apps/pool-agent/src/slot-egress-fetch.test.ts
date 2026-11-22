/**
 * Round H: a pool host pulls a slot's upstream credentials from the account service, signed by
 * its host key, to the fixed contract. Written before the fetch existed.
 */
import { execFileSync } from "node:child_process";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fetchSlotEgress, slotEgressBytes } from "./slot-egress-fetch.js";

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** A self-signed identity for 127.0.0.1, trusted only by these tests. */
function identity() {
  const directory = mkdtempSync(join(tmpdir(), "opensteer-slot-egress-"));
  execFileSync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:prime256v1",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=127.0.0.1",
    "-addext",
    "subjectAltName=IP:127.0.0.1",
    "-keyout",
    join(directory, "key.pem"),
    "-out",
    join(directory, "cert.pem"),
  ]);
  return {
    key: readFileSync(join(directory, "key.pem")),
    cert: readFileSync(join(directory, "cert.pem")),
  };
}

const tls = identity();
const hostKeys = generateKeyPairSync("ed25519");

/** A stand-in account service: answers with `answer`, and keeps each request it got. */
async function account(answer: (body: Record<string, string>) => { status: number; body: string }) {
  const requests: { path: string; body: Record<string, string> }[] = [];
  const server = createServer({ key: tls.key, cert: tls.cert }, (request, response) => {
    let text = "";
    request.on("data", (chunk: Buffer) => (text += chunk.toString("utf8")));
    request.on("end", () => {
      const body = JSON.parse(text) as Record<string, string>;
      requests.push({ path: request.url ?? "", body });
      const reply = answer(body);
      response.writeHead(reply.status, { "content-type": "application/json" });
      response.end(reply.body);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const fetch = (slotId = "bps_test") =>
    fetchSlotEgress({
      origin,
      hostId: "ph_test",
      hostKey: hostKeys.privateKey,
      slotId,
      signal: AbortSignal.timeout(5_000),
      ca: [tls.cert.toString()],
    });
  return { requests, fetch, origin };
}

const assigned = {
  egress: { url: "https://upstream.example:8443", username: "u-1", password: "p@ss word" },
};

describe("the signed request", () => {
  it("signs exactly the contract's bytes", () => {
    expect(
      slotEgressBytes("ph_test", "bps_test", "2026-11-22T00:00:00.000Z", "AAAAAAAAAAAAAAAAAAAAAA"),
    ).toEqual(
      Buffer.from(
        "opensteer-pool-slot-egress-v1\nph_test\nbps_test\n2026-11-22T00:00:00.000Z\nAAAAAAAAAAAAAAAAAAAAAA",
        "utf8",
      ),
    );
  });

  it("sends a request whose signature verifies with the host's public key over those bytes", async () => {
    const service = await account(() => ({ status: 200, body: "{}" }));
    await service.fetch();
    const { path, body } = service.requests[0]!;
    expect(path).toBe("/v1/browser-pool/hosts/ph_test/slot-egress");
    expect(Object.keys(body).sort()).toEqual(
      ["hostId", "issuedAt", "nonce", "signature", "slotId", "v"].sort(),
    );
    expect(body).toMatchObject({ v: 1, hostId: "ph_test", slotId: "bps_test" });
    expect(body.issuedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u);
    expect(body.nonce).toMatch(/^[A-Za-z0-9_-]{22}$/u);
    const bytes = slotEgressBytes(body.hostId!, body.slotId!, body.issuedAt!, body.nonce!);
    expect(
      verify(
        null,
        bytes,
        createPublicKey(hostKeys.privateKey),
        Buffer.from(body.signature!, "base64"),
      ),
    ).toBe(true);
  });
});

describe("the answer", () => {
  it("is the slot's upstream when one is assigned, and none for {}", async () => {
    const service = await account((body) =>
      body.slotId === "bps_test"
        ? { status: 200, body: JSON.stringify(assigned) }
        : { status: 200, body: "{}" },
    );
    expect(await service.fetch()).toEqual({
      upstreamUrl: "https://upstream.example:8443",
      username: "u-1",
      password: "p@ss word",
    });
    expect(await service.fetch("bps_other")).toBeNull();
  });

  it("could not be completed for anything else, and never names the password", async () => {
    const bad = [
      { status: 302, body: "{}" },
      { status: 500, body: JSON.stringify(assigned) },
      { status: 200, body: "not json" },
      { status: 200, body: JSON.stringify({ egress: null }) },
      { status: 200, body: JSON.stringify({ egress: { ...assigned.egress, url: "http://x:1" } }) },
      {
        status: 200,
        body: JSON.stringify({ egress: { ...assigned.egress, url: "https://a:b@x:1" } }),
      },
      { status: 200, body: JSON.stringify({ egress: { ...assigned.egress, username: "a:b" } }) },
      { status: 200, body: JSON.stringify({ ...assigned, extra: true }) },
      { status: 200, body: JSON.stringify({ pad: "x".repeat(17 * 1024) }) },
    ];
    for (const reply of bad) {
      const service = await account(() => reply);
      const error = await service.fetch().then(
        () => undefined,
        (failure: unknown) => failure,
      );
      expect(error).toBeInstanceOf(Error);
      expect(String((error as Error).message)).not.toContain("p@ss");
    }
  });

  it("is refused when its origin's certificate is not trusted", async () => {
    const service = await account(() => ({ status: 200, body: JSON.stringify(assigned) }));
    // The system's roots only: this test's self-signed root is not among them.
    const untrusted = fetchSlotEgress({
      origin: service.origin,
      hostId: "ph_test",
      hostKey: hostKeys.privateKey,
      slotId: "bps_test",
      signal: AbortSignal.timeout(5_000),
    });
    await expect(untrusted).rejects.toThrow();
    expect(service.requests).toEqual([]);
  });

  // Round I, U8: a response cut off part-way fails at once, not at the fetch's deadline.
  it("could not be completed, at once, when the answer is cut off", async () => {
    const server = createServer({ key: tls.key, cert: tls.cert }, (_request, response) => {
      response.writeHead(200, { "content-type": "application/json", "content-length": "500" });
      response.write('{"egress": {"url": "https://up');
      setTimeout(() => response.socket?.destroy(), 50);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const started = Date.now();
    const outcome = await fetchSlotEgress({
      origin: `https://127.0.0.1:${(server.address() as AddressInfo).port}`,
      hostId: "ph_test",
      hostKey: hostKeys.privateKey,
      slotId: "bps_test",
      signal: AbortSignal.timeout(5_000),
      ca: [tls.cert.toString()],
    }).then(
      () => "answered",
      (error: unknown) => (error as Error).name,
    );
    expect(outcome).toBe("SlotEgressUnavailable");
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
