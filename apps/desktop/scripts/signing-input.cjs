const { readFileSync, statSync } = require("node:fs");
const { z } = require("zod");
const { isAbsolute } = require("node:path");
// The CommonJS build boundary mirrors @opensteer/config/build-inputs and adds host file checks.
const signingInputSchema = z
  .object({
    teamId: z.string().regex(/^[A-Z0-9]{10}$/u),
    identity: z.string().regex(/^Developer ID Application: [^\r\n"\\]+ \([A-Z0-9]{10}\)$/u),
    keychain: z
      .string()
      .refine(
        (value) => isAbsolute(value) && value.endsWith(".keychain-db"),
        "keychain must be an absolute .keychain-db path",
      )
      .optional(),
    notarizationProfile: z.string().trim().min(1).optional(),
  })
  .strict()
  .refine((value) => value.identity.endsWith(`(${value.teamId})`), {
    message: "The Developer ID identity must belong to teamId.",
  });
function parseSigningInput(input) {
  return signingInputSchema.parse(input);
}
function resolveSigningMode({ signing, distributable = false } = {}) {
  if (signing !== undefined) return { mode: "signed", signing: parseSigningInput(signing) };
  if (distributable) throw Error("A valid signing input is required for a release build.");
  return { mode: "development" };
}
function readSigningMode(environment = process.env) {
  const file = environment.OPENSTEER_DESKTOP_SIGNING_FILE;
  const mode = resolveSigningMode({
    ...(file ? { signing: JSON.parse(readFileSync(file, "utf8")) } : {}),
    distributable: environment.OPENSTEER_DESKTOP_RELEASE === "1",
  });
  if (mode.mode === "signed" && mode.signing.keychain && !statSync(mode.signing.keychain).isFile())
    throw Error("The configured signing keychain must exist as a file.");
  return mode;
}
function signingKeychainArguments(environment = process.env) {
  const mode = readSigningMode(environment);
  return mode.mode === "signed" && mode.signing.keychain
    ? ["--keychain", mode.signing.keychain]
    : [];
}
function developerIdRequirement(teamId, identifier) {
  if (!/^[A-Z0-9]{10}$/u.test(teamId) || !/^[a-zA-Z0-9.-]+$/u.test(identifier))
    throw Error("Invalid code requirement identity");
  return `anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = "${teamId}" and identifier "${identifier}"`;
}
function generatedSigningConstants(options) {
  const mode =
    options.platform && options.platform !== "darwin"
      ? { mode: "unavailable" }
      : resolveSigningMode(options);
  const team = mode.mode === "signed" ? mode.signing.teamId : null;
  return {
    build: mode.mode === "signed" ? mode.signing : { mode: mode.mode },
    typescript: `export const signingTeamId: string | null = ${JSON.stringify(team)};\nexport const developmentTrust = ${mode.mode === "development"};\n`,
  };
}
function personalRuntimeSigningIdentity(environment = process.env) {
  const mode = readSigningMode(environment);
  return mode.mode === "signed" ? mode.signing.identity : "-";
}
function personalRuntimeSigningOptions(identity) {
  // Library validation cannot match Team IDs between ad-hoc executables and
  // their bundled libraries. Development signatures therefore omit runtime.
  return identity === "-" ? ["--timestamp=none"] : ["--timestamp", "--options", "runtime"];
}
module.exports = {
  personalRuntimeSigningOptions,
  personalRuntimeSigningIdentity,
  signingKeychainArguments,
  parseSigningInput,
  resolveSigningMode,
  readSigningMode,
  generatedSigningConstants,
  developerIdRequirement,
};

function writeSigningConstants(directory, options) {
  const { mkdirSync, writeFileSync } = require("node:fs");
  const { join } = require("node:path");
  const output = generatedSigningConstants(options);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "signing.ts"), output.typescript);
  require("node:fs").rmSync(join(directory, "SigningIdentity.swift"), { force: true });
  writeFileSync(join(directory, "signing.json"), JSON.stringify(output.build));
  return output;
}
module.exports.writeSigningConstants = writeSigningConstants;

function writePlatformSigningConstants(
  directory,
  environment = process.env,
  platform = process.platform,
) {
  if (!["darwin", "linux", "win32"].includes(platform))
    throw Error("Unsupported desktop build platform");
  if (platform !== "darwin") return writeSigningConstants(directory, { platform });
  const mode = readSigningMode(environment);
  return writeSigningConstants(directory, mode.mode === "signed" ? { signing: mode.signing } : {});
}
module.exports.writePlatformSigningConstants = writePlatformSigningConstants;
