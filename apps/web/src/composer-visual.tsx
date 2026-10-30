import "@fontsource-variable/inter/wght.css";
import "./styles/index.css";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import {
  ModelSelectionSchema,
  ThreadAccessModeSchema,
  emptyExecutionPreferences,
  type ThreadAccessMode,
} from "@opensteer/core";
import { HarnessModelDescriptorSchema, type HarnessModelDescriptor } from "@opensteer/protocol";
import {
  selectionForModel,
  type ExecutionSelection,
  type ThreadPlacementOption,
} from "@opensteer/client/host";
import { MockHostClient } from "@opensteer/client/mock";
import { DictationController } from "@opensteer/client/dictation";
import { DictationContext } from "./components/dictation.js";
import { Composer } from "./components/composer.js";
import { ExecutionControls } from "./components/execution-controls.js";
import { ToastProvider } from "./components/toast.js";
const client = new MockHostClient({ latencyMs: 0 });
const dictation = new DictationController({
  port: {
    availability: async () => ({
      available: true,
      languageName: "English",
      locale: "en-US",
      model: "installed",
      microphone: "granted",
    }),
    subscribe: () => () => {},
    start: async () => {},
    stop: async () => {},
    cancel: async () => {},
    download: async () => {},
    openMicrophoneSettings: async () => {},
  },
  createId: () => crypto.randomUUID(),
});
await dictation.refresh();
const gpt = model({
  displayName: "GPT-6.1 Terra",
  modelId: "gpt-terra",
  providerId: "openai",
  options: [
    {
      type: "select",
      id: "effort",
      label: "Reasoning",
      defaultValue: "auto",
      values: [
        { value: "auto", label: "Default" },
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium" },
        { value: "high", label: "High" },
        { value: "xhigh", label: "Extra high" },
      ],
    },
    { type: "toggle", id: "fast", label: "Fast", defaultValue: false },
  ],
});
const codex = placement(
  "Codex",
  "codex",
  [
    gpt,
    HarnessModelDescriptorSchema.parse({
      ...gpt,
      modelId: "gpt-mini",
      displayName: "GPT Mini",
      description: "Quick answers for everyday tasks",
    }),
  ],
  { observedConnections: [connection("Codex", "alex@example.com", "Plus")] },
);
const work = {
  ...codex,
  harnessInstanceId: "codex-work",
  accountName: "Work",
  observedConnections: [connection("Codex", "alex@work.example", "Team")],
};
const placements = [
  codex,
  work,
  placement("Claude Code", "claude", [
    HarnessModelDescriptorSchema.parse({ ...gpt, displayName: "Claude Opus", modelId: "opus" }),
  ]),
  placement("Cursor", "cursor", [], {
    available: false,
    availability: "authentication-required",
    detail: "Sign in to use Cursor.",
  }),
];
const fixturePlacements = new URLSearchParams(location.search).has("usage")
  ? placements.map((item) =>
      item.harnessInstanceId !== codex.harnessInstanceId
        ? item
        : {
            ...item,
            observedConnections: item.observedConnections.map((account) => ({
              ...account,
              usage: {
                limitReached: true,
                observedAt: new Date().toISOString(),
                windows: [
                  { label: "weekly", usedPercent: 100, resetsAt: "2099-01-01T00:00:00.000Z" },
                ],
              },
            })),
          },
    )
  : placements;
function App() {
  const [selection, setSelection] = useState(select(codex, gpt, { effort: "xhigh" }));
  const [mode, setMode] = useState<ThreadAccessMode>("full-access");
  return (
    <main style={{ width: "min(760px, 100%)", margin: "100px auto", padding: 16 }}>
      <h1 style={{ fontSize: 24, marginBottom: 32 }}>What should Opensteer do?</h1>
      <DictationContext value={dictation}>
        <Composer
          placeholder="What should Opensteer do?"
          onSend={async () => {}}
          attachments={{
            client,
            workspaceId: client.getSnapshot().workspaces[0]!.id,
            scope: "visual",
          }}
          footerExtras={
            <ExecutionControls
              placements={fixturePlacements}
              preferences={emptyExecutionPreferences}
              selection={selection}
              onApply={setSelection}
              access={{
                mode,
                engine:
                  placements.find(
                    (item) => item.harnessInstanceId === selection.harnessInstanceId,
                  ) ?? null,
                onApply: setMode,
              }}
            />
          }
        />
      </DictationContext>
    </main>
  );
}
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

createRoot(document.getElementById("root")!).render(
  <MemoryRouter>
    <ToastProvider>
      <App />
    </ToastProvider>
  </MemoryRouter>,
);
