import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { builtProcessSupervisor } from "../scripts/process-supervisor-path.js";
import {
  developmentPreflightCommands,
  configureDevelopmentEnvironment,
  developmentMessagingEnrollmentToken,
  parseServices,
  parseShutdownGraceMs,
  readySummary,
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

  it("shares one Personal hosting identity and an isolated agent home between Host and Runner", () => {
    const environment: NodeJS.ProcessEnv = {};
    configureDevelopmentEnvironment("personal", environment);
    expect(environment.OPENSTEER_DEPLOYMENT_KIND).toBe("personal");
    expect(environment.OPENSTEER_HOSTING_ENVIRONMENT_ID).toBe(environment.OPENSTEER_ENVIRONMENT_ID);
    expect(environment.OPENSTEER_AGENT_HOME).toBe(
      resolve(import.meta.dirname, "..", ".opensteer/agent-home"),
    );
    expect(environment.OPENSTEER_LOCAL_OWNER_CLAIM_TOKEN).toHaveLength(43);
  });
  it("starts a team without Personal hosting configuration", () => {
    const environment: NodeJS.ProcessEnv = {};
    configureDevelopmentEnvironment("team", environment);
    expect(environment.OPENSTEER_DEPLOYMENT_KIND).toBe("team");
    expect(environment.OPENSTEER_HOSTING_ENVIRONMENT_ID).toBeUndefined();
    expect(environment.OPENSTEER_INITIAL_OWNER_ENROLLMENT_TOKEN).toHaveLength(43);
    expect(developmentPreflightCommands(["host", "web"], "team")).toEqual([]);
  });
  it("rejects mismatched local Host and Runner environment identities", () => {
    expect(() =>
      configureDevelopmentEnvironment("personal", {
        OPENSTEER_ENVIRONMENT_ID: "env_00000000-0000-5000-8000-000000000001",
        OPENSTEER_HOSTING_ENVIRONMENT_ID: "env_00000000-0000-5000-8000-000000000002",
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
  });

  it("runs every service under the supervisor built for this computer", () => {
    const environment: NodeJS.ProcessEnv = {};
    configureDevelopmentEnvironment("team", environment);
    expect(environment.OPENSTEER_PROCESS_SUPERVISOR_EXECUTABLE).toBe(
      builtProcessSupervisor(resolve(import.meta.dirname, "..")),
    );
    expect(builtProcessSupervisor("/r", "win32", "x64")).toBe(
      join("/r", "apps/desktop/generated-native/windows-amd64/opensteer-process-supervisor.exe"),
    );
    expect(builtProcessSupervisor("/r", "linux", "arm64")).toBe(
      join("/r", "apps/desktop/generated-native/linux-arm64/opensteer-process-supervisor"),
    );
  });

  it("uses the hosting computer’s native file helper", () => {
    const helper =
      process.platform === "win32" ? "C:\\Opensteer\\native-fs.exe" : "/opt/opensteer/native-fs";
    const environment: NodeJS.ProcessEnv = { OPENSTEER_NATIVE_FS_HELPER: helper };
    configureDevelopmentEnvironment("personal", environment);
    expect(environment.OPENSTEER_NATIVE_FS_HELPER).toBe(helper);
    expect(environment.OPENSTEER_HOST_NATIVE_FS_HELPER).toBeUndefined();
  });
});

describe("development deployment presentation", () => {
  it("names the development Opensteer unless the environment already names it", () => {
    const environment: NodeJS.ProcessEnv = {};
    configureDevelopmentEnvironment("personal", environment);
    expect(environment.OPENSTEER_DEPLOYMENT_NAME).toBe("Development");

    const named: NodeJS.ProcessEnv = { OPENSTEER_DEPLOYMENT_NAME: "Scratch" };
    configureDevelopmentEnvironment("personal", named);
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
