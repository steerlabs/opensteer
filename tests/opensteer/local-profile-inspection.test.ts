import { mkdir, symlink, mkdtemp, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

const childProcessState = vi.hoisted(() => ({
  execFile: vi.fn(),
}));

const cdpDiscoveryState = vi.hoisted(() => ({
  inspectCdpEndpoint: vi.fn(),
  selectAttachBrowserCandidate: vi.fn(),
}));

const processOwnerState = vi.hoisted(() => ({
  getProcessLiveness: vi.fn(async () => "live" as const),
  isProcessRunning: vi.fn(() => false),
}));

vi.mock("node:child_process", () => ({
  execFile: childProcessState.execFile,
}));

vi.mock("../../packages/opensteer/src/local-browser/cdp-discovery.js", () => ({
  inspectCdpEndpoint: cdpDiscoveryState.inspectCdpEndpoint,
  selectAttachBrowserCandidate: cdpDiscoveryState.selectAttachBrowserCandidate,
}));

vi.mock("../../packages/opensteer/src/local-browser/process-owner.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../packages/opensteer/src/local-browser/process-owner.js")
  >("../../packages/opensteer/src/local-browser/process-owner.js");
  return {
    ...actual,
    getProcessLiveness: processOwnerState.getProcessLiveness,
    isProcessRunning: processOwnerState.isProcessRunning,
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  childProcessState.execFile.mockReset();
  childProcessState.execFile.mockImplementation((_file, _args, _options, callback) => {
    callback?.(null, { stdout: "", stderr: "" });
    return {} as ReturnType<typeof childProcessState.execFile>;
  });
  cdpDiscoveryState.inspectCdpEndpoint.mockReset();
  cdpDiscoveryState.inspectCdpEndpoint.mockResolvedValue({
    endpoint: "ws://127.0.0.1:9222/devtools/browser/root",
  });
  cdpDiscoveryState.selectAttachBrowserCandidate.mockReset();
  cdpDiscoveryState.selectAttachBrowserCandidate.mockRejectedValue(new Error("not found"));
  processOwnerState.getProcessLiveness.mockReset();
  processOwnerState.getProcessLiveness.mockResolvedValue("live");
  processOwnerState.isProcessRunning.mockReset();
  processOwnerState.isProcessRunning.mockReturnValue(false);
});

describe("local profile inspection", () => {
  test("classifies known default Chrome user-data-dir as unsupported", async () => {
    vi.doMock("../../packages/opensteer/src/local-browser/chrome-discovery.js", () => ({
      detectLocalChromeInstallations: () => [
        {
          brand: "chrome" as const,
          executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          userDataDir: "/Users/test/Library/Application Support/Google/Chrome",
        },
      ],
      expandHome: (value: string) => value,
      readDevToolsActivePort: vi.fn(() => null),
      resolveChromeUserDataDir: (userDataDir?: string) =>
        path.resolve(userDataDir ?? "/tmp/missing"),
    }));

    const { inspectLocalBrowserProfile } =
      await import("../../packages/opensteer/src/local-browser/profile-inspection.js");

    await expect(
      inspectLocalBrowserProfile({
        userDataDir: "/Users/test/Library/Application Support/Google/Chrome",
      }),
    ).resolves.toEqual({
      status: "unsupported_default_user_data_dir",
      userDataDir: "/Users/test/Library/Application Support/Google/Chrome",
      installationBrand: "chrome",
    });
  });

  test("classifies live Opensteer launch metadata as opensteer_owned", async () => {
    const userDataDir = await mkdtemp(path.join(tmpdir(), "opensteer-profile-owned-"));

    vi.doMock("../../packages/opensteer/src/local-browser/chrome-discovery.js", () => ({
      detectLocalChromeInstallations: () => [],
      expandHome: (value: string) => value,
      readDevToolsActivePort: vi.fn(() => null),
      resolveChromeUserDataDir: (input?: string) => path.resolve(input ?? userDataDir),
    }));

    try {
      const { getProfileLaunchMetadataPath } =
        await import("../../packages/opensteer/src/local-browser/profile-launch-metadata.js");
      await mkdir(path.dirname(getProfileLaunchMetadataPath(userDataDir)), {
        recursive: true,
      });
      await writeFile(
        getProfileLaunchMetadataPath(userDataDir),
        JSON.stringify({
          args: [],
          executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          headless: false,
          owner: {
            pid: 2222,
            processStartedAtMs: 22_222,
          },
          userDataDir,
        }),
      );

      const { inspectLocalBrowserProfile } =
        await import("../../packages/opensteer/src/local-browser/profile-inspection.js");

      await expect(inspectLocalBrowserProfile({ userDataDir })).resolves.toMatchObject({
        status: "opensteer_owned",
        userDataDir,
        owner: {
          pid: 2222,
          processStartedAtMs: 22_222,
        },
      });
    } finally {
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
      const { getProfileLaunchMetadataDir } =
        await import("../../packages/opensteer/src/local-browser/profile-launch-metadata.js");
      await rm(getProfileLaunchMetadataDir(userDataDir), {
        recursive: true,
        force: true,
      }).catch(() => undefined);
    }
  });

  test("classifies reachable DevToolsActivePort as browser_owned", async () => {
    const userDataDir = await mkdtemp(path.join(tmpdir(), "opensteer-profile-devtools-"));
    cdpDiscoveryState.inspectCdpEndpoint.mockResolvedValue({
      endpoint: "ws://127.0.0.1:9222/devtools/browser/root",
    });
    cdpDiscoveryState.selectAttachBrowserCandidate.mockResolvedValue({
      endpoint: "ws://127.0.0.1:9222/devtools/browser/root",
      source: "devtools-active-port",
    });

    vi.doMock("../../packages/opensteer/src/local-browser/chrome-discovery.js", () => ({
      detectLocalChromeInstallations: () => [],
      expandHome: (value: string) => value,
      readDevToolsActivePort: vi.fn(() => ({
        port: 9222,
        webSocketPath: "/devtools/browser/root",
      })),
      resolveChromeUserDataDir: (input?: string) => path.resolve(input ?? userDataDir),
    }));

    try {
      const { inspectLocalBrowserProfile } =
        await import("../../packages/opensteer/src/local-browser/profile-inspection.js");

      await expect(inspectLocalBrowserProfile({ userDataDir })).resolves.toEqual({
        status: "browser_owned",
        userDataDir,
        evidence: "devtools",
        cdpEndpoint: "ws://127.0.0.1:9222/devtools/browser/root",
        attachMode: "attach",
      });
    } finally {
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  test("classifies reachable DevToolsActivePort as attachable even when discovery is ambiguous", async () => {
    const userDataDir = await mkdtemp(path.join(tmpdir(), "opensteer-profile-devtools-cdp-"));
    cdpDiscoveryState.inspectCdpEndpoint.mockResolvedValue({
      endpoint: "ws://127.0.0.1:9333/devtools/browser/root",
    });
    cdpDiscoveryState.selectAttachBrowserCandidate.mockRejectedValue(new Error("ambiguous"));

    vi.doMock("../../packages/opensteer/src/local-browser/chrome-discovery.js", () => ({
      detectLocalChromeInstallations: () => [],
      expandHome: (value: string) => value,
      readDevToolsActivePort: vi.fn(() => ({
        port: 9333,
        webSocketPath: "/devtools/browser/root",
      })),
      resolveChromeUserDataDir: (input?: string) => path.resolve(input ?? userDataDir),
    }));

    try {
      const { inspectLocalBrowserProfile } =
        await import("../../packages/opensteer/src/local-browser/profile-inspection.js");

      await expect(inspectLocalBrowserProfile({ userDataDir })).resolves.toEqual({
        status: "browser_owned",
        userDataDir,
        evidence: "devtools",
        cdpEndpoint: "ws://127.0.0.1:9333/devtools/browser/root",
        attachMode: "attach",
      });
    } finally {
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  test("classifies live singleton owner without DevTools as browser_owned", async () => {
    const userDataDir = await mkdtemp(path.join(tmpdir(), "opensteer-profile-singleton-live-"));

    vi.doMock("../../packages/opensteer/src/local-browser/chrome-discovery.js", () => ({
      detectLocalChromeInstallations: () => [],
      expandHome: (value: string) => value,
      readDevToolsActivePort: vi.fn(() => null),
      resolveChromeUserDataDir: (input?: string) => path.resolve(input ?? userDataDir),
    }));
    processOwnerState.isProcessRunning.mockReturnValue(true);
    childProcessState.execFile.mockImplementation((_file, _args, _options, callback) => {
      callback?.(null, {
        stdout: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --some-flag\n",
        stderr: "",
      });
      return {} as ReturnType<typeof childProcessState.execFile>;
    });

    try {
      await symlink(`${hostname()}-4321`, path.join(userDataDir, "SingletonLock"));
      const { inspectLocalBrowserProfile } =
        await import("../../packages/opensteer/src/local-browser/profile-inspection.js");

      await expect(inspectLocalBrowserProfile({ userDataDir })).resolves.toEqual({
        status: "browser_owned",
        userDataDir,
        evidence: "singleton_owner",
        ownerPid: 4321,
        attachMode: null,
      });
    } finally {
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  test("classifies dead singleton owner as stale_lock", async () => {
    const userDataDir = await mkdtemp(path.join(tmpdir(), "opensteer-profile-singleton-stale-"));

    vi.doMock("../../packages/opensteer/src/local-browser/chrome-discovery.js", () => ({
      detectLocalChromeInstallations: () => [],
      expandHome: (value: string) => value,
      readDevToolsActivePort: vi.fn(() => null),
      resolveChromeUserDataDir: (input?: string) => path.resolve(input ?? userDataDir),
    }));

    try {
      await symlink(`${hostname()}-987654`, path.join(userDataDir, "SingletonLock"));
      await writeFile(path.join(userDataDir, "SingletonSocket"), "");
      const { inspectLocalBrowserProfile } =
        await import("../../packages/opensteer/src/local-browser/profile-inspection.js");

      await expect(inspectLocalBrowserProfile({ userDataDir })).resolves.toEqual({
        status: "stale_lock",
        userDataDir,
        artifacts: ["SingletonLock", "SingletonSocket"],
        staleOwnerPid: 987654,
      });
    } finally {
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  test("classifies singleton artifacts without deterministic stale proof as browser_owned", async () => {
    const userDataDir = await mkdtemp(path.join(tmpdir(), "opensteer-profile-singleton-artifact-"));

    vi.doMock("../../packages/opensteer/src/local-browser/chrome-discovery.js", () => ({
      detectLocalChromeInstallations: () => [],
      expandHome: (value: string) => value,
      readDevToolsActivePort: vi.fn(() => null),
      resolveChromeUserDataDir: (input?: string) => path.resolve(input ?? userDataDir),
    }));

    try {
      await writeFile(path.join(userDataDir, "lockfile"), "");
      const { inspectLocalBrowserProfile } =
        await import("../../packages/opensteer/src/local-browser/profile-inspection.js");

      await expect(inspectLocalBrowserProfile({ userDataDir })).resolves.toEqual({
        status: "browser_owned",
        userDataDir,
        evidence: "singleton_artifacts",
        attachMode: null,
      });
    } finally {
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  test("unlock removes only stale singleton artifacts", async () => {
    const userDataDir = await mkdtemp(path.join(tmpdir(), "opensteer-profile-unlock-"));

    vi.doMock("../../packages/opensteer/src/local-browser/chrome-discovery.js", () => ({
      detectLocalChromeInstallations: () => [],
      expandHome: (value: string) => value,
      readDevToolsActivePort: vi.fn(() => null),
      resolveChromeUserDataDir: (input?: string) => path.resolve(input ?? userDataDir),
    }));

    try {
      await symlink(`${hostname()}-987655`, path.join(userDataDir, "SingletonLock"));
      await writeFile(path.join(userDataDir, "SingletonCookie"), "");
      const { unlockLocalBrowserProfile } =
        await import("../../packages/opensteer/src/local-browser/profile-inspection.js");

      await expect(unlockLocalBrowserProfile({ userDataDir })).resolves.toEqual({
        userDataDir,
        removed: ["SingletonCookie", "SingletonLock"],
      });
    } finally {
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  test("unlock rejects non-stale profiles with the structured inspection error", async () => {
    const userDataDir = await mkdtemp(path.join(tmpdir(), "opensteer-profile-unlock-reject-"));

    vi.doMock("../../packages/opensteer/src/local-browser/chrome-discovery.js", () => ({
      detectLocalChromeInstallations: () => [],
      expandHome: (value: string) => value,
      readDevToolsActivePort: vi.fn(() => null),
      resolveChromeUserDataDir: (input?: string) => path.resolve(input ?? userDataDir),
    }));

    try {
      const { OpensteerLocalProfileUnavailableError, unlockLocalBrowserProfile } =
        await import("../../packages/opensteer/src/local-browser/profile-inspection.js");

      await expect(unlockLocalBrowserProfile({ userDataDir })).rejects.toBeInstanceOf(
        OpensteerLocalProfileUnavailableError,
      );
    } finally {
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
