import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyDependencyManifestCopies } from "../scripts/component-provenance.mjs";

const root = process.cwd();
const recipe = readFileSync("deploy/container/Containerfile", "utf8");

describe("release dependency manifest guard", () => {
  it("copies every real workspace manifest into each install stage", () => {
    expect(() => verifyDependencyManifestCopies(root)).not.toThrow();
  });

  it("rejects a missing manifest COPY before an image build", () => {
    const broken = recipe.replace(/^COPY apps\/web\/package.json .*\n/mu, "");
    expect(() => verifyDependencyManifestCopies(root, broken)).toThrow(/apps\/web\/package.json/u);
  });

  it("rejects two copies in one stage instead of one in each stage", () => {
    const copy = "COPY apps/web/package.json ./apps/web/package.json\n";
    const broken = recipe.replace(copy, "").replace(/(FROM .* AS web-assets\n)/u, `$1${copy}`);
    expect(() => verifyDependencyManifestCopies(root, broken)).toThrow(/dependencies/u);
  });

  it.each(["from node AS inserted", "  FROM\tnode AS inserted"])(
    "rejects a manifest list moved into a stage introduced by %s",
    (from) => {
      const broken = recipe.replace(
        "COPY apps/browser-extension/package.json",
        `${from}\nCOPY apps/browser-extension/package.json`,
      );
      expect(() => verifyDependencyManifestCopies(root, broken)).toThrow(/dependencies/u);
    },
  );

  it("rejects duplicate stage names", () => {
    const broken = recipe + "\nFROM node AS duplicate\nFROM node AS duplicate\n";
    expect(() => verifyDependencyManifestCopies(root, broken)).toThrow(/duplicate/u);
  });

  it("rejects an unparseable FROM line even with lowercase syntax", () => {
    expect(() => verifyDependencyManifestCopies(root, recipe + "\n from node\n")).toThrow(/FROM/u);
  });

  it("rejects duplicate stage names regardless of case", () => {
    const broken = recipe + "\nFROM node AS duplicate\nfrom node as DUPLICATE\n";
    expect(() => verifyDependencyManifestCopies(root, broken)).toThrow(/duplicate/u);
  });

  it("accepts case and whitespace variants without changing stage ownership", () => {
    const variant = recipe.replace(
      "FROM ${NODE_IMAGE} AS dependencies",
      " \tfrom\t${NODE_IMAGE}\tas\tDEPENDENCIES  ",
    );
    expect(() => verifyDependencyManifestCopies(root, variant)).not.toThrow();
  });

  it("discovers manifests from workspace globs, including exclusions", () => {
    const directory = mkdtempSync(join(tmpdir(), "opensteer-manifest-guard-"));
    try {
      writeFileSync(
        join(directory, "pnpm-workspace.yaml"),
        'packages:\n  - modules/*\n  - "!modules/ignored"\n',
      );
      for (const name of ["included", "ignored"]) {
        mkdirSync(join(directory, "modules", name), { recursive: true });
        writeFileSync(join(directory, "modules", name, "package.json"), "{}");
      }
      const copies = ["dependencies", "web-assets"]
        .map(
          (stage) =>
            `FROM node AS ${stage}\nCOPY modules/included/package.json ./modules/included/package.json\n`,
        )
        .join("\n");
      expect(verifyDependencyManifestCopies(directory, copies)).toEqual([
        "modules/included/package.json",
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
