import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { DictationController } from "@opensteer/client/dictation";
import type { DictationEvent, DictationPort, DictationError } from "@opensteer/protocol/dictation";
import { MockHostClient } from "@opensteer/client/mock";
import { emptyExecutionPreferences } from "@opensteer/core";
import { ExecutionControls } from "./components/execution-controls.js";
import { artifactPart } from "./components/attachments/attachment-parts.js";
import { Composer } from "./components/composer.js";
import { DictationContext } from "./components/dictation.js";
import "@fontsource-variable/inter/wght.css";
import "@fontsource-variable/fraunces/wght.css";
import "./styles/index.css";

const client = new MockHostClient({ latencyMs: 0 });
const workspaceId = client.getSnapshot().workspaces[0]!.id;
const file = new File(["Design review"], "review-notes.txt", { type: "text/plain" });
const reservation = await client.createAttachment({
  idempotencyKey: `dictation-visual:${crypto.randomUUID()}`,
  workspaceId,
  name: file.name,
  mediaType: file.type,
  sizeBytes: file.size,
});
const attachment = artifactPart(
  await client.uploadAttachment({ attachmentId: reservation.id, source: file }),
);
const layout = new URLSearchParams(location.search).get("layout") ?? "work";
const scenario = new URLSearchParams(location.search).get("state") ?? "idle";
const errors: readonly DictationError[] = [
  "permission-denied",
  "busy",
  "microphone-unavailable",
  "model-unavailable",
  "download-failed",
  "recognition-failed",
  "service-unavailable",
];
let receive: (event: DictationEvent) => void = () => {};
let session = "";
let seq = 0;
let limit: (() => void) | undefined;
const emit = (
  event:
    | Omit<Extract<DictationEvent, { type: "ended" }>, "session" | "seq">
    | { type: "listening" }
    | { type: "text"; finalized: string[]; volatile: string[] }
    | { type: "downloading"; progress: number }
    | { type: "level"; level: number },
) => receive({ ...event, session, seq: ++seq } as DictationEvent);
const port: DictationPort = {
  availability: async () => ({
    available: true,
    languageName: "English",
    locale: "en-US",
    model:
      scenario === "downloading" || scenario === "downloaded" || scenario === "download-failed"
        ? "download"
        : "installed",
    microphone: scenario === "permission-denied" ? "denied" : "granted",
  }),
  subscribe: (listener) => {
    receive = listener;
    return () => {};
  },
  start: async (id) => {
    session = id;
  },
  download: async (id) => {
    session = id;
  },
  stop: async () => {},
  cancel: async () => {},
  openMicrophoneSettings: async () => {},
};
const controller = new DictationController({
  port,
  createId: () => crypto.randomUUID(),
  setTimer: (callback, ms) => {
    if (ms === 600_000) limit = callback;
    return setTimeout(callback, ms);
  },
});
await controller.refresh();
function Fixture() {
  const [selection, setSelection] = useState<
    import("@opensteer/client/host").ExecutionSelection | null
  >(null);
  useEffect(() => {
    const drive = setTimeout(() => {
      const field = document.querySelector("textarea")!;
      field.setSelectionRange(13, 13);
      if (scenario !== "idle")
        document.querySelector<HTMLButtonElement>('[title="Dictate"]')!.click();
      if (scenario === "downloading") emit({ type: "downloading", progress: 0.42 });
      else if (scenario === "download-failed")
        emit({ type: "ended", reason: "failed", error: "download-failed" });
      else if (scenario === "downloaded") emit({ type: "ended", reason: "completed", error: null });
      else if (scenario !== "idle" && scenario !== "starting" && scenario !== "permission-denied") {
        emit({ type: "listening" });
        if (
          ![
            "empty",
            "busy",
            "microphone-unavailable",
            "model-unavailable",
            "service-unavailable",
          ].includes(scenario)
        )
          emit({
            type: "text",
            finalized: ["the latest design"],
            volatile: scenario === "listening" ? ["with Maya"] : [],
          });
        if (scenario === "finishing") void controller.stop(controller.getSnapshot().owner!);
        else if (scenario === "limit") {
          limit?.();
          emit({ type: "ended", reason: "completed", error: null });
        } else if (scenario === "empty") emit({ type: "ended", reason: "completed", error: null });
        else if (scenario === "interrupted" || scenario === "device-changed")
          emit({ type: "ended", reason: scenario, error: null });
        else if (errors.includes(scenario as DictationError))
          emit({ type: "ended", reason: "failed", error: scenario as DictationError });
      }
      setTimeout(() => emit({ type: "level", level: 0.7 }), 100);
    }, 50);
    return () => clearTimeout(drive);
  }, []);
  return (
    <main style={{ width: "min(760px, 100%)", margin: "100px auto", padding: 24 }}>
      <p className="eyebrow">OPENSTEER · DICTATION</p>
      <h1 style={{ fontSize: 28, marginBottom: 40 }}>What’s on your mind?</h1>
      <DictationContext value={controller}>
        <Composer
          onSend={async () => {}}
          placeholder="Ask Opensteer…"
          variant={layout === "conversation" ? "conversation" : "work"}
          attachments={{ client, scope: "dictation-visual", workspaceId }}
          restore={{
            key: 1,
            text: "Please review before Friday.",
            attachments: [attachment],
            quote: {
              messageId: "message-visual",
              attribution: "Maya",
              excerpt: "Could you review the design?",
            },
          }}
          footerExtras={
            <ExecutionControls
              placements={[]}
              preferences={emptyExecutionPreferences}
              selection={selection}
              onApply={setSelection}
            />
          }
        />
      </DictationContext>
      <p style={{ color: "var(--muted)", fontSize: 12, marginTop: 16 }}>
        On-device dictation · {scenario}
      </p>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
