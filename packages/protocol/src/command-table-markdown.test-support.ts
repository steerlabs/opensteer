/**
 * The command table as Markdown, generated from `command-table.rows.json`, the rows the rule is
 * tested against. `command-table.md` is this output and nothing else: the table test fails when
 * the two differ, and `vitest -u` writes it again.
 */
interface Row {
  readonly type: string;
  readonly family: string;
  readonly governs: string;
  readonly step: string;
  readonly stepFor?: Readonly<Record<string, string>>;
  readonly note?: string;
  readonly faces: readonly {
    readonly when: string | null;
    readonly class: string;
    readonly answers: Readonly<Record<string, string>>;
  }[];
}

const families: Readonly<Record<string, string>> = {
  tasks: "Tasks, inputs, Requests",
  settings: "Settings and defaults",
  engines: "Engines",
  devices: "Devices",
  "device-apps": "Device apps, approvals, local servers",
  home: "Remote access, account link, sign-ins",
  connections: "Connected agents",
  plugins: "Plugins",
  chats: "Chats",
  browser: "Browser",
  "tabs-apps": "Tabs and apps",
  automations: "Automations",
};
const callers = ["a", "b", "c", "d"] as const;

/** One answer per caller for the row: the faces' answer if they agree, else `now/ask`. */
function summary(row: Row, caller: (typeof callers)[number]): string {
  const answers = new Set<string>();
  for (const face of row.faces) {
    answers.add(face.answers[caller]!);
    // Auto answering otherwise than the other modes below Full access, said beside them.
    if (caller === "b" && face.answers["b:auto"]) answers.add(face.answers["b:auto"]);
  }
  const values = [...answers];
  if (values.length === 1) return values[0] === "not_found" ? "nf" : values[0]!;
  return values.includes("not_found") ? values.join("/") : "now/ask";
}

export function commandTableMarkdown(rows: readonly Row[]): string {
  const out = [
    "# The command table",
    "",
    "Generated from `command-table.rows.json` by `command-table-markdown.test-support.ts`; do not",
    "edit. Callers: (a) your own agent at Full access, (b) your own agent below Full access",
    "(an Auto answer that differs is shown beside it), (c) a connected agent with `everything`,",
    "(d) a connected agent with a selected grant. `nf`: not found.",
  ];
  for (const [family, title] of Object.entries(families)) {
    const inFamily = rows.filter((row) => row.family === family);
    if (!inFamily.length) continue;
    out.push("", `## ${title} (${inFamily.length})`, "");
    out.push("| Command | Governs ← input | Class | (a) | (b) | (c) | (d) | Step | Note |");
    out.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const row of inFamily) {
      const classes = row.faces.map((face) => face.class).join(" / ");
      const step =
        row.step +
        (row.stepFor
          ? ` (${Object.entries(row.stepFor)
              .map(([caller, value]) => `${caller}: ${value}`)
              .join(", ")})`
          : "");
      const cells = callers.map((caller) => summary(row, caller)).join(" | ");
      const note = (row.note ?? "").replaceAll("|", "\\|").replaceAll("\n", " ");
      out.push(
        `| \`${row.type}\` | ${row.governs.replaceAll("|", "\\|")} | ${classes} | ${cells} | ${step} | ${note} |`,
      );
    }
  }
  return `${out.join("\n")}\n`;
}
