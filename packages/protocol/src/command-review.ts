import { outsideName as cleanOutsideName } from "@opensteer/shared/outsideName";

/**
 * The proposed command as the person reviews it before approving: every argument, each under a
 * label in the Home's words, each value whole and exactly as proposed. One walk for every command
 * type, shared by the Home (which adds what it knows beside a value) and by every client, so no two
 * of them can show a proposal differently, and nothing the person approves is left out.
 */

/** A value the person approves, or a heading over the values inside it. */
export interface CommandReviewField {
  /** Where it is in the command, as a JSON Pointer: `/grant/resources/0/profileId`. */
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

/** One step of a path, as a JSON Pointer writes it (RFC 6901): `~` and `/` escaped. */
function pointerStep(key: string): string {
  return key.replace(/~/gu, "~0").replace(/\//gu, "~1");
}

/** Where a value is in a command: a JSON Pointer, so no key can pass for nesting. */
export function commandPath(keys: readonly string[]): string {
  return keys.map((key) => `/${pointerStep(key)}`).join("");
}

/** A key the command's own schema could name: a plain identifier. */
const identifier = /^[A-Za-z][A-Za-z0-9]*$/u;

/**
 * A field's name as the Home says it: its own word, or its identifier in plain words. A key that
 * is not an identifier (one inside free-form data) is shown as the escaped data it is.
 */
export function commandFieldLabel(key: string): string {
  if (/^\d+$/u.test(key)) return String(Number(key) + 1);
  if (!identifier.test(key)) return commandValueText(key);
  if (Object.hasOwn(labels, key)) return labels[key]!;
  const words = key.replace(/([a-z0-9])([A-Z])/gu, "$1 $2").toLowerCase();
  return `${words[0]!.toUpperCase()}${words.slice(1)}`;
}

/** What may not reach a card as itself: controls, format and invisible characters, separators. */
const unseen = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/gu;

const escaped = (character: string) => {
  const code = character.codePointAt(0)!;
  return code > 0xffff
    ? `\\u{${code.toString(16).toUpperCase()}}`
    : `\\u${code.toString(16).toUpperCase().padStart(4, "0")}`;
};

/**
 * A proposed value as typed data, whole and never cut: a string in quotes with every unseen
 * character escaped (so text can never pose as the escape for one), and `null`, `true`, `[]`,
 * `{}` as themselves. No two different values read the same.
 */
export function commandValueText(value: unknown): string {
  if (value === undefined) return "null";
  if (typeof value === "string") return JSON.stringify(value).replace(unseen, escaped);
  if (Array.isArray(value) && value.length === 0) return "[]";
  if (value !== null && typeof value === "object" && Object.keys(value).length === 0) return "{}";
  return JSON.stringify(value).replace(unseen, escaped);
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
  const walk = (value: unknown, keys: readonly string[], depth: number) => {
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
      path: commandPath(keys),
      depth,
      label: commandFieldLabel(keys.at(-1)!),
      value: entries ? null : commandValueText(value),
    });
    if (entries) for (const [child, item] of entries) walk(item, [...keys, child], depth + 1);
  };
  for (const [key, value] of Object.entries(command)) if (key !== "type") walk(value, [key], 0);
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
  return lines.length ? lines.join("\n") : commandValueText(value);
}

/**
 * Prose from outside the Home (an agent's reason), as a card shows it, attributed to its writer:
 * its lines kept, every control, format and invisible character removed, so nothing unseen turns
 * it around or hides in it.
 */
export function outsideProse(value: string): string {
  return value
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.replace(unseen, ""))
    .join("\n")
    .trim();
}

/**
 * A name from outside the Home (a task's title, an automation's, an agent's label), to sit inside
 * the Home's “…”: cleaned as the repository cleans every outside name (`outsideName` in
 * `@opensteer/shared`: one line, no control, format or direction character), bounded, and with no
 * quote mark that could close the Home's own.
 */
/** How long a name inside the Home's “…” may be on a card or in its sentence: one limit for all. */
export const commandNameLimit = 80;

export function outsideName(value: string, maximum = commandNameLimit): string {
  return cleanOutsideName(value, maximum).replace(/[“”„"«»]/gu, "'") || "(no name)";
}
