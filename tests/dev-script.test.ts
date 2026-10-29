import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertDevelopmentPortableFsConfiguration,
  developmentPreflightCommands,
  configureDevelopmentWorkspaceEnvironment,
  developmentMessagingEnrollmentToken,
  parseDevelopmentPortableFsDeployment,
  parseServices,
  parseShutdownGraceMs,
  readySummary,
  selectedServices,
} from "../scripts/dev.js";

describe("development service selection", () => {
  it("uses the product's ordinary local processes by default", () => {
    expect(parseServices(undefined)).toEqual([
      "host",
      "runner",
      "browser-runtime",
      "channel-runtime",
      "web",
    ]);
  });

  it("accepts an explicit unique service list", () => {
    expect(parseServices("host,browser-runtime,host,channel-runtime")).toEqual([
      "host",
      "browser-runtime",
      "channel-runtime",
    ]);
  });

  it("rejects unknown and empty selections", () => {
    expect(() => parseServices("host,magic")).toThrow(/Unknown development service/);
    expect(() => parseServices(", ,")).toThrow(/cannot be empty/);
  });

  it("bounds the coordinated shutdown grace period", () => {
    expect(parseShutdownGraceMs(undefined)).toBe(10_000);
    expect(parseShutdownGraceMs("2500")).toBe(2_500);
    expect(() => parseShutdownGraceMs("0")).toThrow(/1000 through 60000/);
  });

  it("uses the local PortableFS deployment only inside the explicit PortableFS backing", () => {
    expect(parseDevelopmentPortableFsDeployment(undefined)).toBe("local");
    expect(parseDevelopmentPortableFsDeployment("external")).toBe("external");
    expect(() => parseDevelopmentPortableFsDeployment("fallback")).toThrow(/local or external/);
  });

  it("constructs one strict local-directory contract for Host and Runner", () => {
    const environment: NodeJS.ProcessEnv = {};
    configureDevelopmentWorkspaceEnvironment("local-directory", environment);
    expect(environment).toMatchObject({
      OPENSTEER_DEFAULT_WORKSPACE_BACKING: "local-directory",
      OPENSTEER_DEPLOYMENT_KIND: "server",
      OPENSTEER_ENVIRONMENT_ID: "env_00000000-0000-5000-8000-000000000001",
      OPENSTEER_LOCAL_WORKSPACE_ENVIRONMENT_ID: "env_00000000-0000-5000-8000-000000000001",
      OPENSTEER_LOCAL_WORKSPACE_REGISTRY_PATH: resolve(
        import.meta.dirname,
        "..",
        ".opensteer/host/workspace-bindings.v1.json",
      ),
      OPENSTEER_LOCAL_WORKSPACE_ROOT: resolve(import.meta.dirname, "..", ".opensteer/workspaces"),
      OPENSTEER_RUNNER_WORKSPACE_BACKINGS: "local-directory",
    });
    expect(environment.OPENSTEER_HOST_NATIVE_FS_HELPER).toBeUndefined();
    expect(environment.OPENSTEER_NATIVE_FS_HELPER).toMatch(
      process.platform === "win32" ? /opensteer-native-fs\.exe$/u : /opensteer-native-fs$/u,
    );
    expect(selectedServices(parseServices(undefined), "local-directory")).toEqual([
      "host",
      "runner",
      "browser-runtime",
      "channel-runtime",
      "web",
    ]);
  });

  it("adds Files only for a local PortableFS integration backing", () => {
    const environment: NodeJS.ProcessEnv = {};
    configureDevelopmentWorkspaceEnvironment("portablefs", environment);
    expect(environment).toMatchObject({
      OPENSTEER_DEFAULT_WORKSPACE_BACKING: "portablefs",
      OPENSTEER_DEPLOYMENT_KIND: "server",
      OPENSTEER_RUNNER_WORKSPACE_BACKINGS: "portablefs",
      OPENSTEER_RUNNER_WORKSPACE_ROOT: resolve(
        import.meta.dirname,
        "..",
        ".opensteer/runner/workspaces",
      ),
    });
    expect(selectedServices(["host", "runner", "web"], "portablefs", "local")).toEqual([
      "files",
      "host",
      "runner",
      "web",
    ]);
    expect(selectedServices(["files"], "portablefs", "local")).toEqual(["files"]);
    expect(selectedServices(["host", "runner", "web"], "portablefs", "external")).toEqual([
      "host",
      "runner",
      "web",
    ]);
    expect(() => selectedServices(["files"], "local-directory")).toThrow(/only with/);
    expect(() => selectedServices(["files"], "portablefs", "external")).toThrow(
      /provide their own Files service/,
    );
  });

  it("requires the explicit external PortableFS endpoints before starting Host or Runner", () => {
    expect(() => assertDevelopmentPortableFsConfiguration("external", ["host"], {})).toThrow(
      /requires OPENSTEER_FILES_SERVICE_URL/,
    );
    expect(() =>
      assertDevelopmentPortableFsConfiguration("external", ["host"], {
        OPENSTEER_FILES_SERVICE_URL: "https://files.example.test",
        OPENSTEER_PORTABLEFS_AUTHORIZATION_DOMAIN: "test",
        OPENSTEER_PORTABLEFS_MANAGER_URL: "https://manager.example.test",
        OPENSTEER_PORTABLEFS_PRODUCT_ISSUER: "test",
        OPENSTEER_PORTABLEFS_SERVICE_ID: "test",
        OPENSTEER_WORKSPACE_DEFAULT_BLOCK_LIMIT_BYTES: "536870912",
        OPENSTEER_WORKSPACE_DEFAULT_INODE_LIMIT: "50000",
      }),
    ).not.toThrow();
    expect(() => assertDevelopmentPortableFsConfiguration("external", ["runner"], {})).toThrow(
      /requires OPENSTEER_PORTABLEFS_MOUNT_BINARY/,
    );
    expect(() =>
      assertDevelopmentPortableFsConfiguration("external", ["runner"], {
        OPENSTEER_PORTABLEFS_MOUNT_BINARY: "/opt/portablefs",
      }),
    ).not.toThrow();
  });

  it("rejects mismatched local Host and Runner environment identities", () => {
    expect(() =>
      configureDevelopmentWorkspaceEnvironment("local-directory", {
        OPENSTEER_ENVIRONMENT_ID: "env_00000000-0000-5000-8000-000000000001",
        OPENSTEER_LOCAL_WORKSPACE_ENVIRONMENT_ID: "env_00000000-0000-5000-8000-000000000002",
      }),
    ).toThrow(/must match/);
  });

  it("builds the strict filesystem helper before starting a Runner", () => {
    expect(developmentPreflightCommands(["host", "runner", "web"])).toEqual([
      ["--filter", "@opensteer/runner", "build:native-fs"],
    ]);
    expect(developmentPreflightCommands(["host", "web"])).toEqual([
      ["--filter", "@opensteer/runner", "build:native-fs"],
    ]);
    expect(developmentPreflightCommands(["host", "web"], "portablefs")).toEqual([]);
  });

  it("gives the native filesystem authority to the Runner alone", () => {
    const helper =
      process.platform === "win32" ? "C:\\Opensteer\\native-fs.exe" : "/opt/opensteer/native-fs";
    const environment: NodeJS.ProcessEnv = { OPENSTEER_NATIVE_FS_HELPER: helper };
    configureDevelopmentWorkspaceEnvironment("local-directory", environment);
    expect(environment.OPENSTEER_NATIVE_FS_HELPER).toBe(helper);
    expect(environment.OPENSTEER_HOST_NATIVE_FS_HELPER).toBeUndefined();
  });
});

describe("development deployment presentation", () => {
  it("names the development Opensteer unless the environment already names it", () => {
    const environment: NodeJS.ProcessEnv = {};
    configureDevelopmentWorkspaceEnvironment("local-directory", environment);
    expect(environment.OPENSTEER_DEPLOYMENT_NAME).toBe("Development");

    const named: NodeJS.ProcessEnv = { OPENSTEER_DEPLOYMENT_NAME: "Scratch" };
    configureDevelopmentWorkspaceEnvironment("local-directory", named);
    expect(named.OPENSTEER_DEPLOYMENT_NAME).toBe("Scratch");
  });
});

describe("development messaging computer", () => {
  it("derives one stable enrollment token from the deployment secret the stack already keeps", () => {
    // The Host binds the enrollment's idempotency key to the exact token, so a
    // value that changed between runs would refuse the Host its own startup.
    const environment: NodeJS.ProcessEnv = { OPENSTEER_AUTH_SECRET: "a".repeat(48) };
    const token = developmentMessagingEnrollmentToken(["host", "channel-runtime"], environment);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(token).not.toContain("a".repeat(20));
    expect(developmentMessagingEnrollmentToken(["host", "channel-runtime"], environment)).toBe(
      token,
    );
    expect(
      developmentMessagingEnrollmentToken(["host", "channel-runtime"], {
        OPENSTEER_AUTH_SECRET: "b".repeat(48),
      }),
    ).not.toBe(token);
    expect(environment).toEqual({ OPENSTEER_AUTH_SECRET: "a".repeat(48) });
  });

  it("prefers a configured token and mints nothing without a messaging computer", () => {
    const configured = "operator-minted-token".padEnd(32, "x");
    expect(
      developmentMessagingEnrollmentToken(["host", "channel-runtime"], {
        OPENSTEER_AUTH_SECRET: "a".repeat(48),
        OPENSTEER_INITIAL_MESSAGING_RUNNER_ENROLLMENT_TOKEN: configured,
      }),
    ).toBe(configured);
    expect(
      developmentMessagingEnrollmentToken(["host", "runner", "web"], {
        OPENSTEER_AUTH_SECRET: "a".repeat(48),
      }),
    ).toBeUndefined();
    expect(developmentMessagingEnrollmentToken(["host", "channel-runtime"], {})).toBeUndefined();
  });
});

describe("development boot summary", () => {
  it("claims readiness only for health-checked services and ends on the one address", () => {
    const summary = readySummary(["host", "runner", "browser-runtime", "channel-runtime", "web"], {
      bootstrap: {
        runnerEnrollmentToken: null,
        setupUrl: "http://localhost:43100/?setup=code",
      },
      openingBrowser: true,
      url: "http://localhost:43100/?setup=code",
      webReady: true,
    });

    expect(summary).toContain("✓ Host");
    expect(summary).toMatch(/Host\s+ready/);
    expect(summary).toMatch(/Main Runner\s+started/);
    expect(summary).toMatch(/Browser Runtime\s+ready/);
    expect(summary).toMatch(/Web\s+ready/);
    expect(summary).toContain("Your development Opensteer is ready — finish setup at");
    expect(summary).toContain("→ http://localhost:43100/?setup=code");
    expect(summary).toContain("Opening your browser…");
  });

  it("stays honest on a returning claimed run without a setup link", () => {
    const summary = readySummary(["host", "web"], {
      bootstrap: {
        runnerEnrollmentToken: null,
        setupUrl: null,
      },
      openingBrowser: false,
      url: "http://localhost:43100",
      webReady: true,
    });

    expect(summary).toContain("Your development Opensteer is ready");
    expect(summary).not.toContain("finish setup");
    expect(summary).not.toContain("Opening your browser…");
    expect(summary).toContain("→ http://localhost:43100");
  });
});
