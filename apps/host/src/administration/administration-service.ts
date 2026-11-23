import { removeDevice } from "./device-removal.js";
import { DeviceDriverService } from "./device-driver-service.js";
import { KeyedMutationQueue } from "@opensteer/shared/mutationQueue";
import { createHash } from "node:crypto";
import {
  commandAdmission,
  type AdministrationCommandIdentity,
  requirePersonalOwner,
} from "@opensteer/database";
import { z } from "zod";
import {
  EnvironmentIdSchema,
  OpensteerError,
  DeviceIdSchema,
  type AuthSessionId,
  type EnvironmentId,
} from "@opensteer/core";
import {
  hostApi,
  BrowserProfileSchema,
  PendingBrowserProfileDeletionSchema,
  HarnessModelSettingsMapSchema,
  type HostApiCommand,
  type HostApiCommandOutput,
} from "@opensteer/protocol";
import type { HostServerDependencies } from "../server.js";
import type { AgentCaller } from "../mcp/agent-caller.js";
import { settings } from "../mcp/tool-access.js";
import { commitPersonalMutation } from "@opensteer/database/personal-mutation";
import { harnessView, requireMachineAccessManagement } from "./authority.js";
import {
  executeDeviceAdministration,
  isDeviceAdministrationCommand,
  type AdministrationActor,
} from "../devices/device-administration.js";
export type AdministrationCaller =
  | AgentCaller
  | ({
      readonly kind: "person";
      readonly sessionId?: AuthSessionId;
    } & AdministrationActor);
export type AdministrationDependencies = Pick<
  HostServerDependencies,
  | "authenticator"
  | "store"
  | "commands"
  | "apps"
  | "browser"
  | "browserSources"
  | "shellControl"
  | "computerApps"
  | "runners"
  | "channels"
  | "realtime"
  | "ownerProfile"
  | "deviceDrivers"
> & {
  readonly reconcileIdleCompaction?: () => Promise<void>;
  readonly integrations: Pick<
    HostServerDependencies["integrations"],
    "devices" | "localServerRegistry" | "continuations"
  >;
};
const coreTypes = [
  "viewer.timeZone.update",
  "viewer.quietTasks.update",
  "viewer.name.update",
  "settings.idleCompaction.set",
  "execution.preferences.remember",
  "harness.model.configure",
  "harness.rename",
  "harness.enabled.set",
  "harness.default.set",
  "machine.revoke",
  "machine.rename",
  "iphone.screen.attach",
  "iphone.screen.detach",
  "machine.access.session.stop",
  "browser.profile.rename",
  "browser.profile.delete",
  "browser.history.remove",
  "browser.history.clear",
] as const;
type CoreAdministrationCommand = Extract<
  HostApiCommand,
  {
    type: (typeof coreTypes)[number];
  }
>;
export type AdministrationCommand =
  | CoreAdministrationCommand
  | Extract<
      HostApiCommand,
      {
        type: "browser.site.remove" | "channel.connection.status.set";
      }
    >
  | Parameters<typeof executeDeviceAdministration>[2];
/**
 * The commands this service runs for agents as well as the person: its own, the browser's site
 * removal, a chat account's status and the device administration it hands on.
 */
export const agentAdministrationTypes: ReadonlySet<string> = new Set([
  ...coreTypes,
  "browser.site.remove",
  "channel.connection.status.set",
  "plugin.remove",
  "integration.grant.revoke",
  "integration.disconnect",
]);
export function isAdministrationCommand(
  command: HostApiCommand,
): command is CoreAdministrationCommand {
  return coreTypes.some((type) => command.type === type);
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
    await requirePersonalOwner(this.dependencies.store.database, caller.userId);
    return { userId: caller.userId };
  }
  async authorize(caller: AdministrationCaller, command: AdministrationCommand) {
    await requirePersonalOwner(this.dependencies.store.database, caller.userId);
    if (caller.kind === "person") return;
    if (command.type === "iphone.screen.attach" || command.type === "iphone.screen.detach")
      throw new OpensteerError({
        code: "forbidden",
        message: "Screen driver setup requires the owner's signed-in session.",
      });
    if (command.type === "settings.idleCompaction.set")
      throw new OpensteerError({
        code: "forbidden",
        message: "Claude compaction preferences require the person",
      });
    // A name is what others see; it changes only when the person saves it.
    if (command.type === "viewer.name.update")
      throw new OpensteerError({ code: "forbidden", message: "Changing your name requires you" });
    settings(caller, []);
  }
  async admitHarnessManagement(actor: AdministrationActor, environmentIdInput: string) {
    const environmentId = EnvironmentIdSchema.parse(environmentIdInput);
    const environment = (await this.dependencies.store.listEnvironmentsForUser(actor.userId)).find(
      (candidate) => candidate.id === environmentId,
    );
    if (!environment)
      throw new OpensteerError({
        code: "not_found",
        message: "Work location not found",
      });
    return environment;
  }
  async execute(
    caller: AdministrationCaller,
    command: AdministrationCommand,
    afterResponse?: (effect: () => void) => void,
  ): Promise<HostApiCommandOutput> {
    if (caller.kind === "person") return this.#authorizedExecute(caller, command, afterResponse);
    return this.#mutations.run(JSON.stringify([caller.userId, command.idempotencyKey]), () =>
      this.#authorizedExecute(caller, command, afterResponse),
    );
  }
  async #authorizedExecute(
    caller: AdministrationCaller,
    command: AdministrationCommand,
    afterResponse?: (effect: () => void) => void,
  ): Promise<HostApiCommandOutput> {
    await this.authorize(caller, command);
    const actor = await this.actor(caller);
    const administration =
      caller.kind === "person" ? undefined : this.#commandIdentity(caller, command);
    if (administration) {
      if (command.type.startsWith("harness.") && "environmentId" in command)
        await this.admitHarnessManagement(actor, command.environmentId);
      const replay = await this.dependencies.store.replayAdministrationCommand(administration);
      if (replay?.output) return hostApi["commands.dispatch"].success.parse(replay.output);
      if (replay && command.type === "machine.access.session.stop")
        return hostApi["commands.dispatch"].success.parse({
          type: command.type,
          ...z
            .object({
              ended: z.boolean(),
            })
            .parse(replay.result),
        });
    }
    return this.#execute(caller, actor, command, administration, afterResponse);
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
      authoritySource: {
        kind: "mcp",
        callerKind: caller.kind,
        callerKey: caller.key,
      },
      // The one command rule, at commit: what an agent may change is the table's, not this list's.
      ...commandAdmission({ ownerUserId: caller.userId, callerKey: caller.key, command }),
      output: async (result) => {
        let fields: Record<string, unknown> = {};
        if (command.type.startsWith("harness.")) {
          const harness = z.record(z.string(), z.unknown()).parse(result);
          const config = z
            .object({
              models: HarnessModelSettingsMapSchema.optional(),
            })
            .safeParse(harness.config);
          fields = {
            harness: {
              ...harness,
              ...(config.success && config.data.models
                ? {
                    modelSettings: config.data.models,
                  }
                : {}),
            },
          };
        }
        if (command.type === "execution.preferences.remember")
          fields = {
            preferences: result,
          };
        if (command.type === "viewer.timeZone.update")
          fields = {
            timeZone: result,
          };
        if (command.type === "viewer.quietTasks.update")
          fields = {
            quietTaskDays: result,
          };
        if (command.type === "integration.disconnect")
          fields = {
            notice: null,
            revokedUpstream: false,
          };
        if (command.type === "browser.profile.delete")
          fields = z
            .object({
              deletion: PendingBrowserProfileDeletionSchema.optional(),
            })
            .parse(result);
        if (command.type === "browser.profile.rename") {
          const { purpose, ...profile } = BrowserProfileSchema.extend({
            purpose: z.enum(["person", "engine-sign-in"]).optional(),
          }).parse(result);
          fields = {
            profile: { ...profile, ...(purpose === "engine-sign-in" ? { purpose } : {}) },
          };
        }
        return hostApi["commands.dispatch"].success.parse({
          type: command.type,
          ...fields,
        });
      },
    };
  }
  async #execute(
    caller: AdministrationCaller,
    actor: AdministrationActor,
    command: AdministrationCommand,
    administration?: AdministrationCommandIdentity | undefined,
    afterResponse?: (effect: () => void) => void,
  ): Promise<HostApiCommandOutput> {
    const { userId } = actor;
    const dependencies = this.dependencies;
    if (isDeviceAdministrationCommand(command)) {
      const result = await executeDeviceAdministration(
        {
          devices: dependencies.integrations.devices,
          localServers: dependencies.integrations.localServerRegistry,
        },
        actor,
        command,
        command.idempotencyKey,
        administration,
      );
      if (command.type.startsWith("plugin."))
        dependencies.realtime.publishConnectionsChanged(userId);
      return result;
    }
    switch (command.type) {
      case "browser.site.remove": {
        const deployment = await dependencies.store.getDeployment();
        if (!deployment)
          throw new OpensteerError({
            code: "internal",
            message: "Deployment identity is unavailable",
          });
        await dependencies.browserSources.removeSite({
          administration,
          ownerId: userId,
          deploymentId: deployment.id,
          site: command.site,
        });
        return {
          type: command.type,
        };
      }
      case "channel.connection.status.set":
        await dependencies.channels.service.setConnectionStatus(
          command.connectionId,
          userId,
          command.status,
          administration,
        );
        return {
          type: command.type,
        };

      case "settings.idleCompaction.set": {
        const policy = await dependencies.store.notificationState.setIdleCompactionPolicy({
          administration,
          policy: command.policy,
          userId,
        });
        await dependencies.reconcileIdleCompaction?.();
        return { type: command.type, policy };
      }
      case "viewer.quietTasks.update":
        return {
          quietTaskDays: await dependencies.store.notificationState.setQuietTaskDays({
            administration,
            quietTaskDays: command.quietTaskDays,
            userId,
          }),
          type: command.type,
        };
      case "viewer.name.update": {
        if (!dependencies.ownerProfile)
          throw new OpensteerError({
            code: "not_found",
            message: "This Opensteer has no owner name",
          });
        return {
          ...(await dependencies.ownerProfile.update(
            userId,
            command.name,
            command.expectedVersion,
          )),
          type: command.type,
        };
      }
      case "viewer.timeZone.update":
        return { timeZone: command.timeZone, type: command.type };

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
            ...(command.accessMode === undefined
              ? {}
              : {
                  accessMode: command.accessMode,
                }),
            ...(selection === undefined
              ? {}
              : {
                  selection,
                }),
          },
          administration,
        );
        return {
          preferences,
          type: command.type,
        };
      }
      case "harness.model.configure": {
        const environment = await this.admitHarnessManagement(actor, command.environmentId);
        const current = await dependencies.store.getHarnessInstance(command.harnessInstanceId);
        if (!current || current.environmentId !== environment.id || current.removedAt) {
          throw new OpensteerError({
            code: "not_found",
            message: "AI engine not found",
          });
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
            : {
                ...currentModels,
                [command.nativeModelId]: command.settings,
              };
        const harness = await dependencies.store.updateHarnessInstance({
          id: current.id,
          administration,
          expectedRuntimeRevision: current.runtimeRevision,
          config: {
            ...config,
            models,
          },
        });
        this.scheduleHarnesses(environment.id);
        return {
          harness: harnessView(harness),
          type: command.type,
        };
      }
      case "harness.rename":
      case "harness.enabled.set": {
        const environment = await this.admitHarnessManagement(actor, command.environmentId);
        const current = await dependencies.store.getHarnessInstance(command.harnessInstanceId);
        if (!current || current.environmentId !== environment.id) {
          throw new OpensteerError({
            code: "not_found",
            message: "AI engine not found",
          });
        }
        const harness = await dependencies.store.updateHarnessInstance({
          administration,
          ...(command.type === "harness.enabled.set"
            ? {
                enabled: command.enabled,
              }
            : {}),
          id: command.harnessInstanceId,
          ...(command.type === "harness.rename"
            ? {
                name: command.name,
              }
            : {}),
        });
        if (command.type === "harness.enabled.set") {
          this.scheduleHarnesses(environment.id);
        }
        return {
          harness: harnessView(harness),
          type: command.type,
        };
      }
      case "harness.default.set": {
        // Which account of an engine a placement lands on is a stored choice,
        // not a configuration change, so no catalog has gone stale here.
        const environment = await this.admitHarnessManagement(actor, command.environmentId);
        const current = await dependencies.store.getHarnessInstance(command.harnessInstanceId);
        if (!current || current.environmentId !== environment.id) {
          throw new OpensteerError({
            code: "not_found",
            message: "AI engine not found",
          });
        }
        const harness = await dependencies.store.setDefaultHarnessInstance({
          administration,
          environmentId: environment.id,
          harnessInstanceId: command.harnessInstanceId,
        });
        return {
          harness: harnessView(harness),
          type: command.type,
        };
      }
      case "machine.revoke": {
        const deviceId = DeviceIdSchema.parse(command.machineId);
        await removeDevice(
          dependencies,
          deviceId,
          userId,
          { administration, allowDeployment: true },
          afterResponse,
        );
        return {
          type: command.type,
        };
      }
      case "machine.rename": {
        await dependencies.store.renameDevice(
          DeviceIdSchema.parse(command.machineId),
          userId,
          command.name,
          administration ? { administration } : {},
        );
        return {
          type: command.type,
        };
      }
      case "iphone.screen.attach":
      case "iphone.screen.detach": {
        if (caller.kind !== "person" || !caller.sessionId)
          throw new OpensteerError({
            code: "forbidden",
            message: "Screen driver setup requires the owner's signed-in session.",
          });
        if (!dependencies.deviceDrivers)
          throw new OpensteerError({
            code: "conflict",
            message: "Device driver management is unavailable.",
          });
        const result = await new DeviceDriverService(
          dependencies.store,
          dependencies.deviceDrivers,
        ).execute({ userId, sessionId: caller.sessionId }, command);
        await commitPersonalMutation(dependencies.store.database, async (_tx, mutation) =>
          mutation.bumpResource("machine"),
        );
        return hostApi["commands.dispatch"].success.parse(result);
      }
      case "machine.access.session.stop": {
        // The full row resolves and authorizes the Stop even for an ended
        // session; an unknown id discloses nothing beyond "nothing to end".
        const shellSession = await dependencies.store.getShellSession(command.sessionId);
        if (!shellSession && caller.kind === "person")
          return {
            ended: false,
            type: command.type,
          };
        if (shellSession)
          await requireMachineAccessManagement(
            dependencies.store,
            {
              userId,
            },
            shellSession.runnerId,
          );
        // Through the hub, so a Stop takes the sockets away as well as writing
        // the row; it is the same idempotent ending every other path uses. The
        // key travels with it so a retried click reads back what the first one
        // did rather than "nothing was open", and closes nothing a second time.
        const { ended } = await dependencies.shellControl.end(
          command.sessionId,
          "stopped-by-owner",
          {
            idempotency: {
              key: command.idempotencyKey,
              requestedBy: userId,
              // An agent's Stop: its record names it, and it is admitted where it commits.
              ...(administration
                ? { authoritySource: administration.authoritySource, admit: administration.admit }
                : {}),
            },
          },
        );
        return {
          ended,
          type: command.type,
        };
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
        return {
          type: command.type,
          ...(deletion
            ? {
                deletion,
              }
            : {}),
        };
      }

      case "browser.history.remove":
      case "browser.history.clear":
        await dependencies.browser.forgetHistory(userId, {
          ...command,
          administration,
          ...(caller.kind === "person"
            ? {}
            : {
                authoritySource: {
                  kind: "mcp",
                  callerKind: caller.kind,
                  callerKey: caller.key,
                },
              }),
        });
        return {
          type: command.type,
        };
    }
  }
}
