import { HarnessIdSchema, createId, harnessCatalog, harnessKindRecord } from "@opensteer/core";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { claudeInstallGuidance } from "@opensteer/harness-claude";
import { createHarnessRegistry } from "./harness-registry.js";

const harnessExecutables = harnessKindRecord((kind) => `/opt/fake/${kind}`);
const harnessRuntime = {
  nodeExecutable: "/opt/fake/node",
  runtimeCacheDirectory: "/opt/fake/runtime-cache",
};

describe("Runner harness registry", () => {
  let path: string;
  beforeAll(async () => {
    path = await mkdtemp(join(tmpdir(), "opensteer-engine-path-"));
    for (const entry of harnessCatalog) {
      const installed =
        entry.runtime.shape === "installed"
          ? entry.runtime
          : "installed" in entry
            ? entry.installed
            : undefined;
      if (installed) await writeFile(join(path, installed.command), "", { mode: 0o700 });
    }
  });
  beforeEach(() => vi.stubEnv("PATH", path));
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => rm(path, { recursive: true, force: true }));

  it("advertises every catalog engine in catalog order, and nothing else", async () => {
    const harnesses = createHarnessRegistry(harnessExecutables, harnessRuntime);
    expect(harnesses.listDrivers()).toEqual(
      harnessCatalog.map((entry) =>
        expect.objectContaining({
          kind: entry.kind,
          readiness: expect.objectContaining({
            note: `${entry.label} availability and models are inspected per configured engine`,
            status: "runtime-check",
          }),
        }),
      ),
    );
    expect(harnesses.listDrivers().some(({ kind }) => kind === "native")).toBe(false);

    const codexId = createId("harnessInstance");
    await harnesses.reconcileInstances([
      {
        config: { requestTimeoutMs: 30_000 },
        driverKind: HarnessIdSchema.parse("codex"),
        id: codexId,
        name: "Codex",
        runtimeRevision: 1,
        sourceId: "openai",
        stateKind: "isolated",
      },
    ]);
    await expect(harnesses.adapter(codexId)).rejects.toMatchObject({
      code: "conflict",
      message: "Harness Codex is still preparing",
      retryable: true,
    });
    await harnesses.close();
  });

  it("offers the engines a computer ships and says how to install the rest", () => {
    vi.stubEnv("PATH", "/nonexistent");
    const harnesses = createHarnessRegistry(harnessExecutables, harnessRuntime);
    const finds = "Opensteer finds it within a minute; if it doesn't, restart Opensteer.";
    expect(
      Object.fromEntries(harnesses.listDrivers().map(({ kind, readiness }) => [kind, readiness])),
    ).toEqual({
      antigravity: expect.objectContaining({ status: "runtime-check" }),
      claude: { reason: claudeInstallGuidance, status: "unavailable" },
      codex: expect.objectContaining({ status: "runtime-check" }),
      cursor: {
        reason: `Cursor's CLI is not installed on this computer. Install it from https://cursor.com/install. ${finds}`,
        status: "unavailable",
      },
      grok: {
        reason: `Grok's CLI is not installed on this computer. Install it from https://x.ai/cli. ${finds}`,
        status: "unavailable",
      },
      muse: {
        reason: `Muse Code's CLI is not installed on this computer. Install it from https://dev.meta.ai/docs/muse-code. ${finds}`,
        status: "unavailable",
      },
      opencode: expect.objectContaining({ status: "runtime-check" }),
      pi: expect.objectContaining({ status: "runtime-check" }),
    });
    // Without the person's own Codex, only an Opensteer-managed account is on offer.
    expect(
      harnesses
        .driverSources(HarnessIdSchema.parse("codex"))
        ?.flatMap(({ stateKinds }) => stateKinds),
    ).not.toContain("ambient");
  });

  it("offers a Claude Code found on PATH", () => {
    const harnesses = createHarnessRegistry(harnessExecutables, harnessRuntime);
    expect(harnesses.canRunDriver(HarnessIdSchema.parse("claude"))).toBe(true);
    expect(
      harnesses.driverSources(HarnessIdSchema.parse("claude"))?.map(({ sourceId }) => sourceId),
    ).toContain("anthropic");
  });

  it("declares the access modes every catalog engine can enforce", () => {
    const harnesses = createHarnessRegistry(harnessExecutables, harnessRuntime);

    // How far an engine can enforce the provider-neutral modes is the driver's
    // own statement, so this checks that every catalog kind registers and
    // declares a non-empty subset rather than restating each driver's list.
    const modes = ["approval-required", "auto-accept-edits", "auto", "full-access"];
    for (const entry of harnessCatalog) {
      const declared = harnesses.driverAccessModes(HarnessIdSchema.parse(entry.kind));
      expect({
        declaresOnlyKnownModes: declared?.every((mode) => modes.includes(mode)),
        kind: entry.kind,
        registered: (declared?.length ?? 0) > 0,
      }).toEqual({ declaresOnlyKnownModes: true, kind: entry.kind, registered: true });
    }
    // Codex and Claude Code translate all four explicitly, so nothing a Host
    // admits for them is refused.
    for (const kind of ["codex", "claude"]) {
      expect(harnesses.driverAccessModes(HarnessIdSchema.parse(kind))).toEqual(modes);
    }
    expect(harnesses.driverAccessModes(HarnessIdSchema.parse("native"))).toBeUndefined();
  });

  it("reconciles reordered and changed runtime definitions", async () => {
    const harnesses = createHarnessRegistry(harnessExecutables, harnessRuntime);
    const instanceId = createId("harnessInstance");
    const base = {
      driverKind: HarnessIdSchema.parse("codex"),
      id: instanceId,
      name: "Codex",
      sourceId: "openai",
      stateKind: "isolated" as const,
    };

    await harnesses.upsertInstance({
      ...base,
      config: { requestTimeoutMs: 30_000 },
      runtimeRevision: 1,
    });
    await expect(
      harnesses.upsertInstance({
        ...base,
        config: { requestTimeoutMs: 30_000 },
        runtimeRevision: 1,
      }),
    ).resolves.toMatchObject({ status: "available" });
    await expect(
      harnesses.upsertInstance({
        ...base,
        config: { requestTimeoutMs: 60_000 },
        runtimeRevision: 2,
      }),
    ).resolves.toMatchObject({ status: "available" });
  });

  it("treats a changed source as a runtime change that must advance the revision", async () => {
    const harnesses = createHarnessRegistry(harnessExecutables, harnessRuntime);
    const base = {
      config: { requestTimeoutMs: 30_000 },
      driverKind: HarnessIdSchema.parse("codex"),
      id: createId("harnessInstance"),
      name: "Codex",
      stateKind: "isolated" as const,
    };

    await harnesses.upsertInstance({ ...base, runtimeRevision: 1, sourceId: "openai" });
    await expect(
      harnesses.upsertInstance({
        ...base,
        runtimeRevision: 1,
        sourceId: "openai-compatible",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      harnesses.upsertInstance({
        ...base,
        runtimeRevision: 2,
        sourceId: "openai-compatible",
      }),
    ).resolves.toMatchObject({ status: "available" });
  });
});

/**
 * Several copies of an engine the person installed: the Runner reads each
 * one's version. Codex, which Opensteer also ships, runs Opensteer's own copy
 * when every copy here is too old; Claude Code, which it does not ship, keeps
 * the person's and lets its own check say what to update.
 */
describe("Runner harness registry with several copies of an installed engine", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "opensteer-engine-copies-"));
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  async function copies(command: string, outputs: readonly string[]): Promise<void> {
    const directories = outputs.map((_, index) => join(root, `bin-${index}`));
    for (const [index, output] of outputs.entries()) {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(directories[index]!, { recursive: true });
      await writeFile(join(directories[index]!, command), `#!/bin/sh\necho '${output}'\n`, {
        mode: 0o755,
      });
    }
    vi.stubEnv("PATH", directories.join(":"));
  }

  it.skipIf(process.platform === "win32")(
    "says when Opensteer's own Codex runs because every Codex here is too old",
    async () => {
      await copies("codex", ["codex-cli 0.146.1", "codex-cli 0.150.0"]);
      const harnesses = createHarnessRegistry(harnessExecutables, harnessRuntime);
      await expect(harnesses.installationNotice(HarnessIdSchema.parse("codex"))).resolves.toBe(
        "Using Opensteer’s own Codex 0.162.0: the one on this computer (0.150.0) is too old.",
      );
      await harnesses.close();
    },
  );

  it.skipIf(process.platform === "win32")(
    "says nothing when a newer Codex here is supported",
    async () => {
      await copies("codex", ["codex-cli 0.146.1", "codex-cli 0.161.0"]);
      const harnesses = createHarnessRegistry(harnessExecutables, harnessRuntime);
      await expect(
        harnesses.installationNotice(HarnessIdSchema.parse("codex")),
      ).resolves.toBeUndefined();
      await harnesses.close();
    },
  );

  it.skipIf(process.platform === "win32")(
    "keeps the person's Claude Code, which Opensteer does not ship",
    async () => {
      await copies("claude", ["2.1.100 (Claude Code)", "2.1.200 (Claude Code)"]);
      const harnesses = createHarnessRegistry(harnessExecutables, harnessRuntime);
      await expect(
        harnesses.installationNotice(HarnessIdSchema.parse("claude")),
      ).resolves.toBeUndefined();
      await harnesses.close();
    },
  );
});
