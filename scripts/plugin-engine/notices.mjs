import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, sep, isAbsolute } from "node:path";

const noticeFile = /^(?:licen[sc]e|notice|copying|copyright|third.party)(?:[._-]|$)/iu;
const embedded = (text) =>
  [...text.matchAll(/\/\*[\s\S]*?\*\//gu), ...text.matchAll(/(?:^|\n)(?:[ \t]*\/\/[^\n]*\n?)+/gu)]
    .map(([comment]) => comment.trim())
    .filter((comment) => /copyright|SPDX-License-Identifier|@license/iu.test(comment));

/** Preserve original notices verbatim; renaming code must never rename attribution. */
export async function collectNotices(root, files, patches = []) {
  const notices = new Map();
  const directories = new Set();
  for (const file of files) {
    let directory = dirname(file);
    while (directory !== root) {
      const path = relative(root, directory);
      if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) break;
      directories.add(directory);
      directory = dirname(directory);
    }
    for (const comment of embedded(await readFile(file, "utf8")))
      notices.set(relative(root, file).split(sep).join("/"), [
        ...(notices.get(relative(root, file).split(sep).join("/")) ?? []),
        comment,
      ]);
  }
  for (const directory of [...directories].sort()) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (entry.isFile() && noticeFile.test(entry.name)) {
        const file = join(directory, entry.name);
        notices.set(relative(root, file).split(sep).join("/"), [
          (await readFile(file, "utf8")).trim(),
        ]);
      }
    }
  }
  for (const [name, patch] of patches) {
    const added = patch
      .split("\n")
      .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
      .map((line) => line.slice(1))
      .join("\n");
    const comments = embedded(added);
    if (comments.length) notices.set(name, comments);
  }
  const primary = (await readFile(join(root, "LICENSE"), "utf8")).trim();
  const seen = new Set([primary]);
  return [...notices]
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([file, texts]) =>
      texts.flatMap((text) => {
        if (seen.has(text)) return [];
        seen.add(text);
        return [{ file, text }];
      }),
    );
}
