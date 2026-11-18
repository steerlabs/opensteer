import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  buildSnapshot,
  checkRewrites,
  iconPath,
  manifestProblems,
  serialize,
  type Rewrites,
} from "../scripts/catalog-snapshot/core.ts";

const manifest = (name: string) => JSON.stringify({ name, dependencies: { apps: "1.0.0" } });
const source = (name: string, extra: object[] = []) => ({
  files: [
    { path: "index.ts", content: `import { defineApp } from "apps"; // acme app ${name}` },
    { path: "package.json", content: manifest(name) },
    ...extra,
  ],
  package: name,
});
const entry = (id: string, icons: { src: string }[] = []) => ({
  id,
  package: `@acme.sh/${id}`,
  name: id,
  description: `Talk to ${id} through acme`,
  auth: [{ method: "oauth", kind: "oauth2" }],
  icons,
  source: `apps/${id}.json`,
});

/** Build from in-memory documents, collecting what the snapshot writes. */
async function build(options: {
  apps?: ReturnType<typeof entry>[];
  sources?: Record<string, unknown>;
  icons?: Record<string, string>;
  rewrites?: Rewrites;
}) {
  const apps = options.apps ?? [entry("mail", [{ src: "icons/mail.svg" }]), entry("chat")];
  const sources = options.sources ?? {
    mail: source("@acme.sh/mail"),
    chat: source("@acme.sh/chat"),
  };
  const icons = options.icons ?? { "icons/mail.svg": "<svg/>" };
  const written = new Map<string, string>();
  const result = await buildSnapshot({
    feed: JSON.stringify({ apps, version: 1 }),
    readSource: async (id) => (id in sources ? JSON.stringify(sources[id]) : undefined),
    readIcon: async (path) => (path in icons ? new TextEncoder().encode(icons[path]) : undefined),
    write: async (path, bytes) => {
      written.set(path, new TextDecoder().decode(bytes));
    },
    rewrites: options.rewrites ?? [],
  });
  return { ...result, written };
}

describe("catalog snapshot", () => {
  test("lays out the feed the catalog client reads from any base URL", async () => {
    const { written, failures, manifest } = await build({});
    expect(failures).toEqual([]);
    expect([...written.keys()].sort()).toEqual([
      "apps/chat.json",
      "apps/mail.json",
      "icons/mail.svg",
      "index.json",
    ]);
    const index = JSON.parse(written.get("index.json")!);
    const mail = index.apps[0];
    // The client resolves the source and icons against the index's own URL.
    for (const base of ["https://catalog.example/index.json", "http://127.0.0.1:9/x/index.json"]) {
      expect(new URL(`apps/${mail.id}.json`, base).href).toBe(new URL(mail.source, base).href);
      expect(new URL(mail.icons[0].src, base).href).toBe(
        new URL("icons/mail.svg", new URL(".", base)).href,
      );
    }
    expect(manifest).toMatchObject({ entries: 2, documents: 2, icons: 1, duplicateIds: [] });
  });

  test("hashes each source document's exact bytes in the index and the manifest", async () => {
    const { written, manifest } = await build({});
    const hash = (text: string) => createHash("sha256").update(text).digest("hex");
    const index = JSON.parse(written.get("index.json")!);
    for (const app of index.apps) {
      const document = written.get(`apps/${app.id}.json`)!;
      expect(app.sha256).toBe(hash(document));
      expect(manifest.files[`apps/${app.id}.json`]).toEqual({
        sha256: hash(document),
        bytes: Buffer.byteLength(document),
      });
    }
    expect(manifest.feed.sha256).toBe(hash(written.get("index.json")!));
    expect(manifest.totalBytes).toBe(
      [...written.values()].reduce((sum, text) => sum + Buffer.byteLength(text), 0),
    );
  });

  test("is byte-identical across runs and independent of the served formatting", async () => {
    const first = await build({});
    const second = await build({});
    expect([...second.written]).toEqual([...first.written]);
    expect(second.manifest).toEqual(first.manifest);
    expect(serialize({ b: [2, { d: 1, c: 0 }], a: "x" })).toBe(
      '{\n  "a": "x",\n  "b": [\n    2,\n    {\n      "c": 0,\n      "d": 1\n    }\n  ]\n}\n',
    );
  });

  test("lists every document it cannot validate instead of stopping at the first", async () => {
    const { failures, written } = await build({
      apps: [entry("mail"), entry("chat"), entry("gone"), entry("no-index")],
      sources: {
        mail: { ...source("@acme.sh/mail"), package: "@acme.sh/other" },
        chat: { package: "@acme.sh/chat" },
        "no-index": { package: "x", files: [{ path: "package.json", content: manifest("x") }] },
      },
      icons: {},
    });
    expect(failures.map((failure) => failure.document)).toEqual([
      "apps/mail.json",
      "apps/chat.json",
      "apps/gone.json",
      "apps/no-index.json",
    ]);
    expect(failures[0]!.reason).toContain("package.json names @acme.sh/mail");
    expect(failures[2]!.reason).toBe("the feed has no source document for this entry");
    expect(written.has("index.json")).toBe(true);
  });

  test("refuses an id or icon that would leave the snapshot", async () => {
    const { failures } = await build({ apps: [entry("../mail")], sources: {} });
    expect(failures).toEqual([
      expect.objectContaining({ document: "index.json#/apps/0", reason: expect.any(String) }),
    ]);
    expect(iconPath("icons/a.svg")).toBe("icons/a.svg");
    expect(iconPath("./icons/a.svg")).toBe("icons/a.svg");
    // Resolved as the client resolves it: this one stays inside, at the root.
    expect(iconPath("icons/%2e%2e/a.svg")).toBe("a.svg");
    for (const outside of [
      "../a.svg",
      "/a.svg",
      "https://cdn.example/a.svg",
      "icons/a.svg?x=1",
      "index.json",
      "data:image/png;base64,AA==",
    ])
      expect(iconPath(outside)).toBeUndefined();
  });

  test("keeps duplicate ids pointing at their one document", async () => {
    const { manifest, written } = await build({
      apps: [entry("mail"), entry("chat"), entry("mail")],
    });
    expect(manifest).toMatchObject({ entries: 3, documents: 2, duplicateIds: ["mail"] });
    const [first, , again] = JSON.parse(written.get("index.json")!).apps;
    expect(again).toEqual(first);
  });

  test("rewrites the feed and every text file in order, counting each mapping entry", async () => {
    const binary = { path: "ui/public/logo.png", content: "YWNtZQ==", encoding: "base64" };
    const { written, manifest, leftovers, failures } = await build({
      sources: {
        mail: source("@acme.sh/mail", [binary]),
        chat: source("@acme.sh/chat"),
      },
      rewrites: [
        ["@acme.sh/", "@opensteer/"],
        ["acme", "steer"],
      ],
    });
    expect(failures).toEqual([]);
    expect(leftovers).toEqual([]);
    const mail = JSON.parse(written.get("apps/mail.json")!);
    expect(mail.package).toBe("@opensteer/mail");
    expect(
      JSON.parse(mail.files.find((f: { path: string }) => f.path === "package.json").content),
    ).toMatchObject({ name: "@opensteer/mail" });
    expect(mail.files.find((f: { path: string }) => f.path === "index.ts").content).toContain(
      "// steer app @opensteer/mail",
    );
    // Binary bytes are not text, so they are copied as they are.
    expect(mail.files.find((f: { path: string }) => f.path === binary.path)).toEqual(binary);
    expect(JSON.parse(written.get("index.json")!).apps[0]).toMatchObject({
      package: "@opensteer/mail",
      description: "Talk to mail through steer",
    });
    // Index: 2 packages, 2 descriptions. Each source: package, package.json name, index.ts.
    expect(manifest.rewrites).toEqual([
      { from: "@acme.sh/", to: "@opensteer/", count: 2 + 3 * 2 },
      { from: "acme", to: "steer", count: 2 + 2 },
    ]);
  });

  test("reports old strings that remain after rewriting", async () => {
    const { leftovers, written } = await build({
      // The second pair puts the first one's old string back.
      rewrites: [
        ["acme", "steer"],
        ["steer", "acme"],
      ],
    });
    expect(leftovers).toEqual([
      expect.objectContaining({ from: "acme", first: "apps/mail.json#/files/0/content" }),
    ]);
    expect(leftovers[0]!.count).toBeGreaterThan(0);
    expect(written.get("index.json")).toContain("through acme");
  });

  test("accepts only an ordered list of exact string pairs", () => {
    expect(checkRewrites([["a", "b"]])).toEqual([["a", "b"]]);
    expect(checkRewrites([])).toEqual([]);
    for (const invalid of [undefined, { a: "b" }, [["a"]], [["", "b"]], [["a", 1]]])
      expect(() => checkRewrites(invalid)).toThrow("[old, new] string pairs");
    expect(() =>
      checkRewrites([
        ["a", "b"],
        ["a", "c"],
      ]),
    ).toThrow('lists "a" twice');
  });

  test("publishes only a directory that is exactly the snapshot its manifest describes", async () => {
    const { manifest, written } = await build({});
    const hash = (text: string) => createHash("sha256").update(text).digest("hex");
    const files = Object.fromEntries(
      [...written].map(([path, text]) => [
        path,
        { sha256: hash(text), bytes: Buffer.byteLength(text) },
      ]),
    );
    const manifestFile = { sha256: hash("{}"), bytes: 2 };
    expect(manifestProblems(manifest, { ...files, "manifest.json": manifestFile })).toEqual([]);
    const { "apps/chat.json": _missing, ...partial } = files;
    expect(
      manifestProblems(manifest, {
        ...partial,
        "apps/mail.json": { ...files["apps/mail.json"]!, sha256: hash("edited") },
        "apps/extra.json": manifestFile,
      }),
    ).toEqual([
      "apps/chat.json is missing",
      "apps/mail.json differs from the manifest",
      "apps/extra.json is not in the manifest",
    ]);
  });
});
