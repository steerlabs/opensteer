import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { smokeConfig } from "../apps/desktop/scripts/tsup.electron-smoke.config.js";
import { nodeApp } from "../scripts/tsup-node-app.js";

/**
 * Prefix-only builtins (node:sqlite, node:test, node:sea) stop resolving if tsup removes the node:
 * prefix, its default: every build that bundles the Home, a Runner or the engines' drivers keeps
 * it. The Electron smokes' bundle lost it once (journey 20261125T051645Z-3acafa10: quit and
 * menu-bar could not load "sqlite").
 */
describe("builds keep the node: prefix of prefix-only builtins", () => {
  it("the Node app builds", () => {
    expect(nodeApp({ entry: ["src/main.ts"] }).removeNodeProtocol).toBe(false);
  });

  it("the Personal runtime build", () => {
    const source = readFileSync(
      new URL("../apps/desktop/scripts/build-personal-runtime.ts", import.meta.url),
      "utf8",
    );
    expect(source).toMatch(/\bremoveNodeProtocol: false,/u);
    expect(source).not.toMatch(/\bremoveNodeProtocol: true\b/u);
  });

  it("the Electron smokes' bundle", () => {
    expect(smokeConfig.removeNodeProtocol).toBe(false);
  });
});
