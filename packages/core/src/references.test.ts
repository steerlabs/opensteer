import { describe, expect, it } from "vitest";
import { createId, idSchema, TabIdSchema } from "./ids.js";
import {
  formatReferenceLink,
  parseReferenceHref,
  referenceHref,
  tabReferenceHref,
  ReferenceIdSchema,
  ReferenceSchema,
} from "./references.js";
import { parseMarkdown } from "@opensteer/shared/markdownParser";

describe("personal references", () => {
  it.each([
    ["thread", "task"],
    ["run", "run"],
    ["request", "request"],
    ["message", "message"],
    ["trigger", "automation"],
    ["runner", "computer"],
    ["attachment", "attachment"],
  ] as const)("derives %s from the branded ID and canonicalizes its case", (idKind, kind) => {
    const id = createId(idKind);
    expect(parseReferenceHref("OPENSTEER:" + id.toUpperCase())).toEqual({ kind, id });
    expect(referenceHref(idSchema(idKind).parse(id.toUpperCase()))).toBe("opensteer:" + id);
    expect(ReferenceIdSchema.parse(id.toUpperCase())).toBe(id);
    expect(ReferenceSchema.parse({ kind, id: id.toUpperCase() })).toEqual({ kind, id });
  });

  it("rejects opaque IDs with extra URL syntax and unsupported prefixes", () => {
    const id = createId("thread");
    for (const href of [
      "opensteer://" + id,
      "opensteer:/" + id,
      "opensteer:" + id + "/",
      "opensteer:" + id + "\n",
      "opensteer:" + id + "?q=x",
      "opensteer:" + id + "#x",
      "opensteer: " + id,
      " opensteer:" + id,
      "opensteer:" + id.replace("_", "%5F"),
      "opensteer:" + createId("user"),
      "opensteer:thr_invalid",
    ])
      expect(parseReferenceHref(href)).toBeNull();
    expect(ReferenceSchema.safeParse({ kind: "task", id: createId("run") }).success).toBe(false);
  });

  it("builds one inert readable label and a kind fallback", () => {
    const id = createId("thread");
    const label = "Plan [v2] \\ _draft_\n🦊";
    const tree = parseMarkdown(formatReferenceLink(id, label));
    const paragraph = tree.children[0];
    expect(paragraph?.type).toBe("paragraph");
    if (paragraph?.type !== "paragraph") throw new Error("Missing paragraph");
    expect(paragraph.children).toMatchObject([
      {
        type: "link",
        url: referenceHref(id),
        children: [{ type: "text", value: "Plan [v2] \\ _draft_ 🦊" }],
      },
    ]);
    expect(formatReferenceLink(id, " \n ")).toBe("[task](" + referenceHref(id) + ")");
  });
});

it("parses explicit opaque tab links without swallowing bare domain IDs", () => {
  const id = TabIdSchema.parse("a/b ?#🦊");
  expect(parseReferenceHref(tabReferenceHref(id))).toEqual({ kind: "tab", id });
  expect(ReferenceIdSchema.parse(id)).toBe(id);
  expect(parseReferenceHref("opensteer:tab/%E0%A4%A")).toBeNull();
  expect(parseReferenceHref("opensteer:tab/")).toBeNull();
});

it.each(["surface_abc", "bsf_ABC", "opaque-page-id"])(
  "accepts page reference %s without changing its case",
  (value) => {
    const id = TabIdSchema.parse(value);
    expect(ReferenceIdSchema.parse(id)).toBe(id);
    expect(formatReferenceLink(id, "Page")).toBe(`[Page](${referenceHref(id)})`);
    expect(parseReferenceHref(referenceHref(id))).toEqual({ kind: "tab", id });
  },
);
