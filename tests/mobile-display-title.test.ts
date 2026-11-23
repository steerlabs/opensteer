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
 *
 * What it sees, by reading each line of the phone's source:
 * - a display role named outside the type scale and `DisplayTitle`'s own body (another component
 *   in `primitives.tsx` among them), Compose's `typography: "displayLarge"` too;
 * - an inline font size as large as the smallest display role (22), outside the type scale;
 * - a SwiftUI title (`textStyle` largeTitle, title or title2, or a font size of 22 or more) whose
 *   modifiers do not cap it with `dynamicTypeSize({ max: displayDynamicTypeLimit })`.
 * What it cannot see: a size computed at run time or passed in from elsewhere, a style spread
 * from another file, a text drawn by a native module, and whether a capped title still breaks
 * inside a word (the layout tests see that, on the screens they lay out).
 */

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const mobileSource = path.join(repositoryRoot, "apps/mobile/src");
/** Where a display role may be named: the type scale that defines them, and `DisplayTitle`. */
const allowed = new Set(["apps/mobile/src/theme.ts", "apps/mobile/src/ui/primitives.tsx"]);
const displayRole = /\bdisplay(?:Large|Medium|Small)\b/u;

const inlineSize = /\bfontSize:\s*(\d+)/u;
const swiftTitle =
  /textStyle:\s*"(?:largeTitle|title|title2)"|font\(\{[^}]*\bsize:\s*(?:2[2-9]|[3-9]\d|\d{3})/u;
/** The smallest display role's size: an inline size this large is a display title. */
const displaySize = 22;

export function displayRolesIn(file: string, source: string): string[] {
  if (file === "apps/mobile/src/theme.ts") return [];
  const lines = source.split("\n");
  // `DisplayTitle`'s own body, the one place in primitives.tsx that names the roles it draws.
  const titleStart = lines.findIndex((line) => line.startsWith("export function DisplayTitle("));
  const titleEnd =
    titleStart < 0 ? -1 : lines.findIndex((line, index) => index > titleStart && line === "}");
  return lines.flatMap((line, index) => {
    const where = `${file}:${index + 1}: ${line.trim()}`;
    const inTitle =
      file === "apps/mobile/src/ui/primitives.tsx" && index > titleStart && index < titleEnd;
    if (displayRole.test(line) && !inTitle) return [where];
    const size = inlineSize.exec(line);
    if (size && Number(size[1]) >= displaySize) return [where];
    // A `font({` left open on its line is read with the lines up to where it closes.
    const close = /font\(\{(?![^}]*\})/u.test(line)
      ? lines.findIndex((next, at) => at > index && next.includes("}"))
      : -1;
    const statement = close > index ? lines.slice(index, close + 1).join(" ") : line;
    if (swiftTitle.test(statement)) {
      // Its modifiers, on the lines around it.
      const near = lines.slice(Math.max(0, index - 4), index + 5).join("\n");
      if (!/dynamicTypeSize\(\{\s*max:\s*displayDynamicTypeLimit/u.test(near)) return [where];
    }
    return [];
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

  it("sees a large inline size, an uncapped SwiftUI title and another component in primitives", () => {
    expect(
      displayRolesIn("apps/mobile/src/x.tsx", "<Text style={{ fontSize: 34 }}>Hi</Text>"),
    ).toHaveLength(1);
    expect(
      displayRolesIn("apps/mobile/src/x.tsx", "<Text style={{ fontSize: 17 }}>Hi</Text>"),
    ).toEqual([]);
    expect(
      displayRolesIn("apps/mobile/src/x.ios.tsx", 'modifiers={[font({ textStyle: "title" })]}'),
    ).toHaveLength(1);
    expect(
      displayRolesIn(
        "apps/mobile/src/x.ios.tsx",
        'modifiers={[font({ textStyle: "title" }), dynamicTypeSize({ max: displayDynamicTypeLimit })]}',
      ),
    ).toEqual([]);
    expect(
      displayRolesIn(
        "apps/mobile/src/ui/primitives.tsx",
        'export function DisplayTitle() {\n  role="displayLarge"\n}\nexport function Big() {\n  role="displaySmall"\n}',
      ),
    ).toEqual(['apps/mobile/src/ui/primitives.tsx:5: role="displaySmall"']);
  });

  // The reader's re-check of 5ebc2cbbd: Prettier wraps a long `font({ … })` over lines, and the
  // scanner read one line at a time.
  it("sees a SwiftUI title whose font is written over several lines", () => {
    expect(
      displayRolesIn(
        "apps/mobile/src/x.ios.tsx",
        "modifiers={[\n  font({\n    size: 28,\n  }),\n]}",
      ),
    ).toHaveLength(1);
    expect(
      displayRolesIn(
        "apps/mobile/src/x.ios.tsx",
        "modifiers={[\n  font({\n    size: 28,\n  }),\n  dynamicTypeSize({ max: displayDynamicTypeLimit }),\n]}",
      ),
    ).toEqual([]);
    expect(displayRolesIn("apps/mobile/src/x.ios.tsx", "font({\n  size: 17,\n})")).toEqual([]);
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
