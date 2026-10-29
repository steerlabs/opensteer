import { describe, expect, it } from "vitest";
import {
  compareStableVersions,
  engineReleases,
  recordRuntimeVersions,
  releasesToUpdate,
  withCatalogPin,
  withExpectedVersion,
  type EngineRelease,
} from "../scripts/engines.js";
import {
  harnessRuntimeExpectedVersion,
  shippedHarnessKinds,
} from "../packages/core/src/harness-catalog.js";

const codexRelease: EngineRelease = {
  kind: "codex",
  npmPackage: "@openai/codex",
  pinned: "1.9.0",
  latest: "1.10.0",
};

describe("engines script", () => {
  it("reports every shipped engine's pin against its latest release", async () => {
    const releases = await engineReleases(async (npmPackage) =>
      npmPackage === "@openai/codex" ? "999.0.0" : "0.0.1",
    );
    expect(releases.map((release) => release.kind)).toEqual(shippedHarnessKinds);
    expect(releases.find((release) => release.kind === "codex")).toMatchObject({
      latest: "999.0.0",
      npmPackage: "@openai/codex",
      pinned: expect.stringMatching(/^\d+\.\d+\.\d+$/u),
    });

    const fetched: string[] = [];
    const selected = await engineReleases(
      async (npmPackage) => {
        fetched.push(npmPackage);
        return "999.0.0";
      },
      ["codex", "codex"],
    );
    expect(selected.map((release) => release.kind)).toEqual(["codex"]);
    expect(fetched).toEqual(["@openai/codex"]);
  });

  it("orders stable versions numerically without unsafe integer rounding", () => {
    expect(compareStableVersions("0.157.0", "0.156.99")).toBe(1);
    expect(compareStableVersions("1.0.0", "0.999.999")).toBe(1);
    expect(compareStableVersions("1.9.0", "1.10.0")).toBe(-1);
    expect(compareStableVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareStableVersions("9007199254740993.0.0", "9007199254740992.999.999")).toBe(1);
    expect(() => compareStableVersions("1.2.3-beta.1", "1.2.3")).toThrow("stable x.y.z");
    expect(() => compareStableVersions("01.2.3", "1.2.3")).toThrow("stable x.y.z");
  });

  it("updates only requested engines with a newer stable release", () => {
    const releases: EngineRelease[] = [
      codexRelease,
      {
        kind: "opencode",
        npmPackage: "opencode-ai",
        pinned: "0.3.280",
        latest: "0.3.279",
      },
      {
        kind: "pi",
        npmPackage: "@earendil-works/pi-coding-agent",
        pinned: "0.87.1",
        latest: "0.87.1",
      },
    ];
    expect(releasesToUpdate(releases, ["codex", "opencode", "pi"])).toEqual([codexRelease]);
    expect(releasesToUpdate(releases, ["opencode"])).toEqual([]);
    expect(releasesToUpdate(releases, [])).toEqual([]);
  });

  it("moves exactly one pin, quoted or not", () => {
    const workspace = 'catalog:\n  "@openai/codex": 0.156.0\n  opencode-ai: 1.18.32\n';
    expect(withCatalogPin(workspace, "@openai/codex", "0.156.0", "0.157.0")).toBe(
      'catalog:\n  "@openai/codex": 0.157.0\n  opencode-ai: 1.18.32\n',
    );
    expect(withCatalogPin(workspace, "opencode-ai", "1.18.32", "1.19.0")).toBe(
      'catalog:\n  "@openai/codex": 0.156.0\n  opencode-ai: 1.19.0\n',
    );
    expect(() => withCatalogPin(workspace, "opencode-ai", "1.18.31", "1.19.0")).toThrow(
      "does not pin opencode-ai at 1.18.31 exactly once",
    );
  });

  it("records exactly what the selected engine prints even if another has the same old version", () => {
    const source =
      '    kind: "opencode",\n    runtime: {\n      expectedVersion: "1.0.0",\n    },\n  },\n    kind: "pi",\n    runtime: {\n      expectedVersion: "1.0.0",\n    },\n  },\n';
    const updated = withExpectedVersion(source, "opencode", "1.0.0", "1.1.0");
    expect(updated).toContain('kind: "opencode",\n    runtime: {\n      expectedVersion: "1.1.0"');
    expect(updated).toContain('kind: "pi",\n    runtime: {\n      expectedVersion: "1.0.0"');
    expect(() => withExpectedVersion(source, "opencode", "9.9.9", "10.0.0")).toThrow(
      'does not state "9.9.9" for opencode exactly once',
    );
  });

  it("accepts an npm update when its runtime version is unchanged", () => {
    const expected = harnessRuntimeExpectedVersion("codex");
    const source = `    kind: "codex",\n    runtime: {\n      expectedVersion: ${JSON.stringify(expected)},\n    },\n  },\n`;
    const unchanged = recordRuntimeVersions(source, [codexRelease], new Map());
    expect(unchanged.catalog).toBe(source);
    expect(unchanged.updates).toEqual([
      {
        kind: "codex",
        npmPackage: "@openai/codex",
        from: codexRelease.pinned,
        to: codexRelease.latest,
        runtimeVersion: expected,
      },
    ]);

    const changed = recordRuntimeVersions(
      source,
      [codexRelease],
      new Map([["codex", "codex-cli 0.157.0"]]),
    );
    expect(changed.catalog).toContain('expectedVersion: "codex-cli 0.157.0"');
    expect(changed.updates[0]?.runtimeVersion).toBe("codex-cli 0.157.0");
    expect(() =>
      recordRuntimeVersions(source, [codexRelease], new Map([["pi", "0.88.0"]])),
    ).toThrow("Engines not being updated print an unexpected --version: pi");
    expect(() => recordRuntimeVersions(source, [codexRelease], new Map([["codex", ""]]))).toThrow(
      "printed an empty --version",
    );
  });
});
