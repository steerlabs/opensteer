import { KeyedMutationQueue } from "@opensteer/shared/mutationQueue";
import { createHash } from "node:crypto";
import { type AdministrationCommandIdentity } from "@opensteer/database";
import { z } from "zod";
import {
  EnvironmentIdSchema,
  OpensteerError,
  RunnerIdSchema,
  WorkspaceSchema,
  type EnvironmentId,
  type WorkspaceId,
} from "@opensteer/core";
import {
  hostApi,
  PendingBrowserProfileDeletionSchema,
  HarnessModelSettingsMapSchema,
  type HostApiCommand,
  type HostApiCommandOutput,
} from "@opensteer/protocol";
import type { HostServerDependencies } from "../server.js";
import type { AgentCaller } from "../mcp/agent-caller.js";
import { settings } from "../mcp/tool-access.js";
import { notifyMachinesChanged } from "../shell/machine-access-events.js";
import {
  boundRunnerEnvironmentIds,
  harnessAuthenticationIsAllowed,
  harnessView,
  requireMachineAccessManagement,
  workspaceView,
} from "./authority.js";
import {
  assertAdministrator,
  executeIntegrationAdministration,
  isIntegrationAdministrationCommand,
  type AdministrationActor,
} from "../integrations/integration-administration.js";

export type AdministrationCaller =
  AgentCaller | ({ readonly kind: "person" } & AdministrationActor);
export type AdministrationDependencies = Pick<
  HostServerDependencies,
  | "store"
  | "commands"
  | "workspaces"
  | "workspaceDeletion"
  | "apps"
  | "browser"
  | "browserSources"
  | "shellControl"
  | "computerApps"
  | "runners"
  | "channels"
  | "realtime"
  | "publishWorkspaceEvent"
> & {
  readonly integrations: Pick<
    HostServerDependencies["integrations"],
    "platform" | "service" | "continuations"
  >;
};
const coreTypes = [
  "workspace.notifications.update",
  "viewer.timeZone.update",
  "workspace.storage.retry",
  "workspace.icon.set",
  "workspace.color.set",
  "workspace.delete",
  "workspace.deletion.recover",
  "execution.preferences.remember",
  "automaticModels.set",
  "harness.model.configure",
  "harness.rename",
  "harness.enabled.set",
  "harness.default.set",
  "machine.revoke",
  "machine.rename",
  "machine.access.session.stop",
  "browser.profile.rename",
  "browser.profile.delete",
  "browser.profileGrant.revoke",
  "browser.history.remove",
  "browser.history.clear",
] as const;
type CoreAdministrationCommand = Extract<HostApiCommand, { type: (typeof coreTypes)[number] }>;
export type AdministrationCommand =
  | CoreAdministrationCommand
  | Extract<
      HostApiCommand,
      { type: "browser.site.remove" | "channel.binding.revoke" | "channel.connection.status.set" }
    >
  | Parameters<typeof executeIntegrationAdministration>[2];
export function isAdministrationCommand(
  command: HostApiCommand,
): command is CoreAdministrationCommand {
  return coreTypes.some((type) => command.type === type);
}
export function assertWorkspaceReach(caller: AgentCaller, workspaceId: WorkspaceId) {
  if (
    caller.reach.kind === "user" ||
    (caller.reach.kind === "workspace" && caller.reach.workspaceId === workspaceId)
  )
    return;
  throw new OpensteerError({
    code: "forbidden",
    message: "Workspace is outside the caller's reach",
  });
}
export function assertUserReach(caller: AgentCaller) {
  if (caller.reach.kind !== "user")
    throw new OpensteerError({
      code: "forbidden",
      message: "This action requires user-wide reach",
    });
}
export class AdministrationService {
  readonly #mutations = new KeyedMutationQueue();
  readonly dependencies: AdministrationDependencies;
  readonly scheduleHarnesses: (id: EnvironmentId) => void;
  readonly warn: (fields: Record<string, unknown>, message: string) => void;
  constructor(
    dependencies: AdministrationDependencies,
    scheduleHarnesses: (id: EnvironmentId) => void,
    warn: (fields: Record<string, unknown>, message: string) => void = () => {},
  ) {
    this.dependencies = dependencies;
    this.scheduleHarnesses = scheduleHarnesses;
    this.warn = warn;
  }
  async actor(caller: AdministrationCaller): Promise<AdministrationActor> {
    if (caller.kind === "person") return caller;
    const user = await this.dependencies.store.userById(caller.userId);
    if (!user || user.disabledAt)
      throw new OpensteerError({ code: "forbidden", message: "Caller is unavailable" });
    return { userId: caller.userId, isAdministrator: user.instanceRole === "administrator" };
  }
  async authorize(caller: AdministrationCaller, command: AdministrationCommand) {
    if (caller.kind === "person") return;
    if (command.type.startsWith("automaticModels."))
      throw new OpensteerError({
        code: "forbidden",
        message: "Automatic model preferences require the person",
      });
    settings(caller, []);
    if ("workspaceId" in command) {
      assertWorkspaceReach(caller, command.workspaceId);
      const membership = await this.dependencies.store.workspaceMembershipForUser(
        command.workspaceId,
        caller.userId,
      );
      if (membership?.state !== "active")
        throw new OpensteerError({
          code: "forbidden",
          message: "Active Workspace membership is required",
        });
    } else if (command.type === "channel.binding.revoke") {
      const binding = await this.dependencies.store.database
        .selectFrom("channelBindings")
        .innerJoin("channelAccounts", "channelAccounts.id", "channelBindings.accountId")
        .innerJoin(
          "integrationConnections",
          "integrationConnections.id",
          "channelAccounts.connectionId",
        )
        .select("channelBindings.workspaceId")
        .where("channelBindings.id", "=", command.bindingId)
        .where("integrationConnections.ownerUserId", "=", caller.userId)
        .executeTakeFirst();
      if (!binding)
        throw new OpensteerError({ code: "not_found", message: "Channel route not found" });
      assertWorkspaceReach(caller, binding.workspaceId);
    } else if (command.type === "browser.profileGrant.revoke") {
      const grant = await this.dependencies.store.database
        .selectFrom("browserProfileGrants")
        .select("workspaceId")
        .where("id", "=", command.grantId)
        .where("createdBy", "=", caller.userId)
        .executeTakeFirst();
      if (!grant)
        throw new OpensteerError({ code: "not_found", message: "Browser profile grant not found" });
      assertWorkspaceReach(caller, grant.workspaceId);
    } else {
      assertUserReach(caller);
    }
  }
  async admitHarnessManagement(actor: AdministrationActor, environmentIdInput: string) {
    const environmentId = EnvironmentIdSchema.parse(environmentIdInput);
    const environment = (await this.dependencies.store.listEnvironmentsForUser(actor.userId)).find(
      (candidate) => candidate.id === environmentId,
    );
    if (!environment)
      throw new OpensteerError({ code: "not_found", message: "Work location not found" });
    if (
      !harnessAuthenticationIsAllowed({
        environment,
        isInstanceAdministrator: actor.isAdministrator,
        boundEnvironmentIds: actor.isAdministrator
          ? new Set()
          : await boundRunnerEnvironmentIds(this.dependencies.store, actor.userId),
      })
    )
      throw new OpensteerError({
        code: "forbidden",
        message: "This work location's AI engines are administered by the Deployment",
      });
    return environment;
  }
  async execute(
    caller: AdministrationCaller,
    command: AdministrationCommand,
  ): Promise<HostApiCommandOutput> {
    if (caller.kind === "person") return this.#authorizedExecute(caller, command);
    return this.#mutations.run(JSON.stringify([caller.userId, command.idempotencyKey]), () =>
      this.#authorizedExecute(caller, command),
    );
  }
  async #authorizedExecute(
    caller: AdministrationCaller,
    command: AdministrationCommand,
  ): Promise<HostApiCommandOutput> {
    await this.authorize(caller, command);
    const actor = await this.actor(caller);
    const administration =
      caller.kind === "person" ? undefined : this.#commandIdentity(caller, command);
    if (administration) {
      if (command.type.startsWith("harness.") && "environmentId" in command)
        await this.admitHarnessManagement(actor, command.environmentId);
      if (["plugin.remove", "plugin.update", "integration.uninstall"].includes(command.type))
        assertAdministrator(actor);
      const replay = await this.dependencies.store.replayAdministrationCommand(administration);
      if (replay?.output) return hostApi["commands.dispatch"].success.parse(replay.output);
      if (replay && command.type === "machine.access.session.stop")
        return hostApi["commands.dispatch"].success.parse({
          type: command.type,
          ...z.object({ ended: z.boolean() }).parse(replay.result),
        });
    }
    const result = await this.#execute(caller, actor, command, administration);
    if (
      command.type.startsWith("workspace.") ||
      command.type.startsWith("harness.") ||
      command.type.startsWith("automaticModels.") ||
      command.type === "execution.preferences.remember" ||
      command.type === "viewer.timeZone.update" ||
      command.type === "browser.site.remove"
    )
      notifyMachinesChanged(this.dependencies.realtime, "unspecified");
    return result;
  }
  #commandIdentity(
    caller: AgentCaller,
    command: AdministrationCommand,
  ): AdministrationCommandIdentity {
    const { idempotencyKey, type, ...fields } = command;
    const request =
      type === "browser.history.remove"
        ? {
            profileId: command.profileId,
            urlFingerprint: createHash("sha256")
              .update(`${command.profileId}\0${command.url}`)
              .digest("base64url"),
          }
        : fields;
    return {
      requestedBy: caller.userId,
      idempotencyKey,
      type,
      request: z.record(z.string(), z.unknown()).parse(JSON.parse(JSON.stringify(request))),
      authoritySource: { kind: "mcp", callerKind: caller.kind, callerKey: caller.key },
      output: async (result) => {
        let fields: Record<string, unknown> = {};
        if (
          [
            "workspace.icon.set",
            "workspace.color.set",
            "workspace.deletion.recover",
            "workspace.storage.retry",
          ].includes(command.type)
        )
          fields = {
            workspace: await workspaceView(
              this.dependencies.workspaces,
              WorkspaceSchema.parse(result),
            ),
          };
        if (command.type === "workspace.delete")
          fields = {
            workspace: await workspaceView(
              this.dependencies.workspaces,
              WorkspaceSchema.parse(z.object({ workspace: z.unknown() }).parse(result).workspace),
            ),
          };
        if (command.type.startsWith("harness.")) {
          const harness = z.record(z.string(), z.unknown()).parse(result);
          const config = z
            .object({ models: HarnessModelSettingsMapSchema.optional() })
            .safeParse(harness.config);
          fields = {
            harness: {
              ...harness,
              ...(config.success && config.data.models
                ? { modelSettings: config.data.models }
                : {}),
            },
          };
        }
        if (command.type === "execution.preferences.remember") fields = { preferences: result };
        if (command.type === "viewer.timeZone.update") fields = { timeZone: result };
        if (command.type === "workspace.notifications.update")
          fields = z.record(z.string(), z.unknown()).parse(result);
        if (command.type === "integration.disconnect")
          fields = { notice: null, revokedUpstream: false };
        if (command.type === "integration.uninstall") {
          const removed = z
            .object({
              cancelledRequestIds: z.array(z.string()),
              removedConnectionIds: z.array(z.string()),
            })
            .parse(result);
          fields = {
            cancelledRequests: removed.cancelledRequestIds.length,
            removedConnections: removed.removedConnectionIds.length,
          };
        }
        if (command.type === "browser.profile.delete")
          fields = z
            .object({ deletion: PendingBrowserProfileDeletionSchema.optional() })
            .parse(result);
        if (command.type === "browser.profile.rename") fields = { profile: result };
        return hostApi["commands.dispatch"].success.parse({ type: command.type, ...fields });
      },
    };
  }
  async #execute(
    caller: AdministrationCaller,
    actor: AdministrationActor,
    command: AdministrationCommand,
    administration?: AdministrationCommandIdentity | undefined,
  ): Promise<HostApiCommandOutput> {
    const { userId, isAdministrator } = actor;
    const dependencies = this.dependencies;
    const publishWorkspaceEvent =
      dependencies.publishWorkspaceEvent ?? ((event) => dependencies.realtime.publish(event));
    if (isIntegrationAdministrationCommand(command)) {
      const result = await executeIntegrationAdministration(
        {
          platform: dependencies.integrations.platform,
          integrations: dependencies.integrations.service,
        },
        actor,
        command,
        command.idempotencyKey,
        administration,
      );
      if (command.type.startsWith("plugin.") || command.type === "specialist.remove")
        notifyMachinesChanged(dependencies.realtime, "integration.connections");
      return result;
    }
    switch (command.type) {
      case "browser.site.remove":
        await dependencies.browserSources.removeSite({
          administration,
          ownerId: userId,
          workspaceId: command.workspaceId,
          site: command.site,
        });
        return { type: command.type };
      case "channel.binding.revoke":
        await dependencies.channels.service.revokeBinding(
          command.bindingId,
          userId,
          administration,
        );
        return { type: command.type };
      case "channel.connection.status.set":
        await dependencies.channels.service.setConnectionStatus(
          command.connectionId,
          userId,
          command.status,
          administration,
        );
        return { type: command.type };
      case "workspace.notifications.update": {
        const preference = await dependencies.store.notificationState.setAgentNotificationMute({
          administration,
          workspaceId: command.workspaceId,
          muted: command.muted,
          userId,
        });
        dependencies.realtime.publishNotificationPreference(userId, preference);
        return { type: command.type, ...preference };
      }
      case "viewer.timeZone.update":
        return {
          timeZone: await dependencies.store.notificationState.setTimeZone({
            administration,
            timeZone: command.timeZone,
            userId,
          }),
          type: command.type,
        };
      case "workspace.storage.retry": {
        const workspace = await dependencies.workspaces.retry(
          command.workspaceId,
          userId,
          administration,
        );
        if (workspace.storageIssue) {
          this.warn(
            { storageIssue: workspace.storageIssue.code, workspaceId: workspace.id },
            "Workspace storage retry did not reach ready",
          );
        }
        return {
          type: command.type,
          workspace: await workspaceView(dependencies.workspaces, workspace),
        };
      }
      case "workspace.icon.set": {
        const workspace = await dependencies.workspaces.setIcon({
          administration,
          ...(caller.kind === "person"
            ? {}
            : { authoritySource: { kind: "mcp", callerKind: caller.kind, callerKey: caller.key } }),
          icon: command.icon,
          idempotencyKey: command.idempotencyKey,
          requestedBy: userId,
          workspaceId: command.workspaceId,
        });
        return {
          type: command.type,
          workspace: await workspaceView(dependencies.workspaces, workspace),
        };
      }
      case "workspace.color.set": {
        const workspace = await dependencies.commands.setWorkspaceColor({
          administration,
          ...(caller.kind === "person"
            ? {}
            : { authoritySource: { kind: "mcp", callerKind: caller.kind, callerKey: caller.key } }),
          color: command.color,
          idempotencyKey: command.idempotencyKey,
          requestedBy: userId,
          workspaceId: command.workspaceId,
        });
        return {
          type: command.type,
          workspace: await workspaceView(dependencies.workspaces, workspace),
        };
      }
      case "workspace.delete": {
        const affected = await dependencies.integrations.platform.store.settings.affectedViewers({
          workspaceId: command.workspaceId,
        });
        const workspace = await dependencies.workspaceDeletion.requestDeletion(
          command.workspaceId,
          userId,
          administration,
        );
        await dependencies.apps.stopWorkspace(command.workspaceId);
        dependencies.realtime.sendToUsers(affected, { type: "host.plugins-changed" });
        return {
          type: command.type,
          workspace: await workspaceView(dependencies.workspaces, workspace),
        };
      }
      case "workspace.deletion.recover": {
        const workspace = await dependencies.workspaceDeletion.recover(
          command.workspaceId,
          userId,
          administration,
        );
        return {
          type: command.type,
          workspace: await workspaceView(dependencies.workspaces, workspace),
        };
      }
      case "automaticModels.set": {
        return {
          type: command.type,
          config: await dependencies.store.setAutomaticModelConfig(userId, command.config),
        };
      }
      case "execution.preferences.remember": {
        // A preference is a hint the Host re-validates when a Thread actually
        // starts, so the model is deliberately not checked against a catalog
        // here — a person may remember a model whose Runner is asleep. What is
        // checked is hygiene: the account exists, it lives on the work location
        // named with it, and that work location is one this person can see.
        const selection = command.selection;
        if (selection) {
          const harness = await dependencies.store.getHarnessInstance(selection.harnessInstanceId);
          if (!harness || harness.environmentId !== selection.environmentId) {
            throw new OpensteerError({
              code: "conflict",
              message: "The selected AI engine is not available",
            });
          }
          const environments = await dependencies.store.listEnvironmentsForUser(userId);
          if (!environments.some(({ id }) => id === selection.environmentId)) {
            throw new OpensteerError({
              code: "not_found",
              message: "The selected place to run this work no longer exists",
            });
          }
        }
        const preferences = await dependencies.store.rememberExecutionChoice(
          userId,
          {
            ...(command.accessMode === undefined ? {} : { accessMode: command.accessMode }),
            ...(selection === undefined ? {} : { selection }),
          },
          administration,
        );
        return { preferences, type: command.type };
      }
      case "harness.model.configure": {
        const environment = await this.admitHarnessManagement(actor, command.environmentId);
        const current = await dependencies.store.getHarnessInstance(command.harnessInstanceId);
        if (!current || current.environmentId !== environment.id || current.removedAt) {
          throw new OpensteerError({ code: "not_found", message: "AI engine not found" });
        }
        const driver = dependencies.runners
          .identityForEnvironment(environment.id)
          ?.modules.agents?.harnessDrivers.find(
            (candidate) => candidate.driverKind === current.driverKind,
          );
        const source =
          driver && driver.readiness !== "unavailable"
            ? driver.sources.find((candidate) => candidate.sourceId === current.sourceId)
            : undefined;
        if (!source?.modelSettings) {
          throw new OpensteerError({
            code: "conflict",
            message:
              "This account does not currently offer model settings. Reconnect its computer and refresh.",
          });
        }
        const config = z.record(z.string(), z.unknown()).parse(current.config);
        const currentModels = HarnessModelSettingsMapSchema.parse(config.models ?? {});
        const catalog = await dependencies.store.getHarnessCatalog(environment.id, current.id);
        if (
          !Object.hasOwn(currentModels, command.nativeModelId) &&
          !(
            catalog?.status === "ready" &&
            catalog.models.some(
              (model) => (model.nativeModelId ?? model.modelId) === command.nativeModelId,
            )
          )
        ) {
          throw new OpensteerError({
            code: "conflict",
            message: "This server has not reported that model. Refresh its model list first.",
          });
        }
        const models =
          command.settings === null
            ? Object.fromEntries(
                Object.entries(currentModels).filter(([id]) => id !== command.nativeModelId),
              )
            : { ...currentModels, [command.nativeModelId]: command.settings };
        const harness = await dependencies.store.updateHarnessInstance({
          id: current.id,
          administration,
          expectedRuntimeRevision: current.runtimeRevision,
          config: { ...config, models },
        });
        this.scheduleHarnesses(environment.id);
        return { harness: harnessView(harness), type: command.type };
      }
      case "harness.rename":
      case "harness.enabled.set": {
        const environment = await this.admitHarnessManagement(actor, command.environmentId);
        const current = await dependencies.store.getHarnessInstance(command.harnessInstanceId);
        if (!current || current.environmentId !== environment.id) {
          throw new OpensteerError({ code: "not_found", message: "AI engine not found" });
        }
        const harness = await dependencies.store.updateHarnessInstance({
          administration,
          ...(command.type === "harness.enabled.set" ? { enabled: command.enabled } : {}),
          id: command.harnessInstanceId,
          ...(command.type === "harness.rename" ? { name: command.name } : {}),
        });
        if (command.type === "harness.enabled.set") {
          this.scheduleHarnesses(environment.id);
        }
        return { harness: harnessView(harness), type: command.type };
      }
      case "harness.default.set": {
        // Which account of an engine a placement lands on is a stored choice,
        // not a configuration change, so no catalog has gone stale here.
        const environment = await this.admitHarnessManagement(actor, command.environmentId);
        const current = await dependencies.store.getHarnessInstance(command.harnessInstanceId);
        if (!current || current.environmentId !== environment.id) {
          throw new OpensteerError({ code: "not_found", message: "AI engine not found" });
        }
        const harness = await dependencies.store.setDefaultHarnessInstance({
          administration,
          environmentId: environment.id,
          harnessInstanceId: command.harnessInstanceId,
        });
        return { harness: harnessView(harness), type: command.type };
      }
      case "machine.revoke": {
        const allowDeployment = isAdministrator;
        const runnerId = RunnerIdSchema.parse(command.machineId);
        // Order matters and is the whole point of the operation. The durable
        // write lands first — tombstone plus generation bump, plus every module
        // effect that outlives a socket — so a Host that dies mid-revocation
        // still refuses this machine on its next connection. Only then are the
        // live streams torn down, which is what stops work already in flight.
        const revoked = await dependencies.shellControl.withMachineAdmission(runnerId, () =>
          dependencies.computerApps.withRunnerAdmission(runnerId, () =>
            dependencies.store.revokeRunner(runnerId, userId, {
              administration,
              allowDeployment,
              allowOtherOwners: allowDeployment,
            }),
          ),
        );
        // Between the durable write and the stream teardown: a session ended
        // before the tombstone landed could be reopened by a caller that raced
        // the revoke, and one ended after the stream went would have already
        // been recorded as a disconnection rather than as this revocation.
        await dependencies.shellControl.endMachineSessions(runnerId, "machine-revoked");
        await dependencies.runners.revoke(runnerId);
        dependencies.channels.relay.forget(runnerId);
        // The apps this computer was lending are gone with its connections, and
        // a call still waiting on its stream is answered by the loss rules.
        dependencies.computerApps.detachRunner(runnerId, "revoked");
        for (const sessionId of revoked.closedBrowserSessions) {
          dependencies.browser.abandonSession(sessionId);
        }
        // The queued work this machine will now never claim has been failed
        // durably; these are the terminal events its Threads are waiting on.
        for (const event of revoked.events) publishWorkspaceEvent(event);
        for (const event of revoked.requestEvents) publishWorkspaceEvent(event);
        if (revoked.cancelledRequestIds.length > 0) {
          dependencies.integrations.continuations.notify();
        }
        notifyMachinesChanged(dependencies.realtime, "machine.command");
        return { type: command.type };
      }
      case "machine.rename": {
        const allowDeployment = isAdministrator;
        await dependencies.store.renameRunner(
          RunnerIdSchema.parse(command.machineId),
          userId,
          command.name,
          { allowDeployment, administration },
        );
        notifyMachinesChanged(dependencies.realtime, "machine.command");
        return { type: command.type };
      }
      case "machine.access.session.stop": {
        // The full row resolves and authorizes the Stop even for an ended
        // session; an unknown id discloses nothing beyond "nothing to end".
        const shellSession = await dependencies.store.getShellSession(command.sessionId);
        if (!shellSession && caller.kind === "person") return { ended: false, type: command.type };
        if (shellSession)
          await requireMachineAccessManagement(
            dependencies.store,
            { userId, isAdministrator },
            shellSession.runnerId,
          );
        // Through the hub, so a Stop takes the sockets away as well as writing
        // the row; it is the same idempotent ending every other path uses. The
        // key travels with it so a retried click reads back what the first one
        // did rather than "nothing was open", and closes nothing a second time.
        const { ended } = await dependencies.shellControl.end(
          command.sessionId,
          "stopped-by-owner",
          { idempotency: { key: command.idempotencyKey, requestedBy: userId } },
        );
        return { ended, type: command.type };
      }
      case "browser.profile.rename":
        return {
          profile: await dependencies.browser.renameProfile({
            administration,
            name: command.name,
            ownerId: userId,
            profileId: command.profileId,
          }),
          type: command.type,
        };
      case "browser.profile.delete": {
        const deletion = await dependencies.browser.deleteProfile({
          administration,
          ownerId: userId,
          profileId: command.profileId,
        });
        return { type: command.type, ...(deletion ? { deletion } : {}) };
      }
      case "browser.profileGrant.revoke": {
        const revoked = await dependencies.store.revokeBrowserProfileGrant(
          command.grantId,
          userId,
          administration,
        );
        await dependencies.browser.detachAgentSessionsForRevokedProfileGrant({
          ownerId: userId,
          profileId: revoked.profileId,
          workspaceId: revoked.workspaceId,
        });
        return { type: command.type };
      }
      case "browser.history.remove":
      case "browser.history.clear":
        await dependencies.browser.forgetHistory(userId, {
          ...command,
          administration,
          ...(caller.kind === "person"
            ? {}
            : { authoritySource: { kind: "mcp", callerKind: caller.kind, callerKey: caller.key } }),
        });
        return { type: command.type };
    }
  }
}
