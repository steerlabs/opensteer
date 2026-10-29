import {
  ModelIdSchema,
  ModelProviderIdSchema,
  OpensteerError,
  canonicalModelReference,
  type ModelSelection,
} from "@opensteer/core";
import { reasoningEffortLabel, type HarnessModelDescriptor } from "@opensteer/harness";

/**
 * Cursor's CLI names models with one flat id per variant: the reasoning
 * effort, the thinking mode and the "fast" pool are suffixes baked into the
 * id, and `--model` accepts nothing else. The bracketed parameter form the
 * CLI's own tip advertises (`claude-opus-4-8[effort=high]`) is refused in
 * print mode — verified 2026-09-17 against 2026.09.15-d2fe57e, which answered
 * "Cannot use this model: claude-4.6-opus[thinking=true,effort=high]" and
 * exited 1 before contacting a model. So the driver never synthesizes an id:
 * it groups the listing into one descriptor per base id and keeps the exact
 * listed id for every combination it offers.
 *
 * The suffix order is not uniform either — `claude-opus-4-8-thinking-high`
 * and `claude-4.6-opus-high-thinking` are both in one listing — so suffixes
 * are stripped from the end in any order and the tuple, not the spelling, is
 * the key.
 */
export interface CursorModelVariant {
  readonly displayName: string;
  readonly effort: string | undefined;
  readonly fast: boolean;
  readonly id: string;
  /** The listing marks exactly one id `(default)`. */
  readonly isListedDefault: boolean;
  readonly thinking: boolean;
}

export interface CursorModelBase {
  readonly baseId: string;
  /** The variant a selection that names no options resolves to: the first listed. */
  readonly defaultVariant: CursorModelVariant;
  readonly variants: readonly CursorModelVariant[];
}

export interface CursorModelListing {
  readonly bases: readonly CursorModelBase[];
}

/** The effort a value of `default` stands for: the id with no effort suffix. */
export const cursorDefaultEffortValue = "default";

/**
 * Longest first, because `gpt-5.5-extra-high` and `gpt-5.6-sol-xhigh` are both
 * in one listing and a shortest-match strip would leave a phantom base
 * `gpt-5.5-extra`.
 */
const cursorEffortTokens = [
  "extra-high",
  "minimal",
  "medium",
  "xhigh",
  "none",
  "high",
  "low",
  "max",
] as const;

/** How the picker orders efforts, weakest first. */
const cursorEffortOrder = [
  cursorDefaultEffortValue,
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "extra-high",
  "max",
];

/**
 * Cursor's own older spellings of Anthropic ids. The canonical pair has to
 * match what every other engine reports for the same model, and Cursor kept
 * `claude-4.6-opus` where Anthropic says `claude-opus-4-6`; the newer entries
 * in the same listing (`claude-opus-4-8`) already agree, so this is a closed
 * table of the legacy ones rather than a rewriting rule.
 */
const cursorLegacyModelIds: Readonly<Record<string, string>> = {
  "claude-4-sonnet": "claude-sonnet-4",
  "claude-4.5-opus": "claude-opus-4-5",
  "claude-4.5-sonnet": "claude-sonnet-4-5",
  "claude-4.6-opus": "claude-opus-4-6",
  "claude-4.6-sonnet": "claude-sonnet-4-6",
};

export function canonicalCursorModelId(baseId: string): string {
  return cursorLegacyModelIds[baseId] ?? baseId;
}

/** Words the display name repeats from the id's option suffixes. */
const cursorDisplayOptionWords = new Set([
  "extra",
  "fast",
  "high",
  "low",
  "max",
  "medium",
  "minimal",
  "none",
  "thinking",
  "xhigh",
]);

/**
 * Parses `agent models`. The listing is a heading, one `<id> - <display name>`
 * line per variant, and a closing tip; the id nearest the top of a base's
 * group is the one a selection with no options resolves to, because that is
 * the order Cursor itself presents them in.
 */
export function parseCursorModelListing(output: string): CursorModelListing {
  const bases = new Map<string, CursorModelVariant[]>();
  const seenIds = new Set<string>();
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    const match = /^(\S+) - (.+)$/u.exec(line);
    if (!match) continue;
    const id = match[1];
    const rawName = match[2];
    if (!id || !rawName || id.startsWith("-")) continue;
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    // The tip line ends with an example invocation, never an id definition.
    if (line.startsWith("Tip:")) continue;
    const isListedDefault = rawName.endsWith(" (default)");
    const displayName = rawName.replace(/ \((?:default|current)\)$/u, "").trim();
    const decomposed = decomposeCursorModelId(id);
    const variants = bases.get(decomposed.baseId) ?? [];
    variants.push({ ...decomposed, displayName, id, isListedDefault });
    bases.set(decomposed.baseId, variants);
  }
  return {
    bases: [...bases].flatMap(([baseId, variants]) => {
      const defaultVariant = variants[0];
      return defaultVariant ? [{ baseId, defaultVariant, variants }] : [];
    }),
  };
}

export function decomposeCursorModelId(id: string): {
  readonly baseId: string;
  readonly effort: string | undefined;
  readonly fast: boolean;
  readonly thinking: boolean;
} {
  let baseId = id;
  let effort: string | undefined;
  let fast = false;
  let thinking = false;
  for (;;) {
    if (!fast && baseId.endsWith("-fast")) {
      fast = true;
      baseId = baseId.slice(0, -"-fast".length);
      continue;
    }
    if (!thinking && baseId.endsWith("-thinking")) {
      thinking = true;
      baseId = baseId.slice(0, -"-thinking".length);
      continue;
    }
    const token = effort
      ? undefined
      : cursorEffortTokens.find(
          (candidate) => baseId.endsWith(`-${candidate}`) && baseId.length > candidate.length + 1,
        );
    if (token) {
      effort = token;
      baseId = baseId.slice(0, -(token.length + 1));
      continue;
    }
    return { baseId, effort, fast, thinking };
  }
}

/**
 * The model families whose makers document image input, by canonical lab.
 *
 * `agent models` states no modalities, and Cursor lists text-only models
 * beside vision ones (GLM, for one), so a listed model is not evidence that it
 * reads a screenshot. Only a family known to read images says so; everything
 * else stays silent, which the Host reads as no images. Codex-Spark is a
 * text-only GPT, and Cursor's own models (placed under xAI with its Grok
 * builds) are not Grok 4.
 */
const cursorVisionFamilies: ReadonlyMap<string, RegExp> = new Map([
  ["anthropic", /^claude-/u],
  ["google", /^gemini-/u],
  ["openai", /^gpt-(?:4o|4\.1|5|6)(?!.*[.-]spark(?:$|[.-]))(?:$|[.-])/u],
  ["xai", /^grok-4(?:$|[.-])/u],
]);

function cursorModelReadsImages(providerId: string, modelId: string): boolean {
  return cursorVisionFamilies.get(providerId)?.test(modelId) ?? false;
}

/**
 * One descriptor per base id. Most bases form a complete Cartesian product,
 * so their reasoning, thinking and fast controls can be shown independently.
 * A sparse base cannot be represented by independent controls without making
 * invalid combinations selectable; it gets one exact variant control instead.
 * Every value still carries an id Cursor itself listed.
 */
export function cursorModelDescriptors(
  listing: CursorModelListing,
  sourceId: string,
): readonly HarnessModelDescriptor[] {
  const descriptors = listing.bases.flatMap((base) => {
    const canonicalId = canonicalCursorModelId(base.baseId);
    const reference = canonicalModelReference(canonicalId, sourceId);
    const modelId = ModelIdSchema.safeParse(reference.modelId);
    const providerId = ModelProviderIdSchema.safeParse(reference.providerId);
    // One unplaceable id is Cursor's problem, never the catalog's: the rest of
    // the listing is still exactly what this account can run.
    if (!modelId.success || !providerId.success) return [];
    return [
      {
        ...(cursorModelReadsImages(providerId.data, modelId.data) ? { acceptsImages: true } : {}),
        displayName: cursorBaseDisplayName(base.defaultVariant),
        isDefault: base.variants.some((variant) => variant.isListedDefault),
        modelId: modelId.data,
        nativeModelId: base.baseId,
        options: cursorModelOptions(base),
        providerId: providerId.data,
      },
    ];
  });
  return descriptors.some((descriptor) => descriptor.isDefault)
    ? descriptors
    : descriptors.map((descriptor, index) => ({ ...descriptor, isDefault: index === 0 }));
}

function cursorModelOptions(base: CursorModelBase): HarnessModelDescriptor["options"] {
  if (!cursorVariantsFormCartesianProduct(base.variants)) {
    const labels = base.variants.map(cursorVariantLabel);
    const labelCounts = new Map<string, number>();
    for (const label of labels) labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
    return [
      {
        defaultValue: base.defaultVariant.id,
        id: "variant",
        label: "Configuration",
        type: "select",
        values: base.variants.map((variant, index) => ({
          label:
            (labelCounts.get(labels[index] ?? "") ?? 0) > 1
              ? `${labels[index]} (${variant.id})`
              : (labels[index] ?? variant.id),
          value: variant.id,
        })),
      },
    ];
  }
  const options: HarnessModelDescriptor["options"][number][] = [];
  const efforts = [
    ...new Set(base.variants.map((variant) => variant.effort ?? cursorDefaultEffortValue)),
  ].sort((left, right) => effortRank(left) - effortRank(right));
  if (efforts.length > 1) {
    options.push({
      defaultValue: base.defaultVariant.effort ?? cursorDefaultEffortValue,
      id: "effort",
      label: "Reasoning",
      type: "select",
      values: efforts.map((value) => ({ label: cursorEffortLabel(value), value })),
    });
  }
  if (new Set(base.variants.map((variant) => variant.thinking)).size > 1) {
    options.push({
      defaultValue: base.defaultVariant.thinking,
      id: "thinking",
      label: "Thinking",
      type: "toggle",
    });
  }
  if (new Set(base.variants.map((variant) => variant.fast)).size > 1) {
    options.push({
      defaultValue: base.defaultVariant.fast,
      id: "fast",
      label: "Fast",
      type: "toggle",
    });
  }
  return options;
}

function cursorVariantsFormCartesianProduct(variants: readonly CursorModelVariant[]): boolean {
  const efforts = new Set(variants.map((variant) => variant.effort ?? cursorDefaultEffortValue));
  const thinking = new Set(variants.map((variant) => variant.thinking));
  const fast = new Set(variants.map((variant) => variant.fast));
  const tuples = new Set(
    variants.map(
      (variant) =>
        `${variant.effort ?? cursorDefaultEffortValue}\0${String(variant.thinking)}\0${String(variant.fast)}`,
    ),
  );
  return (
    tuples.size === variants.length && tuples.size === efforts.size * thinking.size * fast.size
  );
}

function cursorVariantLabel(variant: CursorModelVariant): string {
  const parts = [
    variant.effort === undefined ? undefined : cursorEffortLabel(variant.effort),
    variant.thinking ? "Thinking" : undefined,
    variant.fast ? "Fast" : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.length > 0 ? parts.join(" · ") : "Default";
}

function effortRank(value: string): number {
  const index = cursorEffortOrder.indexOf(value);
  return index === -1 ? cursorEffortOrder.length : index;
}

function cursorEffortLabel(value: string): string {
  if (value === cursorDefaultEffortValue) return "Default";
  if (value === "extra-high") return reasoningEffortLabel("xhigh");
  return reasoningEffortLabel(value);
}

/**
 * The model's name without the words the variant's own suffixes contributed:
 * "Claude Opus 4.7 1M Low Thinking" describes one variant, while the
 * descriptor covers the whole base and its options carry those words already.
 * Only as many trailing words are removed as the id has option tokens, so a
 * name that merely ends in one of them keeps it.
 */
function cursorBaseDisplayName(variant: CursorModelVariant): string {
  const note = /\s*(\([^)]*\))$/u.exec(variant.displayName);
  let name = note ? variant.displayName.slice(0, note.index) : variant.displayName;
  let budget =
    (variant.fast ? 1 : 0) +
    (variant.thinking ? 1 : 0) +
    (variant.effort === undefined
      ? 0
      : variant.effort === "xhigh" || variant.effort === "extra-high"
        ? 2
        : 1);
  while (budget > 0) {
    const trailing = /\s+(\S+)$/u.exec(name);
    if (!trailing?.[1] || !cursorDisplayOptionWords.has(trailing[1].toLowerCase())) break;
    name = name.slice(0, trailing.index);
    budget -= 1;
  }
  const trimmed = name.trim();
  const base = trimmed.length > 0 ? trimmed : variant.displayName;
  return note?.[1] ? `${base} ${note[1]}` : base;
}

/**
 * The exact `--model` argument for one selection. Every dimension the
 * selection leaves out takes the default variant's value, and a combination
 * the listing does not hold is refused rather than approximated: Cursor
 * answers an unknown id by exiting 1 with its whole catalog on stderr, which
 * is a Run that failed for no reason a reader could act on.
 */
export function cursorModelArgument(
  listing: CursorModelListing,
  selection: Pick<ModelSelection, "modelId" | "nativeModelId" | "options">,
): string {
  const requested = selection.nativeModelId ?? selection.modelId;
  const base = listing.bases.find((candidate) => candidate.baseId === requested);
  if (!base) {
    const exact = listing.bases
      .flatMap((candidate) => candidate.variants)
      .find((variant) => variant.id === requested);
    // A selection made before this account's catalog was last read may still
    // name a full variant id; it is a model Cursor can run, so it is sent.
    if (exact && Object.keys(selection.options).length === 0) return exact.id;
    throw new OpensteerError({
      code: "bad_request",
      message: `Cursor does not offer the model ${requested}`,
    });
  }
  const descriptors = cursorModelOptions(base);
  const sparse = descriptors.length === 1 && descriptors[0]?.id === "variant";
  if (sparse && selection.options.variant === undefined) {
    const legacyOptions = new Set(["effort", "thinking", "fast"]);
    const unknownOption = Object.keys(selection.options).find(
      (option) => !legacyOptions.has(option),
    );
    if (unknownOption) throw cursorUnsupportedOption(requested, unknownOption);
    assertLegacyCursorOptionTypes(requested, selection.options);
    return resolveCursorTuple(base, requested, selection.options);
  }
  const allowedOptions = new Set(descriptors.map((option) => option.id));
  const unknownOption = Object.keys(selection.options).find(
    (option) => !allowedOptions.has(option),
  );
  if (unknownOption) throw cursorUnsupportedOption(requested, unknownOption);
  const variant = optionString(selection.options.variant);
  if (variant !== undefined) {
    const exact = base.variants.find((candidate) => candidate.id === variant);
    if (exact) return exact.id;
    throw new OpensteerError({
      code: "bad_request",
      message: `Cursor does not offer the variant ${variant} for ${requested}`,
    });
  }
  if (selection.options.variant !== undefined) {
    throw cursorInvalidOptionValue(requested, "variant");
  }
  for (const descriptor of descriptors) {
    if (!(descriptor.id in selection.options)) continue;
    const value = selection.options[descriptor.id];
    const valid =
      descriptor.type === "toggle"
        ? typeof value === "boolean"
        : typeof value === "string" &&
          descriptor.values.some((candidate) => candidate.value === value);
    if (!valid) throw cursorInvalidOptionValue(requested, descriptor.id);
  }
  return resolveCursorTuple(base, requested, selection.options);
}

function resolveCursorTuple(
  base: CursorModelBase,
  requested: string,
  options: Readonly<Record<string, unknown>>,
): string {
  const effort =
    optionString(options.effort) ?? base.defaultVariant.effort ?? cursorDefaultEffortValue;
  const thinking = optionBoolean(options.thinking) ?? base.defaultVariant.thinking;
  const fast = optionBoolean(options.fast) ?? base.defaultVariant.fast;
  const match = base.variants.find(
    (variant) =>
      (variant.effort ?? cursorDefaultEffortValue) === effort &&
      variant.thinking === thinking &&
      variant.fast === fast,
  );
  if (!match) {
    throw new OpensteerError({
      code: "bad_request",
      message: `Cursor does not offer ${requested} with reasoning ${effort}, thinking ${String(thinking)}, fast ${String(fast)}`,
    });
  }
  return match.id;
}

function assertLegacyCursorOptionTypes(
  requested: string,
  options: Readonly<Record<string, unknown>>,
): void {
  const invalid = ["effort", "thinking", "fast"].find((id) => {
    const value = options[id];
    if (value === undefined) return false;
    return id === "effort"
      ? typeof value !== "string" || value.length === 0
      : typeof value !== "boolean";
  });
  if (invalid) throw cursorInvalidOptionValue(requested, invalid);
}

function cursorUnsupportedOption(requested: string, option: string): OpensteerError {
  return new OpensteerError({
    code: "bad_request",
    message: `Cursor does not offer the option ${option} for ${requested}`,
  });
}

function cursorInvalidOptionValue(requested: string, option: string): OpensteerError {
  return new OpensteerError({
    code: "bad_request",
    message: `Cursor does not accept the value of option ${option} for ${requested}`,
  });
}

function optionString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
