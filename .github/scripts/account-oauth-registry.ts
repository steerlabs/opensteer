// Rebuilds the Account runtime secret's provider registry from deploy/account/oauth-providers.json,
// keeping each provider's credentials from the pinned version, and adds the result as a new version.
// Run it after every change to the template.
// Usage: pnpm exec tsx .github/scripts/account-oauth-registry.ts [--dry-run]
//
// Secret values stay in this process: they are read from and written to gcloud through pipes,
// never printed, logged or written to disk. gcloud's own stderr passes through for diagnosis.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { HostedOAuthProviderRegistrySchema } from "../../apps/control-plane/src/auth/hosted-oauth-provider-registry.ts";

const secret = "opensteer-account-runtime";
const registryKey = "OPENSTEER_HOSTED_OAUTH_PROVIDERS";
const root = new URL("../../", import.meta.url);

class Refusal extends Error {}

function gcloud(args: string[], input?: Buffer): Buffer {
  try {
    return execFileSync("gcloud", args, {
      maxBuffer: 1 << 24,
      stdio: [input ? "pipe" : "ignore", "pipe", "inherit"],
      ...(input ? { input } : {}),
    });
  } catch {
    // The thrown error can hold the command's output; only the command name is safe to show.
    throw new Refusal(`gcloud ${args.slice(0, 3).join(" ")} failed`);
  }
}

function main(argv: string[]) {
  if (argv.some((arg) => arg !== "--dry-run")) throw new Refusal("Usage: [--dry-run]");
  const dryRun = argv.includes("--dry-run");

  // The version the Account runs now, as the manifest pins it.
  const manifest = readFileSync(new URL("deploy/account/account.yaml", root), "utf8");
  const pins = [
    ...manifest.matchAll(
      new RegExp(`resourceName: "projects/([a-z0-9-]+)/secrets/${secret}/versions/([0-9]+)"`, "gu"),
    ),
  ];
  if (pins.length !== 1) throw new Refusal(`deploy/account/account.yaml must pin ${secret} once`);
  const [, project, version] = pins[0]!;

  let document: Record<string, unknown>;
  try {
    document = JSON.parse(
      gcloud([
        "secrets",
        "versions",
        "access",
        version!,
        `--secret=${secret}`,
        `--project=${project}`,
      ]).toString("utf8"),
    );
  } catch (error) {
    if (error instanceof Refusal) throw error;
    // JSON.parse quotes the text it rejects.
    throw new Refusal(`${secret} version ${version} is not JSON`);
  }
  if (
    typeof document !== "object" ||
    document === null ||
    Array.isArray(document) ||
    Object.values(document).some((value) => typeof value !== "string")
  ) {
    // The init container in deploy/account/account.yaml reads one object of string values.
    throw new Refusal(`${secret} version ${version} is not an object of string values`);
  }
  const source = document[registryKey];
  if (typeof source !== "string") {
    throw new Refusal(`${secret} version ${version} is missing ${registryKey}`);
  }
  let previous: unknown;
  try {
    previous = JSON.parse(source);
  } catch {
    throw new Refusal(`${registryKey} is not JSON`);
  }
  const held = z
    .array(
      z.looseObject({
        provider: z.string(),
        clientId: z.string(),
        clientSecret: z.string(),
        installationUrl: z.string().optional(),
      }),
    )
    .safeParse(previous);
  if (!held.success) throw new Refusal(`${registryKey} is not a provider registry`);

  // The template is the whole entry except its credentials, which only the secret holds.
  const template = JSON.parse(
    readFileSync(new URL("deploy/account/oauth-providers.json", root), "utf8"),
  ) as Array<Record<string, unknown> & { provider: string }>;
  const unknown = held.data.filter(
    ({ provider }) => !template.some((entry) => entry.provider === provider),
  );
  if (unknown.length > 0) {
    throw new Refusal(
      `The template has no entry for: ${unknown.map(({ provider }) => provider).join(", ")}`,
    );
  }
  const skipped: string[] = [];
  const registry = template.flatMap((entry) => {
    if (["clientId", "clientSecret", "installationUrl"].some((field) => field in entry)) {
      throw new Refusal(`The template's ${entry.provider} entry must not hold credentials`);
    }
    const credentials = held.data.find(({ provider }) => provider === entry.provider);
    if (!credentials) {
      skipped.push(entry.provider);
      return [];
    }
    const { clientId, clientSecret, installationUrl } = credentials;
    return [{ ...entry, clientId, clientSecret, ...(installationUrl ? { installationUrl } : {}) }];
  });
  if (registry.length === 0) throw new Refusal("No provider in the template has credentials");
  const validated = HostedOAuthProviderRegistrySchema.safeParse(registry);
  if (!validated.success) {
    // Only schema-authored messages are safe to show. Other issues may include input keys.
    const issues = validated.error.issues.map(({ path, code, message }) => {
      const index = typeof path[0] === "number" ? `entry ${path[0] + 1}` : "registry";
      return `  ${index}: ${code === "custom" ? message : code}`;
    });
    throw new Refusal(`The registry is invalid:\n${issues.join("\n")}`);
  }

  const next = { ...document, [registryKey]: JSON.stringify(registry) };
  console.log(`Included: ${validated.data.map(({ provider }) => provider).join(", ")}`);
  console.log(`Skipped, no credentials: ${skipped.join(", ") || "none"}`);
  if (dryRun) {
    console.log("Dry run: no version added");
    return;
  }
  const name = gcloud(
    [
      "secrets",
      "versions",
      "add",
      secret,
      `--project=${project}`,
      "--data-file=-",
      "--format=value(name)",
    ],
    Buffer.from(JSON.stringify(next), "utf8"),
  )
    .toString("utf8")
    .trim();
  const added = /\/versions\/([0-9]+)$/u.exec(name)?.[1];
  if (!added) throw new Refusal("gcloud did not report the new version");
  console.log(`Added ${secret} version ${added}`);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Refusal ? error.message : "Failed before adding a version");
  process.exitCode = 1;
}
