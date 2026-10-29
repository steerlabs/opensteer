import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { contributorPackageInputs } from "./contributor-package-inputs.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function validLayout(cloudflared: string) {
  const root = mkdtempSync(path.join(tmpdir(), "contributor-inputs-"));
  roots.push(root);
  for (const directory of ["postgres/bin", "postgres/lib", "postgres/share", "node/bin"]) {
    mkdirSync(path.join(root, directory), { recursive: true });
  }
  for (const file of ["postgres/bin/postgres", "postgres/bin/initdb", "postgres/bin/pg_isready"]) {
    writeFileSync(path.join(root, file), "");
  }
  writeFileSync(path.join(root, "node/bin/node"), "");
  writeFileSync(path.join(root, "cloudflared"), cloudflared);
  return {
    OPENSTEER_PERSONAL_RUNTIME_POSTGRES_SOURCE: path.join(root, "postgres"),
    OPENSTEER_PERSONAL_RUNTIME_NODE_SOURCE: path.join(root, "node"),
    OPENSTEER_CLOUDFLARED_BINARY_SOURCE: path.join(root, "cloudflared"),
    OPENSTEER_CLOUDFLARED_RELEASE_VERSION: "2026.3.0",
    OPENSTEER_CLOUDFLARED_BINARY_SHA256: createHash("sha256").update(cloudflared).digest("hex"),
  };
}

describe("contributor package inputs", () => {
  it("reports every missing input and the required layout in one error", () => {
    expect(() => contributorPackageInputs({})).toThrow(
      /OPENSTEER_PERSONAL_RUNTIME_POSTGRES_SOURCE[\s\S]*OPENSTEER_PERSONAL_RUNTIME_NODE_SOURCE[\s\S]*OPENSTEER_CLOUDFLARED_BINARY_SOURCE[\s\S]*OPENSTEER_CLOUDFLARED_RELEASE_VERSION[\s\S]*OPENSTEER_CLOUDFLARED_BINARY_SHA256[\s\S]*bin\/postgres[\s\S]*bin\/initdb[\s\S]*bin\/pg_isready[\s\S]*bin\/node/,
    );
  });
  it("rejects malformed digests and non-stable versions before building", () => {
    expect(() =>
      contributorPackageInputs({
        OPENSTEER_PERSONAL_RUNTIME_POSTGRES_SOURCE: "/missing-postgres",
        OPENSTEER_PERSONAL_RUNTIME_NODE_SOURCE: "/missing-node",
        OPENSTEER_CLOUDFLARED_BINARY_SOURCE: "/missing-cloudflared",
        OPENSTEER_CLOUDFLARED_RELEASE_VERSION: "latest",
        OPENSTEER_CLOUDFLARED_BINARY_SHA256: "wrong",
      }),
    ).toThrow(/OPENSTEER_CLOUDFLARED_RELEASE_VERSION[\s\S]*OPENSTEER_CLOUDFLARED_BINARY_SHA256/);
  });
  it("reports invalid paths with the required layout", () => {
    expect(() =>
      contributorPackageInputs({
        OPENSTEER_PERSONAL_RUNTIME_POSTGRES_SOURCE: "/missing-postgres",
        OPENSTEER_PERSONAL_RUNTIME_NODE_SOURCE: "/missing-node",
        OPENSTEER_CLOUDFLARED_BINARY_SOURCE: "/missing-cloudflared",
        OPENSTEER_CLOUDFLARED_RELEASE_VERSION: "2026.3.0",
        OPENSTEER_CLOUDFLARED_BINARY_SHA256: "a".repeat(64),
      }),
    ).toThrow(/Invalid input layout:[\s\S]*bin\/postgres[\s\S]*bin\/node/);
  });
  it("accepts a complete layout whose cloudflared matches its version and digest", () => {
    const inputs = validLayout("cloudflared bytes");
    expect(contributorPackageInputs(inputs)).toEqual(inputs);
  });
  it("reports a cloudflared below the minimum version and a mismatched digest together", () => {
    const inputs = {
      ...validLayout("cloudflared bytes"),
      OPENSTEER_CLOUDFLARED_RELEASE_VERSION: "2025.3.9",
      OPENSTEER_CLOUDFLARED_BINARY_SHA256: "b".repeat(64),
    };
    expect(() => contributorPackageInputs(inputs)).toThrow(
      /OPENSTEER_CLOUDFLARED_RELEASE_VERSION must be 2025\.4\.0 or newer[\s\S]*cloudflared binary digest mismatch/,
    );
  });
});
