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
const composeFiles = [resolve(repositoryRoot, "deploy/team/compose.yaml")];
const arguments_ = ["compose", "--file", composeFiles[0], "config", "--format", "json"];
const canonicalOrigin = process.env.OPENSTEER_CANONICAL_ORIGIN || "https://team.example.test";

const rendered = spawnSync("docker", arguments_, {
  cwd: repositoryRoot,
  encoding: "utf8",
  env: {
    ...process.env,
    OPENSTEER_RELEASE_VERSION: process.env.OPENSTEER_RELEASE_VERSION || packageVersion,
    OPENSTEER_SOURCE_REVISION: process.env.OPENSTEER_SOURCE_REVISION || sourceRevision,
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
const postgres = service(project, "postgres");
const gateway = service(project, "gateway");
assert(
  sameNames(project.services, ["host", "postgres", "gateway"]),
  "Team must construct only Host, PostgreSQL and HTTPS Gateway.",
);
assert(
  host.environment?.OPENSTEER_DEPLOYMENT_KIND === "team",
  "Host must select the team composition.",
);
assert(
  gateway.environment?.OPENSTEER_SITE_ADDRESS === host.environment?.OPENSTEER_CANONICAL_ORIGIN,
  "Gateway and Host must receive one public HTTPS origin.",
);
assert(
  new URL(host.environment.OPENSTEER_CANONICAL_ORIGIN).protocol === "https:",
  "Team needs a public HTTPS origin for Account adoption.",
);
for (const [name, file] of [
  ["AUTH_SECRET", "auth_secret"],
  ["DATABASE_URL", "database_url"],
  ["INITIAL_OWNER_ENROLLMENT_TOKEN", "initial_owner_enrollment_token"],
]) {
  assert(
    host.environment?.[`OPENSTEER_${name}_FILE`] === `/run/secrets/${file}`,
    "Team credentials must be file-backed.",
  );
  assert(
    host.environment?.[`OPENSTEER_${name}`] === undefined,
    "Team credentials must not be inline.",
  );
}
assert(
  Number(postgres.mem_limit) === 2147483648 &&
    Number(postgres.memswap_limit) === 2147483648 &&
    Number(postgres.cpus) === 2,
  "PostgreSQL must have a bounded memory and CPU budget.",
);
assert(
  !postgres.ports &&
    sameNames(postgres.networks, ["database"]) &&
    project.networks?.database?.internal === true,
  "PostgreSQL must stay on a private network without host ports.",
);
assert(
  hasVolume(volumes(host), "host-data", "/var/lib/opensteer", false),
  "Host keys and Account bundle must persist on host-data.",
);
assert(
  host.environment?.OPENSTEER_HOST_PRIVATE_KEY_PATH === "/var/lib/opensteer/keys/host-private.pem",
  "Host private keys must stay on host-data.",
);
assert(
  !host.ports &&
    sameNames(host.networks, ["database", "edge"]) &&
    sameNames(gateway.networks, ["edge"]),
  "Only the HTTPS gateway may expose the team Host.",
);
const caddyfile = readFileSync(resolve(repositoryRoot, "deploy/team/Caddyfile"), "utf8");
assert(
  !caddyfile.includes("/internal/v1/runners") && !caddyfile.includes("runtime_callbacks"),
  "Team gateway must not expose Personal Runner routes.",
);
process.stdout.write(`${JSON.stringify({ composeFiles, event: "team-deployment.verified" })}\n`);

function service(project, name) {
  const value = project?.services?.[name];
  if (!value || typeof value !== "object") fail(`Rendered Compose is missing ${name}.`);
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
