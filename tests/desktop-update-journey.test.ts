import { forbiddenPublicUpdateHosts } from "../scripts/public-download/update-traffic.js";
import { personalEndpoint } from "../scripts/public-download/personal-endpoint.js";
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
    { stdio: "ignore" },
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
  try {
    const ports = await new Promise<{ https: { port: number }; dns: { port: number } }>(
      (resolve, reject) => {
        child.once("error", reject);
        child.once("exit", () => reject(new Error("mirror exited")));
        child.stdout.once("data", (b) => resolve(JSON.parse(String(b))));
      },
    );
    const get = (host: string, url: string, range?: string) =>
      new Promise<{ status: number | undefined; location: string | undefined; body: string }>(
        (resolve, reject) => {
          const req = request(
            {
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
      );
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
      const response = await reply;
      expect(response.readUInt16BE(2) & 15).toBe(3);
      expect(response.readUInt16BE(10)).toBe(0);
      expect(readFileSync(log, "utf8")).toContain(
        '"forbiddenDns":"unexpected.accounts.opensteer.com"',
      );
    } finally {
      dns.close();
    }
  } finally {
    const done = new Promise<void>((resolve) => child.once("close", () => resolve()));
    child.kill("SIGTERM");
    await done;
    rmSync(dir, { recursive: true, force: true });
  }
}, 15000);

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
