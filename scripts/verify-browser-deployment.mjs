#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const packageManifest = JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf8"));
const sourceRevisionResult = spawnSync(
  "git",
  ["-C", repositoryRoot, "rev-parse", "--verify", "HEAD^{commit}"],
  { encoding: "utf8", shell: false, stdio: ["ignore", "pipe", "pipe"] },
);
if (sourceRevisionResult.status !== 0) {
  fail(sourceRevisionResult.stderr.trim() || "Could not resolve the source revision.");
}
const sourceRevision = sourceRevisionResult.stdout.trim();
if (!/^[a-f0-9]{40}$/u.test(sourceRevision)) fail("The source revision is invalid.");
const packageVersion =
  packageManifest && typeof packageManifest === "object" && !Array.isArray(packageManifest)
    ? packageManifest.version
    : undefined;
if (
  typeof packageVersion !== "string" ||
  !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.test(packageVersion)
) {
  fail("The root package version is invalid.");
}
const overlays = process.argv.slice(2).filter((argument) => argument !== "--");
const composeFiles = ["deploy/self-host/compose.yaml", ...overlays].map((file) =>
  resolve(repositoryRoot, file),
);
const arguments_ = ["compose"];
for (const file of composeFiles) arguments_.push("--file", file);
arguments_.push("config", "--format", "json");
const workspaceBacking = "local-directory";
const canonicalOrigin = process.env.OPENSTEER_CANONICAL_ORIGIN || "https://opensteer.example.test";
if (
  process.env.OPENSTEER_DEFAULT_WORKSPACE_BACKING &&
  process.env.OPENSTEER_DEFAULT_WORKSPACE_BACKING !== "local-directory"
)
  fail("Self-host Compose requires local-directory Workspace storage.");
const runtimeOrigin = process.env.OPENSTEER_RUNTIME_ORIGIN || "https://gateway:8443";

const rendered = spawnSync("docker", arguments_, {
  cwd: repositoryRoot,
  encoding: "utf8",
  env: {
    ...process.env,
    OPENSTEER_RELEASE_VERSION: process.env.OPENSTEER_RELEASE_VERSION || packageVersion,
    OPENSTEER_SOURCE_REVISION: process.env.OPENSTEER_SOURCE_REVISION || sourceRevision,
    OPENSTEER_DEPLOYMENT_KIND: "server",
    OPENSTEER_DEFAULT_WORKSPACE_BACKING: workspaceBacking,
    OPENSTEER_LOCAL_WORKSPACE_ENVIRONMENT_ID:
      process.env.OPENSTEER_LOCAL_WORKSPACE_ENVIRONMENT_ID ||
      "env_00000000-0000-5000-8000-000000000101",
    OPENSTEER_MODE: "production",
    OPENSTEER_RUNTIME_ORIGIN: runtimeOrigin,
    OPENSTEER_CANONICAL_ORIGIN: canonicalOrigin,
  },
});
if (rendered.error) fail(`Could not execute Docker Compose: ${rendered.error.message}`);
if (rendered.status !== 0) fail(rendered.stderr.trim() || "Docker Compose render failed.");

let project;
try {
  project = JSON.parse(rendered.stdout);
} catch (error) {
  fail(`Docker Compose returned invalid JSON: ${safeMessage(error)}`);
}

const host = service(project, "host");
const runtime = service(project, "browser-runtime");
const messaging = service(project, "channel-runtime");
const egress = service(project, "browser-egress");
const gateway = service(project, "gateway");
const runner = optionalService(project, "runner");
const controlCaExporter = service(project, "control-ca-export");
const hostVolumes = volumes(host);
const runtimeVolumes = volumes(runtime);
const runtimeTmpfs = Array.isArray(runtime.tmpfs) ? runtime.tmpfs : [];
if (!runner) fail("local-directory verification requires compose.runner-linux.yaml.");
const ownerEnrollmentOverlay = overlays.some((file) => file.endsWith("compose.initial-owner.yaml"));

assert(
  gateway.environment?.OPENSTEER_SITE_ADDRESS === host.environment?.OPENSTEER_CANONICAL_ORIGIN,
  "Gateway and Host must receive one identical public origin.",
);
assert(
  host.build !== undefined && gateway.build !== undefined,
  "Host and Gateway must remain the only build owners for their reusable images.",
);
assert(
  controlCaExporter.image === gateway.image && controlCaExporter.build === undefined,
  "The control-CA exporter must reuse Gateway's image without racing a duplicate image build.",
);
assert(
  host.environment?.OPENSTEER_RUNTIME_ORIGIN === runtimeOrigin &&
    new URL(host.environment.OPENSTEER_RUNTIME_ORIGIN).protocol === "https:",
  "Host-issued runtime callbacks must use the explicitly selected HTTPS origin.",
);
assert(
  runtime.environment?.OPENSTEER_BROWSER_RELAY_HOST_URL === "https://gateway:8443" &&
    runtime.environment?.OPENSTEER_RUNNER_CONTROL_CA_PATH === "/control-ca/root.crt" &&
    hasVolume(runtimeVolumes, "control-ca", "/control-ca", true),
  "The browser-only Runner must enroll through Gateway TLS with the exported control CA.",
);
assert(
  messaging.environment?.OPENSTEER_MESSAGING_HOST_URL === "https://gateway:8443" &&
    messaging.environment?.OPENSTEER_RUNNER_CONTROL_CA_PATH === "/control-ca/root.crt" &&
    messaging.environment?.OPENSTEER_RUNNER_ENROLLMENT_TOKEN_FILE ===
      "/run/secrets/messaging_runner_enrollment_token",
  "The messaging-only Runner must enroll through Gateway TLS with the common Runner credential.",
);
assert(
  host.environment?.OPENSTEER_AUTH_SECRET_FILE === "/run/secrets/opensteer_auth_secret",
  "Host identity must use the file-backed authentication signing secret.",
);
assert(
  host.environment?.OPENSTEER_ACCESS_TOKEN === undefined &&
    host.environment?.OPENSTEER_ACCESS_TOKEN_FILE === undefined &&
    host.environment?.OPENSTEER_SINGLE_USER === undefined,
  "Retired permanent bearer and single-user authentication must not reach Host.",
);
assert(
  ownerEnrollmentOverlay
    ? host.environment?.OPENSTEER_INITIAL_OWNER_ENROLLMENT_TOKEN_FILE ===
        "/run/secrets/initial_owner_enrollment_token"
    : host.environment?.OPENSTEER_INITIAL_OWNER_ENROLLMENT_TOKEN_FILE === undefined,
  "Initial-owner enrollment must exist only in its transient setup overlay.",
);

assert(
  host.environment?.OPENSTEER_HOST_PRIVATE_KEY_PATH === "/var/lib/opensteer/keys/host-private.pem",
  "Host private browser-ticket key must remain in host-data.",
);
assert(
  host.environment?.OPENSTEER_BROWSER_PROFILE_STATE_INTERNAL_URL === undefined,
  "Host must not receive the Browser Runtime's private profile-state fetch origin.",
);
assert(
  host.environment?.OPENSTEER_HOST_PUBLIC_KEY_PATH === "/var/lib/opensteer/keys/host-public.pem",
  "Host must keep its public key on the configured durable path.",
);
{
  const workspaceInitializer = optionalService(project, "workspace-storage-init");
  assert(
    !hasVolume(hostVolumes, "browser-trust", "/var/lib/opensteer-public", false) &&
      project.services?.files === undefined,
    "The local-directory stack must keep the Host public key on host-data without a Files service.",
  );
  assert(
    host.environment?.OPENSTEER_DEFAULT_WORKSPACE_BACKING === "local-directory",
    "Base self-host Compose must use local-directory.",
  );
  assert(
    host.environment?.OPENSTEER_LOCAL_WORKSPACE_ENVIRONMENT_ID ===
      (process.env.OPENSTEER_LOCAL_WORKSPACE_ENVIRONMENT_ID ||
        "env_00000000-0000-5000-8000-000000000101"),
    "Base self-host Compose must pin the machine that holds new Workspaces.",
  );
  assert(
    host.environment?.OPENSTEER_LOCAL_WORKSPACE_ROOT === undefined &&
      host.environment?.OPENSTEER_LOCAL_WORKSPACE_REGISTRY_PATH === undefined &&
      host.environment?.OPENSTEER_HOST_NATIVE_FS_HELPER === undefined,
    "The Host must hold no local Workspace paths: the owning Runner owns that disk.",
  );
  assert(
    host.environment?.OPENSTEER_FILES_SERVICE_URL === undefined,
    "Base self-host Compose must not configure a Files service.",
  );
  assert(
    !hasVolume(hostVolumes, "workspace-data", "/var/lib/opensteer-workspaces", false) &&
      !hasVolume(hostVolumes, "workspace-registry", "/var/lib/opensteer-workspace-registry", false),
    "The Host must not mount the managed local Workspace volumes.",
  );
  assert(
    (workspaceInitializer === undefined) === (runner === undefined),
    "The local Workspace initializer belongs with the cohosted Runner that owns those directories.",
  );
  assert(
    workspaceInitializer === undefined ||
      (workspaceInitializer.network_mode === "none" &&
        workspaceInitializer.read_only === true &&
        workspaceInitializer.image === host.image &&
        workspaceInitializer.build === undefined &&
        sameNames(workspaceInitializer.cap_drop, ["ALL"]) &&
        sameNames(workspaceInitializer.cap_add, ["CHOWN", "FOWNER"])),
    "The local Workspace initializer must reuse Host's image, have no network, and keep only its two filesystem capabilities.",
  );
}
if (runner) {
  assert(
    runner.environment?.OPENSTEER_DEFAULT_WORKSPACE_BACKING === workspaceBacking &&
      runner.environment?.OPENSTEER_DEPLOYMENT_KIND === "server",
    "A cohosted Runner must receive the same Deployment axes as its Host.",
  );
  assert(
    runner.environment?.NODE_EXTRA_CA_CERTS === "/control-ca/root.crt" &&
      runner.environment?.OPENSTEER_RUNNER_CONTROL_CA_PATH === "/control-ca/root.crt" &&
      hasVolume(volumes(runner), "control-ca", "/control-ca", true),
    "A cohosted Runner must use the exported public control CA for its WebSocket and Host-issued HTTPS callbacks.",
  );
  {
    const localEnvironmentId =
      process.env.OPENSTEER_LOCAL_WORKSPACE_ENVIRONMENT_ID ||
      "env_00000000-0000-5000-8000-000000000101";
    assert(
      runner.environment?.OPENSTEER_ENVIRONMENT_ID === localEnvironmentId &&
        runner.environment?.OPENSTEER_LOCAL_WORKSPACE_ROOT === "/var/lib/opensteer-workspaces" &&
        runner.environment?.OPENSTEER_LOCAL_WORKSPACE_REGISTRY_PATH ===
          "/var/lib/opensteer-workspace-registry/workspace-bindings.v1.json" &&
        runner.environment?.OPENSTEER_RUNNER_WORKSPACE_BACKINGS === "local-directory",
      "The single-node local Runner must share Host's stable environment and managed paths.",
    );
    assert(
      runner.cap_add === undefined && runner.devices === undefined,
      "The local-directory Runner must not receive mount privileges.",
    );
  }
}
assert(
  runtime.environment?.OPENSTEER_BROWSER_PUBLIC_KEY_PATH === undefined &&
    !runtimeVolumes.some((volume) => volume.source === "browser-trust"),
  "Browser Runtime must not receive the Host public-key volume or a retired ticket-key setting.",
);
assert(
  hasVolume(runtimeVolumes, "browser-data", "/var/lib/opensteer/browser", false),
  "Browser Runtime must keep profiles and replay state on writable browser-data.",
);
assert(
  !runtimeVolumes.some((volume) =>
    ["host-data", "caddy-data", "runner-data", "runner-control-ca", "browser-trust"].includes(
      volume.source,
    ),
  ),
  "Browser Runtime must not mount control-plane private data.",
);
assert(
  runtime.environment?.OPENSTEER_CHROMIUM_SANDBOX === "true",
  "Production Browser Runtime must enable Chromium's sandbox.",
);
assert(runtime.read_only === true, "Browser Runtime root filesystem must remain read-only.");
assert(
  runtimeTmpfs.includes("/home/opensteer:uid=10001,gid=10001,mode=0700,noexec,nosuid,nodev"),
  "Browser Runtime must give Chromium an owner-only, non-executable writable home tmpfs.",
);
assert(
  runtime.environment?.OPENSTEER_BROWSER_PROXY_URL === "http://browser-egress:4313",
  "Production Browser Runtime must use the private browser egress proxy.",
);
assert(
  runtime.environment?.OPENSTEER_BROWSER_PROFILE_STATE_INTERNAL_URL === "http://host:4310",
  "Browser Runtime must trust only the exact private Host origin for cleartext profile state.",
);
const securityOptions = Array.isArray(runtime.security_opt) ? runtime.security_opt : [];
assert(
  securityOptions.some((option) => String(option).endsWith("chromium-seccomp.json")),
  "Browser Runtime must use the pinned Chromium seccomp policy.",
);
assert(
  securityOptions.every((option) => !String(option).includes("unconfined")),
  "Browser Runtime must not disable seccomp.",
);
assert(
  sameNames(runtime.networks, ["browser", "browser-egress-private", "control"]),
  "Browser Runtime must join only its Host profile-state, relay, and private proxy networks.",
);
assert(
  sameNames(egress.networks, ["browser-egress-private", "egress"]),
  "Browser egress proxy must be the only bridge from Chromium to external egress.",
);
assert(project.networks?.browser?.internal === true, "Browser control network must be internal.");
assert(
  project.networks?.["browser-egress-private"]?.internal === true,
  "Browser proxy network must be internal.",
);
assert(project.networks?.control?.internal === true, "Runtime control network must be internal.");
assert(!runtime.ports, "Browser Runtime must not publish a host port.");
assert(
  JSON.stringify(gateway.healthcheck?.test) ===
    JSON.stringify(["CMD", "wget", "--quiet", "--spider", "http://127.0.0.1:8080/ready"]),
  "Gateway readiness must use the non-redirecting loopback-only listener.",
);
assert(
  JSON.stringify(
    (gateway.ports ?? []).map((port) => `${port.published}:${port.target}:${port.protocol}`).sort(),
  ) === JSON.stringify(["443:443:tcp", "80:80:tcp"]),
  "Direct Caddy-managed HTTPS must publish the exact 80/443 port pair.",
);

const caddyfile = readFileSync(resolve(repositoryRoot, "deploy/gateway/Caddyfile"), "utf8");
assert(
  caddyfile.includes("skip_install_trust"),
  "The containerized gateway must leave private-CA trust distribution to the explicit CA export path.",
);
const callbackPaths = caddyfile
  .match(/^\s*@runtime_callbacks path ([^\n]+)$/mu)?.[1]
  ?.trim()
  .split(/\s+/u);
const callbackHandler = caddyfile.match(/handle @runtime_callbacks \{([^}]*)\}/u)?.[1];
assert(
  callbackPaths && callbackHandler && /^\s*reverse_proxy host:4310\s*$/mu.test(callbackHandler),
  "The shared runtime callback allowlist must proxy to Host.",
);
for (const path of [
  "/internal/v1/agent-control",
  "/internal/v1/browser-cdp",
  "/internal/v1/browser-cdp/*",
  "/internal/v1/browser-sources/pair",
  "/internal/v1/browser-sources/connect",
  "/internal/v1/egress",
  "/internal/v1/integration-mcp",
  "/internal/v1/integration-skills",
  "/internal/v1/mcp",
  "/internal/v1/mount-grants/exchange",
  "/internal/v1/runners",
  "/internal/v1/runners/auxiliary/*",
  "/internal/v1/trigger-cdp",
]) {
  assert(callbackPaths.includes(path), `Caddy runtime callback allowlist is missing ${path}.`);
}
for (const removedPath of ["/internal/v1/channel-runtime", "/internal/v1/devices/connect"]) {
  assert(
    !caddyfile.includes(removedPath),
    `Caddy must not publish the retired identity route ${removedPath}.`,
  );
}
assert(
  caddyfile.match(/\bimport runtime_callbacks\b/gu)?.length === 2,
  "The public and private HTTPS listeners must share one runtime callback allowlist.",
);
assert(
  !caddyfile.includes("header_up Host"),
  "Caddy must preserve the exact incoming Host header, including the private listener port.",
);

process.stdout.write(`${JSON.stringify({ composeFiles, event: "browser-deployment.verified" })}\n`);

function service(project, name) {
  const value = project?.services?.[name];
  if (!value || typeof value !== "object") fail(`Rendered Compose is missing ${name}.`);
  return value;
}

function optionalService(project, name) {
  const value = project?.services?.[name];
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") fail(`Rendered Compose has an invalid ${name} service.`);
  return value;
}

function volumes(service) {
  return Array.isArray(service.volumes) ? service.volumes : [];
}

function hasVolume(all, source, target, readOnly) {
  return all.some(
    (volume) =>
      volume?.type === "volume" &&
      volume.source === source &&
      volume.target === target &&
      Boolean(volume.read_only) === readOnly,
  );
}

function sameNames(value, expected) {
  const actual = Array.isArray(value) ? value : Object.keys(value ?? {});
  return JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function safeMessage(error) {
  return error instanceof Error ? error.message : "unknown error";
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
