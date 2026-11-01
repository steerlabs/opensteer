import "@fontsource-variable/inter/wght.css";
import "@fontsource-variable/fraunces/wght.css";
import "@fontsource-variable/fraunces/wght-italic.css";
import "./styles/index.css";
import { useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import { HostClientRequestError, type HostClient, type MessageEntry } from "@opensteer/client/host";
import { MockHostClient } from "@opensteer/client/mock";
import {
  ThreadInputQueueViewSchema,
  createId,
  emptyExecutionPreferences,
  type ArtifactContentPart,
  type ContentPart,
  type ThreadInputQueue,
} from "@opensteer/core";
import { AgentTranscript } from "./components/agent-activity.js";
import type { ShellContext } from "./components/app-shell.js";
import { artifactPart, type SentContentPart } from "./components/attachments/attachment-parts.js";
import type { ComposerRestore } from "./components/composer.js";
import { InputSurface } from "./components/input-surface.js";
import { QueuedMessages } from "./components/queued-messages.js";
import { ToastProvider } from "./components/toast.js";

/**
 * Visual and behavioural QA for chat attachments, on the real composer,
 * transcript and queue over the preview's mock Host. `?scenario=` picks what
 * the Host does; every attachment call it receives is listed under "Host
 * calls", so a screenshot shows both the surface and the traffic behind it.
 *
 *   staged         an image and a PDF upload and become ready     (default)
 *   uploading      uploads never finish; Send stays disabled
 *   failed         the first upload is lost; Retry reuses the reservation
 *   ambiguous      the bytes land but the answer is lost; a check reconciles
 *   refused        the Host refuses the reservation; no Retry
 *   limits         eleven files and one over 25 MB; the notice names the rest
 *   attachment-only  sends a message with no text part
 *   lost-send      the first send is accepted but its answer lost; it is held
 *                  apart from new typing, and Send again replays the same key
 *                  and content
 *   model-refused  the Host refuses images for this thread's model
 *   fence          uploads in flight when the composer moves to another thread
 *   transcript     sent messages: thumbnails, file chips, preview, download
 *   queue          a queued message with files; Edit hands them back
 *   unreadable     the kept message for this thread cannot be read; nothing
 *                  sends until the person discards it
 *   no-storage     the browser refuses to keep messages; nothing sends, the
 *                  draft stays and the reason is shown
 *
 * Add `&manual` to stage nothing and drive the composer by hand (choose,
 * paste or drop files). Unsent messages are kept in this browser's storage
 * and cleared on every load; add `&keep` to reload into one instead.
 */
const search = new URLSearchParams(location.search);
const scenario = search.get("scenario") ?? "staged";
const manual = search.has("manual");
const scenarios = [
  "staged",
  "uploading",
  "failed",
  "ambiguous",
  "refused",
  "limits",
  "attachment-only",
  "lost-send",
  "model-refused",
  "fence",
  "transcript",
  "queue",
  "unreadable",
  "no-storage",
] as const;
const pendingKeyPrefix = "opensteer:pending-send:";
if (!search.has("keep")) {
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith(pendingKeyPrefix)) localStorage.removeItem(key);
  }
}
if (scenario === "no-storage") {
  // Refuses exactly what the composer keeps messages in, as a browser with
  // site data blocked does.
  const setItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function (this: Storage, key: string, value: string): void {
    if (key.startsWith(pendingKeyPrefix)) {
      throw new DOMException("Site data is blocked.", "SecurityError");
    }
    setItem.call(this, key, value);
  };
}

let hostCalls: readonly string[] = [];
const hostCallListeners = new Set<() => void>();
function record(line: string): void {
  if (seeding) return;
  hostCalls = [...hostCalls, line];
  for (const listener of hostCallListeners) listener();
}
function subscribeHostCalls(listener: () => void): () => void {
  hostCallListeners.add(listener);
  return () => hostCallListeners.delete(listener);
}

/** True while the fixture itself stores the attachments the transcript and queue show. */
let seeding = false;
const fixtureQueueMessageIds = new Set<string>();
const neverSettles = scenario === "uploading" || scenario === "fence";

type Dispatch = HostClient["dispatch"];

class ScriptedHostClient extends MockHostClient {
  readonly #uploadAttempts = new Map<string, number>();
  readonly #answered = new Map<string, Awaited<ReturnType<Dispatch>>>();
  #sends = 0;

  override async createAttachment(
    input: Parameters<HostClient["createAttachment"]>[0],
  ): ReturnType<HostClient["createAttachment"]> {
    record(
      `reserve "${input.name}" ${input.mediaType} ${input.sizeBytes} B under …${tail(input.idempotencyKey)}`,
    );
    if (!seeding && scenario === "refused") {
      record("  → refused 415");
      throw new HostClientRequestError({
        code: "unsupported_media_type",
        message: "This deployment does not accept files of this type.",
        status: 415,
      });
    }
    const attachment = await super.createAttachment(input).catch((error: unknown) => {
      record(`  → refused: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    });
    record(`  → ${tail(attachment.id)}`);
    return attachment;
  }

  override async uploadAttachment(
    input: Parameters<HostClient["uploadAttachment"]>[0],
  ): ReturnType<HostClient["uploadAttachment"]> {
    const attempt = (this.#uploadAttempts.get(input.attachmentId) ?? 0) + 1;
    this.#uploadAttempts.set(input.attachmentId, attempt);
    record(`upload ${tail(input.attachmentId)} attempt ${attempt}`);
    if (!seeding && neverSettles) {
      return new Promise((_, reject) => {
        input.signal?.addEventListener("abort", () => {
          record(`  → aborted ${tail(input.attachmentId)}`);
          reject(new DOMException("The upload was abandoned.", "AbortError"));
        });
      });
    }
    if (!seeding && scenario === "failed" && attempt === 1) {
      record("  → connection lost");
      throw new TypeError("Failed to fetch");
    }
    if (!seeding && scenario === "ambiguous" && attempt === 1) {
      await super.uploadAttachment(input);
      record("  → stored, answer lost");
      throw new TypeError("Failed to fetch");
    }
    if (!seeding) await pause(500);
    const attachment = await super.uploadAttachment(input);
    record(`  → ${attachment.state}`);
    return attachment;
  }

  override async getAttachment(attachmentId: string): ReturnType<HostClient["getAttachment"]> {
    const attachment = await super.getAttachment(attachmentId);
    record(`check ${tail(attachmentId)} → ${attachment.state}`);
    return attachment;
  }

  override async discardAttachment(attachmentId: string): Promise<void> {
    record(`discard ${tail(attachmentId)}`);
    await super.discardAttachment(attachmentId);
  }

  override async cancelThreadInput(threadId: string, messageId: string): Promise<void> {
    if (!fixtureQueueMessageIds.has(messageId)) {
      return super.cancelThreadInput(threadId, messageId);
    }
    record(`take back queued ${tail(messageId)}`);
  }

  override async dispatch(command: Parameters<Dispatch>[0]): ReturnType<Dispatch> {
    if (command.type !== "thread.sendMessage") return super.dispatch(command);
    record(`send under …${tail(command.idempotencyKey)}: ${describeContent(command.content)}`);
    const answered = this.#answered.get(command.idempotencyKey);
    if (answered) {
      record("  → same key: the Host answers the first send again");
      return answered;
    }
    const images = command.content.filter(
      (part) => part.type === "artifact" && part.mediaType.startsWith("image/"),
    );
    if (scenario === "model-refused" && images.length > 0) {
      record("  → refused 422");
      throw new HostClientRequestError({
        code: "unsupported",
        message:
          "The model this thread runs on does not accept images. Remove the image or switch to a model that does.",
        status: 422,
      });
    }
    const result = await super.dispatch(command);
    this.#answered.set(command.idempotencyKey, result);
    this.#sends += 1;
    if (scenario === "lost-send" && this.#sends === 1) {
      record("  → accepted, answer lost");
      throw new TypeError("Failed to fetch");
    }
    record("  → accepted");
    return result;
  }
}

const client = new ScriptedHostClient({ latencyMs: 0 });
await client.load();
const snapshot = client.getSnapshot();
const threads = snapshot.threads.filter((thread) => thread.status !== "archived");
const user = snapshot.user;
// The same signed-in identity a real Host confirms: every kept message and
// staged file belongs to this deployment and user.
const deploymentId = snapshot.deploymentId;
if (threads.length === 0 || !user || !deploymentId) {
  throw new Error("The mock Host has no signed-in deployment with an open thread.");
}
if (scenario === "unreadable") {
  localStorage.setItem(
    `${pendingKeyPrefix}v1:${encodeURIComponent(deploymentId)}:${encodeURIComponent(user.id)}:${encodeURIComponent(threads[0]!.id)}`,
    "{ not a message",
  );
}
const noOp = () => undefined;

seeding = true;
const screenshot = await pictureFile("dashboard.png", 1600, 900, 210);
const portrait = await pictureFile("receipt.jpg", 720, 1280, 30, "image/jpeg");
const exportFile = new File(["month,total\n2026-08,4120\n2026-09,3985\n"], "totals-export.csv", {
  type: "text/csv",
});
const logo = new File(['<svg xmlns="http://www.w3.org/2000/svg"/>'], "logo.svg", {
  type: "image/svg+xml",
});
const seeded =
  scenario === "transcript" || scenario === "queue"
    ? await Promise.all([screenshot, exportFile, portrait, logo].map(seed))
    : [];
seeding = false;

const author = {
  displayName: user.displayName,
  kind: "human" as const,
  principalId: user.id,
  userId: user.id,
};
const transcript: MessageEntry[] =
  scenario === "transcript"
    ? [
        message(
          "Here's the dashboard and the export it was built from. Why do the September totals differ?",
          seeded.slice(0, 2),
        ),
        message("", seeded.slice(2, 3)),
        message("The logo, and one screenshot that has since been deleted.", [
          seeded[3]!,
          {
            artifactId: createId("attachment"),
            mediaType: "image/png",
            name: "deleted-screenshot.png",
            sizeBytes: 48_213,
            type: "artifact",
          },
        ]),
      ]
    : [];

const initialQueue: ThreadInputQueue | null =
  scenario === "queue" ? queuedWith("Compare these two before the next step.", seeded) : null;

function useShellContext(): ShellContext {
  const live = useSyncExternalStore(client.subscribe, client.getSnapshot);
  return {
    actionError: null,
    clearActionError: noOp,
    askOpensteerAbout: noOp,
    clearHomeHandoff: noOp,
    homeDraft: "",
    homeHandoff: null,
    homeThreadId: null,
    setHomeDraft: noOp,
    createThreadAndSend: async () => null,
    defaultPlacement: undefined,
    deploymentAccess: null,
    desktopBridge: null,
    desktopDeployment: null,
    executionPreferences: emptyExecutionPreferences,
    hostClient: client,
    localExecutionAction: null,
    localExecutionError: null,
    localExecutionStatus: null,
    openHarnessAuthentication: null,
    refreshHarnessCatalog: async () => undefined,
    leaveSettings: noOp,
    openMobileNavigation: noOp,
    openNewWorkspace: noOp,
    openSharing: noOp,
    performLocalExecutionAction: async () => undefined,
    placements: [],
    rememberExecution: noOp,
    reportActionError: noOp,
    setTaskDone: noOp,
    writeInChat: noOp,
    snapshot: { ...live, connection: "connected" },
  };
}

function Shell() {
  return <Outlet context={useShellContext()} />;
}

function Fixture() {
  const calls = useSyncExternalStore(subscribeHostCalls, () => hostCalls);
  const [threadIndex, setThreadIndex] = useState(0);
  const [queue, setQueue] = useState(initialQueue);
  const [restored, setRestored] = useState<ComposerRestore | null>(null);
  const thread = threads[threadIndex % threads.length]!;
  return (
    <main className="attachments-visual">
      <nav aria-label="Scenarios" className="attachments-visual__nav">
        {scenarios.map((name) => (
          <a
            aria-current={name === scenario ? "page" : undefined}
            href={`?scenario=${name}`}
            key={name}
          >
            {name}
          </a>
        ))}
      </nav>
      <p className="attachments-visual__thread">
        Thread: {thread.title}
        {scenario === "fence" && threads.length > 1 ? (
          <button
            className="btn btn--small"
            onClick={() => setThreadIndex((index) => index + 1)}
            type="button"
          >
            Move to another thread
          </button>
        ) : null}
      </p>
      {transcript.length > 0 || queue ? (
        <div className="transcript">
          <AgentTranscript
            attachmentReader={client}
            entries={transcript}
            queued={
              queue ? (
                <QueuedMessages
                  client={client}
                  disabled={false}
                  onEdit={(taken) => {
                    setQueue(null);
                    setRestored((current) => ({ ...taken, key: (current?.key ?? 0) + 1 }));
                  }}
                  onError={noOp}
                  queue={queue}
                  viewerUserId={author.userId}
                  workspaces={[]}
                />
              ) : null
            }
            viewerUserId={author.userId}
          />
        </div>
      ) : null}
      <div className="composer-dock">
        <InputSurface
          disabled={false}
          key={`${deploymentId}:${author.userId}:${thread.id}`}
          placeholder="Ask Opensteer…"
          requests={[]}
          restoredDraft={restored}
          running={queue !== null}
          threadId={thread.id}
        />
      </div>
      <section aria-label="Host calls" className="attachments-visual__calls">
        <h2>Host calls</h2>
        <ol>
          {calls.map((line, index) => (
            <li key={index}>{line}</li>
          ))}
        </ol>
      </section>
    </main>
  );
}

const container = document.getElementById("root");
if (!container) throw new Error("Missing root");
const style = document.createElement("style");
style.textContent = `
  .attachments-visual { display: flex; flex-direction: column; gap: 16px; width: min(780px, 100%); margin: 24px auto; padding: 16px; }
  .attachments-visual__nav { display: flex; flex-wrap: wrap; gap: 6px 12px; font-size: 12px; }
  .attachments-visual__nav a { color: var(--muted); }
  .attachments-visual__nav a[aria-current] { color: var(--text); font-weight: 600; }
  .attachments-visual__thread { display: flex; align-items: center; gap: 12px; color: var(--muted); font-size: 12px; }
  .attachments-visual .composer-dock { padding: 0; background: none; }
  .attachments-visual__calls { color: var(--muted); font: 11.5px/1.6 var(--font-mono); }
  .attachments-visual__calls h2 { margin: 0 0 4px; color: var(--text-soft); font-size: 12px; }
`;
document.head.append(style);
createRoot(container).render(
  <ToastProvider>
    <MemoryRouter initialEntries={["/visual"]}>
      <Routes>
        <Route element={<Shell />}>
          <Route element={<Fixture />} path="*" />
        </Route>
      </Routes>
    </MemoryRouter>
  </ToastProvider>,
);

if (!manual) void drive();

/** Stages files and presses Send through the same controls a person uses. */
async function drive(): Promise<void> {
  const files = scenarioFiles();
  if (files.length > 0) await chooseFiles(files);
  if (scenario === "unreadable" || scenario === "no-storage") {
    await type("This draft stays while nothing can be sent.");
  } else if (scenario === "attachment-only") {
    await click(await readySend());
  } else if (scenario === "model-refused") {
    await type("What stands out in this dashboard?");
    await click(await readySend());
  } else if (scenario === "lost-send") {
    await type("Summarise the attached report.");
    await click(await readySend());
    // Held as sent while new words go in the field; only Send again sends it.
    await type("A separate follow-up, typed while the first is unconfirmed.");
    await pause(800);
    await click(
      await waitFor(
        () =>
          [...document.querySelectorAll<HTMLButtonElement>(".held-message button")].find(
            (button) => !button.disabled,
          ) ?? null,
      ),
    );
  }
}

function scenarioFiles(): File[] {
  const report = new File([new Uint8Array(180_000)], "quarterly-report.pdf", {
    type: "application/pdf",
  });
  switch (scenario) {
    case "transcript":
    case "queue":
    case "unreadable":
    case "no-storage":
      return [];
    case "attachment-only":
    case "model-refused":
      return [screenshot];
    case "limits":
      return [
        new File([new Uint8Array(26 * 1_024 * 1_024)], "screen-recording.mov", {
          type: "video/quicktime",
        }),
        ...Array.from(
          { length: 11 },
          (_, index) =>
            new File([`note ${index + 1}`], `note-${index + 1}.txt`, { type: "text/plain" }),
        ),
      ];
    default:
      return [screenshot, report];
  }
}

async function chooseFiles(files: readonly File[]): Promise<void> {
  const input = await waitFor(() =>
    document.querySelector<HTMLInputElement>('.composer input[type="file"]'),
  );
  const transfer = new DataTransfer();
  for (const file of files) transfer.items.add(file);
  input.files = transfer.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

async function type(text: string): Promise<void> {
  const field = await waitFor(() =>
    document.querySelector<HTMLTextAreaElement>(".composer__input"),
  );
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(field, text);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

function readySend(): Promise<HTMLButtonElement> {
  return waitFor(() => {
    const button = document.querySelector<HTMLButtonElement>(".composer__send");
    return button && !button.disabled ? button : null;
  });
}

async function click(button: HTMLButtonElement): Promise<void> {
  button.click();
  await pause(50);
}

async function waitFor<T>(find: () => T | null, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = find();
    if (found) return found;
    if (Date.now() > deadline) throw new Error("The fixture timed out waiting for the composer.");
    await pause(50);
  }
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function seed(file: File): Promise<ArtifactContentPart> {
  const reserved = await client.createAttachment({
    idempotencyKey: `fixture:${crypto.randomUUID()}`,
    mediaType: file.type,
    name: file.name,
    sizeBytes: file.size,
    workspaceId: threads[0]!.workspaceId,
  });
  return artifactPart(await client.uploadAttachment({ attachmentId: reserved.id, source: file }));
}

function message(body: string, attachments: readonly ArtifactContentPart[]): MessageEntry {
  return {
    attachments,
    author,
    body,
    createdAt: new Date().toISOString(),
    id: createId("message"),
    kind: "message",
    messageKind: "input",
    runId: null,
  };
}

function queuedWith(text: string, attachments: readonly ArtifactContentPart[]): ThreadInputQueue {
  const thread = threads[0]!;
  const now = new Date().toISOString();
  const messageId = createId("message");
  fixtureQueueMessageIds.add(messageId);
  const content: ContentPart[] = [{ text, type: "text" }, ...attachments.slice(0, 2)];
  return ThreadInputQueueViewSchema.parse({
    items: [
      {
        canCancel: true,
        canMove: true,
        canSteer: false,
        input: {
          cancelReason: null,
          causalChainId: createId("causalChain"),
          createdAt: now,
          deliveredAt: null,
          messageId,
          policy: "queue",
          replyTarget: null,
          runId: null,
          state: "pending",
          threadId: thread.id,
          updatedAt: now,
        },
        message: {
          author,
          content,
          createdAt: now,
          id: messageId,
          kind: "input",
          runId: null,
          sequence: "12",
          threadId: thread.id,
        },
      },
    ],
    paused: false,
    steerRunId: null,
    threadId: thread.id,
  });
}

async function pictureFile(
  name: string,
  width: number,
  height: number,
  hue: number,
  mediaType = "image/png",
): Promise<File> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas is unavailable.");
  const gradient = context.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, `hsl(${hue} 45% 22%)`);
  gradient.addColorStop(1, `hsl(${hue + 40} 55% 48%)`);
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);
  context.fillStyle = "rgb(255 255 255 / 85%)";
  context.font = `600 ${Math.round(height / 9)}px sans-serif`;
  context.fillText(name, Math.round(width / 16), Math.round(height / 2));
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (result) => (result ? resolve(result) : reject(new Error("The image was not drawn."))),
      mediaType,
    ),
  );
  return new File([blob], name, { type: mediaType });
}

function describeContent(content: readonly SentContentPart[]): string {
  return content
    .map((part) =>
      part.type === "text"
        ? `text "${part.text}"`
        : part.type === "browser-page"
          ? `page "${part.title}"`
          : `file ${part.name}`,
    )
    .join(", ");
}

function tail(value: string): string {
  return value.slice(-6);
}
