import { personalEndpoint } from "../scripts/public-download/personal-endpoint.js";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { test, expect } from "vitest";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { request } from "node:https";
import { createSocket } from "node:dgram";

test("Public GitHub Atom/Latest, cross-origin ranges and wildcard Account sinkhole", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "opensteer-public-mirror-"));
  const cert = path.join(dir, "cert.pem"),
    key = path.join(dir, "key.pem"),
    log = path.join(dir, "network.jsonl");
  writeFileSync(
    path.join(dir, "openssl.cnf"),
    "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=Private test\n[ext]\nsubjectAltName=DNS:github.com,DNS:api.github.com,DNS:objects.githubusercontent.com,DNS:release-assets.githubusercontent.com\nbasicConstraints=critical,CA:TRUE\n",
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
    const get = async (host: string, url: string, range?: string, accept = "application/json") => {
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
                  headers: { host, ...(accept ? { accept } : {}), ...(range ? { range } : {}) },
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
    expect((await get("github.com", `${prefix}/latest`, undefined, "")).status).toBe(406);
    expect((await get("api.github.com", `${prefix}/latest`)).status).toBe(421);
    writeFileSync(
      path.join(dir, "atom.json"),
      JSON.stringify(["v0.10.2", "desktop-v0.1.2", "v0.1.2-insider", "v0.1.1-insider"]),
    );
    expect(
      JSON.parse((await get("github.com", "/steerlabs/opensteer/releases/latest")).body),
    ).toEqual({ tag_name: "desktop-v0.1.1" });
    expect((await get("github.com", `${prefix}.atom`)).body).toContain("v0.1.2-insider");
    mkdirSync(path.join(dir, "v0.1.2-insider"));
    writeFileSync(path.join(dir, "v0.1.2-insider/insider-mac.yml"), "version: 0.1.2");
    expect(
      (await get("github.com", `${prefix}/download/v0.1.2-insider/insider-mac.yml`)).location,
    ).toBe("https://release-assets.githubusercontent.com/v0.1.2-insider/insider-mac.yml");
    const first = await get("github.com", `${prefix}/download/desktop-v0.1.1/latest-mac.yml`);
    expect(first.status).toBe(302);
    writeFileSync(path.join(dir, "latest"), "desktop-v0.1.2");
    expect(first.location).toBe(
      "https://release-assets.githubusercontent.com/desktop-v0.1.1/latest-mac.yml",
    );
    expect(
      (await get("release-assets.githubusercontent.com", new URL(first.location!).pathname)).body,
    ).toBe("0.1.1");
    const partial = await get(
      "release-assets.githubusercontent.com",
      "/desktop-v0.1.1/latest-mac.yml",
      "bytes=2-4",
    );
    expect(partial.status).toBe(206);
    expect(partial.body).toBe("1.1");
    expect(
      (
        await get(
          "release-assets.githubusercontent.com",
          "/desktop-v0.1.1/latest-mac.yml",
          "bytes=99-100",
        )
      ).status,
    ).toBe(416);
    expect(
      JSON.parse((await get("github.com", "/steerlabs/opensteer/releases/latest")).body),
    ).toEqual({ tag_name: "desktop-v0.1.2" });
    expect(
      (await get("release-assets.githubusercontent.com", "/desktop-v0.1.1/not-an-asset")).status,
    ).toBe(404);
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
