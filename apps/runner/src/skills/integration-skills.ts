import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ThreadId } from "@opensteer/core";
import type { HarnessSkill } from "@opensteer/harness";
import { IntegrationSkillBundleSchema, type RunIntegrationSkillsPlan } from "@opensteer/protocol";
import { readBoundedResponse } from "@opensteer/shared/boundedJson";

const maximumResponseBytes = 32 * 1_024 * 1_024;

export interface MaterializedIntegrationSkills {
  readonly cleanup: () => Promise<void>;
  /** Identifies the bundle's content, so an engine started with it is told apart from one that was not. */
  readonly digest: string;
  /** The per-Thread root every skill path sits under; absent when nothing was materialized. */
  readonly directory: string | undefined;
  readonly skills: readonly HarnessSkill[];
}

export async function materializeIntegrationSkills(input: {
  readonly plan: RunIntegrationSkillsPlan;
  readonly stateDirectory: string;
  readonly signal: AbortSignal;
  readonly threadId: ThreadId;
}): Promise<MaterializedIntegrationSkills> {
  const response = await fetch(input.plan.url, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${input.plan.token}`,
    },
    method: "GET",
    redirect: "error",
    signal: AbortSignal.any([input.signal, AbortSignal.timeout(30_000)]),
  });
  if (!response.ok) throw new Error(`Integration skill bundle failed with HTTP ${response.status}`);
  const bytes = Buffer.from(
    await readBoundedResponse(response, {
      maximumBytes: maximumResponseBytes,
      sizeError: () => new Error(`Integration skill bundle exceeds ${maximumResponseBytes} bytes`),
    }),
  );
  let bundle;
  let digest: string;
  try {
    bundle = IntegrationSkillBundleSchema.parse(JSON.parse(bytes.toString("utf8")));
    digest = createHash("sha256").update(bytes).digest("base64url");
  } finally {
    bytes.fill(0);
  }
  if (bundle.plugins.length === 0) {
    return { cleanup: async () => undefined, digest, directory: undefined, skills: [] };
  }
  const parent = join(input.stateDirectory, "integration-skills");
  const root = join(parent, input.threadId);
  await mkdir(parent, { mode: 0o700, recursive: true });
  // Provider sessions retain skill paths across Runs. Recreate the exact
  // per-Thread path so a resumed provider session never points at a deleted
  // one-time temporary directory.
  await rm(root, { force: true, recursive: true });
  await mkdir(root, { mode: 0o700 });
  try {
    const skills: HarnessSkill[] = [];
    for (const plugin of bundle.plugins) {
      const pluginName = safeName(plugin.name);
      const pluginPath = join(root, pluginName);
      for (const skill of plugin.skills) {
        const skillName = safeName(skill.name);
        const skillPath = join(pluginPath, skillName);
        await mkdir(skillPath, { mode: 0o700, recursive: true });
        for (const file of skill.files) {
          const segments = safeRelativePath(file.path);
          const target = resolve(skillPath, ...segments);
          const relativeTarget = relative(skillPath, target);
          if (
            relativeTarget === ".." ||
            relativeTarget.startsWith(`..${sep}`) ||
            isAbsolute(relativeTarget)
          ) {
            throw new Error("Integration skill file escaped its directory");
          }
          await mkdir(resolve(target, ".."), { mode: 0o700, recursive: true });
          const content = decodeBase64(file.content);
          try {
            await writeFile(target, content, {
              flag: "wx",
              mode: file.executable ? 0o700 : 0o600,
            });
          } finally {
            content.fill(0);
          }
        }
        skills.push(Object.freeze({ name: skillName, path: skillPath }));
      }
    }
    return {
      cleanup: () => rm(root, { force: true, recursive: true }),
      digest,
      directory: root,
      skills: Object.freeze(skills),
    };
  } catch (error) {
    await rm(root, { force: true, recursive: true });
    throw error;
  }
}

function safeName(value: string): string {
  if (!/^[a-z0-9]+(?:[-.][a-z0-9]+)*$/u.test(value)) {
    throw new Error("Integration plugin or skill name is invalid");
  }
  return value;
}

function safeRelativePath(value: string): readonly string[] {
  if (value.includes("\\") || value.startsWith("/") || value.includes("\0")) {
    throw new Error("Integration skill path is invalid");
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Integration skill path is invalid");
  }
  return segments;
}

function decodeBase64(value: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new Error("Integration skill file encoding is invalid");
  }
  return Buffer.from(value, "base64");
}
