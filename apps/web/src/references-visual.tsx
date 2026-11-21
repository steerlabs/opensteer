import "@fontsource-variable/inter/wght.css";
import "./styles/index.css";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { ThreadIdSchema, createId, type ReferenceId } from "@opensteer/core";
import type { ReferenceResolveInput, ReferenceResolveResult } from "@opensteer/protocol";
import {
  AssetUrlStore,
  TranscriptFileController,
  type TranscriptEntry,
} from "@opensteer/client/host";
import { MockHostClient } from "@opensteer/client/mock";
import { ReferenceStore } from "@opensteer/client/references";
import { AgentTranscript } from "./components/agent-activity.js";
import { ToastProvider } from "./components/toast.js";
import { FileViewer } from "./components/references/file-viewer.js";
import { PersonalReferences } from "./components/references/reference-scope.js";
import { Unavailable } from "./components/references/unavailable.js";

/**
 * Visual QA for inline references over the preview's mock Host. `?scenario=`
 * picks the surface: `transcript` (a reply with chips, a person's Markdown, an
 * inline image), `unavailable` (where a gone link
 * lands) or `file` (the file viewer at line 42). Images load from
 * `/media/…`, which the capture script serves.
 */
const scenario = new URLSearchParams(location.search).get("scenario") ?? "transcript";
const client = new MockHostClient({ latencyMs: 0, agentImagesAvailable: true });
await client.load();
const snapshot = client.getSnapshot();
const viewer = snapshot.user!;
const thread = snapshot.threads.find((candidate) => candidate.listed)!;
const threadId = ThreadIdSchema.parse(thread.id);
const taskId = createId("thread");
const runId = createId("run");
const automationId = createId("trigger");
const computerId = createId("runner");
const goneId = createId("message");
const answers = new Map<string, ReferenceResolveResult["results"][number]>([
  [
    taskId,
    {
      status: "available",
      kind: "task",
      id: taskId,
      title: "Migrate billing webhooks to the new queue and backfill ninety days of events",
    },
  ],
  [
    runId,
    {
      status: "available",
      kind: "run",
      id: runId,
      threadId,
      anchorMessageId: createId("message"),
      title: "Deploy preview",
    },
  ],
  [
    automationId,
    { status: "available", kind: "automation", id: automationId, title: "Nightly typecheck" },
  ],
  [computerId, { status: "available", kind: "computer", id: computerId, title: "Studio Mac" }],
]);
const references = new ReferenceStore({
  resolveReferences: async ({ ids }: ReferenceResolveInput) => ({
    results: ids.map(
      (id) => answers.get(id) ?? { status: "unavailable" as const, id: id as ReferenceId },
    ),
  }),
  getSnapshot: () => client.getSnapshot(),
  subscribe: (listener) => client.subscribe(listener),
});
const source = Array.from({ length: 120 }, (_, index) =>
  index === 41
    ? '  const response = await fetch(url, { signal, headers: { accept: "application/json" } });'
    : index % 9 === 0
      ? `export async function step${index}(input: Request): Promise<Response> {`
      : `  // line ${index + 1}: keep the request bounded and the answer typed`,
).join("\n");
const files = new TranscriptFileController({
  rpc: {
    openFile: async ({ source: file }) =>
      file.kind === "path" && file.path.endsWith("http.ts")
        ? {
            status: "ok",
            resource: { kind: "home", key: "src/server/http.ts", revision: "r1" },
            name: "http.ts",
            sizeBytes: source.length,
            mediaType: "text/plain",
            preview: { kind: "text", text: source, truncated: false },
          }
        : { status: "unavailable" },
    readFile: () => Promise.reject(new Error("Not in the preview")),
  },
});
const media = new AssetUrlStore(
  async ({ assets }) => ({
    assets: assets.map(() => ({
      status: "ok" as const,
      url: "/media/preview/chart.png",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      revision: "1",
      mediaType: "image/png" as const,
      width: 1200,
      height: 750,
    })),
  }),
  { origin: async () => location.origin },
);
Object.defineProperty(client, "references", { value: references });
Object.defineProperty(client, "transcriptFiles", { value: files });
Object.defineProperty(client, "assetUrls", { value: media });

const reply = [
  "Shipped. The webhook work is in " +
    `[billing migration](opensteer:${taskId}); the [preview deploy](opensteer:${runId}) is green ` +
    `and [the nightly check](opensteer:${automationId}) runs on [Studio](opensteer:${computerId}).`,
  "",
  `The retry fix is in [http.ts:42](/Users/me/Opensteer/src/server/http.ts:42). ` +
    `The note I left earlier, [rollout notes](opensteer:${goneId}), was removed.`,
  "",
  "![Queue depth after the change](/Users/me/Opensteer/charts/queue-depth.png)",
].join("\n");
const personal = [
  "## Before Friday",
  "",
  `- check [billing migration](opensteer:${taskId})`,
  "- then rerun:",
  "",
  "```sh",
  "pnpm test:integration -- billing",
  "```",
].join("\n");
const entries: TranscriptEntry[] = [
  {
    author: {
      displayName: viewer.displayName ?? "You",
      kind: "human",
      principalId: `user:${viewer.id}`,
      userId: viewer.id,
    },
    body: personal,
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    id: createId("message"),
    kind: "message",
    messageKind: "input",
    runId: null,
  },
  {
    author: { cause: "assistant-message", kind: "platform" },
    body: reply,
    createdAt: new Date().toISOString(),
    id: createId("message"),
    kind: "message",
    messageKind: "assistant",
    runId,
  },
];
function Page() {
  if (scenario === "unavailable")
    return (
      <div className="thread">
        <Unavailable onBack={() => undefined} />
      </div>
    );
  if (scenario === "file")
    return (
      <FileViewer
        client={client}
        input={{
          source: { kind: "path", path: "/Users/me/Opensteer/src/server/http.ts" },
          line: 42,
        }}
        onClose={() => undefined}
        threadId={threadId}
      />
    );
  return (
    <PersonalReferences client={client} threadId={thread.id}>
      <main style={{ maxWidth: 760, margin: "0 auto", padding: "16px 16px 48px" }}>
        <div className="transcript">
          <AgentTranscript
            attachmentReader={client}
            entries={entries}
            threadId={thread.id}
            viewerUserId={viewer.id}
          />
        </div>
      </main>
    </PersonalReferences>
  );
}

createRoot(document.getElementById("root")!).render(
  <MemoryRouter>
    <ToastProvider>
      <Page />
    </ToastProvider>
  </MemoryRouter>,
);
