import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inventoryClaudeDistribution } from "../scripts/check-no-claude-executable.js";

const asar = createRequire(new URL("../apps/desktop/package.json", import.meta.url))(
  "@electron/asar",
) as { createPackage(source: string, destination: string): Promise<void> };
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "claude-inventory-"));
  roots.push(root);
  const sdk = "node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs";
  await put(
    root,
    sdk,
    '/* @anthropic-ai/claude-agent-sdk */ export function query() { return "pathToClaudeCodeExecutable"; }',
  );
  return { root, sdk };
}
async function put(root: string, path: string, contents: string | Buffer) {
  await mkdir(join(root, path, ".."), { recursive: true });
  await writeFile(join(root, path), contents);
}

describe("Claude distribution inventory", () => {
  it("keeps a sorted, hashed inventory proving SDK JS is present", async () => {
    const { root, sdk } = await fixture();
    const result = await inventoryClaudeDistribution(root);
    expect(result.violations).toEqual([]);
    expect(result.sdkJavaScript).toEqual([sdk]);
    expect(result.files).toContainEqual(
      expect.objectContaining({ path: sdk, sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) }),
    );
  });
  it.each([
    "bin/claude",
    "bin/claude.exe",
    "bin/claude.cmd",
    "node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/README.md",
    "node_modules/.pnpm/@anthropic-ai+claude-agent-sdk-win32-arm64@0.3.295/package.json",
    "node_modules/@anthropic-ai/claude-code/cli.js",
    "node_modules/@anthropic-ai/claude-agent-sdk/cli.js",
  ])("rejects a forbidden shipped path: %s", async (path) => {
    const { root } = await fixture();
    await put(root, path, "forbidden");
    expect((await inventoryClaudeDistribution(root)).violations).not.toEqual([]);
  });
  it("detects a renamed native executable from embedded build metadata", async () => {
    const { root } = await fixture();
    await put(
      root,
      "helpers/renamed",
      Buffer.from(
        '\x7fELF\0PACKAGE_URL:"@anthropic-ai/claude-code",README_URL:"https://code.claude.com",VERSION:"2.1.295"',
        "latin1",
      ),
    );
    expect((await inventoryClaudeDistribution(root)).violations).toContainEqual(
      expect.stringContaining("helpers/renamed"),
    );
  });
  it("does not mistake SDK JavaScript mentioning the CLI for a native executable", async () => {
    const { root } = await fixture();
    await put(
      root,
      "services/runner.mjs",
      '/* @anthropic-ai/claude-agent-sdk */ const pathToClaudeCodeExecutable = "@anthropic-ai/claude-code";',
    );
    expect((await inventoryClaudeDistribution(root)).violations).toEqual([]);
  });
  it("fails closed when SDK JS is absent or an archive has not been unpacked", async () => {
    const { root, sdk } = await fixture();
    await rm(join(root, sdk));
    expect((await inventoryClaudeDistribution(root)).violations).toContain(
      "Claude Agent SDK JavaScript is missing",
    );
    await put(root, "installer.exe", Buffer.from("MZ\0\0NullsoftInst\0compressed-payload"));
    expect((await inventoryClaudeDistribution(root)).violations).toContainEqual(
      expect.stringContaining("Unpack archive before inventory: installer.exe"),
    );
    await put(root, "installer.zip", "uninspected");
    expect((await inventoryClaudeDistribution(root)).violations).toContainEqual(
      expect.stringContaining("Unpack archive"),
    );
  });
  it("checks symlink names and targets without traversing outside the inventory", async () => {
    const { root } = await fixture();
    await symlink("/usr/local/bin/claude", join(root, "launcher"));
    expect((await inventoryClaudeDistribution(root)).violations).toContainEqual(
      expect.stringContaining("launcher"),
    );
  });
  it("inspects ASAR contents rather than trusting the outer filename", async () => {
    const { root } = await fixture();
    const outer = await mkdtemp(join(tmpdir(), "claude-asar-"));
    roots.push(outer);
    await asar.createPackage(root, join(outer, "app.asar"));
    const clean = await inventoryClaudeDistribution(outer);
    expect(clean.violations).toEqual([]);
    expect(clean.sdkJavaScript).toEqual([
      "app.asar!/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs",
    ]);
    await put(root, "nested.zip", "uninspected");
    await asar.createPackage(root, join(outer, "app.asar"));
    expect((await inventoryClaudeDistribution(outer)).violations).toContainEqual(
      expect.stringContaining("Unpack archive before inventory: app.asar!/nested.zip"),
    );
    await rm(join(root, "nested.zip"));
    const platformDirectory = "node_modules/@anthropic-ai/claude-agent-sdk-win32-x64";
    await mkdir(join(root, platformDirectory), { recursive: true });
    await asar.createPackage(root, join(outer, "app.asar"));
    expect((await inventoryClaudeDistribution(outer)).violations).toContainEqual(
      expect.stringContaining(platformDirectory),
    );
    await rm(join(root, platformDirectory), { recursive: true });
    await put(root, "bin/claude", "forbidden");
    await asar.createPackage(root, join(outer, "app.asar"));
    expect((await inventoryClaudeDistribution(outer)).violations).toContainEqual(
      expect.stringContaining("app.asar!/bin/claude"),
    );
  });
  it("recursively inspects a nested ASAR with SDK JS outside and Claude inside", async () => {
    const { root } = await fixture();
    const inner = await mkdtemp(join(tmpdir(), "claude-inner-asar-"));
    const outer = await mkdtemp(join(tmpdir(), "claude-outer-asar-"));
    roots.push(inner, outer);
    const executable = "node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude";
    await put(inner, executable, "forbidden");
    await asar.createPackage(inner, join(root, "payload.asar"));
    await asar.createPackage(root, join(outer, "app.asar"));
    const result = await inventoryClaudeDistribution(outer);
    expect(result.sdkJavaScript).toEqual([
      "app.asar!/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs",
    ]);
    expect(result.violations).toContain(
      `Claude executable or platform package: app.asar!/payload.asar!/${executable}`,
    );
  });
  it("recognizes SDK JavaScript embedded in a Personal runtime service bundle", async () => {
    const { root, sdk } = await fixture();
    await rm(join(root, sdk));
    await put(
      root,
      "services/runner.mjs",
      '/* @anthropic-ai/claude-agent-sdk/sdk.mjs */ const pathToClaudeCodeExecutable = "claude";',
    );
    expect((await inventoryClaudeDistribution(root)).sdkJavaScript).toEqual([
      "services/runner.mjs",
    ]);
    expect((await inventoryClaudeDistribution(root)).violations).toEqual([]);
  });
});
