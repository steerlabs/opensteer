import "@fontsource-variable/inter/wght.css";
import "@fontsource-variable/fraunces/wght.css";
import "./styles/index.css";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import {
  ModelSelectionSchema,
  PlaceContentPartSchema,
  ThreadAccessModeSchema,
  emptyExecutionPreferences,
  type ThreadAccessMode,
} from "@opensteer/core";
import { HarnessModelDescriptorSchema, type HarnessModelDescriptor } from "@opensteer/protocol";
import {
  HostClientRequestError,
  accessModeConflict,
  selectionForModel,
  type ExecutionSelection,
  type ThreadPlacementOption,
} from "@opensteer/client/host";
import { MockHostClient } from "@opensteer/client/mock";
import { Composer } from "./components/composer.js";
import { ExecutionControls } from "./components/execution-controls.js";
import { useComposerContext } from "./components/workspace/composer-context.js";
import { ToastProvider } from "./components/toast.js";

/**
 * One-control composer QA failure modes (written before implementing checks):
 * SPILL: a control escapes the composer, overlaps another, or is clipped by an
 * overflow ancestor. WRAP: Attach, settings, Stop and Send leave the trailing
 * action's line (Stop is the anchor when Send is absent; draft text is excluded).
 * CLUSTER: a wordless settings control sits beside another settings control.
 * FRAGMENT: a truncated visible label is narrower than 72px; naturally short
 * complete words are valid. ORDER: a later stage folds before an earlier stage.
 * WASTE: the last folded stage fits unfolded, with its shortening floor tried.
 * SQUEEZE: conversation field content cannot hold the plain placeholder (its
 * floor) before the field's stage folds. FLOOR: at a phone's width (296px and
 * up) the field gives up that floor although only one of Stop and Send is
 * present.
 * CUT PLACEHOLDER: the placeholder spills its field, or, while the floor did
 * not have to fold, is not the longest whole form that fits ("about this page"
 * wherever it fits, else the plain form). UNNAMED: a pill has neither an
 * aria-label nor a title. TOUCH: a footer control is below 44×44 under hover:none.
 * HIDDEN STATE: a blocked choice is not unavailable on the primary, or an access
 * conflict is absent from the composer's send-blocked reason.
 *
 * Both variants cover single/multiple accounts, default/non-default/conflicting
 * access, signed-out/missing choices, long names, required Choose AI, no accounts,
 * running empty/with an attachment, recipient/context placeholders, many options
 * and a default-true toggle. Both span 760–180px. 256px is the narrowest
 * composer any device gives (a 280px folding-phone cover screen, less the
 * composer's margins), so failures below it are reported apart from those at
 * device widths, and never as passes: there, four 44px touch targets alone
 * need 176px plus padding, and Attach, the control's mark and Send leave a
 * conversation no room for a readable placeholder. Live resize in both
 * directions and fixed-width content changes must refit without remounting
 * the composer.
 * window.composerQa publishes every frame and failure for the picker journey.
 */

const client = new MockHostClient({ latencyMs: 0 });
const conversationWidths = [
  760, 620, 520, 460, 420, 380, 366, 340, 316, 296, 280, 256, 220, 180,
] as const;
const widths = [760, 620, 520, 460, 420, 380, 340, 300, 256, 220, 180] as const;
/** The narrowest composer any device gives; see the failure modes above. */
const deviceMinimum = 256;

const effort = (values: readonly (readonly [string, string])[], defaultValue: string) => ({
  defaultValue,
  id: "effort",
  label: "Reasoning",
  type: "select" as const,
  values: values.map(([value, label]) => ({ label, value })),
});

const gpt = model({
  displayName: "GPT-5.5",
  modelId: "gpt-5.5",
  options: [
    effort(
      [
        ["low", "Low"],
        ["medium", "Medium"],
        ["high", "High"],
        ["xhigh", "Extra high"],
      ],
      "medium",
    ),
  ],
  providerId: "openai",
});
const opus = model({
  displayName: "Claude Opus 4.1 (1M context)",
  modelId: "claude-opus-4-1-1m",
  options: [
    effort(
      [
        ["default", "Default"],
        ["low", "Low"],
        ["medium", "Medium"],
        ["high", "High"],
        ["max", "Max"],
      ],
      "default",
    ),
    { defaultValue: false, id: "fast", label: "Fast mode", type: "toggle" },
  ],
  providerId: "anthropic",
});
const gptMini = model({
  displayName: "GPT-5.5 mini",
  modelId: "gpt-5.5-mini",
  options: [],
  providerId: "openai",
});
const sonnet = model({
  displayName: "Claude Sonnet 5",
  modelId: "claude-sonnet-5",
  options: [],
  providerId: "anthropic",
});
const kimi = model({
  displayName: "Kimi K2",
  modelId: "kimi-k2",
  options: [{ defaultValue: true, id: "fast", label: "Fast", type: "toggle" }],
  providerId: "moonshot",
});

const codexPersonal = placement("Codex", "hin-codex-personal", [gpt], {
  observedConnections: [connection("Codex", "alex@example.com", "Plus")],
});
const codexWork = placement("Codex", "hin-codex-work", [gpt], {
  accountName: "Codex 2",
  defaultAccount: false,
  observedConnections: [connection("Codex", "alex@company.example", "Team")],
});
const claudePersonal = placement("Claude Code", "hin-claude-personal", [opus, sonnet], {
  observedConnections: [connection("Claude Code", "alex@personal.example", "Max")],
});
const claudeWork = placement("Claude Code", "hin-claude-work", [opus, sonnet], {
  accountName: "Claude Code 2",
  defaultAccount: false,
  observedConnections: [connection("Claude Code", "alex@work.example", "Team")],
});
const codexPersonalWithMini = placement("Codex", "hin-codex-personal", [gpt, gptMini], {
  observedConnections: [connection("Codex", "alex@example.com", "Plus")],
});
const cursor = placement("Cursor", "hin-cursor", [opus], {
  environmentId: "environment-laptop",
  whereLabel: "Laptop",
});
const opencode = placement("OpenCode", "hin-opencode", [kimi]);
const codexSignedOut = placement("Codex", "hin-codex-signed-out", [gpt], {
  availability: "authentication-required",
  available: false,
  detail: "Sign in to Codex to use this account",
});

interface Scenario {
  readonly attachedContext?: boolean;
  readonly attachment?: boolean;
  readonly recipient?: boolean;
  readonly required?: boolean;
  readonly blocked?: ExecutionSelection;
  readonly draft?: string;
  /** Sends once on arrival and has the Host refuse it, so the error line shows. */
  readonly error?: boolean;
  readonly id: string;
  readonly mode: ThreadAccessMode;
  readonly placements: readonly ThreadPlacementOption[];
  readonly running?: boolean;
  readonly selection: ExecutionSelection | null;
  readonly title: string;
}

const manyOptions = model({
  displayName: "GPT with many option descriptors",
  modelId: "many-options",
  providerId: "openai",
  options: [
    ...gpt.options,
    ...Array.from({ length: 8 }, (_, index) => ({
      id: `option-${index}`,
      label: `Additional option ${index + 1}`,
      type: "toggle" as const,
      defaultValue: false,
    })),
  ],
});
const manyPlacement = placement("Codex", "hin-many", [manyOptions]);
const limited = placement("Cursor", "hin-limited", [opus], {
  accessModes: ["full-access", "approval-required"],
});
const contextPage = PlaceContentPartSchema.parse({
  type: "browser-page",
  sessionId: "bsn_00000000-0000-4000-8000-000000000001",
  tabId: "tab-qa",
  title: "QA reference page",
  url: "https://example.com/qa",
});

const scenarios: readonly Scenario[] = [
  {
    id: "four",
    mode: "full-access",
    placements: [codexPersonal, codexWork],
    selection: select(codexPersonal, gpt, { effort: "xhigh" }),
    title: "Multiple accounts, default access and reasoning summary",
  },
  {
    id: "long",
    mode: "auto-accept-edits",
    placements: [claudePersonal, claudeWork, cursor],
    selection: select(claudeWork, opus, { effort: "default", fast: true }),
    title: "Long names: a model two engines offer, long emails, engine-default reasoning",
  },
  {
    id: "two",
    mode: "approval-required",
    placements: [claudePersonal],
    selection: select(claudePersonal, sonnet, {}),
    title: "Single account, no model options, Supervised access",
  },
  {
    draft: "Also check the second listing",
    id: "running",
    mode: "auto",
    placements: [codexPersonal, codexWork],
    running: true,
    selection: select(codexWork, gpt, { effort: "high" }),
    title: "Running with a draft: Stop and Send both in the row",
  },
  {
    draft: "Try this again",
    error: true,
    id: "error",
    mode: "full-access",
    placements: [codexPersonal, codexWork],
    selection: select(codexPersonal, gpt, { effort: "low" }),
    title: "A refused send: the error takes its own line, not the controls' row",
  },
  {
    id: "refused",
    mode: "auto",
    placements: [codexPersonalWithMini, codexWork],
    selection: select(codexPersonalWithMini, gptMini, {}),
    title: "A model only one account offers: the other is listed and refused",
  },
  {
    blocked: select(codexSignedOut, gpt, {}),
    id: "blocked",
    mode: "full-access",
    placements: [codexSignedOut, claudePersonal],
    selection: null,
    title: "The chosen model cannot run: the pill stays red at every width",
  },
  {
    id: "toggles",
    mode: "full-access",
    placements: [opencode],
    selection: select(opencode, kimi, {}),
    title: "Default-true toggle: Fast is on without an explicit override",
  },
  {
    id: "single",
    title: "Single account and default Full access",
    mode: "full-access",
    placements: [codexPersonal],
    selection: select(codexPersonal, gpt, {}),
  },
  {
    id: "conflict",
    title: "Draft engine cannot enforce Auto",
    mode: "auto",
    placements: [limited],
    selection: select(limited, opus, {}),
  },
  {
    id: "missing",
    title: "Blocked choice: its placement disappeared",
    mode: "full-access",
    placements: [claudePersonal],
    selection: null,
    blocked: select(codexPersonal, gpt, {}),
  },
  {
    id: "choose",
    title: "Required Choose AI, nothing selected",
    mode: "full-access",
    placements: [codexPersonal],
    selection: null,
    required: true,
  },
  {
    id: "zero",
    title: "No accounts connected",
    mode: "full-access",
    placements: [],
    selection: null,
  },
  {
    id: "running-empty",
    title: "Running, no draft: Stop replaces Send",
    mode: "full-access",
    placements: [codexPersonal],
    selection: select(codexPersonal, gpt, {}),
    running: true,
  },
  {
    id: "running-attachment",
    title: "Running with an attachment: Stop, Send and placeholder",
    mode: "full-access",
    placements: [codexPersonal],
    selection: select(codexPersonal, gpt, {}),
    running: true,
    attachment: true,
  },
  {
    id: "recipient",
    title: "Recipient placeholder: Ask Opensteer…",
    mode: "full-access",
    placements: [codexPersonal],
    selection: select(codexPersonal, gpt, {}),
    recipient: true,
  },
  {
    id: "context",
    title: "Recipient with attached page context",
    mode: "full-access",
    placements: [codexPersonal],
    selection: select(codexPersonal, gpt, {}),
    recipient: true,
    attachedContext: true,
  },
  {
    id: "many",
    title: "Many option descriptors",
    mode: "full-access",
    placements: [manyPlacement],
    selection: select(
      manyPlacement,
      manyOptions,
      Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`option-${index}`, true])),
    ),
  },
];

function App(): ReactNode {
  return (
    <main className="composer-visual">
      <header className="composer-visual__head">
        <h1>Composer controls at every width</h1>
        <p className="composer-visual__summary" id="qa-summary">
          Checking…
        </p>
      </header>
      <LiveFrame />
      {(["work", "conversation"] as const).map((variant) => (
        <section className="composer-visual__scenario" key={variant}>
          <h2>{variant === "work" ? "Work composer" : "Conversation composer"}</h2>
          {scenarios.map((scenario) => (
            <section className="composer-visual__scenario" key={scenario.id}>
              <h2>{scenario.title}</h2>
              {(variant === "work" ? widths : conversationWidths).map((width) => (
                <Frame key={width} scenario={scenario} variant={variant} width={width} />
              ))}
            </section>
          ))}
        </section>
      ))}
    </main>
  );
}

type Variant = "work" | "conversation";

function Frame({
  scenario,
  variant,
  width,
}: {
  scenario: Scenario;
  variant: Variant;
  width: number;
}): ReactNode {
  return (
    <figure
      className="qa-frame"
      data-qa={`${variant}/${scenario.id}@${width}`}
      data-scenario={scenario.id}
      data-variant={variant}
      style={{ width }}
    >
      <figcaption>
        <span>{width}px</span>
        <span className="qa-verdict" />
      </figcaption>
      <ScenarioComposer scenario={scenario} variant={variant} />
    </figure>
  );
}

function ScenarioComposer({
  scenario,
  variant,
}: {
  scenario: Scenario;
  variant: Variant;
}): ReactNode {
  const [selection, setSelection] = useState(scenario.selection);
  const [mode, setMode] = useState(scenario.mode);
  useEffect(() => setSelection(scenario.selection), [scenario.selection]);
  const context = useComposerContext({ auto: false, hostClient: client });
  const restore = useMemo(
    () => ({
      key: 1,
      text: scenario.draft ?? "",
      ...(scenario.attachedContext ? { places: [contextPage] } : {}),
    }),
    [scenario.draft, scenario.attachedContext],
  );
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !scenario.attachment) return;
    const input = root.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) return;
    const transfer = new DataTransfer();
    transfer.items.add(new File(["Composer QA attachment"], "qa-note.txt", { type: "text/plain" }));
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, [scenario.attachment]);
  useEffect(() => {
    if (!scenario.error) return;
    const timer = window.setTimeout(() => {
      rootRef.current?.querySelector<HTMLButtonElement>(".composer__send")?.click();
    }, 60);
    return () => window.clearTimeout(timer);
  }, [scenario.error]);
  const placements = scenario.placements;
  const current = placements.find(
    (candidate) => candidate.harnessInstanceId === selection?.harnessInstanceId,
  );
  const conflict = current ? accessModeConflict(mode, current) : null;
  const blockedReason =
    conflict ??
    (scenario.blocked
      ? "The chosen AI is unavailable. Choose another AI to start."
      : placements.length === 0
        ? "Connect an AI account to start."
        : null);
  // Longest first; the last is the floor the field keeps room for.
  const placeholderForms = scenario.recipient
    ? [...(scenario.attachedContext ? ["Ask Opensteer about this page…"] : []), "Ask Opensteer…"]
    : [variant === "conversation" ? "Ask Opensteer…" : "Reply…"];
  return (
    <div
      ref={rootRef}
      data-placeholder-forms={placeholderForms.join("\n")}
      data-access-conflict={conflict ?? undefined}
      data-blocked-choice={scenario.blocked ? "" : undefined}
    >
      <Composer
        attachments={{
          client,
          scope: `qa/${scenario.id}`,
          workspaceId: client.getSnapshot().workspaces[0]!.id,
        }}
        placeContext={scenario.attachedContext ? { context, hostClient: client } : null}
        onSend={async () => {
          if (scenario.error)
            throw new HostClientRequestError({
              code: "unsupported",
              message:
                "The model this thread runs on does not accept images. Remove the image or switch to a model that does.",
              status: 422,
            });
        }}
        onStop={scenario.running ? async () => undefined : undefined}
        placeholder={variant === "conversation" ? "Ask Opensteer…" : "Reply…"}
        recipient={scenario.recipient ? { lead: "Ask", name: "Opensteer" } : null}
        restore={restore}
        running={scenario.running ?? false}
        sendBlocked={blockedReason}
        settingsRequired={scenario.required ?? false}
        variant={variant}
        footerExtras={
          <ExecutionControls
            access={{ engine: current ?? null, mode, onApply: setMode }}
            blocked={scenario.blocked ?? null}
            onApply={(next) => setSelection(next)}
            placements={placements}
            preferences={emptyExecutionPreferences}
            required={scenario.required ?? false}
            selection={selection}
          />
        }
      />
    </div>
  );
}

/** One frame whose width and content change in place. */
function LiveFrame(): ReactNode {
  const [longModel, setLongModel] = useState(false);
  const [twoAccounts, setTwoAccounts] = useState(true);
  const [running, setRunning] = useState(false);
  const [errorKey, setErrorKey] = useState(0);
  const placements = longModel
    ? twoAccounts
      ? [claudePersonal, claudeWork, cursor]
      : [claudePersonal, cursor]
    : twoAccounts
      ? [codexPersonal, codexWork]
      : [codexPersonal];
  const selection = longModel
    ? select(claudePersonal, opus, { effort: "high" })
    : select(codexPersonal, gpt, { effort: "xhigh" });
  const scenario: Scenario = {
    error: errorKey > 0,
    id: `live-${longModel}-${twoAccounts}-${errorKey}`,
    mode: "full-access",
    placements,
    running,
    selection,
    title: "Live",
    ...(errorKey > 0 || running ? { draft: "A draft" } : {}),
  };
  const frameRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const observer = new ResizeObserver(scheduleCheck);
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);
  return (
    <section className="composer-visual__scenario">
      <h2>Live: drag the corner to resize, change what the row holds</h2>
      <div className="composer-visual__toggles">
        <label>
          <input
            checked={longModel}
            onChange={(event) => setLongModel(event.target.checked)}
            type="checkbox"
          />
          Long model name
        </label>
        <label>
          <input
            checked={twoAccounts}
            onChange={(event) => setTwoAccounts(event.target.checked)}
            type="checkbox"
          />
          Second account
        </label>
        <label>
          <input
            checked={running}
            onChange={(event) => setRunning(event.target.checked)}
            type="checkbox"
          />
          Running
        </label>
        <button
          className="btn btn--small"
          onClick={() => setErrorKey((key) => key + 1)}
          type="button"
        >
          Refuse a send
        </button>
      </div>
      <figure
        className="qa-frame qa-frame--live"
        data-qa="live"
        ref={frameRef}
        data-variant="conversation"
        style={{ width: 420 }}
      >
        <figcaption>
          <span>live</span>
          <span className="qa-verdict" />
        </figcaption>
        <ScenarioComposer scenario={scenario} variant="conversation" />
      </figure>
    </section>
  );
}

/* ---- Checks ---- */

interface FrameVerdict {
  readonly failures: readonly string[];
  readonly folded: readonly number[];
  readonly frame: string;
  readonly width: number;
  readonly variant: string;
}

function visible(element: HTMLElement): boolean {
  return element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
}

function footerControls(frame: HTMLElement): HTMLElement[] {
  return [
    ...frame.querySelectorAll<HTMLElement>(
      ".composer__attach, .composer__settings button, .composer__stop, .composer__send",
    ),
  ].filter(visible);
}

function overlaps(left: DOMRect, right: DOMRect): boolean {
  return (
    Math.min(left.right, right.right) - Math.max(left.left, right.left) > 0.5 &&
    Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top) > 0.5
  );
}

function outside(rect: DOMRect, bounds: DOMRect): boolean {
  return (
    rect.left < bounds.left - 0.5 ||
    rect.right > bounds.right + 0.5 ||
    rect.top < bounds.top - 0.5 ||
    rect.bottom > bounds.bottom + 0.5
  );
}

function checkFrame(frame: HTMLElement): FrameVerdict {
  const failures: string[] = [];
  const composer = frame.querySelector<HTMLElement>(".composer")!;
  const bounds = composer.getBoundingClientRect();
  const controls = footerControls(frame);
  const action =
    frame.querySelector<HTMLElement>(".composer__send, .composer__stop") ?? controls.at(-1);
  const trailing = frame.querySelector<HTMLElement>(".composer__send") ?? action;
  for (const control of controls) {
    const rect = control.getBoundingClientRect();
    if (outside(rect, bounds))
      failures.push(
        `SPILL: ${nameOf(control)} outside composer (${rect.left.toFixed(1)}–${rect.right.toFixed(1)} vs ${bounds.left.toFixed(1)}–${bounds.right.toFixed(1)})`,
      );
    for (let ancestor = control.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const css = getComputedStyle(ancestor);
      const box = ancestor.getBoundingClientRect();
      const clipsX = /hidden|clip|auto|scroll/.test(css.overflowX);
      const clipsY = /hidden|clip|auto|scroll/.test(css.overflowY);
      if (
        (clipsX && (rect.left < box.left - 0.5 || rect.right > box.right + 0.5)) ||
        (clipsY && (rect.top < box.top - 0.5 || rect.bottom > box.bottom + 0.5))
      ) {
        failures.push(`SPILL: ${nameOf(control)} clipped by .${ancestor.className}`);
        break;
      }
    }
    if (trailing && !overlapsVertically(rect, trailing.getBoundingClientRect()))
      failures.push(`WRAP: ${nameOf(control)} is off the trailing action's line`);
    if (matchMedia("(hover: none)").matches && (rect.width < 44 || rect.height < 44))
      failures.push(
        `TOUCH: ${nameOf(control)} is ${rect.width.toFixed(1)}×${rect.height.toFixed(1)}`,
      );
  }
  for (const [index, left] of controls.entries()) {
    for (const right of controls.slice(index + 1)) {
      if (overlaps(left.getBoundingClientRect(), right.getBoundingClientRect()))
        failures.push(`SPILL: ${nameOf(left)} overlaps ${nameOf(right)}`);
    }
  }
  const pills = [...frame.querySelectorAll<HTMLElement>(".exec-pill, .exec-choose")].filter(
    visible,
  );
  for (const pill of pills) {
    if (pill.classList.contains("exec-pill") && !pill.getAttribute("aria-label") && !pill.title)
      failures.push(`UNNAMED: ${pill.textContent}`);
    const words = [
      ...pill.querySelectorAll<HTMLElement>(
        ".exec-pill__engine, .exec-pill__label, .exec-pill__summary, .exec-pill__meta",
      ),
    ].some((part) => visible(part) && /[\p{L}\p{N}]/u.test(part.textContent ?? ""));
    if (pills.length > 1 && !words && !pill.classList.contains("exec-choose"))
      failures.push(`CLUSTER: ${nameOf(pill)} has no words beside another settings control`);
  }
  for (const label of frame.querySelectorAll<HTMLElement>(
    ".exec-pill__engine, .exec-pill__label, .exec-pill__summary, .exec-pill__meta",
  )) {
    if (
      visible(label) &&
      label.scrollWidth > label.clientWidth &&
      label.getBoundingClientRect().width < 72
    )
      failures.push(
        `FRAGMENT: "${label.textContent}" shows ${label.getBoundingClientRect().width.toFixed(1)}px`,
      );
  }
  const parts = [...frame.querySelectorAll<HTMLElement>("[data-fold]")];
  const folded = parts.filter((part) => part.hasAttribute("data-folded")).map(stageOf);
  const open = parts.filter((part) => !part.hasAttribute("data-folded")).map(stageOf);
  if (folded.length && open.length && Math.max(...folded) > Math.min(...open))
    failures.push(`ORDER: stage ${Math.max(...folded)} folded before ${Math.min(...open)}`);
  const row = frame.querySelector<HTMLElement>("[data-fold-row]");
  const field = frame.querySelector<HTMLTextAreaElement>("textarea")!;
  const last = Math.max(...folded);
  const fieldCss = getComputedStyle(field);
  const canvas = document.createElement("canvas").getContext("2d")!;
  canvas.font = fieldCss.font;
  const measure = (text: string) => canvas.measureText(text).width;
  const fieldStage = Number(field.dataset.fold);
  let floorHadToFold = field.hasAttribute("data-folded");
  if (row && folded.length) {
    const lastParts = parts.filter((part) => stageOf(part) === last);
    const saved = lastParts.map((part) => [part, part.getAttribute("style")] as const);
    try {
      const fieldFloor = field.dataset.foldText
        ? Math.ceil(
            measure(field.dataset.foldText) +
              parseFloat(fieldCss.paddingLeft) +
              parseFloat(fieldCss.paddingRight),
          )
        : 0;
      for (const part of lastParts) {
        part.removeAttribute("data-folded");
        const floor = part === field ? fieldFloor : Number(part.dataset.foldFloor);
        if (floor) {
          if (part !== field) part.style.maxWidth = `${floor}px`;
          part.style.minWidth = `${floor}px`;
        }
      }
      const now = footerControls(frame);
      const fits =
        (last !== fieldStage || field.getBoundingClientRect().width >= fieldFloor) &&
        row.scrollWidth <= row.clientWidth &&
        now.every((control) => !outside(control.getBoundingClientRect(), bounds)) &&
        now.every((left, index) =>
          now
            .slice(index + 1)
            .every(
              (right) => !overlaps(left.getBoundingClientRect(), right.getBoundingClientRect()),
            ),
        );
      if (last === fieldStage) floorHadToFold = !fits;
      if (fits) failures.push(`WASTE: stage ${last} fits unfolded (shortening floor tried)`);
    } finally {
      for (const [part, style] of saved) {
        part.dataset.folded = "";
        if (style === null) part.removeAttribute("style");
        else part.setAttribute("style", style);
      }
    }
  }
  const fixture = frame.querySelector<HTMLElement>("[data-placeholder-forms]")!;
  const forms = fixture.dataset.placeholderForms!.split("\n");
  const plain = forms.at(-1)!;
  const contentWidth =
    field.clientWidth - parseFloat(fieldCss.paddingLeft) - parseFloat(fieldCss.paddingRight);
  const expected = forms.find((form) => measure(form) <= contentWidth) ?? plain;
  if (
    frame.dataset.variant === "conversation" &&
    !field.hasAttribute("data-folded") &&
    contentWidth < measure(plain)
  )
    failures.push(
      `SQUEEZE: field ${contentWidth.toFixed(1)}px < plain placeholder ${measure(plain).toFixed(1)}px`,
    );
  if (
    frame.dataset.variant === "conversation" &&
    bounds.width >= 296 &&
    field.hasAttribute("data-folded") &&
    !(frame.querySelector(".composer__stop") && frame.querySelector(".composer__send"))
  )
    failures.push(`FLOOR: the field gave up its whole placeholder at ${bounds.width}px`);
  if (measure(field.placeholder) > contentWidth)
    failures.push(
      `CUT PLACEHOLDER: "${field.placeholder}" spills; ${contentWidth.toFixed(1)}px available, ${measure(field.placeholder).toFixed(1)}px needed`,
    );
  else if (!floorHadToFold && field.placeholder !== expected)
    failures.push(`CUT PLACEHOLDER: "${field.placeholder}" where "${expected}" fits whole`);
  const primary = frame.querySelector<HTMLElement>('.exec-pill[aria-label^="Engine and model:"]');
  if (
    fixture.hasAttribute("data-blocked-choice") &&
    (!primary?.classList.contains("is-unavailable") ||
      !primary.getAttribute("aria-label")?.endsWith(" (unavailable)") ||
      !primary.getAttribute("aria-description"))
  )
    failures.push(
      "HIDDEN STATE: blocked choice lacks unavailable styling, accessible name or reason",
    );
  const conflict = fixture.dataset.accessConflict;
  if (conflict) {
    const send = frame.querySelector<HTMLButtonElement>(".composer__send");
    const described = send?.getAttribute("aria-describedby");
    const reason = described ? document.getElementById(described)?.textContent : null;
    if (
      !send?.disabled ||
      reason !== conflict ||
      frame.querySelector(".composer__notice")?.textContent !== conflict
    )
      failures.push("HIDDEN STATE: access conflict is not the composer's send-blocked reason");
  }
  if (
    frame.dataset.scenario === "running-attachment" &&
    (!frame.querySelector(".attachment-tray") ||
      !frame.querySelector(".composer__stop") ||
      !frame.querySelector(".composer__send") ||
      field.value ||
      !field.placeholder)
  )
    failures.push(
      "HIDDEN STATE: running attachment requires tray, Stop, Send and empty field with placeholder",
    );
  return {
    failures,
    folded: [...new Set(folded)].sort((a, b) => a - b),
    frame: frame.dataset.qa ?? "",
    width: bounds.width,
    variant: frame.dataset.variant ?? "",
  };
}

function overlapsVertically(left: DOMRect, right: DOMRect): boolean {
  return Math.min(left.bottom, right.bottom) > Math.max(left.top, right.top);
}

function stageOf(part: HTMLElement): number {
  return Number(part.dataset.fold);
}

function nameOf(control: HTMLElement): string {
  return control.getAttribute("aria-label") || control.title || control.textContent || "control";
}

function checkAll(): void {
  const verdicts = [...document.querySelectorAll<HTMLElement>(".qa-frame")].map((frame) => {
    const verdict = checkFrame(frame);
    const badge = frame.querySelector<HTMLElement>(".qa-verdict");
    if (badge) {
      badge.textContent =
        verdict.failures.length > 0
          ? `✕ ${verdict.failures.join(" · ")}`
          : `✓ ${verdict.folded.length === 0 ? "nothing folded" : `folded ${verdict.folded.join(", ")}`}`;
      badge.dataset.pass = String(verdict.failures.length === 0);
    }
    return verdict;
  });
  const failed = verdicts.filter((verdict) => verdict.failures.length > 0);
  const belowDeviceMinimum = failed.filter((verdict) => verdict.width < deviceMinimum);
  const summary = document.getElementById("qa-summary");
  if (summary) {
    summary.textContent =
      failed.length === 0
        ? `All ${verdicts.length} frames pass.`
        : `${failed.length} of ${verdicts.length} frames fail, ${belowDeviceMinimum.length} of them narrower than any device (${deviceMinimum}px).`;
    summary.dataset.pass = String(failed.length === 0);
  }
  Object.assign(window, {
    composerQa: { belowDeviceMinimum, failed, frames: verdicts.length, verdicts },
  });
}

// A timer rather than an animation frame: a scripted run may hold this page in
// a background tab, where frames never come.
let pending = 0;
function scheduleCheck(): void {
  window.clearTimeout(pending);
  pending = window.setTimeout(checkAll, 120);
}

/* ---- Fixtures ---- */

function model(input: {
  displayName: string;
  modelId: string;
  options: HarnessModelDescriptor["options"];
  providerId: string;
}): HarnessModelDescriptor {
  return HarnessModelDescriptorSchema.parse({ ...input, isDefault: true });
}

function connection(label: string, accountLabel: string, billingLabel: string) {
  return {
    accountLabel,
    billingLabel,
    connectionSlot: "primary",
    label,
    status: "connected" as const,
  };
}

function select(
  target: ThreadPlacementOption,
  chosen: HarnessModelDescriptor,
  options: Record<string, string | boolean>,
): ExecutionSelection {
  return {
    environmentId: target.environmentId,
    harnessInstanceId: target.harnessInstanceId,
    modelSelection: selectionForModel(chosen, options),
  };
}

function placement(
  engineName: string,
  harnessInstanceId: string,
  models: HarnessModelDescriptor[],
  overrides: Partial<ThreadPlacementOption> = {},
): ThreadPlacementOption {
  const first = models[0];
  return {
    accessModes: [...ThreadAccessModeSchema.options],
    accountName: engineName,
    availability: "runtime-check",
    available: true,
    continuationIdentity: null,
    defaultAccount: true,
    detail: "Ready",
    driverKind: engineName.toLowerCase().replaceAll(" ", "-"),
    engineName,
    environmentId: "environment-main",
    environmentKind: "main",
    harnessAuthenticationAllowed: false,
    harnessInstanceId,
    models,
    modelSelection: first
      ? selectionForModel(first)
      : ModelSelectionSchema.parse({ modelId: "none", options: {}, providerId: "none" }),
    observedConnections: [],
    setupAvailable: false,
    setupMethods: [],
    source: {
      fields: [],
      kind: "first-party",
      label: engineName,
      quota: "windows",
      sourceId: engineName.toLowerCase(),
      stateKinds: ["ambient", "isolated"],
    },
    sourceId: engineName.toLowerCase(),
    whereLabel: "Main",
    ...overrides,
  };
}

const style = document.createElement("style");
style.textContent = `
  html, body, #root { height: auto; min-height: 100%; overflow: visible; }
  .composer-visual { display: flex; flex-direction: column; gap: 28px; padding: 24px; }
  .composer-visual__head h1 { font-size: 18px; font-weight: 600; }
  .composer-visual__summary { margin-top: 6px; font-size: 13px; }
  .composer-visual__summary[data-pass="true"], .qa-verdict[data-pass="true"] { color: var(--green); }
  .composer-visual__summary[data-pass="false"], .qa-verdict[data-pass="false"] { color: var(--red); }
  .composer-visual__scenario { display: flex; flex-direction: column; gap: 14px; }
  .composer-visual__scenario h2 { font-size: 13px; font-weight: 600; color: var(--text-soft); }
  .composer-visual__toggles { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; font-size: 12px; color: var(--muted); }
  .composer-visual__toggles label { display: inline-flex; align-items: center; gap: 6px; }
  .qa-frame { margin: 0; }
  .qa-frame figcaption { display: flex; gap: 10px; margin-bottom: 6px; font-size: 11px; color: var(--muted-dim); }
  .qa-frame .composer { max-width: none; }
  .qa-frame--live { resize: horizontal; overflow: hidden; min-width: 280px; max-width: 760px; padding: 0; border-right: 1px dashed var(--line-strong); border-bottom: 1px dashed var(--line-strong); }
`;
document.head.append(style);

createRoot(document.getElementById("root")!).render(
  <ToastProvider>
    <MemoryRouter>
      <App />
    </MemoryRouter>
  </ToastProvider>,
);

void document.fonts.ready.then(scheduleCheck);
new ResizeObserver(scheduleCheck).observe(document.body);
// The verdicts are written into the page too; those writes are not a change
// worth checking again.
new MutationObserver((records) => {
  const own = records.every((record) => {
    const element = record.target instanceof Element ? record.target : record.target.parentElement;
    return element?.closest(".qa-verdict, #qa-summary") != null;
  });
  if (!own) scheduleCheck();
}).observe(document.body, { characterData: true, childList: true, subtree: true });
