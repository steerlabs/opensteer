import { HarnessIdSchema, createId, harnessCatalog, harnessKindRecord } from "@opensteer/core";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { isolatedServiceHarnessRuntimeBoundary } from "@opensteer/harness";
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

  it("on a Linux Home, offers only engines that can run sandboxed, and says why the rest can't", () => {
    vi.stubEnv("PATH", "/nonexistent");
    const harnesses = createHarnessRegistry(harnessExecutables, harnessRuntime);
    harnesses.adoptRuntimeBoundary(isolatedServiceHarnessRuntimeBoundary);
    const sandboxed = "runs only on a computer where Opensteer runs as you.";
    expect(
      Object.fromEntries(harnesses.listDrivers().map(({ kind, readiness }) => [kind, readiness])),
    ).toEqual({
      antigravity: {
        reason: `Antigravity keeps its sign-in in the computer's own account, so it ${sandboxed}`,
        status: "unavailable",
      },
      // Shipped only when the Home's image includes it; never "install it yourself".
      claude: {
        reason: "Claude Code isn’t included on this computer, so it can’t run here.",
        status: "unavailable",
      },
      codex: expect.objectContaining({ status: "runtime-check" }),
      cursor: {
        reason: `Cursor keeps its sign-in in the computer's own account, so it ${sandboxed}`,
        status: "unavailable",
      },
      grok: {
        reason: `Grok keeps its sign-in in the computer's own account, so it ${sandboxed}`,
        status: "unavailable",
      },
      muse: {
        reason: `Muse Code keeps its sign-in in the computer's own account, so it ${sandboxed}`,
        status: "unavailable",
      },
      opencode: {
        reason: `OpenCode has no command sandbox of its own, so it ${sandboxed}`,
        status: "unavailable",
      },
      pi: {
        reason: `Pi has no command sandbox of its own, so it ${sandboxed}`,
        status: "unavailable",
      },
    });
    expect(harnesses.driverSources(HarnessIdSchema.parse("codex"))).not.toHaveLength(0);
  });

  it("offers a Claude Code a Linux Home's image includes", () => {
    const harnesses = createHarnessRegistry(harnessExecutables, harnessRuntime);
    harnesses.adoptRuntimeBoundary(isolatedServiceHarnessRuntimeBoundary);
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
