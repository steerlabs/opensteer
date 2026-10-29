import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  configureDevelopmentBrowserRuntimeEnvironment,
  developmentBrowserRuntimeUrl,
} from "../scripts/dev.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("development Browser Runtime environment", () => {
  it("trusts the exact Host package key and fills local runtime defaults", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "opensteer-dev-browser-"));
    directories.push(repositoryRoot);
    const environment: NodeJS.ProcessEnv = {
      OPENSTEER_BROWSER_ATTACH_KEY_ID: "development-host",
      OPENSTEER_CHROMIUM_EXECUTABLE: process.execPath,
      OPENSTEER_HOST_DATA_DIR: ".opensteer/host",
      OPENSTEER_HOST_URL: "http://127.0.0.1:4310",
    };

    await configureDevelopmentBrowserRuntimeEnvironment(
      ["browser-runtime", "runner"],
      environment,
      repositoryRoot,
    );

    expect(environment.OPENSTEER_BROWSER_PROFILE_ROOT).toBe(
      join(repositoryRoot, ".opensteer/browser-runtime/profiles"),
    );
    expect(environment.OPENSTEER_BROWSER_PROFILE_STATE_INTERNAL_URL).toBe("http://127.0.0.1:4310");
    expect(environment.OPENSTEER_BROWSER_RUNTIME_ID).toBe("browser-main");
    expect(environment.OPENSTEER_BROWSER_BRIDGE_TOKEN).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(environment.OPENSTEER_BROWSER_BRIDGE_URL).toBe("http://127.0.0.1:4312/");
    const publicKey = await readFile(
      join(repositoryRoot, "apps/host/.opensteer/host/keys/host-public.pem"),
      "utf8",
    );
    expect(JSON.parse(environment.OPENSTEER_BROWSER_ATTACH_PUBLIC_KEYS ?? "{}")).toEqual({
      "development-host": publicKey,
    });
  });

  it("derives Runner bridge and Browser health routing from the same host and port", () => {
    expect(
      developmentBrowserRuntimeUrl({
        OPENSTEER_BROWSER_HOST: "localhost",
        OPENSTEER_BROWSER_PORT: "5312",
      }).toString(),
    ).toBe("http://localhost:5312/");
    expect(() => developmentBrowserRuntimeUrl({ OPENSTEER_BROWSER_PORT: "not-a-port" })).toThrow(
      /TCP port/u,
    );
  });

  it("preserves explicit Browser Runtime trust and path configuration", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "opensteer-dev-browser-explicit-"));
    directories.push(repositoryRoot);
    const environment: NodeJS.ProcessEnv = {
      OPENSTEER_BROWSER_ATTACH_PUBLIC_KEYS: '{"manual":"public-key"}',
      OPENSTEER_BROWSER_PROFILE_ROOT: "/private/browser-profiles",
      OPENSTEER_BROWSER_PROFILE_STATE_INTERNAL_URL: "http://host.internal:4310",
      OPENSTEER_CHROMIUM_EXECUTABLE: process.execPath,
    };

    await configureDevelopmentBrowserRuntimeEnvironment(
      ["browser-runtime"],
      environment,
      repositoryRoot,
    );

    expect(environment).toMatchObject({
      OPENSTEER_BROWSER_ATTACH_PUBLIC_KEYS: '{"manual":"public-key"}',
      OPENSTEER_BROWSER_PROFILE_ROOT: "/private/browser-profiles",
      OPENSTEER_BROWSER_PROFILE_STATE_INTERNAL_URL: "http://host.internal:4310",
      OPENSTEER_CHROMIUM_EXECUTABLE: process.execPath,
    });
  });

  it("does not configure browsing when the service is not selected", async () => {
    const environment: NodeJS.ProcessEnv = {};
    await configureDevelopmentBrowserRuntimeEnvironment(["host"], environment, "/workspace");
    expect(environment).toEqual({});
  });

  it("replaces an empty internal Host origin with the active development Host", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "opensteer-dev-browser-origin-"));
    directories.push(repositoryRoot);
    const environment: NodeJS.ProcessEnv = {
      OPENSTEER_BROWSER_ATTACH_PUBLIC_KEYS: '{"manual":"public-key"}',
      OPENSTEER_BROWSER_PROFILE_STATE_INTERNAL_URL: "  ",
      OPENSTEER_CHROMIUM_EXECUTABLE: process.execPath,
      OPENSTEER_HOST_URL: "http://127.0.0.1:4310",
    };

    await configureDevelopmentBrowserRuntimeEnvironment(
      ["browser-runtime"],
      environment,
      repositoryRoot,
    );

    expect(environment.OPENSTEER_BROWSER_PROFILE_STATE_INTERNAL_URL).toBe("http://127.0.0.1:4310");
  });
});
