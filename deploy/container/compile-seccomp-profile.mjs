import { readFile, writeFile } from "node:fs/promises";

const [sourcePath, outputPath, targetArchitecture, ...capabilities] = process.argv.slice(2);
if (!sourcePath || !outputPath || !targetArchitecture) {
  throw new Error("usage: compile-seccomp-profile.mjs <source> <output> <amd64|arm64> [CAP_* ...]");
}

const supportedArchitectures = {
  amd64: { condition: "amd64", oci: "SCMP_ARCH_X86_64" },
  arm64: { condition: "arm64", oci: "SCMP_ARCH_AARCH64" },
};
const target = supportedArchitectures[targetArchitecture];
if (!target) throw new Error(`unsupported seccomp target architecture: ${targetArchitecture}`);
if (new Set(capabilities).size !== capabilities.length) {
  throw new Error("seccomp capabilities must be unique");
}
for (const capability of capabilities) {
  if (!/^CAP_[A-Z0-9_]+$/u.test(capability)) {
    throw new Error(`invalid seccomp capability: ${capability}`);
  }
}

const source = JSON.parse(await readFile(sourcePath, "utf8"));
requireKeys(source, ["archMap", "defaultAction", "syscalls"], "profile");
if (!Array.isArray(source.archMap) || !Array.isArray(source.syscalls)) {
  throw new Error("seccomp profile archMap and syscalls must be arrays");
}
for (const entry of source.archMap) {
  requireKeys(entry, ["architecture", "subArchitectures"], "architecture");
}
const architecture = source.archMap.find((entry) => entry.architecture === target.oci);
if (!architecture || !Array.isArray(architecture.subArchitectures)) {
  throw new Error(`seccomp profile does not support ${targetArchitecture}`);
}

const capabilitySet = new Set(capabilities);
const syscalls = source.syscalls.flatMap((rule, index) => {
  requireKeys(
    rule,
    ["action", "args", "comment", "excludes", "includes", "names"],
    `syscall rule ${index}`,
  );
  if (!Array.isArray(rule.names) || (rule.args !== null && !Array.isArray(rule.args))) {
    throw new Error(
      `seccomp syscall rule ${index} names must be an array and args an array or null`,
    );
  }
  for (const argument of rule.args ?? []) {
    requireKeys(argument, ["index", "op", "value", "valueTwo"], "syscall argument");
  }
  const includes = condition(rule.includes, "includes");
  const excludes = condition(rule.excludes, "excludes");
  if (!included(includes) || excluded(excludes)) return [];
  return [{ action: rule.action, args: rule.args, names: rule.names }];
});

await writeFile(
  outputPath,
  `${JSON.stringify(
    {
      architectures: [architecture.architecture, ...architecture.subArchitectures],
      defaultAction: source.defaultAction,
      syscalls,
    },
    null,
    2,
  )}\n`,
  "utf8",
);

function condition(filter, kind) {
  requireKeys(filter, ["arches", "caps", "minKernel"], "seccomp condition");
  const arches = filter.arches ?? [];
  const caps = filter.caps ?? [];
  if (!Array.isArray(arches) || !Array.isArray(caps)) {
    throw new Error("seccomp condition arches and caps must be arrays");
  }
  if (kind === "excludes" && filter.minKernel !== undefined) {
    throw new Error("seccomp excludes.minKernel is unsupported");
  }
  if (filter.minKernel !== undefined && filter.minKernel !== "4.8") {
    throw new Error(`unsupported seccomp minimum kernel: ${String(filter.minKernel)}`);
  }
  return { arches, caps, minKernel: filter.minKernel };
}

function included(filter) {
  const { arches, caps, minKernel } = filter;
  return (
    (arches.length === 0 || arches.includes(target.condition)) &&
    caps.every((capability) => capabilitySet.has(capability)) &&
    // Hosted seccomp profiles target the supported Linux kernel 4.8+ floor.
    (minKernel === undefined || minKernel === "4.8")
  );
}

function excluded(filter) {
  const { arches, caps } = filter;
  return (
    arches.includes(target.condition) || caps.some((capability) => capabilitySet.has(capability))
  );
}

function requireKeys(value, supported, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const unsupported = Object.keys(value).filter((key) => !supported.includes(key));
  if (unsupported.length > 0) {
    throw new Error(`${label} has unsupported fields: ${unsupported.join(", ")}`);
  }
}
