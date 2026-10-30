import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  HostStaticDistribution,
  HostStaticDistributionManifestSchema,
  HostStaticDistributionVersionMismatchError,
} from "./static-distribution.js";
import { writeWebDistributionManifest } from "../../../../scripts/write-web-distribution-manifest.mjs";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("Host static Web distribution", () => {
  it("serves immutable assets, no-store HTML, security headers, and SPA routes", async () => {
    const fixture = await distributionFixture();
    const distribution = await HostStaticDistribution.load(fixture.config);
    const app = Fastify();
    distribution.register(app);

    const asset = await app.inject({ method: "GET", url: "/assets/app-12345678.js" });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(asset.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(asset.headers["permissions-policy"]).toContain("microphone=(self)");
    expect(asset.headers["permissions-policy"]).toContain("camera=()");
    expect(asset.headers["referrer-policy"]).toBe("no-referrer");

    const index = await app.inject({ method: "GET", url: "/" });
    expect(index.statusCode).toBe(200);
    expect(index.headers["cache-control"]).toBe("no-store");
    expect(index.headers["content-type"]).toContain("text/html; charset=utf-8");

    const fallback = await app.inject({ method: "GET", url: "/settings/account" });
    expect(fallback.body).toContain("fixture app");
    expect((await app.inject({ method: "GET", url: "/assets/missing.js" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/..%2fsecret" })).statusCode).toBe(404);
    await app.close();
  });

  it("keeps the gateway microphone policy aligned", async () => {
    const gateway = await readFile(
      new URL("../../../../deploy/gateway/Caddyfile", import.meta.url),
      "utf8",
    );
    expect(gateway).toContain(
      'Permissions-Policy "camera=(), microphone=(self), geolocation=(), payment=()"',
    );
  });

  it("fails closed with a named error when the bundle version is stale", async () => {
    const fixture = await distributionFixture();
    await expect(
      HostStaticDistribution.load({ ...fixture.config, expectedHostVersion: "2.0.0" }),
    ).rejects.toBeInstanceOf(HostStaticDistributionVersionMismatchError);
    await expect(
      HostStaticDistribution.load({ ...fixture.config, expectedBuildId: "new-web-build" }),
    ).rejects.toBeInstanceOf(HostStaticDistributionVersionMismatchError);
  });

  it("rejects Web bytes changed after the shared manifest is written", async () => {
    const fixture = await distributionFixture();
    await writeFile(path.join(fixture.config.directory, "assets/app-12345678.js"), "tampered");
    await expect(HostStaticDistribution.load(fixture.config)).rejects.toThrow(
      /failed verification/u,
    );
  });

  it("fails closed when stale Web bytes are relabeled with the current build identity", async () => {
    const fixture = await distributionFixture();
    const assetPath = path.join(fixture.config.directory, "assets/app-12345678.js");
    const staleBytes = Buffer.from("globalThis.build='stale-web-build'");
    await writeFile(assetPath, staleBytes);
    const manifest = HostStaticDistributionManifestSchema.parse(
      JSON.parse(await readFile(fixture.config.manifestPath, "utf8")),
    );
    await chmod(fixture.config.manifestPath, 0o644);
    await writeFile(
      fixture.config.manifestPath,
      JSON.stringify({
        ...manifest,
        files: manifest.files.map((file) =>
          file.path === "assets/app-12345678.js"
            ? { ...file, sha256: createHash("sha256").update(staleBytes).digest("hex") }
            : file,
        ),
      }),
    );
    await expect(HostStaticDistribution.load(fixture.config)).rejects.toBeInstanceOf(
      HostStaticDistributionVersionMismatchError,
    );
  });

  it("refuses to package stale Web bytes under the current build identity", async () => {
    await expect(distributionFixture({ embeddedBuildId: "stale-web-build" })).rejects.toThrow(
      /does not embed its expected build identity/u,
    );
  });
});

async function distributionFixture(options: { readonly embeddedBuildId?: string } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "opensteer-static-"));
  directories.push(directory);
  await mkdir(path.join(directory, "assets"));
  const files = new Map([
    ["index.html", Buffer.from("<!doctype html><title>fixture app</title>")],
    [
      "assets/app-12345678.js",
      Buffer.from(
        `globalThis.fixture=true;globalThis.build=${JSON.stringify(options.embeddedBuildId ?? "fixture-web-build")}`,
      ),
    ],
  ]);
  for (const [relative, bytes] of files) await writeFile(path.join(directory, relative), bytes);
  const manifestPath = path.join(directory, "opensteer-web.json");
  await writeWebDistributionManifest({
    buildId: "fixture-web-build",
    directory,
    hostVersion: "1.0.0",
  });
  return {
    config: {
      directory,
      expectedBuildId: "fixture-web-build",
      expectedHostVersion: "1.0.0",
      manifestPath,
    },
  };
}
