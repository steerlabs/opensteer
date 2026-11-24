import { personNameFromEmail } from "@opensteer/core";
import { outsideName } from "@opensteer/shared/outsideName";
import { describe, expect, it } from "vitest";
import { resourceRevisionsDdl } from "./personal-state-schema.js";

/**
 * A migration's meaning is pinned here. Each helper below is called by a migration that has run,
 * or will run, on people's databases, and it is shared with live code. If one of these fails
 * because you changed the helper, a database migrated before your change and one migrated after
 * it would differ: keep the old behaviour for the migration (a frozen copy beside it) or add a
 * NEW migration, and never change the recorded outputs here to match.
 */
describe("a migration's meaning is pinned here: change the helper, and add a NEW migration", () => {
  // 0109 (chat routes end) and 0113 (automations) clean every stored name through it.
  it("outsideName", () => {
    const recorded: readonly (readonly [string, number, string])[] = [
      ["  Weekly   report  ", 120, "Weekly report"],
      ["Line\nbreak\r\n\ttab", 120, "Line break tab"],
      ["a\u{200B}b\u{AD}c\u{2060}d", 120, "abcd"],
      ["Bell\u{7} and \u{202E}bidi", 120, "Bell and bidi"],
      ["Family 👨\u{200D}👩\u{200D}👧 trip", 120, "Family 👨\u{200D}👩\u{200D}👧 trip"],
      ["Keycap 1\u{FE0F}\u{20E3} and ❤\u{FE0F}", 120, "Keycap 1\u{FE0F}\u{20E3} and ❤\u{FE0F}"],
      [
        "Wales 🏴\u{E0067}\u{E0062}\u{E0077}\u{E006C}\u{E0073}\u{E007F}",
        120,
        "Wales 🏴\u{E0067}\u{E0062}\u{E0077}\u{E006C}\u{E0073}\u{E007F}",
      ],
      ["क्\u{200D}ष and a\u{200D}b", 120, "क्\u{200D}ष and ab"],
      ["Braille\u{2800}blank", 120, "Braille blank"],
      ["Project plan for the second quarter", 10, "Project pl"],
      ["🇯🇵🇺🇸🇫🇷", 5, "🇯🇵"],
      ["ab👨\u{200D}👩\u{200D}👧", 4, "ab"],
      ["cafe\u{301} au lait", 4, "caf"],
      ["x".repeat(130), 120, "x".repeat(120)],
      ["   ", 120, ""],
    ];
    for (const [value, maximum, cleaned] of recorded)
      expect(outsideName(value, maximum), JSON.stringify(value)).toBe(cleaned);
  });

  // The account service's 0022 renames an Account named with its whole email by it.
  it("personNameFromEmail", () => {
    const recorded: readonly (readonly [string, string])[] = [
      ["alex.smith@example.com", "Alex Smith"],
      ["j_doe+tag@x.io", "J Doe Tag"],
      ["A@b.c", "A"],
      ["first-last@example.org", "First Last"],
      ["123@example.com", "Member"],
      ["ÉLODIE.dupont@exemple.fr", "ÉLODIE Dupont"],
      [`${"n".repeat(200)}@example.com`, `N${"n".repeat(119)}`],
    ];
    for (const [email, name] of recorded) expect(personNameFromEmail(email), email).toBe(name);
  });

  // 0038 builds its released resource-revision default and CHECK with it, and 0110 its own.
  it("resourceRevisionsDdl", () => {
    expect(resourceRevisionsDdl(["settings", "plugin"])).toEqual({
      defaultValue: '{"settings":"0","plugin":"0"}',
      check:
        "jsonb_typeof(resource_revisions) = 'object'\n      and resource_revisions ?& array['settings','plugin']\n      and resource_revisions - array['settings','plugin'] = '{}'::jsonb and jsonb_typeof(resource_revisions->'settings') = 'string' and\n    (resource_revisions->>'settings') ~ '^(0|[1-9][0-9]{0,18})$' and\n    (resource_revisions->>'settings')::numeric <= sequence and jsonb_typeof(resource_revisions->'plugin') = 'string' and\n    (resource_revisions->>'plugin') ~ '^(0|[1-9][0-9]{0,18})$' and\n    (resource_revisions->>'plugin')::numeric <= sequence",
    });
  });
});
