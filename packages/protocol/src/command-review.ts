/**
 * The proposed command as the person reviews it before approving: every argument, each under a
 * label in the Home's words, each value whole and exactly as proposed. One walk for every command
 * type, shared by the Home (which adds what it knows beside a value) and by every client, so no two
 * of them can show a proposal differently, and nothing the person approves is left out.
 */

/** A value the person approves, or a heading over the values inside it. */
export interface CommandReviewField {
  /** Where it is in the command: `grant.resources.0.profileId`. */
  readonly path: string;
  /** How deep it sits: 0 for an argument of the command itself. */
  readonly depth: number;
  /** Its name in the Home's words. */
  readonly label: string;
  /** The value as proposed, whole; null on a heading over an object or a list. */
  readonly value: string | null;
}

/** What the Home adds beside one proposed value: what an id names, and what it is now. */
export interface CommandReviewNote {
  readonly path: string;
  /** What the id names, in the Home's words (a task's title, a profile's name). */
  readonly name?: string | undefined;
  /** What it is now, where the Home can say and the proposal changes it. */
  readonly current?: string | undefined;
}

/** A field as a card shows it: the proposed value with what the Home said beside it. */
export interface CommandReviewRow extends CommandReviewField {
  readonly name: string | null;
  readonly current: string | null;
}

const labels: Readonly<Record<string, string>> = {
  accessMode: "Mode",
  agentConnectionId: "Connected agent",
  appId: "App",
  automationId: "Automation",
  connectionId: "Connected agent",
  deviceId: "Device",
  environmentId: "Computer",
  expectedRevision: "As of version",
  grant: "What it may use",
  harnessId: "AI engine",
  harnessInstanceId: "AI engine account",
  label: "Name",
  machineId: "Device",
  profileId: "Browser profile",
  requestId: "Request",
  resources: "Chosen",
  runnerId: "Computer",
  scope: "Reach",
  taskId: "Task",
  tasks: "Tasks",
  threadId: "Task",
  triggerId: "Automation",
};

/** A field's name as the Home says it: its own word, or its key in plain words. */
export function commandFieldLabel(key: string): string {
  if (/^\d+$/u.test(key)) return String(Number(key) + 1);
  const known = labels[key];
  if (known) return known;
  const words = key
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/[_-]+/gu, " ")
    .toLowerCase()
    .trim();
  return words ? `${words[0]!.toUpperCase()}${words.slice(1)}` : key;
}

/** A proposed value as text, whole: what it is, never cut. */
export function commandValueText(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.length === 0 ? "None" : JSON.stringify(value);
  if (typeof value === "object")
    return Object.keys(value).length === 0 ? "None" : JSON.stringify(value);
  return String(value);
}

/**
 * Every argument of a proposed command, in order, outermost first: a heading for each object or
 * list with anything in it, a value for everything else. Only the command's `type` (what the
 * card's sentence says) is not a field; nothing else is ever left out.
 */
export function commandReviewFields(
  command: Readonly<Record<string, unknown>>,
): readonly CommandReviewField[] {
  const fields: CommandReviewField[] = [];
  const walk = (value: unknown, path: string, key: string, depth: number) => {
    const entries =
      Array.isArray(value) && value.length > 0
        ? value.map((item, index) => [String(index), item] as const)
        : value !== null &&
            typeof value === "object" &&
            !Array.isArray(value) &&
            Object.keys(value).length > 0
          ? Object.entries(value as Record<string, unknown>)
          : null;
    fields.push({
      path,
      depth,
      label: commandFieldLabel(key),
      value: entries ? null : commandValueText(value),
    });
    if (entries)
      for (const [child, item] of entries) walk(item, `${path}.${child}`, child, depth + 1);
  };
  for (const [key, value] of Object.entries(command)) if (key !== "type") walk(value, key, key, 0);
  return fields;
}

/** The fields with what the Home said beside them; a note for a path not proposed is dropped. */
export function commandReviewRows(
  command: Readonly<Record<string, unknown>>,
  notes: readonly CommandReviewNote[] = [],
): readonly CommandReviewRow[] {
  const byPath = new Map(notes.map((note) => [note.path, note]));
  return commandReviewFields(command).map((field) => ({
    ...field,
    name: byPath.get(field.path)?.name ?? null,
    current: byPath.get(field.path)?.current ?? null,
  }));
}

/** A whole object or value as review text, one line per value: how the Home says what is now. */
export function commandReviewText(value: unknown): string {
  if (value === null || typeof value !== "object") return commandValueText(value);
  const lines = commandReviewFields(value as Record<string, unknown>).map(
    (field) =>
      `${"  ".repeat(field.depth)}${field.label}${field.value === null ? "" : `: ${field.value}`}`,
  );
  return lines.length ? lines.join("\n") : "None";
}

/**
 * Characters that change how text reads without being seen: controls, bidirectional overrides
 * and isolates, zero-width marks. Tab, newline and carriage return are layout, handled apart.
 */
function hidden(code: number): boolean {
  return (
    code <= 0x08 ||
    code === 0x0b ||
    code === 0x0c ||
    (code >= 0x0e && code <= 0x1f) ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x061c ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x2069) ||
    code === 0xfeff
  );
}

/**
 * Text from outside the Home (an agent's or a person's), as a card shows it: every hidden or
 * direction-changing character written out as its code, so what is shown is what is there.
 * On one line, line breaks and tabs read as spaces.
 */
export function visibleText(value: string, lines: "keep" | "one" = "keep"): string {
  let shown = "";
  for (const character of value) {
    const code = character.codePointAt(0)!;
    shown += hidden(code) ? `[U+${code.toString(16).toUpperCase().padStart(4, "0")}]` : character;
  }
  return lines === "one" ? shown.replace(/[\r\n\t]+/gu, " ") : shown;
}

/** A name from outside the Home, to sit inside the Home's “…”: one line, never closing them. */
export function outsideName(value: string): string {
  return visibleText(value, "one").replace(/[“”„"«»]/gu, "'");
}
