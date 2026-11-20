import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPluginSnapshot, pluginSnapshotDigest } from "@opensteer/agent-plugins";
import type { AgentGrant, ThreadAccessMode } from "@opensteer/core";
import { AgentConnectionStore, TriggerStore } from "@opensteer/database";
import {
  createStoreFixture,
  describeStore,
  testReadyHarnessCatalog,
} from "@opensteer/database/test-support/store";
import { CommandDispatchError, type RunnerRegistry } from "@opensteer/orchestration";
import type { RunnerCommand } from "@opensteer/protocol";
import { expect } from "vitest";
import {
  packageStillGranted,
  PluginPackageService,
  type PluginPackagesTokenService,
} from "../local-servers/plugin-package-service.js";
import {
  connection,
  createTask,
  queuedRun,
  serveMcp,
} from "../mcp/connection-caller.test-support.js";
import { HostCommandDispatcher } from "./dispatcher.js";

type Fixture = Awaited<ReturnType<typeof createStoreFixture>>;

const pluginA = { pluginId: "plugin_a", name: "a", digest: "a".repeat(64) };
const pluginB = { pluginId: "plugin_b", name: "b", digest: "b".repeat(64) };
const plugin = (pluginId: string) =>
  ({ kind: "plugin", target: { kind: "installed", pluginId }, access: "read-write" }) as const;

/** The real dispatcher, with a Runner that runs the send fence and then takes the command. */
function dispatcher(
  storeFixture: Fixture,
  runnerId: string,
  hooks: { readonly planning: () => Promise<void> },
  sent: RunnerCommand[],
  issued: (readonly string[])[],
) {
  const { store } = storeFixture;
  const identity = {
    bootId: "fixture-boot",
    capabilities: [
      "native-session-continuation-v1",
      "assignments-v1",
      "thread-state-v1",
      "execution-plane-v2",
      "agent-tools-plan-v1",
    ],
    modules: { agents: { computerTool: 1 } },
    name: "Fixture computer",
    runnerId,
  };
  return new HostCommandDispatcher({
    store,
    triggers: new TriggerStore(store.database),
    executionLeaseMs: 90_000,
    publicUrl: new URL("https://host.test"),
    requestResponseVault: {} as never,
    runToolTokens: { issue: () => "tools" } as never,
    attachmentRunTokens: { issue: () => "attachments" } as never,
    attachments: { listForRun: async () => [] },
    browser: { hasBrowserProfiles: async () => false },
    egress: { issue: () => ({ allowedHosts: [], token: "egress" }) } as never,
    pluginVersions: async () => {
      await hooks.planning();
      return [pluginA, pluginB];
    },
    pluginsTokens: {
      issue: (claims: { readonly pluginDigests: readonly string[] }) => {
        issued.push(claims.pluginDigests);
        return "plugins";
      },
    } as never,
    triggerControlTokens: { issue: () => "control" } as never,
    teamRequestContext: async () => {
      throw new Error("Unexpected team request");
    },
    runners: {
      identityForEnvironment: (environmentId: string) => ({ ...identity, environmentId }),
      canRunHarness: () => true,
      supportsMessageAttachments: () => false,
      connectionGenerationFor: () => 1,
      inspectHarnesses: async (_environment: unknown, harnesses: readonly { id: string }[]) =>
        harnesses.map((harness) => testReadyHarnessCatalog(harness.id as never)),
      // RunnerRegistry's contract: the caller's last check, then the command, nothing between.
      dispatch: async (
        command: RunnerCommand,
        _signal: AbortSignal,
        options?: { readonly beforeSend?: () => Promise<void> },
      ) => {
        await options?.beforeSend?.();
        sent.push(command);
        return { type: "runner.command-accepted" };
      },
    } as unknown as RunnerRegistry,
  });
}

describeStore("a connected agent's authority at the send", (it) => {
  const cases: readonly {
    readonly name: string;
    readonly accessMode: ThreadAccessMode;
    readonly grant: AgentGrant;
    readonly change: { readonly accessMode?: ThreadAccessMode; readonly grant?: AgentGrant };
    readonly expected: { readonly accessMode: ThreadAccessMode; readonly digests: string[] };
  }[] = [
    {
      name: "a lowered mode",
      accessMode: "full-access",
      grant: { scope: "selected", tasks: true, resources: [plugin(pluginA.pluginId)] },
      change: { accessMode: "auto" },
      expected: { accessMode: "auto", digests: [pluginA.digest] },
    },
    {
      name: "a new grant revision in the same mode",
      accessMode: "full-access",
      grant: { scope: "selected", tasks: true, resources: [plugin(pluginA.pluginId)] },
      change: {
        grant: {
          scope: "selected",
          tasks: true,
          resources: [plugin(pluginA.pluginId), plugin(pluginB.pluginId)],
        },
      },
      expected: { accessMode: "full-access", digests: [pluginA.digest, pluginB.digest] },
    },
  ];
  it("refuses a Run planned under authority that changed before the send, then sends under the new one", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("dispatch-fence");
    const url = await serveMcp(storeFixture);
    const { database, store } = storeFixture;
    for (const [index, item] of cases.entries()) {
      const agent = await connection(store, url, {
        userId: f.userId,
        accessMode: item.accessMode,
        grant: item.grant,
      });
      const task = await createTask(agent, f, `dispatch-fence-${index}`);
      const run = await queuedRun(storeFixture, task);
      const command = await database
        .selectFrom("commands")
        .select("id")
        .where("runId", "=", run.id)
        .where("type", "=", "run.execute")
        .executeTakeFirstOrThrow();
      const sent: RunnerCommand[] = [];
      const issued: (readonly string[])[] = [];
      let changeOnce = true;
      const planning = async () => {
        if (!changeOnce) return;
        changeOnce = false;
        // Committed while the dispatcher plans; its effects (a narrowing's Stop) have not run.
        await new AgentConnectionStore(database).update(f.userId, {
          connectionId: agent.id,
          expectedRevision: 1,
          ...item.change,
        });
      };
      const { runnerId } = await database
        .selectFrom("executionEnvironments")
        .select("runnerId")
        .where("id", "=", f.environmentId)
        .executeTakeFirstOrThrow();
      const dispatch = dispatcher(storeFixture, runnerId!, { planning }, sent, issued);
      const first = await store.claimCommand(command.id, "fence-test");
      if (!first) throw new Error("Expected the Run's command");
      const refused = await dispatch.dispatch(first.command, new AbortController().signal).then(
        () => null,
        (error: unknown) => error,
      );
      expect(refused, item.name).toBeInstanceOf(CommandDispatchError);
      expect(refused, item.name).toMatchObject({
        disposition: "retry",
        message: "This connected agent's access changed while the Run was being prepared.",
      });
      expect(sent, `${item.name}: the Runner received nothing`).toEqual([]);
      await store.retryCommand(command.id, refused);
      const second = await store.claimCommand(command.id, "fence-test");
      if (!second) throw new Error("Expected the retried command");
      await dispatch.dispatch(second.command, new AbortController().signal);
      const [received] = sent;
      if (received?.type !== "run.execute") throw new Error(`${item.name}: nothing was sent`);
      expect(
        {
          accessMode: received.context.accessMode,
          plugins: received.context.plugins?.versions.map(({ digest }) => digest),
          token: issued.at(-1),
        },
        item.name,
      ).toEqual({
        accessMode: item.expected.accessMode,
        plugins: item.expected.digests,
        token: item.expected.digests,
      });
    }
  });

  it("refuses a pinned package once the grant no longer reaches its plugin, before the Run stops", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("package-withdrawn");
    const url = await serveMcp(storeFixture);
    const { database, store } = storeFixture;
    const root = await mkdtemp(join(tmpdir(), "package-withdrawn-"));
    try {
      const digests: string[] = [];
      for (const name of ["a", "b"]) {
        const source = join(root, `source-${name}`);
        await mkdir(source);
        await writeFile(join(source, "tool.sh"), `echo ${name}`);
        const digest = pluginSnapshotDigest(await readPluginSnapshot(source));
        await (await import("node:fs/promises")).rename(source, join(root, digest));
        digests.push(digest);
      }
      const [digestA, digestB] = digests as [string, string];
      const installed = [
        { id: pluginA.pluginId, digest: digestA },
        { id: pluginB.pluginId, digest: digestB },
      ];
      const agent = await connection(store, url, {
        userId: f.userId,
        accessMode: "full-access",
        grant: {
          scope: "selected",
          tasks: true,
          resources: [plugin(pluginA.pluginId), plugin(pluginB.pluginId)],
        },
      });
      const run = await queuedRun(storeFixture, await createTask(agent, f, "package-withdrawn"));
      const service = new PluginPackageService({
        snapshotDirectory: root,
        tokens: {
          authenticate: async () => ({
            pluginDigests: digests,
            requestedBy: f.userId,
            runId: run.id,
          }),
        } as unknown as PluginPackagesTokenService,
        stillGranted: packageStillGranted({ store, installed: async () => installed }),
      });
      for (const digest of digests) expect(await service.snapshot("run", digest)).toHaveLength(1);
      await new AgentConnectionStore(database).update(f.userId, {
        connectionId: agent.id,
        expectedRevision: 1,
        grant: { scope: "selected", tasks: true, resources: [plugin(pluginA.pluginId)] },
      });
      expect(await service.snapshot("run", digestA)).toHaveLength(1);
      await expect(service.snapshot("run", digestB)).rejects.toMatchObject({
        code: "forbidden",
        message: "Package is not pinned to this Run",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
