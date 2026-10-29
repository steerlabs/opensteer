/**
 * The headline and snapshot header of an observation.
 *
 * Line 1 is the headline: what happened, in the words a person uses —
 * `Clicked "Save", then typed "Venue shortlist" into "Title"` — and, when the
 * batch stopped, why: `Stopped. The observed window closed.` The
 * reason is stated here once, so the notes after the tree only name the next
 * step and a client can say why a step stopped. Line 2 is the
 * observation header that binds indices and coordinates to one snapshot, and
 * the tree follows. The Host writes both with `formatComputerUseResultHead`;
 * a client reads the headline back with `readComputerUseResultHeadline` to
 * title the step, because tool output is persisted as text and the transcript
 * on web, desktop and mobile should say what the agent did rather than name
 * the gateway tool it called. Both halves live here so the format has one
 * owner and one test.
 */

export interface ComputerUseResultHeadInput {
  readonly appName: string;
  readonly elementCount: number;
  readonly geometry: { readonly height: number; readonly width: number };
  readonly snapshot: string;
  /** Null for `observe`; each completed action's description for `act`. */
  readonly performed: readonly string[] | null;
  /** The helper's sentence for why an act stopped, or null when it did not. */
  readonly stoppedBecause: string | null;
  readonly truncated: boolean;
  readonly windowTitle: string | null;
}

/** Long enough for three actions; a transcript row shows one line of it. */
export const computerUseHeadlineMaxLength = 240;
/** Actions named before the rest are counted instead. */
const namedActions = 3;

export function formatComputerUseResultHead(input: ComputerUseResultHeadInput): string {
  const header = [
    `Observation ${input.snapshot} of ${oneLine(input.appName)}`,
    input.windowTitle ? ` (${oneLine(input.windowTitle)})` : "",
    ` — ${input.elementCount} elements`,
    input.truncated ? ", truncated" : "",
    `. Screenshot ${input.geometry.width}×${input.geometry.height} px; all coordinates are screenshot pixels.`,
  ].join("");
  return `${computerUseHeadline(input)}\n${header}`;
}

/**
 * What a call did. An observation names the app it looked at; an act names
 * its actions only, because the app is already named by the observation
 * header beneath it and by the transcript row the step sits in.
 */
export function computerUseHeadline(
  input: Pick<ComputerUseResultHeadInput, "appName" | "performed" | "stoppedBecause">,
): string {
  return input.performed === null
    ? clip(`Looked at ${input.appName}`)
    : computerUseActHeadline({ performed: input.performed, stoppedBecause: input.stoppedBecause });
}

/**
 * What an act did, and why it stopped when it did: the first line of every
 * act result, with or without an observation to follow it.
 */
export function computerUseActHeadline(
  input: Pick<ComputerUseResultHeadInput, "stoppedBecause"> & {
    readonly performed: readonly string[];
  },
): string {
  const { performed, stoppedBecause } = input;
  const reason = stoppedBecause === null ? "" : ` ${stoppedBecause}`;
  if (performed.length === 0) return clip(`Stopped.${reason}`);
  const named = performed
    .slice(0, namedActions)
    .map((entry, index) => (index === 0 ? entry : lowerFirst(entry)));
  const rest = performed.length - named.length;
  const actions =
    named.join(", then ") + (rest > 0 ? `, and ${rest} more action${rest === 1 ? "" : "s"}` : "");
  return clip(stoppedBecause === null ? actions : `${actions}, then stopped.${reason}`);
}

/**
 * The headline of a result this module formatted, or null for any other text.
 *
 * It is recognized by its second line, the observation header, so a result
 * from any other tool never borrows a computer-use title.
 */
export function readComputerUseResultHeadline(text: string): string | null {
  const [headline, header] = text.split("\n", 2);
  if (!headline || !header || !observationHeader.test(header)) return null;
  return headline;
}

/**
 * Only for Host-recorded computer.<operation> steps with a trusted integration
 * subject. Their Host-authored headline needs no observation-header guard.
 */
export function readComputerStepHeadline(text: string): string {
  return (text.split("\n", 1)[0] ?? "").slice(0, computerUseHeadlineMaxLength);
}

const observationHeader = /^Observation \S+ of .+ — \d+ elements(?:, truncated)?\. Screenshot /u;

function lowerFirst(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
}

/** Titles are the app's own text, which can hold line breaks. */
function oneLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function clip(value: string): string {
  const single = oneLine(value);
  return single.length <= computerUseHeadlineMaxLength
    ? single
    : `${single.slice(0, computerUseHeadlineMaxLength - 1)}…`;
}
