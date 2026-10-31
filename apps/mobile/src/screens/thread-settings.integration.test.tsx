import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { unwrapRpcResult, type HttpHostClient } from "@opensteer/client/host";

import { afterEach, describe, expect, it, vi } from "vitest";

// Voice's controls animate with Reanimated, which cannot load here; these tests are not about voice.
vi.mock("../voice/controls.js", () => ({
  VoiceDock: () => null,
  VoiceMic: () => null,
  useVoiceAvailable: () => false,
}));

import { type ModelSelection, type WorkspaceId } from "@opensteer/core";
import type { HarnessModelDescriptor, HostApiClient } from "@opensteer/protocol";

import {
  mobile,
  navigation,
  ThreadSettingsScreen,
  NewThreadScreen,
} from "./thread-settings.test-support.js";
// Import the Node fixture at runtime so Expo's TypeScript program does not
// merge its native globals into the Host/Runner programs.
interface InspectionStack {
  readonly api: HostApiClient;
  readonly catalog: { readonly models: readonly HarnessModelDescriptor[] };
  readonly environmentId: string;
  readonly harnessInstanceId: string;
  readonly mainWorkspaceId: WorkspaceId;
  close(): Promise<void>;
  createThread(input: {
    modelSelection: ModelSelection;
    title: string;
    workspaceId: WorkspaceId;
  }): Promise<string>;
}
const fixtureModule = "../../../host/src/agents/engine-inspection.test-support.js";
const { startEngineInspectionStack, engineInspectionViewer } = (await import(fixtureModule)) as {
  startEngineInspectionStack(
    databaseUrl: string,
    scratch: string,
  ): Promise<{ stack: InspectionStack; state: string }>;
  engineInspectionViewer(stack: InspectionStack): HttpHostClient;
};

const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
integration("Expo external engine sign-in recovery", () => {
  let stack: InspectionStack | undefined;
  let scratch: string | undefined;
  let root: Root | undefined;
  let client: HttpHostClient | undefined;
  afterEach(async () => {
    await act(async () => root?.unmount());
    client?.dispose();
    mobile.hostClient = null;
    navigation.goBack.mockClear();
    document.body.replaceChildren();
    await stack?.close();
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }, 60_000);

  it.each(["existing", "new"] as const)(
    "refreshes a signed-in external CLI from the %s-thread picker",
    async (context) => {
      scratch = await mkdtemp(join(tmpdir(), "opensteer-expo-inspection-"));
      const started = await startEngineInspectionStack(databaseUrl!, scratch);
      stack = started.stack;
      const { state } = started;
      const active = stack;
      const model = active.catalog.models.find(
        (candidate) => candidate.modelId === "composer-2.5",
      )!;
      const threadId = await active.createThread({
        modelSelection: { modelId: model.modelId, providerId: model.providerId, options: {} },
        title: "Expo recovery",
        workspaceId: active.mainWorkspaceId,
      });
      await writeFile(state, "logged-out");
      unwrapRpcResult(
        await active.api["harness.catalog.refresh"]({
          environmentId: active.environmentId,
          harnessInstanceId: active.harnessInstanceId,
        }),
      );
      client = engineInspectionViewer(active);
      await client.load();
      client.activateWorkspace(active.mainWorkspaceId);
      await expect
        .poll(() => client!.getSnapshot().connection, { timeout: 10_000 })
        .toBe("connected");
      mobile.hostClient = client;
      const rpc = client.rpc;
      const refresh = vi.fn(rpc["harness.catalog.refresh"]);
      Object.defineProperty(client, "rpc", {
        value: new Proxy(rpc, {
          get: (target, key) =>
            key === "harness.catalog.refresh" ? refresh : Reflect.get(target, key),
        }),
      });
      const container = document.createElement("div");
      document.body.append(container);
      root = createRoot(container);
      await act(async () =>
        root!.render(
          context === "existing" ? (
            <ThreadSettingsScreen
              route={{ params: { deploymentId: "test-deployment", threadId } }}
            />
          ) : (
            <NewThreadScreen route={{ params: { deploymentId: "test-deployment" } }} />
          ),
        ),
      );
      const button = (label: string) =>
        Array.from(document.querySelectorAll("button")).find((item) =>
          item.textContent?.includes(label),
        );
      expect(refresh).not.toHaveBeenCalled();
      const engine = Array.from(document.querySelectorAll("button")).find((item) =>
        item.textContent?.startsWith("Cursor"),
      );
      expect(engine).toBeDefined();
      await act(async () => engine!.click());
      expect(document.body.textContent).toContain("Sign in to use Cursor");
      const checkAgain = button("Sign in");
      expect(checkAgain).toBeDefined();
      const before = container.innerHTML;
      await writeFile(state, "happy");
      await act(async () => {
        checkAgain!.click();
        checkAgain!.click();
      });
      await act(async () => {
        await expect
          .poll(
            () =>
              client!
                .getSnapshot()
                .environments.flatMap((environment) => environment.harnessCatalogs)
                .find((catalog) => catalog.harnessInstanceId === active.harnessInstanceId)?.status,
            { timeout: 10_000 },
          )
          .toBe("ready");
      });
      if (!button(model.displayName)) {
        const account = button("Cursor");
        if (account) await act(async () => account.click());
      }
      await act(async () => {
        await expect.poll(() => button(model.displayName), { timeout: 10_000 }).toBeDefined();
      });
      expect(refresh).toHaveBeenCalledExactlyOnceWith({
        environmentId: active.environmentId,
        harnessInstanceId: active.harnessInstanceId,
      });
      const selectable = button(model.displayName)!;
      expect(selectable.disabled).toBe(false);
      const after = container.innerHTML;
      await act(async () => selectable.click());
      if (context === "new") {
        await act(async () => {
          await expect
            .poll(
              () => client!.getSnapshot().executionPreferences.history[0]?.modelSelection.modelId,
              { timeout: 10_000 },
            )
            .toBe(model.modelId);
        });
      }
      expect(navigation.goBack).toHaveBeenCalled();
      const artifactDirectory =
        process.env.OPENSTEER_ENGINE_INSPECTION_ARTIFACT_DIR ??
        (await mkdtemp(join(tmpdir(), "opensteer-expo-inspection-evidence-")));
      await mkdir(artifactDirectory, { recursive: true });
      await writeFile(
        join(artifactDirectory, `expo-${context}.json`),
        JSON.stringify(
          { context, refreshCalls: refresh.mock.calls, model, before, after },
          null,
          2,
        ) + "\n",
      );
    },
    60_000,
  );
});
