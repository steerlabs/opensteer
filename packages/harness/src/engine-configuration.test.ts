import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { assertEngineMayRun, engineConfiguration } from "./engine-configuration.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

async function makeCodexHome(files: { readonly auth?: string; readonly config?: string }) {
  const root = await mkdtemp(join(tmpdir(), "opensteer-codex-check-"));
  temporaryDirectories.push(root);
  const codexHome = join(root, ".codex");
  await mkdir(codexHome, { recursive: true });
  if (files.auth !== undefined) await writeFile(join(codexHome, "auth.json"), files.auth);
  if (files.config !== undefined) await writeFile(join(codexHome, "config.toml"), files.config);
  return { codexHome, root };
}

it("gives the engine's own configuration only to the person's own task with personal context", () => {
  expect(engineConfiguration({ personalContext: true, personLineage: true })).toBe("own");
  // A connected agent's or a chat's task, even one only the person speaks in.
  expect(engineConfiguration({ personalContext: true, personLineage: false })).toBe("stripped");
  // A chat others can speak in.
  expect(engineConfiguration({ personalContext: false, personLineage: false })).toBe("stripped");
  expect(engineConfiguration({ personalContext: false, personLineage: true })).toBe("stripped");
});

it("refuses a task that is not the person's own only on an engine not shown to start without their configuration", () => {
  const others = { personalContext: true, personLineage: false };
  const own = { personalContext: true, personLineage: true };
  for (const engine of ["claude", "pi", "opencode", "antigravity"])
    expect(() => assertEngineMayRun(engine, others)).not.toThrow();
  for (const [engine, label] of [
    ["cursor", "Cursor"],
    ["grok", "Grok"],
    ["muse", "Muse Code"],
  ] as const) {
    expect(() => assertEngineMayRun(engine, others)).toThrow(
      `${label} starts with your own ${label} settings, so it runs only tasks you started yourself that no connected agent or chat has written to.`,
    );
    expect(() => assertEngineMayRun(engine, own)).not.toThrow();
  }
});

it("lets Codex run others' tasks only when an Opensteer home can share a file login", async () => {
  const withFileLogin = await makeCodexHome({
    auth: '{"auth_mode":"apikey","OPENAI_API_KEY":"sk-stub"}',
  });
  expect(() =>
    assertEngineMayRun("codex", {
      environment: { CODEX_HOME: withFileLogin.codexHome },
      personalContext: true,
      personLineage: false,
      providerState: { kind: "ambient" },
    }),
  ).not.toThrow();

  // Isolated Codex profiles already own their home and file login.
  expect(() =>
    assertEngineMayRun("codex", {
      personalContext: true,
      personLineage: false,
      providerState: { kind: "isolated" },
    }),
  ).not.toThrow();

  // Keyring store cannot be shared into another CODEX_HOME.
  const withKeyring = await makeCodexHome({
    auth: '{"auth_mode":"apikey","OPENAI_API_KEY":"sk-stub"}',
    config: 'cli_auth_credentials_store = "keyring"\n',
  });
  expect(() =>
    assertEngineMayRun("codex", {
      environment: { CODEX_HOME: withKeyring.codexHome },
      personalContext: true,
      personLineage: false,
      providerState: { kind: "ambient" },
    }),
  ).toThrow(/cli_auth_credentials_store = "file"/u);

  // Missing auth.json refuses with guidance.
  const withoutAuth = await makeCodexHome({
    config: 'cli_auth_credentials_store = "auto"\n',
  });
  expect(() =>
    assertEngineMayRun("codex", {
      environment: { CODEX_HOME: withoutAuth.codexHome },
      personalContext: true,
      personLineage: false,
      providerState: { kind: "ambient" },
    }),
  ).toThrow(/auth\.json/u);

  // Command-backed model provider auth refuses so no user command runs on an others' task.
  const withCommandAuth = await makeCodexHome({
    auth: '{"auth_mode":"apikey","OPENAI_API_KEY":"sk-stub"}',
    config: [
      'model_provider = "corp"',
      "[model_providers.corp]",
      'base_url = "https://corp.invalid/v1"',
      "[model_providers.corp.auth]",
      'command = "corp-token"',
    ].join("\n"),
  });
  expect(() =>
    assertEngineMayRun("codex", {
      environment: { CODEX_HOME: withCommandAuth.codexHome },
      personalContext: true,
      personLineage: false,
      providerState: { kind: "ambient" },
    }),
  ).toThrow(/command/iu);
});
