import { CheckOAuthSetup } from "../contracts/oauth.ts";
import { OAuthClientInputs } from "../contracts/oauth-clients.ts";
import {
  StartWorkflow,
  WorkflowTarget,
  WorkflowApp,
  ListWorkflowRuns,
} from "../contracts/workflows.ts";
import { CompleteWebhookSetup } from "../contracts/webhook-setup.ts";
/** Promise facade parses plain inputs before calling native operations. */
import {
  CreateWebhook,
  DeliverWebhook,
  LinkWebhookSource,
  UpdateWebhookSource,
  UnlinkWebhookSource,
  WebhookApp,
  WebhookDefinitionsInput,
  WebhookTarget,
} from "../contracts/webhooks.ts";
import { Effect, Schema, Stream } from "effect";
import type { PluginEngine, PromisePluginEngine } from "../contracts/pluginEngine.ts";
import { AccountInputs } from "../contracts/account.ts";
import {
  CreateAccountConnection,
  GetAccountConnection,
  SubmitAccountConnection,
  StartConnectionOAuth,
  CompleteConnectionOAuth,
  FindConnectionOAuth,
} from "../contracts/account-connection.ts";
import { ScheduleInputs } from "../contracts/schedules.ts";
import { AppInputs } from "../contracts/apps.ts";
import { OwnerInputs } from "../contracts/owner.ts";
import { RegistryInputs } from "../contracts/registry.ts";
import { ElicitationFailed, ToolInputs, type ToolInvocationOptions } from "../contracts/tools.ts";
import { OwnerId, RequestInvalid } from "../contracts/shared.ts";
import { AppDataInput } from "../contracts/app-data.ts";
import { AppSkillInputs } from "../contracts/skills.ts";

function run<A, B, E>(
  schema: Schema.Decoder<A>,
  input: unknown,
  operation: (value: A) => Effect.Effect<B, E>,
) {
  return Effect.runPromise(
    Schema.decodeUnknownEffect(schema)(input).pipe(
      Effect.mapError(() => new RequestInvalid()),
      Effect.flatMap(operation),
    ),
  );
}

const invocationOptions = (
  options: Parameters<PromisePluginEngine["tools"]["call"]>[1],
): ToolInvocationOptions => {
  const deliver = options?.elicitation;
  return {
    ...(deliver === undefined
      ? {}
      : {
          elicitation: (request, signal) =>
            Effect.tryPromise({
              try: () => deliver(request, signal),
              catch: () => new ElicitationFailed({ reason: "transport" }),
            }),
        }),
    ...(options?.issuer === undefined ? {} : { issuer: options.issuer }),
  };
};

/** Adapt an existing native client; each Promise call runs one decoded operation. */
export const promisePluginEngine = (pluginEngine: PluginEngine): PromisePluginEngine => {
  return {
    skills: {
      bundle: (input) => run(AppSkillInputs.list, input, pluginEngine.skills.bundle),
      list: (input) => run(AppSkillInputs.list, input, pluginEngine.skills.list),
      read: (input) => run(AppSkillInputs.read, input, pluginEngine.skills.read),
    },
    schedules: {
      definitions: (input) =>
        run(ScheduleInputs.definitions, input, pluginEngine.schedules.definitions),
      list: (input) => run(ScheduleInputs.list, input, pluginEngine.schedules.list),
      configure: (input) => run(ScheduleInputs.configure, input, pluginEngine.schedules.configure),
      copy: (input) => run(ScheduleInputs.copy, input, pluginEngine.schedules.copy),
      update: (input) => run(ScheduleInputs.update, input, pluginEngine.schedules.update),
      runNow: (input) => run(ScheduleInputs.runNow, input, pluginEngine.schedules.runNow),
      remove: (input) => run(ScheduleInputs.remove, input, pluginEngine.schedules.remove),
      runs: (input = {}) => run(ScheduleInputs.runs, input, pluginEngine.schedules.runs),
      approval: (input) => run(ScheduleInputs.approval, input, pluginEngine.schedules.approval),
      answer: (input) => run(ScheduleInputs.answer, input, pluginEngine.schedules.answer),
    },
    accounts: {
      get: (input) => run(AccountInputs.get, input, pluginEngine.accounts.get),
      provider: (input) => run(AccountInputs.get, input, pluginEngine.accounts.provider),
      list: (input) => run(AccountInputs.list, input, pluginEngine.accounts.list),
      update: (input) => run(AccountInputs.update, input, pluginEngine.accounts.update),
      remove: (input) => run(AccountInputs.get, input, pluginEngine.accounts.remove),
      signIn: (input) => run(AccountInputs.get, input, pluginEngine.accounts.signIn),
      providers: (input) => run(AccountInputs.providers, input, pluginEngine.accounts.providers),
      health: (input) => run(AccountInputs.health, input, pluginEngine.accounts.health),
      revocation: (input) => run(AccountInputs.get, input, pluginEngine.accounts.revocation),
      listHealth: (input) => run(AccountInputs.listHealth, input, pluginEngine.accounts.listHealth),
      check: (input) => run(AccountInputs.check, input, pluginEngine.accounts.check),
    },
    accountConnections: {
      oauthSetup: (input) => run(CheckOAuthSetup, input, pluginEngine.accountConnections.oauthSetup),
      create: (input) => run(CreateAccountConnection, input, pluginEngine.accountConnections.create),
      get: (input) => run(GetAccountConnection, input, pluginEngine.accountConnections.get),
      cancel: (input) => run(GetAccountConnection, input, pluginEngine.accountConnections.cancel),
      submit: (input) => run(SubmitAccountConnection, input, pluginEngine.accountConnections.submit),
      startOAuth: (input) =>
        run(StartConnectionOAuth, input, pluginEngine.accountConnections.startOAuth),
      findOAuth: (input) => run(FindConnectionOAuth, input, pluginEngine.accountConnections.findOAuth),
      completeOAuth: (input) =>
        run(CompleteConnectionOAuth, input, pluginEngine.accountConnections.completeOAuth),
    },
    oauthClients: {
      register: (input) => run(OAuthClientInputs.register, input, pluginEngine.oauthClients.register),
      list: (input) => run(OAuthClientInputs.list, input, pluginEngine.oauthClients.list),
      issuers: (input) => run(OAuthClientInputs.issuers, input, pluginEngine.oauthClients.issuers),
      get: (input) => run(OAuthClientInputs.get, input, pluginEngine.oauthClients.get),
      update: (input) => run(OAuthClientInputs.update, input, pluginEngine.oauthClients.update),
      remove: (input) => run(OAuthClientInputs.remove, input, pluginEngine.oauthClients.remove),
    },
    owners: {
      check: (input) => run(OwnerInputs.check, input, pluginEngine.owners.check),
      remove: (input) => run(OwnerInputs.remove, input, pluginEngine.owners.remove),
    },
    apps: {
      workflows: { list: (input) => run(WorkflowApp, input, pluginEngine.apps.workflows.list) },
      workflowRuns: {
        start: (input) => run(StartWorkflow, input, pluginEngine.apps.workflowRuns.start),
        get: (input) => run(WorkflowTarget, input, pluginEngine.apps.workflowRuns.get),
        pinned: (input) =>
          run(
            Schema.Struct({ ...WorkflowTarget.fields, owner: Schema.optional(OwnerId) }),
            input,
            pluginEngine.apps.workflowRuns.pinned,
          ),
        list: (input) =>
          run(Schema.toType(ListWorkflowRuns), input, pluginEngine.apps.workflowRuns.list),
        terminate: (input) => run(WorkflowTarget, input, pluginEngine.apps.workflowRuns.terminate),
      },
      create: (input) => run(AppInputs.create, input, pluginEngine.apps.create),
      workspace: (input) => run(AppInputs.workspace, input, pluginEngine.apps.workspace),
      commit: (input) => run(AppInputs.commit, input, pluginEngine.apps.commit),
      copy: (input) => run(AppInputs.copy, input, pluginEngine.apps.copy),
      deploy: (input) => run(AppInputs.deploy, input, pluginEngine.apps.deploy),
      get: (input) => run(AppInputs.get, input, pluginEngine.apps.get),
      list: (input = {}) => run(AppInputs.list, input, pluginEngine.apps.list),
      checkCredentials: (input) =>
        run(AppInputs.checkCredentials, input, pluginEngine.apps.checkCredentials),
      remove: (input) => run(AppInputs.get, input, pluginEngine.apps.remove),
      activate: (input) => run(AppInputs.activate, input, pluginEngine.apps.activate),
      rename: (input) => run(AppInputs.rename, input, pluginEngine.apps.rename),
      versions: (input) => run(AppInputs.versions, input, pluginEngine.apps.versions),
      version: (input) => run(AppInputs.source, input, pluginEngine.apps.version),
      source: (input) => run(AppInputs.source, input, pluginEngine.apps.source),
      history: (input) => run(AppInputs.history, input, pluginEngine.apps.history),
      revision: (input) => run(AppInputs.revision, input, pluginEngine.apps.revision),
    },
    registry: {
      list: (input = {}) => run(RegistryInputs.list, input, pluginEngine.registry.list),
      snapshot: (input) => run(RegistryInputs.snapshot, input, pluginEngine.registry.snapshot),
      file: (input) => run(RegistryInputs.file, input, pluginEngine.registry.file),
    },
    webhookSetup: {
      read: (input) => run(WebhookTarget, input, pluginEngine.webhookSetup.read),
      complete: (input) => run(CompleteWebhookSetup, input, pluginEngine.webhookSetup.complete),
    },
    webhooks: {
      get: (input) => run(WebhookTarget, input, pluginEngine.webhooks.get),
      confirmRemoval: (input) => run(WebhookTarget, input, pluginEngine.webhooks.confirmRemoval),
      definitions: (input) => run(WebhookDefinitionsInput, input, pluginEngine.webhooks.definitions),
      list: (input) => run(WebhookApp, input, pluginEngine.webhooks.list),
      create: (input) => run(CreateWebhook, input, pluginEngine.webhooks.create),
      reconcile: (input) => run(WebhookTarget, input, pluginEngine.webhooks.reconcile),
      remove: (input) => run(WebhookTarget, input, pluginEngine.webhooks.remove),
      deliver: (input) => run(DeliverWebhook, input, pluginEngine.webhooks.deliver),
      sources: (input) => run(WebhookApp, input, pluginEngine.webhooks.sources),
      link: (input) => run(LinkWebhookSource, input, pluginEngine.webhooks.link),
      configureSource: (input) =>
        run(UpdateWebhookSource, input, pluginEngine.webhooks.configureSource),
      unlink: (input) => run(UnlinkWebhookSource, input, pluginEngine.webhooks.unlink),
    },
    appData: {
      subscribe: (input) =>
        run(AppDataInput, input, (value) =>
          pluginEngine.appData.subscribe(value).pipe(Effect.map(Stream.toAsyncIterable)),
        ),
      query: (input) => run(AppDataInput, input, pluginEngine.appData.query),
      mutate: (input) => run(AppDataInput, input, pluginEngine.appData.mutate),
    },
    tools: {
      list: (input) => run(Schema.toType(ToolInputs.list), input, pluginEngine.tools.list),
      index: (input) => run(Schema.toType(ToolInputs.index), input, pluginEngine.tools.index),
      get: (input) => run(Schema.toType(ToolInputs.get), input, pluginEngine.tools.get),
      call: (input, options) =>
        run(ToolInputs.call, input, (value) =>
          pluginEngine.tools.call(value, invocationOptions(options)),
        ),
      // Native resume rejects excess fields before lookup; do not strip them at this boundary.
      resume: (input, options) =>
        Effect.runPromise(pluginEngine.tools.resume(input, invocationOptions(options))),
      pruneApprovals: (input = {}) =>
        run(ToolInputs.pruneApprovals, input, pluginEngine.tools.pruneApprovals),
    },
  };
};
