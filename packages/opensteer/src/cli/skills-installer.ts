import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export interface OpensteerSkillsInstallOptions {
  readonly agents?: readonly string[];
  readonly skills?: readonly string[];
  readonly global?: boolean;
  readonly yes?: boolean;
  readonly copy?: boolean;
  readonly all?: boolean;
  readonly list?: boolean;
}

interface OpensteerSkillsInvocation {
  readonly cliPath: string;
  readonly cliArgs: readonly string[];
}

interface OpensteerSkillsInstallerDeps {
  readonly resolveSkillsCliPath: () => string;
  readonly resolveSkillSourcePath: () => string;
  readonly spawnInvocation: (invocation: OpensteerSkillsInvocation) => Promise<number>;
}

export function createOpensteerSkillsInvocation(input: {
  readonly options: OpensteerSkillsInstallOptions;
  readonly skillsCliPath: string;
  readonly skillSourcePath: string;
}): OpensteerSkillsInvocation {
  const cliArgs = ["add", input.skillSourcePath];

  if (input.options.all === true) {
    cliArgs.push("--all");
  } else {
    const selectedSkills = resolveSelectedSkills(input.options);
    for (const skill of selectedSkills) {
      cliArgs.push("--skill", skill);
    }
  }

  for (const agent of input.options.agents ?? []) {
    cliArgs.push("--agent", agent);
  }

  if (input.options.global === true) {
    cliArgs.push("--global");
  }
  if (input.options.yes === true) {
    cliArgs.push("--yes");
  }
  if (input.options.copy === true) {
    cliArgs.push("--copy");
  }
  if (input.options.list === true) {
    cliArgs.push("--list");
  }

  return {
    cliPath: input.skillsCliPath,
    cliArgs,
  };
}

export function resolveOpensteerSkillsCliPath(): string {
  const require = createRequire(import.meta.url);
  const skillsPackagePath = require.resolve("skills/package.json");
  const skillsPackageDir = path.dirname(skillsPackagePath);
  const cliPath = path.join(skillsPackageDir, "bin", "cli.mjs");
  if (!existsSync(cliPath)) {
    throw new Error(`skills CLI entrypoint was not found at "${cliPath}".`);
  }
  return cliPath;
}

export function resolveOpensteerSkillSourcePath(): string {
  let ancestor = path.dirname(fileURLToPath(import.meta.url));

  for (let index = 0; index < 6; index += 1) {
    const candidate = path.join(ancestor, "skills");
    const skillManifest = path.join(candidate, "opensteer", "SKILL.md");
    if (existsSync(skillManifest)) {
      return candidate;
    }
    ancestor = path.resolve(ancestor, "..");
  }

  throw new Error("Unable to find the packaged Opensteer skill source directory.");
}

export async function runOpensteerSkillsInstaller(
  options: OpensteerSkillsInstallOptions = {},
  overrideDeps: Partial<OpensteerSkillsInstallerDeps> = {},
): Promise<number> {
  const deps: OpensteerSkillsInstallerDeps = {
    resolveSkillsCliPath: resolveOpensteerSkillsCliPath,
    resolveSkillSourcePath: resolveOpensteerSkillSourcePath,
    spawnInvocation: spawnOpensteerSkillsInvocation,
    ...overrideDeps,
  };

  const invocation = createOpensteerSkillsInvocation({
    options,
    skillsCliPath: deps.resolveSkillsCliPath(),
    skillSourcePath: deps.resolveSkillSourcePath(),
  });

  return deps.spawnInvocation(invocation);
}

async function spawnOpensteerSkillsInvocation(
  invocation: OpensteerSkillsInvocation,
): Promise<number> {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [invocation.cliPath, ...invocation.cliArgs], {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    });

    child.once("error", (error) => {
      rejectPromise(error);
    });

    child.once("exit", (code) => {
      resolvePromise(typeof code === "number" ? code : 1);
    });
  });
}

function resolveSelectedSkills(options: OpensteerSkillsInstallOptions): readonly string[] {
  if (options.skills !== undefined && options.skills.length > 0) {
    return options.skills;
  }
  if (options.list === true) {
    return [];
  }
  return ["opensteer"];
}
