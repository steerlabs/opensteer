import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const authority = "packages/deployment-authority/src/authority.ts";
const stable = /^desktop-v(\d+)\.(\d+)\.(\d+)$/u;
function version(source, name, { optional = false } = {}) {
  const match = new RegExp(`^export const ${name} = ([1-9][0-9]*);$`, "m").exec(source);
  if (!match && optional && !source.includes(`export const ${name} `)) return null;
  const value = Number(match?.[1]);
  if (!Number.isSafeInteger(value)) throw new Error(`Cannot read ${name} from ${authority}`);
  return value;
}

/**
 * Neither minimum may exclude the latest published Stable desktop: its Macs and
 * self-hosted teams must keep working as apps update. See "API compatibility"
 * in docs/connections.md.
 */
export function checkStableApi(root = process.cwd()) {
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();
  // Release publication creates desktop-v* tags; drafts have no tag (release-plan.mjs).
  const tags = git("tag", "--list", "desktop-v*")
    .split("\n")
    .filter((tag) => stable.test(tag));
  tags.sort((a, b) => {
    const left = stable.exec(a).slice(1).map(BigInt);
    const right = stable.exec(b).slice(1).map(BigInt);
    const difference =
      left.map((part, index) => part - right[index]).find((part) => part !== 0n) ?? 0n;
    return difference > 0n ? -1 : difference < 0n ? 1 : 0;
  });
  const tag = tags[0];
  if (!tag)
    throw new Error("No published Stable desktop-v* tag; fetch tags before checking API floors");
  const published = git("show", `refs/tags/${tag}:${authority}`);
  const current = readFileSync(path.join(root, authority), "utf8");
  const team = {
    published: version(published, "teamApiVersion"),
    minimum: version(current, "minimumTeamApiVersion"),
  };
  if (team.minimum > team.published)
    throw new Error(
      `minimumTeamApiVersion ${team.minimum} excludes ${tag} (teamApiVersion ${team.published}). Keep Stable team servers compatible; see docs/connections.md#api-compatibility.`,
    );
  // A Stable from before the personal window serves one exact version; there is no floor to keep.
  const personal =
    version(published, "minimumHostApiVersion", { optional: true }) === null
      ? null
      : {
          published: version(published, "hostApiVersion"),
          minimum: version(current, "minimumHostApiVersion"),
        };
  if (personal && personal.minimum > personal.published)
    throw new Error(
      `minimumHostApiVersion ${personal.minimum} excludes ${tag} (hostApiVersion ${personal.published}). Keep Stable Macs reachable; see docs/connections.md#api-compatibility.`,
    );
  return { tag, team, personal };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const { tag, team, personal } = checkStableApi();
  console.log(`Team API minimum ${team.minimum} admits ${tag} (team API ${team.published})`);
  console.log(
    personal
      ? `Personal API minimum ${personal.minimum} admits ${tag} (personal API ${personal.published})`
      : `${tag} predates the personal API window; no personal floor applies`,
  );
}
