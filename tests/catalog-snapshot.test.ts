import { describe, expect, test } from "vitest";
import {
  buildSnapshot,
  iconPath,
  serialize,
  sha256,
  snapshotProblems,
} from "../scripts/catalog-snapshot/core.ts";
import {
  markdownProse,
  parseRules,
  pythonComments,
  rewriteProblems,
  scriptComments,
  scriptTokens,
  type RewriteRules,
  type Source,
} from "../scripts/catalog-snapshot/rewrite.ts";

// "acme" stands in for the upstream name throughout.
const manifest = (name: string) =>
  JSON.stringify({ name, acme: { title: "x" }, dependencies: { apps: "1.0.0" } }, null, 2) + "\n";
const source = (name: string, extra: { path: string; content: string }[] = []) => ({
  files: [
    { path: "index.ts", content: `import { tools } from "./tools/main.ts"; // acme app ${name}` },
    { path: "tools/main.ts", content: "export const tools = [];" },
    { path: "package.json", content: manifest(name) },
    ...extra,
  ],
  package: name,
});
const entry = (id: string, icons: { src: string }[] = []) => ({
  id,
  package: `@acme.sh/${id}`,
  name: id,
  description: `Talk to ${id}`,
  auth: [{ method: "oauth", kind: "oauth2" }],
  icons,
  source: `apps/${id}.json`,
});
const text = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);

/** Build from in-memory documents. */
async function build(options: {
  apps?: object[];
  sources?: Record<string, unknown>;
  icons?: Record<string, string>;
  rules?: RewriteRules;
}) {
  const apps = options.apps ?? [entry("mail", [{ src: "icons/mail.svg" }]), entry("chat")];
  const sources = options.sources ?? {
    mail: source("@acme.sh/mail"),
    chat: source("@acme.sh/chat"),
  };
  const icons = options.icons ?? { "icons/mail.svg": "<svg/>" };
  return buildSnapshot({
    feed: JSON.stringify({ apps, version: 1 }),
    readSource: async (id) => (id in sources ? JSON.stringify(sources[id]) : undefined),
    readIcon: async (path) => (path in icons ? new TextEncoder().encode(icons[path]) : undefined),
    ...(options.rules ? { rules: { rules: options.rules, sha256: "f".repeat(64) } } : {}),
  });
}
const rules = (partial: Partial<RewriteRules>): RewriteRules => ({
  version: 1,
  names: [],
  rules: [],
  preserve: [],
  ...partial,
});
const file = (source: Source, path: string) =>
  source.files.find((candidate) => candidate.path === path)!.content!;
const documentOf = (files: ReadonlyMap<string, Uint8Array>, id: string) =>
  JSON.parse(text(files.get(`apps/${id}.json`))) as Source;

describe("catalog snapshot layout", () => {
  test("addresses each document by its hash and keeps the path today's client reads", async () => {
    const { files, failures, manifest } = await build({});
    expect(failures).toEqual([]);
    const index = JSON.parse(text(files.get("index.json")));
    for (const app of index.apps) {
      const bytes = files.get(app.source)!;
      expect(app.source).toBe(`apps/${app.id}/${sha256(bytes)}.json`);
      expect(app.sha256).toBe(sha256(bytes));
      // Both lookups are present, with the same bytes.
      expect(Buffer.from(files.get(`apps/${app.id}.json`)!).equals(bytes)).toBe(true);
      // Both resolve against the index's own URL, from any base.
      for (const base of ["https://catalog.example/index.json", "http://127.0.0.1:9/x/index.json"])
        expect(new URL(app.source, base).href).toBe(
          new URL(`apps/${app.id}/${app.sha256}.json`, new URL(".", base)).href,
        );
    }
    const [mail] = index.apps;
    expect(mail.icons[0].src).toBe(`icons/${sha256("<svg/>")}.svg`);
    expect([...files.keys()].sort()).toEqual(
      [
        "apps/chat.json",
        index.apps[1].source,
        "apps/mail.json",
        mail.source,
        mail.icons[0].src,
        "index.json",
        "manifest.json",
      ].sort(),
    );
    expect(manifest).toMatchObject({ version: 2, entries: 2, documents: 2, icons: 1, rules: null });
    expect(snapshotProblems(files)).toEqual([]);
  });

  test("is byte-identical across runs and independent of the served formatting", async () => {
    const first = await build({});
    const second = await build({});
    expect([...second.files]).toEqual([...first.files]);
    expect(serialize({ b: [2, { d: 1, c: 0 }], a: "x" })).toBe(
      '{\n  "a": "x",\n  "b": [\n    2,\n    {\n      "c": 0,\n      "d": 1\n    }\n  ]\n}\n',
    );
  });

  test("lists an id repeated with an identical entry once, and fails one repeated differently", async () => {
    const same = await build({ apps: [entry("mail"), entry("chat"), entry("mail")] });
    expect(same.failures).toEqual([]);
    expect(same.manifest).toMatchObject({ entries: 2, duplicateIds: ["mail"] });
    const ids = JSON.parse(text(same.files.get("index.json"))).apps.map(
      (app: { id: string }) => app.id,
    );
    expect(ids).toEqual(["mail", "chat"]);

    const different = await build({
      apps: [entry("mail"), entry("chat"), { ...entry("mail"), description: "Other" }],
    });
    expect(different.failures).toEqual([
      { document: "index.json#/apps/2", reason: "mail is listed again with different fields" },
    ]);
  });

  test("lists every document it cannot use instead of stopping at the first", async () => {
    const { failures } = await build({
      apps: [
        entry("mail"),
        entry("chat"),
        entry("gone"),
        entry("../up"),
        entry("x", [{ src: "https://cdn.example/a.svg" }]),
      ],
      sources: {
        mail: { ...source("@acme.sh/mail"), package: "@acme.sh/other" },
        chat: { package: "@acme.sh/chat" },
        x: source("@acme.sh/x"),
      },
      icons: {},
    });
    expect(failures.map((failure) => [failure.document, failure.reason.slice(0, 30)])).toEqual([
      ["apps/mail.json", "package.json names @acme.sh/ma"],
      ["apps/chat.json", "not a catalog source: Missing "],
      ["apps/gone.json", "the feed has no source documen"],
      ["index.json#/apps/3", 'id "../up" cannot name a file'],
      ["index.json#/apps/4", "icon https://cdn.example/a.svg"],
    ]);
  });

  test("reads only icons that stay inside the feed", () => {
    expect(iconPath("icons/a.svg")).toBe("icons/a.svg");
    expect(iconPath("./icons/a.svg")).toBe("icons/a.svg");
    for (const outside of [
      "../a.svg",
      "/a.svg",
      "https://cdn.example/a.svg",
      "icons/a.svg?x=1",
      "index.json",
      "data:image/png;base64,AA==",
      "icons/.hidden",
    ])
      expect(iconPath(outside)).toBeUndefined();
  });
});

describe("icons", () => {
  test("are svg, png or webp, and their bytes are that type", async () => {
    const png = "\x89PNG\r\n\x1a\n....";
    const webp = "RIFF\x10\x00\x00\x00WEBPVP8 ";
    const svg = '\ufeff<?xml version="1.0"?>\n<!-- logo -->\n<!DOCTYPE svg>\n<svg xmlns="x"/>';
    const icons: Record<string, string> = {
      "icons/a.png": png,
      "icons/b.webp": webp,
      "icons/c.svg": svg,
      "icons/d.gif": "GIF89a",
      "icons/e.png": "<svg/>",
      "icons/f.webp": "RIFF\x10\x00\x00\x00WAVE",
      "icons/g.svg": "<html><svg/></html>",
      "icons/h.svg": "<svgx/>",
      // A doctype with an internal subset, as an Illustrator export writes it.
      "icons/i.svg": '<!DOCTYPE svg PUBLIC "x" "y" [\r\n\t<!ENTITY a "b">\r\n]>\r\n<svg>',
      "icons/j.svg": '<!DOCTYPE html [<!ENTITY a "b">]><html>',
    };
    const apps = Object.keys(icons).map((src, index) => entry(`app${index}`, [{ src }]));
    const sources = Object.fromEntries(apps.map((app) => [app.id, source(`@acme.sh/${app.id}`)]));
    const { failures } = await buildSnapshot({
      feed: JSON.stringify({ apps, version: 1 }),
      readSource: async (id) => JSON.stringify(sources[id]),
      // Binary signatures byte for byte; SVG as UTF-8 text.
      readIcon: async (path) =>
        path.endsWith(".svg")
          ? new TextEncoder().encode(icons[path])
          : Uint8Array.from(icons[path]!, (char) => char.charCodeAt(0)),
    });
    expect(failures.map((failure) => failure.reason)).toEqual([
      "icon icons/d.gif: icons are svg, png, webp, not .gif",
      "icon icons/e.png: not a PNG image",
      "icon icons/f.webp: not a WebP image",
      "icon icons/g.svg: not an SVG image (no <svg> root)",
      "icon icons/h.svg: not an SVG image (no <svg> root)",
      "icon icons/j.svg: not an SVG image (no <svg> root)",
    ]);
  });
});

describe("snapshot relationships", () => {
  /** The snapshot's files with one changed and the manifest fixed up to match, as an attacker would. */
  async function tampered(change: (files: Map<string, Uint8Array>) => void) {
    const files = new Map((await build({})).files);
    change(files);
    const manifest = JSON.parse(text(files.get("manifest.json")));
    manifest.files = Object.fromEntries(
      [...files.keys()]
        .filter((path) => path !== "manifest.json")
        .sort()
        .map((path) => [
          path,
          { sha256: sha256(files.get(path)!), bytes: files.get(path)!.byteLength },
        ]),
    );
    manifest.feed = manifest.files["index.json"];
    files.set("manifest.json", new TextEncoder().encode(serialize(manifest)));
    return snapshotProblems(files);
  }

  test("refuses a document whose bytes are not the index's hash, even with the manifest fixed up", async () => {
    const problems = await tampered((files) => {
      const index = JSON.parse(text(files.get("index.json")));
      const path = index.apps[0].source;
      const edited = new TextEncoder().encode(
        text(files.get(path)).replace("acme app", "evil app"),
      );
      files.set(path, edited);
      files.set("apps/mail.json", edited);
    });
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/mail.*not named by its hash/u),
        "mail: no document with its hash",
      ]),
    );
  });

  test("refuses a dotfile, an unlisted extra, an icon outside icons/ and a different legacy copy", async () => {
    expect(await tampered((files) => files.set(".env", new Uint8Array([1])))).toContain(
      ".env has no place in a snapshot",
    );
    expect(
      await tampered((files) => files.set("apps/.hidden.json", new Uint8Array([1]))),
    ).toContain("apps/.hidden.json has no place in a snapshot");
    const [extra] = await tampered((files) =>
      files.set(`icons/${"a".repeat(64)}.svg`, new Uint8Array([1])),
    );
    expect(extra).toMatch(/is not named by its hash/u);
    const moved = await tampered((files) => {
      const index = JSON.parse(text(files.get("index.json")));
      // The icon moved to a document's path.
      const icon = files.get(index.apps[0].icons[0].src)!;
      files.delete(index.apps[0].icons[0].src);
      index.apps[0].icons[0].src = index.apps[1].source;
      files.set(index.apps[1].source, icon);
      files.set("index.json", new TextEncoder().encode(serialize(index)));
    });
    expect(moved).toEqual(
      expect.arrayContaining([expect.stringMatching(/icon apps\/chat\/.* is not a file/u)]),
    );
    const legacy = await tampered((files) =>
      files.set("apps/chat.json", new TextEncoder().encode("{}")),
    );
    expect(legacy).toContain("chat: apps/chat.json is not the same document");
  });

  test("refuses files that differ from an untouched manifest", async () => {
    const files = new Map((await build({})).files);
    files.set("apps/extra.json", new Uint8Array([1]));
    files.delete("apps/chat.json");
    expect(snapshotProblems(files)).toEqual(
      expect.arrayContaining([
        "apps/chat.json is missing",
        "apps/extra.json is not in the manifest",
      ]),
    );
  });
});

describe("scoped rewrite rules", () => {
  const scoped = rules({
    names: ["acme"],
    rules: [
      { id: "scope", scope: "package", from: "@acme.sh/", to: "@opensteer.example/" },
      { id: "key", scope: "manifest-key", from: "acme", to: "engine" },
      { id: "prose", scope: "markdown", from: "Acme", to: "Opensteer" },
      { id: "comments", scope: "comments", from: "acme", to: "the engine" },
      {
        id: "one-off",
        scope: "text",
        from: "Acme tools",
        to: "Opensteer tools",
        documents: ["mail"],
        files: ["tools/main.ts"],
      },
    ],
    preserve: [
      { text: "Acme Cloud", reason: "upstream's hosted service" },
      { text: "User-Agent: acme/1", reason: "provider-facing identifier" },
      // Code the scopes do not reach still has to be accounted for.
      { text: "`Acme` stays", reason: "code span" },
      { text: "Acme in a fence", reason: "fenced code" },
      { text: "/acme\\/\\//u", reason: "regular expression" },
      { text: "`acme ${", reason: "template" },
      { text: "} acme`", reason: "template" },
      // A Python comment after code is left alone, like the code.
      { text: 'name = "acme"  # acme', reason: "string" },
    ],
  });
  const readme = [
    "Acme registers a client. Acme Cloud does too.",
    "Requests send `User-Agent: acme/1` and `Acme` stays in code.",
    "```",
    "Acme in a fence",
    "```",
    "![logo](data:image/png;base64,iVBORacmeQ==)",
    "",
  ].join("\n");
  const code = [
    'const ua = "User-Agent: acme/1"; // sent by acme',
    "const re = /acme\\/\\//u; /* acme block */",
    "const t = `acme ${x /* acme */} acme`;",
    'export const tools = ["Acme tools"];',
  ].join("\n");
  const mail = source("@acme.sh/mail", [
    { path: "README.md", content: readme },
    { path: "helper.py", content: '# acme\nname = "acme"  # acme\n' },
  ]).files.map((f) => (f.path === "tools/main.ts" ? { ...f, content: code } : f));

  test("rewrites only where each rule applies and keeps preserved, coded and encoded text", async () => {
    const { files, failures, report, manifest } = await build({
      apps: [entry("mail")],
      sources: { mail: { files: mail, package: "@acme.sh/mail" } },
      rules: scoped,
    });
    expect(failures).toEqual([]);
    const document = documentOf(files, "mail");
    // The package name in all three places, and a valid one.
    expect(document.package).toBe("@opensteer.example/mail");
    expect(JSON.parse(file(document, "package.json"))).toEqual({
      name: "@opensteer.example/mail",
      engine: { title: "x" },
      dependencies: { apps: "1.0.0" },
    });
    expect(JSON.parse(text(files.get("index.json"))).apps[0].package).toBe(
      "@opensteer.example/mail",
    );
    expect(file(document, "README.md")).toBe(
      readme.replace("Acme registers", "Opensteer registers"),
    );
    expect(file(document, "tools/main.ts")).toBe(
      [
        'const ua = "User-Agent: acme/1"; // sent by the engine',
        "const re = /acme\\/\\//u; /* the engine block */",
        "const t = `acme ${x /* the engine */} acme`;",
        'export const tools = ["Opensteer tools"];',
      ].join("\n"),
    );
    expect(file(document, "helper.py")).toBe('# the engine\nname = "acme"  # acme\n');
    // Every name left is accounted for: preserved, inside code the rules do not touch, or base64.
    const left = report.remaining.map((occurrence) => [
      occurrence.location.split("#")[1],
      occurrence.reason,
    ]);
    expect(left).toEqual(
      expect.arrayContaining([
        ["README.md:1", "upstream's hosted service"],
        ["README.md:2", "provider-facing identifier"],
        ["README.md:4", "fenced code"],
        ["README.md:6", "base64"],
        ["tools/main.ts:2", "regular expression"],
      ]),
    );
    expect(report.rules.find((rule) => rule.id === "scope")?.count).toBe(3);
    // The published manifest carries the rule file's hash, never its strings.
    expect(text(files.get("manifest.json"))).not.toMatch(/acme/iu);
    expect(manifest.rules).toBe("f".repeat(64));
  });

  test("fails a name no rule rewrites and no preserve entry keeps", async () => {
    const { failures } = await build({
      apps: [entry("mail")],
      sources: { mail: { files: mail, package: "@acme.sh/mail" } },
      // A string in code no scope reaches, and no preserve entry keeps.
      rules: { ...scoped, preserve: scoped.preserve.filter((item) => item.reason !== "string") },
    });
    const unaccounted = {
      document: "apps/mail.json#helper.py:2",
      reason: expect.stringContaining("a name remains"),
    };
    expect(failures).toEqual([unaccounted, unaccounted]);
  });

  test("refuses a package scope the engine's package-name contract rejects", async () => {
    const { failures } = await build({
      rules: rules({
        rules: [{ id: "scope", scope: "package", from: "@acme.sh/", to: "@Opensteer/" }],
      }),
    });
    expect(failures).toEqual(
      expect.arrayContaining([
        { document: "apps/mail.json", reason: "@Opensteer/mail is not a valid package name" },
      ]),
    );
  });

  test("refuses a rewrite that breaks an import, a JSON file or encoded data", () => {
    const original: Source = {
      package: "p",
      files: [
        {
          path: "index.ts",
          content: 'import { a } from "./lib/a.js";\nconst logo = "data:image/png;base64,AAAA";',
        },
        { path: "lib/a.ts", content: "export const a = 1;" },
        { path: "spec.json", content: '{"a":"acme"}' },
        { path: "ui/public/x.png", content: "AAAA", encoding: "base64" },
      ],
    };
    const edit = (path: string, content: string, encoding?: string): Source => ({
      ...original,
      files: original.files.map((f) =>
        f.path === path ? { ...f, content, ...(encoding ? { encoding } : {}) } : f,
      ),
    });
    expect(rewriteProblems(original, original)).toEqual([]);
    expect(
      rewriteProblems(
        original,
        edit(
          "index.ts",
          'import { a } from "./lib/b.js";\nconst logo = "data:image/png;base64,AAAA";',
        ),
      ),
    ).toEqual(["index.ts: a relative import changed"]);
    expect(
      rewriteProblems(
        original,
        edit(
          "index.ts",
          'import { a } from "./lib/a.js";\nconst logo = "data:image/png;base64,AAAB";',
        ),
      ),
    ).toEqual(["index.ts: a data URI or base64 run changed"]);
    expect(rewriteProblems(original, edit("spec.json", '{"a":"ac"me"}'))).toEqual([
      "spec.json: no longer parses as JSON",
    ]);
    expect(rewriteProblems(original, edit("ui/public/x.png", "AAAB", "base64"))).toEqual([
      "ui/public/x.png: a non-text file changed",
    ]);
  });

  test("finds prose and comments without touching code, strings or regular expressions", () => {
    const prose = (value: string) => markdownProse(value).map(([a, b]) => value.slice(a, b));
    expect(prose("a `b` c\n```\nd\n```\ne ``f ` g`` h")).toEqual(["a ", " c\n", "e ", " h"]);
    const comments = (value: string, find = scriptComments) =>
      find(value).map(([a, b]) => value.slice(a, b));
    expect(comments('a("//x"); b = 1 / 2; // c\nd = /\\/\\/*/; /* e */ `${"//"}` // f')).toEqual([
      "// c",
      "/* e */",
      "// f",
    ]);
    // Python: full-line comments only, never a `#` in a string or after code.
    expect(
      comments("x = '''\n# not\n'''  # after code\n  # yes\n\"#\"\n# also", pythonComments),
    ).toEqual(["# yes", "# also"]);
    // A regular expression after an `if` condition is code, and so is `//` inside it.
    expect(
      comments("if (ok) /[/*] acme */u.test(s); // acme\nconst t = `${a}//`; /* b */"),
    ).toEqual(["// acme", "/* b */"]);
  });

  test("leaves code exactly as it was under a comments or prose rule, and never touches a migration", async () => {
    const regex = "if (ok) /[/*] acme */u.test(s); // acme\n";
    const { files, failures } = await build({
      apps: [entry("mail")],
      sources: {
        mail: source("@acme.sh/mail", [
          { path: "check.ts", content: regex },
          { path: "migrations/0001_init.sql", content: "-- acme\nselect 1;\n" },
        ]),
      },
      rules: rules({
        rules: [
          { id: "c", scope: "comments", from: "acme", to: "engine" },
          {
            id: "sql",
            scope: "text",
            from: "acme",
            to: "engine",
            documents: ["mail"],
            files: ["migrations/0001_init.sql"],
          },
        ],
      }),
    });
    expect(failures).toEqual([]);
    const document = documentOf(files, "mail");
    expect(file(document, "check.ts")).toBe("if (ok) /[/*] acme */u.test(s); // engine\n");
    expect(file(document, "migrations/0001_init.sql")).toBe("-- acme\nselect 1;\n");

    // A comment rule whose replacement ends the comment early changes the code, and fails.
    const broken = await build({
      apps: [entry("mail")],
      sources: { mail: source("@acme.sh/mail", [{ path: "a.ts", content: "/* acme */ x;" }]) },
      rules: rules({ rules: [{ id: "c", scope: "comments", from: "acme", to: "*/ y; /*" }] }),
    });
    expect(broken.failures).toEqual([
      { document: "apps/mail.json", reason: "a.ts: rule c changed text outside its scope" },
    ]);
    const original: Source = {
      package: "p",
      files: [{ path: "db/migrations/1.sql", content: "select 1;" }],
    };
    expect(
      rewriteProblems(original, {
        ...original,
        files: [{ path: "db/migrations/1.sql", content: "select 2;" }],
      }),
    ).toEqual(["db/migrations/1.sql: a migration changed"]);
  });

  test("never adds or removes a line break in a comment, which can change what code does", async () => {
    // `return /* note */ 42;` returns 42; with a line break in the comment it returns nothing,
    // though the tokens are the same: whether a line break precedes `42` is what differs.
    const returns = "function f() {\n  return /* note */ 42;\n}\n";
    const tokens = (value: string) => scriptTokens("a.ts", value).tokens;
    expect(tokens(returns.replace("note", "a\nb"))).not.toEqual(tokens(returns));
    expect(tokens(returns.replace("note", "remark"))).toEqual(tokens(returns));
    const run = (content: string) =>
      build({
        apps: [entry("mail")],
        sources: { mail: source("@acme.sh/mail", [{ path: "a.ts", content }]) },
        // Built directly: a rule file with this rule is refused when it is read (below).
        rules: rules({ rules: [{ id: "c", scope: "comments", from: "note", to: "a\nb" }] }),
      });
    expect((await run(returns)).failures).toEqual([
      { document: "apps/mail.json", reason: "a.ts: rule c changed text outside its scope" },
    ]);
    // Where the code after the comment does not change, the comment's own line breaks still may not.
    expect((await run("/* note */\nx;\n")).failures).toEqual([
      { document: "apps/mail.json", reason: "a.ts: rule c changed the line breaks in a comment" },
    ]);
    // A rule file whose comments or prose replacement adds or removes a line break is refused.
    const file = (rule: object) =>
      JSON.stringify({ version: 1, names: [], rules: [{ id: "r", ...rule }], preserve: [] });
    for (const rule of [
      { scope: "comments", from: "acme", to: "a\nb" },
      { scope: "comments", from: "acme", to: "a\u2028b" },
      { scope: "markdown", from: "a\nb", to: "a b" },
      { scope: "markdown", from: "a\nb", to: "a\r\nb" },
    ])
      expect(() => parseRules(file(rule))).toThrow("must have the same line breaks");
    expect(parseRules(file({ scope: "comments", from: "a\nb", to: "c\nd" })).rules).toHaveLength(1);
    expect(
      parseRules(file({ scope: "text", from: "a", to: "b\nc", documents: ["d"], files: ["f"] }))
        .rules,
    ).toHaveLength(1);
  });

  test("takes rules as JSON data with known keys only, the engine's names in their own section", () => {
    // The package scope and the package.json key are the engine's names, kept apart.
    const engine = scoped.rules.filter((rule) => ["package", "manifest-key"].includes(rule.scope));
    const others = scoped.rules.filter((rule) => !engine.includes(rule));
    const file = { ...scoped, engine, rules: others };
    expect(parseRules(JSON.stringify(file))).toEqual(scoped);
    // A variable is set once and used by name.
    expect(
      parseRules(
        JSON.stringify({
          ...file,
          variables: { contact: "help@example.com" },
          rules: [{ id: "ua", scope: "comments", from: "a", to: "x ({{contact}})" }],
        }),
      ).rules.at(-1)?.to,
    ).toBe("x (help@example.com)");
    for (const invalid of [
      "export const renames = [];",
      JSON.stringify({ ...file, rules: [{ ...others[0], extra: 1 }] }),
      JSON.stringify({ ...file, rules: [{ ...others[0], scope: "everywhere" }] }),
      JSON.stringify({ ...file, rules: [{ id: "t", scope: "text", from: "a", to: "b" }] }),
      JSON.stringify({ ...file, rules: [others[0], others[0]] }),
      JSON.stringify({ ...file, rules: [...others, { ...others[0], id: "u", to: "{{unset}}" }] }),
      // Engine scopes only in the engine section, and only engine scopes there.
      JSON.stringify(scoped),
      JSON.stringify({ ...file, engine: [...engine, others[0]] }),
      JSON.stringify({ ...file, engine: [{ ...engine[0], documents: ["mail"] }] }),
    ])
      expect(() => parseRules(invalid)).toThrow();
  });
});
