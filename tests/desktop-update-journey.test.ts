import { forbiddenPublicUpdateHosts } from "../scripts/public-download/update-traffic.js";
import { personalEndpoint } from "../scripts/public-download/personal-endpoint.js";
import {
  certificationCases,
  releaseAsset,
  requireCertifiedJourneys,
  verifyPreparedArchives,
} from "../scripts/public-download/evidence.js";
import { createHash } from "node:crypto";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { test, expect } from "vitest";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { request } from "node:https";
import { createSocket } from "node:dgram";

test("Enterprise Atom/Latest, cross-origin ranges and wildcard Account sinkhole", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "opensteer-public-mirror-"));
  const cert = path.join(dir, "cert.pem"),
    key = path.join(dir, "key.pem"),
    log = path.join(dir, "network.jsonl");
  writeFileSync(
    path.join(dir, "openssl.cnf"),
    "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=Private test\n[ext]\nsubjectAltName=DNS:github.opensteer.test,DNS:objects.opensteer.test\nbasicConstraints=critical,CA:TRUE\n",
  );
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-config",
      path.join(dir, "openssl.cnf"),
    ],
    { stdio: "ignore", timeout: 1_000 },
  );
  for (const v of ["0.1.1", "0.1.2"]) {
    mkdirSync(path.join(dir, `desktop-v${v}`));
    writeFileSync(path.join(dir, `desktop-v${v}/latest-mac.yml`), v);
  }
  writeFileSync(path.join(dir, "latest"), "desktop-v0.1.1");
  const child = spawn(
    process.execPath,
    [
      "--import",
      import.meta.resolve("tsx"),
      path.resolve("scripts/public-download/eu-mirror.ts"),
      dir,
      cert,
      key,
      log,
    ],
    { env: { ...process.env, OPENSTEER_MIRROR_TEST_PORT: "0" }, stdio: ["ignore", "pipe", "pipe"] },
  );
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  try {
    const ports = await withTimeout(
      new Promise<{ https: { port: number }; dns: { port: number } }>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", () => reject(new Error("mirror exited")));
        child.stdout.once("data", (b) => resolve(JSON.parse(String(b))));
      }),
      1_000,
      { timeoutError: () => new Error("Mirror did not report its HTTPS and DNS ports") },
    );
    const get = async (host: string, url: string, range?: string) => {
      const controller = new AbortController();
      try {
        return await withTimeout(
          new Promise<{ status: number | undefined; location: string | undefined; body: string }>(
            (resolve, reject) => {
              const req = request(
                {
                  signal: controller.signal,
                  hostname: "127.0.0.1",
                  servername: host,
                  port: ports.https.port,
                  path: url,
                  headers: { host, ...(range ? { range } : {}) },
                  ca: readFileSync(cert),
                },
                (res) => {
                  let body = "";
                  res.on("data", (b) => (body += String(b)));
                  res.on("end", () =>
                    resolve({ status: res.statusCode, location: res.headers.location, body }),
                  );
                },
              );
              req.once("error", reject);
              req.end();
            },
          ),
          1_000,
          { timeoutError: () => new Error(`Mirror HTTPS response did not finish: ${host}${url}`) },
        );
      } finally {
        controller.abort();
      }
    };
    const prefix = "/steerlabs/opensteer/releases";
    writeFileSync(
      path.join(dir, "atom.json"),
      JSON.stringify(["v0.10.2", "desktop-v0.1.2", "v0.1.2-insider", "v0.1.1-insider"]),
    );
    expect(
      JSON.parse(
        (await get("github.opensteer.test", "/api/v3/repos/steerlabs/opensteer/releases/latest"))
          .body,
      ),
    ).toEqual({ tag_name: "desktop-v0.1.1" });
    expect((await get("github.opensteer.test", `${prefix}.atom`)).body).toContain("v0.1.2-insider");
    mkdirSync(path.join(dir, "v0.1.2-insider"));
    writeFileSync(path.join(dir, "v0.1.2-insider/insider-mac.yml"), "version: 0.1.2");
    expect(
      (await get("github.opensteer.test", `${prefix}/download/v0.1.2-insider/insider-mac.yml`))
        .location,
    ).toBe("https://objects.opensteer.test/v0.1.2-insider/insider-mac.yml");
    const first = await get(
      "github.opensteer.test",
      `${prefix}/download/desktop-v0.1.1/latest-mac.yml`,
    );
    expect(first.status).toBe(302);
    writeFileSync(path.join(dir, "latest"), "desktop-v0.1.2");
    expect(first.location).toBe("https://objects.opensteer.test/desktop-v0.1.1/latest-mac.yml");
    expect((await get("objects.opensteer.test", new URL(first.location!).pathname)).body).toBe(
      "0.1.1",
    );
    const partial = await get(
      "objects.opensteer.test",
      "/desktop-v0.1.1/latest-mac.yml",
      "bytes=2-4",
    );
    expect(partial.status).toBe(206);
    expect(partial.body).toBe("1.1");
    expect(
      (await get("objects.opensteer.test", "/desktop-v0.1.1/latest-mac.yml", "bytes=99-100"))
        .status,
    ).toBe(416);
    expect(
      JSON.parse(
        (await get("github.opensteer.test", "/api/v3/repos/steerlabs/opensteer/releases/latest"))
          .body,
      ),
    ).toEqual({ tag_name: "desktop-v0.1.2" });
    expect((await get("objects.opensteer.test", "/desktop-v0.1.1/not-an-asset")).status).toBe(404);
    const dns = createSocket("udp4");
    try {
      const labels = "unexpected.accounts.opensteer.com"
        .split(".")
        .map((s) => Buffer.concat([Buffer.from([s.length]), Buffer.from(s)]));
      const packet = Buffer.concat([
        Buffer.from([0, 1, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1]),
        ...labels,
        Buffer.from([0, 0, 1, 0, 1]),
      ]);
      const reply = new Promise<Buffer>((resolve) => dns.once("message", resolve));
      dns.send(packet, ports.dns.port, "127.0.0.1");
      const response = await withTimeout(reply, 1_000, {
        timeoutError: () => new Error("Mirror did not answer the wildcard Account DNS query"),
      });
      expect(response.readUInt16BE(2) & 15).toBe(3);
      expect(response.readUInt16BE(10)).toBe(0);
      expect(readFileSync(log, "utf8")).toContain(
        '"forbiddenDns":"unexpected.accounts.opensteer.com"',
      );
    } finally {
      dns.close();
    }
  } finally {
    try {
      child.kill("SIGTERM");
      await withTimeout(closed, 1_000, {
        timeoutError: () => new Error("Mirror did not close after SIGTERM"),
      }).catch(async (error: unknown) => {
        child.kill("SIGKILL");
        await withTimeout(closed, 1_000, {
          timeoutError: () => new Error("Mirror did not close after SIGKILL"),
        });
        throw error;
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("Personal health follows the persisted dynamic Host port", () => {
  const root = mkdtempSync(path.join(tmpdir(), "opensteer-health-port-"));
  try {
    expect(personalEndpoint(root)).toBeUndefined();
    writeFileSync(
      path.join(root, "personal-deployment.v1.json"),
      JSON.stringify({ deploymentId: "local", hostPort: 51743, postgresPort: 51744 }),
    );
    expect(personalEndpoint(root)).toEqual({
      deploymentId: "local",
      hostPort: 51743,
      origin: "http://127.0.0.1:51743",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("public update hosts are forbidden on both channels while staging Account is informational only for Beta", () => {
  const packet = (host: string) => `100|127.0.0.1|1.2.3.4|${host}||`;
  const records = [
    packet("github.opensteer.test"),
    packet("objects.opensteer.test"),
    packet("accounts.beta.opensteer.com"),
    packet("github.com"),
    packet("release-assets.githubusercontent.com"),
    packet("downloads.opensteer.com"),
  ];
  expect(forbiddenPublicUpdateHosts(records, 99, false)).toHaveLength(4);
  expect(forbiddenPublicUpdateHosts(records, 99, true)).toHaveLength(3);
  expect(forbiddenPublicUpdateHosts(records, 101, true)).toHaveLength(0);
});

// A receipt certifies archives by hash, so the guest must test those same bytes.
test("prepared archives must be the recorded builds before any VM starts", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "opensteer-prepared-archives-"));
  try {
    const build = { channel: "beta" as const, version: "0.1.252" };
    const { tag, zip } = releaseAsset(build.channel, build.version);
    expect({ tag, zip }).toEqual({ tag: "v0.1.252-insider", zip: "Opensteer-Beta-mac-arm64.zip" });
    mkdirSync(path.join(dir, tag));
    writeFileSync(path.join(dir, tag, zip), "tested bytes");
    const sha256 = createHash("sha256").update("tested bytes").digest("hex");
    expect(() => verifyPreparedArchives(dir, [{ ...build, sha256 }])).not.toThrow();
    writeFileSync(path.join(dir, tag, zip), "rebuilt bytes");
    expect(() => verifyPreparedArchives(dir, [{ ...build, sha256 }])).toThrow(/differs/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Certification is the release's whole journey set, never a selected subset.
test("the byte bridge accepts only a channel's complete certification", () => {
  const receipt = (names: string[]) => ({
    builds: [{ channel: "stable" as const, sha256: "a".repeat(64) }],
    results: names.map((name) => ({ name, passed: true as const })),
  });
  expect(() =>
    requireCertifiedJourneys(receipt(["stable:menu"]), "stable", "a".repeat(64)),
  ).toThrow(/stable:tray/u);
  expect(() =>
    requireCertifiedJourneys(
      receipt(["stable:menu", "stable:tray", "stable:quit"]),
      "stable",
      "a".repeat(64),
    ),
  ).not.toThrow();
  expect(() =>
    requireCertifiedJourneys(
      receipt(["stable:menu", "stable:tray", "stable:quit"]),
      "stable",
      "b".repeat(64),
    ),
  ).toThrow(/certified/u);
  expect(certificationCases.beta).toEqual(["beta:menu", "beta:quit"]);
});
