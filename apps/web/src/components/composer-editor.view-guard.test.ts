import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repository = path.resolve(import.meta.dirname, "../../../..");

/** Every non-test TypeScript source under each app's and package's `src`. */
function sources(): string[] {
  const found: string[] = [];
  const walk = (folder: string) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const at = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== "dist") walk(at);
      } else if (
        /\.tsx?$/u.test(entry.name) &&
        !/\.(?:test|interaction\.test|test-support)\.tsx?$/u.test(entry.name)
      )
        found.push(at);
    }
  };
  for (const group of ["apps", "packages"])
    for (const project of readdirSync(path.join(repository, group), { withFileTypes: true }))
      if (project.isDirectory()) {
        const src = path.join(repository, group, project.name, "src");
        try {
          walk(src);
        } catch {
          // A project without sources.
        }
      }
  return found;
}

describe("TipTap's editor view", () => {
  // TipTap destroys an editor whose component has not mounted 1 ms after creating it, and its
  // `editor.view` then throws; the desktop's first signed-in render yields long enough for that.
  const tiptap = sources().filter((file) => /from "@tiptap\//u.test(readFileSync(file, "utf8")));

  it("is used by the composer's editor alone, so this guard sees every reader", () => {
    expect(tiptap.map((file) => path.relative(repository, file)).sort()).toEqual([
      "apps/web/src/components/composer-editor-document.ts",
      "apps/web/src/components/composer-editor.tsx",
    ]);
  });

  it("is read only through liveView, or by a key the mounted view itself is handling", () => {
    const allowed = [
      // liveView: TipTap's own flag says there is a view.
      "return editor && !editor.isDestroyed ? editor.view : null;",
      // The extension's keyboard shortcuts run only from the mounted view's keydown.
      "const view = () => this.editor.view;",
    ];
    const reads = tiptap.flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .map((line, index) => ({
          file: path.relative(repository, file),
          line: index + 1,
          text: line.trim(),
        }))
        .filter(({ text }) => !text.startsWith("//") && !text.startsWith("*"))
        .filter(({ text }) => /\.view\b|\{\s*view\s*\}\s*=\s*\w*editor/u.test(text)),
    );
    expect(reads.filter(({ text }) => !allowed.includes(text))).toEqual([]);
    expect(reads.map(({ text }) => text).sort()).toEqual([...allowed].sort());
  });
});
