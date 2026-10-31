import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  threadPlacementOptions,
  executionAccounts,
  type ExecutionSelection,
  type HostSnapshot,
  type HostClient,
} from "@opensteer/client/host";
import { useHostSnapshot } from "@opensteer/client/react";
import { MockHostClient } from "@opensteer/client/mock";
import { afterEach, describe, expect, it, vi } from "vitest";

// Voice's controls animate with Reanimated, which cannot load here; these tests are not about voice.
vi.mock("../voice/controls.js", () => ({
  VoiceDock: () => null,
  VoiceMic: () => null,
  useVoiceAvailable: () => false,
}));

import { ExecutionSelectionSchema, type ThreadAccessMode } from "@opensteer/core";

import {
  mobile,
  navigation,
  ThreadSettingsScreen,
  NewThreadScreen,
  FirstMessageComposer,
  firstMessageExecution,
  firstMessageBlocker,
} from "./thread-settings.test-support.js";
// The real sheet and catalog against a movable Host snapshot: browsing cannot
// mutate, account changes can end continuation, review cannot reuse stale
// readiness or access declarations, and access must precede execution.
describe("Expo engine/account/model journeys", () => {
  const fixture = new MockHostClient({ automations: "absent", latencyMs: 0 });
  const base = fixture.getSnapshot();
  fixture.dispose();
  const placements = threadPlacementOptions(base.environments, base.harnesses);
  const codex = placements.find((p) => p.available && p.driverKind === "codex")!;
  const second = placements.find(
    (p) =>
      p.available && p.driverKind === "codex" && p.harnessInstanceId !== codex.harnessInstanceId,
  )!;
  const cursor = placements.find((p) => p.available && p.driverKind === "cursor")!;
  const original = base.threads.find((t) => t.environmentId === codex.environmentId)!;
  let root: Root | undefined;
  let snapshot: HostSnapshot;
  const listeners = new Set<() => void>();
  const access = vi.fn(async (threadId: string, mode: ThreadAccessMode) => {
    const updated = {
      ...snapshot.threads.find((thread) => thread.id === threadId)!,
      accessMode: mode,
    };
    move({
      ...snapshot,
      threads: snapshot.threads.map((thread) => (thread.id === threadId ? updated : thread)),
    });
    return updated;
  });
  const execution = vi.fn(
    async (_threadId: string, _choice: unknown, _review?: unknown) => original,
  );
  const remember = vi.fn(async (_choice: unknown) => snapshot.executionPreferences);
  function move(next: HostSnapshot) {
    snapshot = next;
    for (const listener of listeners) listener();
  }
  async function mount(draft = false, auto = false, history: readonly ExecutionSelection[] = []) {
    snapshot = {
      ...base,
      connection: "connected",
      session: "authenticated",
      runQueue: [],
      executionPreferences: {
        accessMode: auto ? "auto" : "approval-required",
        history: history.map((choice) => ExecutionSelectionSchema.parse(choice)),
      },
      threads: [
        {
          ...original,
          status: "idle",
          accessMode: auto ? "auto" : "approval-required",
          environmentId: codex.environmentId,
          harnessInstanceId: codex.harnessInstanceId,
          modelLabel: codex.models[0]!.displayName,
          modelSelection: { ...codex.modelSelection, options: { effort: "high" } },
          continuationIdentity: codex.continuationIdentity,
          providerSessionId: "session-1",
        },
      ],
    };
    mobile.hostClient = {
      load: async () => undefined,
      getSnapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      updateThreadAccess: access,
      updateThreadExecution: execution,
      rememberExecution: remember,
    } as unknown as HostClient;
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root!.render(
        draft ? (
          <NewThreadScreen route={{ params: { deploymentId: "test-deployment" } }} />
        ) : (
          <ThreadSettingsScreen
            route={{ params: { deploymentId: "test-deployment", threadId: original.id } }}
          />
        ),
      ),
    );
  }
  const button = (text: string) =>
    Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.startsWith(text));
  async function press(text: string) {
    const target = button(text);
    expect(target, text).toBeDefined();
    await act(async () => target!.click());
  }
  async function browseSecond() {
    const engine = document.querySelector<HTMLButtonElement>('[aria-label="Engine: Codex"]');
    expect(engine).not.toBeNull();
    await act(async () => engine!.click());
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="This conversation"]')!.click(),
    );
    const title = executionAccounts(placements, {
      environmentId: codex.environmentId,
      harnessInstanceId: codex.harnessInstanceId,
      modelSelection: codex.modelSelection,
    }).find((row) => row.placement.harnessInstanceId === second.harnessInstanceId)!.title;
    await press(title);
  }
  afterEach(async () => {
    const artifacts =
      process.env.OPENSTEER_ENGINE_INSPECTION_ARTIFACT_DIR ??
      join(tmpdir(), "opensteer-expo-picker-evidence");
    await mkdir(artifacts, { recursive: true });
    await writeFile(
      join(artifacts, `${expect.getState().currentTestName!.replace(/[^a-z0-9]+/giu, "-")}.json`),
      JSON.stringify(
        {
          journey: expect.getState().currentTestName,
          html: document.body.innerHTML,
          access: access.mock.calls,
          execution: execution.mock.calls,
          remembered: remember.mock.calls,
        },
        null,
        2,
      ) + "\n",
    );
    await act(async () => root?.unmount());
    root = undefined;
    mobile.hostClient = null;
    document.body.replaceChildren();
    listeners.clear();
    access.mockClear();
    execution.mockClear();
    remember.mockClear();
    navigation.goBack.mockClear();
  });

  it("browses engines and accounts without committing and reviews incompatible accounts", async () => {
    await mount();
    await browseSecond();
    expect(access).not.toHaveBeenCalled();
    expect(execution).not.toHaveBeenCalled();
    expect(remember).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("starts fresh");
    expect(execution).not.toHaveBeenCalled();
    await press("Keep Codex");
    expect(execution).not.toHaveBeenCalled();
    await press("alex@opensteer.test");
    await press("Use Codex");
    expect(execution).toHaveBeenCalledExactlyOnceWith(
      original.id,
      {
        harnessInstanceId: second.harnessInstanceId,
        modelSelection: { ...second.modelSelection, options: { effort: "high" } },
      },
      { expectedProviderSessionId: "session-1" },
    );
    expect(access).not.toHaveBeenCalled();
  });

  it("restores options for the account and model rather than reusing same-model current values", async () => {
    const remembered = {
      environmentId: second.environmentId,
      harnessInstanceId: second.harnessInstanceId,
      modelSelection: {
        ...second.modelSelection,
        options: { effort: "medium", speed: "priority" },
      },
    };
    await mount(false, false, [remembered]);
    await browseSecond();
    await press("Use Codex");
    expect(execution.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: { options: { effort: "medium", speed: "priority" } },
    });
  });

  it("requires an explicit supported access mode, then updates access before execution", async () => {
    await mount(false, true);
    await press("Cursor");
    await press(cursor.models[0]!.displayName);
    expect(document.body.textContent).toContain("Cursor cannot enforce this mode");
    expect(button("Use Cursor")?.disabled).toBe(true);
    expect(access).not.toHaveBeenCalled();
    expect(execution).not.toHaveBeenCalled();
    await press("Supervised");
    await press("Use Cursor");
    expect(access).toHaveBeenCalledExactlyOnceWith(original.id, "approval-required");
    expect(execution.mock.calls[0]?.[1]).toMatchObject({
      harnessInstanceId: cursor.harnessInstanceId,
    });
    expect(access.mock.invocationCallOrder[0]).toBeLessThan(execution.mock.invocationCallOrder[0]!);
  });

  it("does not change execution when the reviewed access update fails", async () => {
    access.mockRejectedValueOnce(new Error("Access refused"));
    await mount(false, true);
    await press("Cursor");
    await press(cursor.models[0]!.displayName);
    await press("Full access");
    await press("Use Cursor");
    expect(document.body.textContent).toContain("Access refused");
    expect(execution).not.toHaveBeenCalled();
  });

  it("revalidates busy state when review confirms", async () => {
    await mount();
    await browseSecond();
    await act(async () =>
      move({
        ...snapshot,
        runQueue: [{ threadId: original.id } as HostSnapshot["runQueue"][number]],
      }),
    );
    await press("Use Codex");
    expect(execution).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Finish the current run");
  });

  it("does not apply a review after the target account disappears", async () => {
    await mount();
    await browseSecond();
    await act(async () =>
      move({
        ...snapshot,
        harnesses: snapshot.harnesses.filter(({ id }) => id !== second.harnessInstanceId),
      }),
    );
    await press("Use Codex");
    expect(execution).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("not available");
  });

  it("browses AI chips without mutation and picks a model", async () => {
    await mount(true);
    await press("Cursor");
    expect(remember).not.toHaveBeenCalled();
    await press(cursor.models[0]!.displayName);
    expect(remember).toHaveBeenCalledExactlyOnceWith({
      selection: expect.objectContaining({ harnessInstanceId: cursor.harnessInstanceId }),
    });
    expect(navigation.goBack).toHaveBeenCalled();
  });

  it("blocks a draft's send until the person selects an enforceable access mode", async () => {
    await mount(true, true, [
      {
        environmentId: cursor.environmentId,
        harnessInstanceId: cursor.harnessInstanceId,
        modelSelection: cursor.modelSelection,
      },
    ]);
    await act(async () => root!.unmount());
    const onSend = vi.fn();
    function Draft() {
      const { snapshot: live } = useHostSnapshot(mobile.hostClient!);
      const execution = firstMessageExecution("task", live);
      const input = useRef<import("react-native").TextInputInstance | null>(null);
      const staged = {
        items: [],
        notice: null,
        remove: vi.fn(),
        retry: vi.fn(),
        pick: vi.fn(),
      } as unknown as Parameters<typeof FirstMessageComposer>[0]["staged"];
      return (
        <FirstMessageComposer
          blocker={firstMessageBlocker({
            attachmentsReady: true,
            connected: true,
            conflict: null,
            execution,
            target: "task",
            workspace: live.workspaces.find((w) => w.status === "ready")!,
          })}
          held={false}
          execution={execution}
          inputRef={input}
          onChangeText={() => undefined}
          onChooseAI={() => undefined}
          onSend={onSend}
          placeholder="Task"
          usageScope={{ deploymentId: "deployment-1", userId: "user-1" }}
          quote={null}
          onRemoveQuote={() => undefined}
          savedAttachmentKeys={[]}
          selectionLabel={cursor.models[0]!.displayName}
          sending={false}
          staged={staged}
          text="Start this task"
          underHeader={false}
        >
          {null}
        </FirstMessageComposer>
      );
    }
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<Draft />));
    expect(button("Send message")?.disabled).toBe(true);
    expect(document.body.textContent).toContain("Cursor can't run in Auto");
    const capsule = document.querySelector('[aria-label^="AI: Cursor"]');
    expect(capsule?.getAttribute("aria-description")).toContain(
      "Cursor can't run in Auto. Choose another access mode.",
    );
    expect(document.querySelector('[aria-label^="Access:"]')).toBeNull();
    const { beginFirstMessagePickerAttempt } =
      await import("../thread/first-message-picker-attempt.js");
    const attempt = beginFirstMessagePickerAttempt();
    const accepted = vi.fn();
    void attempt.result.then(accepted);
    await act(async () =>
      root!.render(
        <NewThreadScreen
          route={{ params: { deploymentId: "test-deployment", pickerAttemptId: attempt.id } }}
        />,
      ),
    );
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="This conversation"]')!.click(),
    );
    expect(
      Array.from(document.querySelectorAll<HTMLButtonElement>('[role="radio"]')).find((button) =>
        button.textContent?.startsWith("AutoCursor"),
      )?.disabled,
    ).toBe(true);
    expect(remember).not.toHaveBeenCalled();
    let complete: (() => void) | undefined;
    remember.mockImplementationOnce(async () => {
      move({
        ...snapshot,
        executionPreferences: { ...snapshot.executionPreferences, accessMode: "approval-required" },
      });
      await new Promise<void>((resolve) => {
        complete = resolve;
      });
      return snapshot.executionPreferences;
    });
    await press("Supervised");
    expect(remember).toHaveBeenCalledExactlyOnceWith({ accessMode: "approval-required" });
    expect(onSend).not.toHaveBeenCalled();
    await press("Done");
    expect(accepted).not.toHaveBeenCalled();
    await act(async () => complete!());
    expect(accepted).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ harnessInstanceId: cursor.harnessInstanceId }),
    );
    await act(async () => root!.render(<Draft />));
    expect(button("Send message")?.disabled).toBe(false);
    await press("Send message");
    expect(onSend).toHaveBeenCalledExactlyOnceWith(null);
  });

  it("keeps one single-line AI capsule with full reasoning and access semantics", async () => {
    const { ComposerPills } = await import("../thread/composer-pills.js");
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root!.render(
        <ComposerPills
          accessMode="auto"
          accessModes={cursor.accessModes}
          disabledReason={null}
          engineName="Cursor"
          modelLabel="Composer 2.5"
          model={codex.models[0]!}
          modelOptions={{ effort: "high" }}
          onOpenModel={() => undefined}
          onPresent={() => undefined}
        />,
      ),
    );
    const capsule = document.querySelector('[aria-label="AI: Cursor · Composer 2.5 · High"]');
    expect(capsule?.textContent).toBe("Composer 2.5 High · Unavailable");
    expect(document.querySelectorAll("button")).toHaveLength(1);
    expect(capsule?.getAttribute("aria-description")).toContain("Access: Auto");
    expect(capsule?.getAttribute("aria-description")).toContain("Cursor cannot enforce this mode");
    expect(capsule?.querySelectorAll('[data-lines="1"][data-ellipsis="tail"]')).toHaveLength(1);
  });

  it("edits the current choice's options and access from the root sheet", async () => {
    await mount();
    await act(async () =>
      move({
        ...snapshot,
        environments: snapshot.environments.map((environment) => ({
          ...environment,
          harnessCatalogs: environment.harnessCatalogs.map((catalog) =>
            catalog.harnessInstanceId !== codex.harnessInstanceId
              ? catalog
              : {
                  ...catalog,
                  models: catalog.models.map((model) =>
                    model.modelId !== codex.models[0]!.modelId
                      ? model
                      : {
                          ...model,
                          options: [
                            ...model.options,
                            {
                              type: "toggle" as const,
                              id: "cache",
                              label: "Cache",
                              defaultValue: false,
                            },
                          ],
                        },
                  ),
                },
          ),
        })),
      }),
    );

    expect(document.body.textContent).toContain(codex.models[0]!.displayName);
    await act(async () =>
      document
        .querySelector<HTMLElement>('[role="adjustable"]')!
        .dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })),
    );
    expect(execution).toHaveBeenCalledExactlyOnceWith(original.id, {
      harnessInstanceId: codex.harnessInstanceId,
      modelSelection: { ...codex.modelSelection, options: { effort: "medium" } },
    });
    expect(navigation.goBack).not.toHaveBeenCalled();
    await press("Fast");
    expect(execution).toHaveBeenLastCalledWith(original.id, {
      harnessInstanceId: codex.harnessInstanceId,
      modelSelection: { ...codex.modelSelection, options: { effort: "high", speed: "priority" } },
    });
    const toggle = document.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Cache"]');
    expect(toggle?.getAttribute("aria-checked")).toBe("false");
    await act(async () => toggle!.click());
    expect(execution).toHaveBeenLastCalledWith(original.id, {
      harnessInstanceId: codex.harnessInstanceId,
      modelSelection: { ...codex.modelSelection, options: { effort: "high", cache: true } },
    });
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="This conversation"]')!.click(),
    );
    await press("Full access");
    expect(access).toHaveBeenCalledExactlyOnceWith(original.id, "full-access");
    expect(navigation.goBack).not.toHaveBeenCalled();
  });

  it("returns reasoning to the automatic choice", async () => {
    await mount();
    await act(async () =>
      move({
        ...snapshot,
        environments: snapshot.environments.map((environment) => ({
          ...environment,
          harnessCatalogs: environment.harnessCatalogs.map((catalog) => ({
            ...catalog,
            models: catalog.models.map((model) => ({
              ...model,
              options: model.options.map((option) =>
                option.type === "select" && option.id === "effort"
                  ? { ...option, values: [{ value: "auto", label: "Default" }, ...option.values] }
                  : option,
              ),
            })),
          })),
        })),
      }),
    );
    await press("Default");
    expect(execution).toHaveBeenCalledExactlyOnceWith(original.id, {
      harnessInstanceId: codex.harnessInstanceId,
      modelSelection: { ...codex.modelSelection, options: { effort: "auto" } },
    });
    expect(navigation.goBack).not.toHaveBeenCalled();
  });

  it("opens This conversation from the usage notice", async () => {
    await mount();
    const { UsageNotice } = await import("../thread/usage-notice.js");
    const { usageLimitNotice } = await import("@opensteer/client/host");
    const exhausted = {
      ...codex,
      observedConnections: [
        {
          accountLabel: "demo@opensteer.test",
          authKind: "subscription" as const,
          billingLabel: "Pro",
          connectionSlot: "chatgpt",
          label: "ChatGPT",
          status: "connected" as const,
          usage: {
            limitReached: true,
            observedAt: new Date().toISOString(),
            windows: [
              {
                label: "weekly",
                resetsAt: new Date(Date.now() + 86400000).toISOString(),
                usedPercent: 100,
              },
            ],
          },
        },
      ],
    };
    const selection = {
      environmentId: codex.environmentId,
      harnessInstanceId: codex.harnessInstanceId,
      modelSelection: codex.modelSelection,
    };
    await act(async () =>
      root!.render(
        <UsageNotice
          notice={usageLimitNotice({
            placements: [exhausted, second],
            selection,
            scope: { deploymentId: "test-deployment", userId: "test-user" },
          })}
          onOpen={() =>
            root!.render(
              <ThreadSettingsScreen
                route={{
                  params: {
                    deploymentId: "test-deployment",
                    threadId: original.id,
                    conversation: true,
                  },
                }}
              />,
            )
          }
        />,
      ),
    );
    expect(document.body.textContent).toContain("Codex usage limit · Resets");
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label^="Codex usage limit"]')!.click(),
    );
    expect(document.body.textContent).toContain("This conversation");
    expect(document.body.textContent).toContain("Account");
  });

  it("shows a failed access mutation without changing the selected access", async () => {
    await mount();
    access.mockRejectedValueOnce(new Error("Access refused"));
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="This conversation"]')!.click(),
    );
    await press("Full access");
    expect(document.body.textContent).toContain("Access refused");
    expect(snapshot.threads[0]!.accessMode).toBe("approval-required");
    expect(execution).not.toHaveBeenCalled();
  });

  it("starts fresh on the current route only after review", async () => {
    await mount();
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="This conversation"]')!.click(),
    );
    await press("Start fresh with Codex");
    expect(execution).not.toHaveBeenCalled();
    await press("Start fresh");
    expect(execution).toHaveBeenCalledExactlyOnceWith(
      original.id,
      expect.objectContaining({ harnessInstanceId: codex.harnessInstanceId }),
      { expectedProviderSessionId: "session-1" },
    );
  });
});
