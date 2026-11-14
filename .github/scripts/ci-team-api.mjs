import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const authority = "packages/deployment-authority/src/authority.ts";
const stable = /^desktop-v(\d+)\.(\d+)\.(\d+)$/u;
function version(source, name) {
  const value = Number(
    new RegExp(`^export const ${name} = ([1-9][0-9]*);$`, "m").exec(source)?.[1],
  );
  if (!Number.isSafeInteger(value)) throw new Error(`Cannot read ${name} from ${authority}`);
  return value;
}

export function checkStableTeamApi(root = process.cwd()) {
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
    throw new Error(
      "No published Stable desktop-v* tag; fetch tags before checking team compatibility",
    );
  const published = version(git("show", `refs/tags/${tag}:${authority}`), "teamApiVersion");
  const minimum = version(
    readFileSync(path.join(root, authority), "utf8"),
    "minimumTeamApiVersion",
  );
  if (minimum > published)
    throw new Error(
      `minimumTeamApiVersion ${minimum} excludes ${tag} (teamApiVersion ${published}). Keep Stable team servers compatible; see docs/teams.md#transport-and-versions.`,
    );
  return { tag, published, minimum };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const { tag, published, minimum } = checkStableTeamApi();
  console.log(`Team API minimum ${minimum} admits ${tag} (team API ${published})`);
}
