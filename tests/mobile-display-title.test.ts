import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/*
 * A display title is drawn one way on the phone: `DisplayTitle` (`apps/mobile/src/ui/primitives.tsx`),
 * which grows only as far as `displayFontScaleLimit`, where its widest word fits the narrowest
 * phone. The re-check of 963f808d0..fb245664c found display roles drawn without that limit on the
 * screens a person meets when something is wrong (a phone removed, a Home to update, the app not
 * starting), their titles broken inside a word at the largest size. So no screen names a display
 * role itself: it uses `DisplayTitle`, and only the type scale and `DisplayTitle` name them.
 */

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const mobileSource = path.join(repositoryRoot, "apps/mobile/src");
/** Where a display role may be named: the type scale that defines them, and `DisplayTitle`. */
const allowed = new Set(["apps/mobile/src/theme.ts", "apps/mobile/src/ui/primitives.tsx"]);
const displayRole = /\bdisplay(?:Large|Medium|Small)\b/u;

export function displayRolesIn(file: string, source: string): string[] {
  return source.split("\n").flatMap((line, index) => {
    if (!displayRole.test(line)) return [];
    // `DisplayTitle` itself names the two roles it draws.
    if (file === "apps/mobile/src/ui/primitives.tsx" && /"display(?:Large|Small)"/u.test(line))
      return [];
    if (file === "apps/mobile/src/theme.ts") return [];
    return [`${file}:${index + 1}: ${line.trim()}`];
  });
}

function appFiles(directory: string): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        /\.tsx?$/u.test(entry.name) &&
        !entry.name.endsWith(".d.ts") &&
        !/\.(test|test-support|fake)\.tsx?$/u.test(entry.name),
    )
    .map((entry) => path.join(entry.parentPath, entry.name));
}

describe("display titles on the phone", () => {
  it("are drawn only by DisplayTitle", () => {
    const found = appFiles(mobileSource).flatMap((file) => {
      const relative = path.relative(repositoryRoot, file);
      return displayRolesIn(relative, readFileSync(file, "utf8"));
    });
    expect(found).toEqual([]);
    expect(
      [...allowed].every((file) => readFileSync(path.join(repositoryRoot, file), "utf8")),
    ).toBe(true);
  });

  it("sees a screen that names a display role itself", () => {
    expect(
      displayRolesIn(
        "apps/mobile/src/app.tsx",
        '<AppText role="displaySmall">Opensteer could not start</AppText>',
      ),
    ).toEqual([
      'apps/mobile/src/app.tsx:1: <AppText role="displaySmall">Opensteer could not start</AppText>',
    ]);
  });
});
