import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  checkCodexEffectiveConfig,
  checkCodexOthersHome,
  extractCodexModelConfig,
  parseCodexConfigToml,
  serializeCodexOthersConfigToml,
} from "./codex-config.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

it("extracts only reach-the-model settings and strips personal rules, hooks, agents and project trust", () => {
  const parsed = parseCodexConfigToml(
    [
      "# User Codex configuration",
      'model_provider = "corp"',
      'openai_base_url = "https://openai.corp.invalid/v1"',
      'chatgpt_base_url = "https://chatgpt.corp.invalid/backend-api"',
      'forced_login_method = "chatgpt"',
      'forced_chatgpt_workspace_id = ["ws-1", "ws-2"]',
      'notify = ["touch", "/tmp/notify-ran"]',
      'developer_instructions = """',
      "PERSON-DEVELOPER-MARKER",
      '"""',
      'personality = "friendly"',
      'approval_policy = "never"',
      'sandbox_mode = "danger-full-access"',
      "",
      "[model_providers.corp]",
      'name = "Corp Gateway"',
      'base_url = "https://gateway.corp.invalid/v1"',
      'wire_api = "responses"',
      'env_key = "CORP_API_KEY"',
      'http_headers = { "X-Team" = "eng" }',
      'env_http_headers = { "X-Token" = "CORP_TOKEN" }',
      'query_params = { "api-version" = "2025-01-01" }',
      "requires_openai_auth = false",
      "supports_websockets = true",
      "request_max_retries = 3",
      "",
      "[agents.person-agent]",
      'description = "PERSON-AGENT-MARKER"',
      "",
      '[projects."/Users/person/work"]',
      'trust_level = "trusted"',
      "",
      "[mcp_servers.personal]",
      'command = "personal-mcp"',
      "",
      "[[hooks.pre_tool_use]]",
      'command = "touch /tmp/hook"',
      "",
    ].join("\n"),
  );
  const extracted = extractCodexModelConfig(parsed);
  expect(extracted.ok).toBe(true);
  if (!extracted.ok) return;
  const serialized = serializeCodexOthersConfigToml(extracted.modelConfig);
  const reparsed = parseCodexConfigToml(serialized);
  expect(reparsed).toEqual({
    cli_auth_credentials_store: "file",
    model_provider: "corp",
    openai_base_url: "https://openai.corp.invalid/v1",
    chatgpt_base_url: "https://chatgpt.corp.invalid/backend-api",
    forced_login_method: "chatgpt",
    forced_chatgpt_workspace_id: ["ws-1", "ws-2"],
    model_providers: {
      corp: {
        name: "Corp Gateway",
        base_url: "https://gateway.corp.invalid/v1",
        wire_api: "responses",
        env_key: "CORP_API_KEY",
        http_headers: { "X-Team": "eng" },
        env_http_headers: { "X-Token": "CORP_TOKEN" },
        query_params: { "api-version": "2025-01-01" },
        requires_openai_auth: false,
        supports_websockets: true,
        request_max_retries: 3,
      },
    },
  });
  for (const forbidden of [
    "notify",
    "PERSON-DEVELOPER-MARKER",
    "friendly",
    "approval_policy",
    "sandbox_mode",
    "PERSON-AGENT-MARKER",
    "trust_level",
    "personal-mcp",
    "hooks",
  ]) {
    expect(serialized).not.toContain(forbidden);
  }
});

it("resolves model_provider from the active profile without copying the rest of the profile", () => {
  const parsed = parseCodexConfigToml(
    [
      'profile = "work"',
      "[profiles.work]",
      'model_provider = "proxy"',
      'approval_policy = "never"',
      "[model_providers.proxy]",
      'base_url = "https://proxy.invalid/v1"',
      'wire_api = "responses"',
    ].join("\n"),
  );
  const extracted = extractCodexModelConfig(parsed);
  expect(extracted.ok).toBe(true);
  if (!extracted.ok) return;
  expect(extracted.modelConfig.model_provider).toBe("proxy");
  expect(serializeCodexOthersConfigToml(extracted.modelConfig)).not.toContain("approval_policy");
});

it("refuses malformed config.toml, keyring store, ephemeral store, and active aws credential_export", async () => {
  const root = await mkdtemp(join(tmpdir(), "opensteer-codex-cfg-"));
  temporaryDirectories.push(root);
  const codexHome = join(root, ".codex");
  await mkdir(codexHome, { recursive: true });
  await writeFile(join(codexHome, "auth.json"), '{"OPENAI_API_KEY":"k"}');

  await writeFile(join(codexHome, "config.toml"), "broken = [unterminated\n");
  expect(checkCodexOthersHome({ environment: { CODEX_HOME: codexHome } })).toMatchObject({
    ok: false,
    message: expect.stringContaining("config.toml"),
  });

  await writeFile(join(codexHome, "config.toml"), 'cli_auth_credentials_store = "ephemeral"\n');
  expect(checkCodexOthersHome({ environment: { CODEX_HOME: codexHome } })).toMatchObject({
    ok: false,
    message: expect.stringContaining('cli_auth_credentials_store = "file"'),
  });

  await writeFile(
    join(codexHome, "config.toml"),
    [
      'model_provider = "bedrock"',
      "[model_providers.bedrock]",
      'base_url = "https://bedrock.invalid/v1"',
      "[model_providers.bedrock.aws.credential_export]",
      'command = "aws-creds"',
    ].join("\n"),
  );
  expect(checkCodexOthersHome({ environment: { CODEX_HOME: codexHome } })).toMatchObject({
    ok: false,
    message: expect.stringContaining("command"),
  });
});

it("refuses active AWS/Bedrock providers (including aws.profile, aws.region and built-in bedrock) and never copies aws tables", async () => {
  const root = await mkdtemp(join(tmpdir(), "opensteer-codex-aws-"));
  temporaryDirectories.push(root);
  const codexHome = join(root, ".codex");
  await mkdir(codexHome, { recursive: true });
  await writeFile(join(codexHome, "auth.json"), '{"OPENAI_API_KEY":"k"}');

  // Active provider with aws.profile / aws.region can invoke ~/.aws/config credential_process or SSO helpers.
  await writeFile(
    join(codexHome, "config.toml"),
    [
      'model_provider = "bedrock"',
      "[model_providers.bedrock]",
      'base_url = "https://bedrock.invalid/v1"',
      "[model_providers.bedrock.aws]",
      'profile = "corp-sso"',
      'region = "us-east-1"',
    ].join("\n"),
  );
  expect(checkCodexOthersHome({ environment: { CODEX_HOME: codexHome } })).toMatchObject({
    ok: false,
    message: expect.stringMatching(/AWS|credential/iu),
  });

  // Built-in amazon-bedrock / amazon-bedrock-runtime providers invoke the AWS SDK credential chain even with no [model_providers.*] table.
  for (const builtIn of ["amazon-bedrock", "amazon-bedrock-runtime"]) {
    await writeFile(join(codexHome, "config.toml"), `model_provider = "${builtIn}"\n`);
    expect(checkCodexOthersHome({ environment: { CODEX_HOME: codexHome } })).toMatchObject({
      ok: false,
      message: expect.stringMatching(/AWS|credential/iu),
    });
  }

  // Inactive AWS provider is dropped completely (never carries aws.profile or aws.region into the others' config.toml).
  const extracted = extractCodexModelConfig(
    parseCodexConfigToml(
      [
        'model_provider = "corp"',
        "[model_providers.corp]",
        'base_url = "https://corp.invalid/v1"',
        "[model_providers.unused-bedrock]",
        'base_url = "https://bedrock.invalid/v1"',
        "[model_providers.unused-bedrock.aws]",
        'profile = "corp-sso"',
        'region = "us-east-1"',
      ].join("\n"),
    ),
  );
  expect(extracted.ok).toBe(true);
  if (!extracted.ok) return;
  const serialized = serializeCodexOthersConfigToml(extracted.modelConfig);
  expect(serialized).not.toContain("unused-bedrock");
  expect(serialized).not.toContain("corp-sso");
  expect(serialized).not.toContain("aws");
});

it("checks merged Codex effective config for system/managed notify, auth, aws, and Bedrock settings", () => {
  expect(checkCodexEffectiveConfig({})).toEqual({ ok: true });
  expect(
    checkCodexEffectiveConfig({
      notify: null,
      model_provider: "openai",
      model_providers: {
        openai: { name: "OpenAI", auth: null, aws: null },
        unused: { auth: { command: "unused-cmd" } },
      },
    }),
  ).toEqual({ ok: true });
  expect(checkCodexEffectiveConfig({ notify: ["touch", "/tmp/n"] })).toMatchObject({
    ok: false,
    message: expect.stringMatching(/notify/iu),
  });
  expect(checkCodexEffectiveConfig({ model_provider: "amazon-bedrock" })).toMatchObject({
    ok: false,
    message: expect.stringMatching(/AWS|credential/iu),
  });
  expect(checkCodexEffectiveConfig({ model_provider: "amazon-bedrock-runtime" })).toMatchObject({
    ok: false,
    message: expect.stringMatching(/AWS|credential/iu),
  });
  expect(
    checkCodexEffectiveConfig({
      model_provider: "corp",
      model_providers: { corp: { auth: { command: "corp-token" } } },
    }),
  ).toMatchObject({
    ok: false,
    message: expect.stringMatching(/command/iu),
  });
  expect(
    checkCodexEffectiveConfig({
      model_provider: "corp",
      model_providers: { corp: { aws: { profile: "corp-sso" } } },
    }),
  ).toMatchObject({
    ok: false,
    message: expect.stringMatching(/AWS|credential/iu),
  });
});
