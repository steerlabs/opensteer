/** HTTP adapters call the same native operations as the in-process SDK. */
import { Layer } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { PluginEngineApi } from "../contracts/http.ts";
import type { PluginEngine } from "../contracts/pluginEngine.ts";

/** Mount the SDK contract with one supplied pluginEngine; the host provides transport and access control. */
export const pluginEngineHandlers = (pluginEngine: PluginEngine) =>
  Layer.mergeAll(
    HttpApiBuilder.group(PluginEngineApi, "skills", (handlers) =>
      handlers
        .handle("bundle", ({ params, query }) => pluginEngine.skills.bundle({ ...params, ...query }))
        .handle("list", ({ params, query }) => pluginEngine.skills.list({ ...params, ...query }))
        .handle("read", ({ params, query }) => pluginEngine.skills.read({ ...params, ...query })),
    ),
    HttpApiBuilder.group(PluginEngineApi, "schedules", (handlers) =>
      handlers
        .handle("definitions", ({ params, query }) =>
          pluginEngine.schedules.definitions({ ...params, ...query }),
        )
        .handle("list", ({ params, query }) => pluginEngine.schedules.list({ ...params, ...query }))
        .handle("configure", ({ params, payload }) =>
          pluginEngine.schedules.configure({ ...params, ...payload }),
        )
        .handle("copy", ({ params, query }) => pluginEngine.schedules.copy({ ...params, ...query }))
        .handle("update", ({ params, payload }) =>
          pluginEngine.schedules.update({ ...params, ...payload }),
        )
        .handle("runNow", ({ params, payload }) =>
          pluginEngine.schedules.runNow({ ...params, ...payload }),
        )
        .handle("remove", ({ params, query }) => pluginEngine.schedules.remove({ ...params, ...query }))
        .handle("runs", ({ query }) => pluginEngine.schedules.runs(query))
        .handle("approval", ({ params, query }) =>
          pluginEngine.schedules.approval({ ...params, ...query }),
        )
        .handle("answer", ({ params, payload }) =>
          pluginEngine.schedules.answer({ ...params, ...payload }),
        ),
    ),
    HttpApiBuilder.group(PluginEngineApi, "accounts", (handlers) =>
      handlers
        .handle("update", ({ params, query, payload }) =>
          pluginEngine.accounts.update({ ...params, ...query, ...payload }),
        )
        .handle("provider", ({ params, query }) =>
          pluginEngine.accounts.provider({ ...params, ...query }),
        )
        .handle("remove", ({ params, query }) => pluginEngine.accounts.remove({ ...params, ...query }))
        .handle("signIn", ({ params, query }) => pluginEngine.accounts.signIn({ ...params, ...query }))
        .handle("providers", ({ query }) => pluginEngine.accounts.providers(query))
        .handle("get", ({ params, query }) => pluginEngine.accounts.get({ ...params, ...query }))
        .handle("health", ({ params, query }) => pluginEngine.accounts.health({ ...params, ...query }))
        .handle("revocation", ({ params, query }) =>
          pluginEngine.accounts.revocation({ ...params, ...query }),
        )
        .handle("listHealth", ({ query }) => pluginEngine.accounts.listHealth(query))
        .handle("check", ({ params, query, payload }) =>
          pluginEngine.accounts.check({ ...params, ...query, ...payload }),
        )
        .handle("list", ({ query }) => pluginEngine.accounts.list(query)),
    ),
    HttpApiBuilder.group(PluginEngineApi, "accountConnections", (handlers) =>
      handlers
        .handle("create", ({ payload }) => pluginEngine.accountConnections.create(payload))
        .handle("get", ({ params, query }) =>
          pluginEngine.accountConnections.get({ ...params, ...query }),
        )
        .handle("cancel", ({ params, query }) =>
          pluginEngine.accountConnections.cancel({ ...params, ...query }),
        )
        .handle("submit", ({ payload }) => pluginEngine.accountConnections.submit(payload))
        .handle("oauthSetup", ({ payload }) => pluginEngine.accountConnections.oauthSetup(payload))
        .handle("startOAuth", ({ payload }) => pluginEngine.accountConnections.startOAuth(payload))
        .handle("findOAuth", ({ payload }) => pluginEngine.accountConnections.findOAuth(payload))
        .handle("completeOAuth", ({ payload }) =>
          pluginEngine.accountConnections.completeOAuth(payload),
        ),
    ),
    HttpApiBuilder.group(PluginEngineApi, "oauthClients", (handlers) =>
      handlers
        .handle("register", ({ payload }) => pluginEngine.oauthClients.register(payload))
        .handle("list", ({ query }) => pluginEngine.oauthClients.list(query))
        .handle("issuers", ({ query }) => pluginEngine.oauthClients.issuers(query))
        .handle("get", ({ params, query }) => pluginEngine.oauthClients.get({ ...params, ...query }))
        .handle("update", ({ params, payload }) =>
          pluginEngine.oauthClients.update({ ...params, ...payload }),
        )
        .handle("remove", ({ params, query }) =>
          pluginEngine.oauthClients.remove({ ...params, ...query }),
        ),
    ),
    HttpApiBuilder.group(PluginEngineApi, "apps", (handlers) =>
      handlers
        .handle("create", ({ payload }) => pluginEngine.apps.create(payload))
        .handle("workspace", ({ params, query }) =>
          pluginEngine.apps.workspace({ ...params, ...query }),
        )
        .handle("commit", ({ params, payload }) => pluginEngine.apps.commit({ ...params, ...payload }))
        .handle("copy", ({ payload }) => pluginEngine.apps.copy(payload))
        .handle("deploy", ({ payload }) => pluginEngine.apps.deploy(payload))
        .handle("get", ({ params, query }) => pluginEngine.apps.get({ ...params, ...query }))
        .handle("list", ({ query }) => pluginEngine.apps.list(query))
        .handle("checkCredentials", ({ params, query, payload }) =>
          pluginEngine.apps.checkCredentials({ ...params, ...query, ...payload }),
        )
        .handle("remove", ({ params, query }) => pluginEngine.apps.remove({ ...params, ...query }))
        .handle("rename", ({ params, query, payload }) =>
          pluginEngine.apps.rename({ ...params, ...query, ...payload }),
        )
        .handle("activate", ({ params, query, payload }) =>
          pluginEngine.apps.activate({ ...params, ...query, ...payload }),
        )
        .handle("versions", ({ params, query }) => pluginEngine.apps.versions({ ...params, ...query }))
        .handle("version", ({ params, query }) => pluginEngine.apps.version({ ...params, ...query }))
        .handle("deployments", ({ params, query }) =>
          pluginEngine.apps.versions({ ...params, ...query }),
        )
        .handle("deployment", ({ params, query }) => pluginEngine.apps.version({ ...params, ...query }))
        .handle("source", ({ params, query }) => pluginEngine.apps.source({ ...params, ...query }))
        .handle("history", ({ params, query }) => pluginEngine.apps.history({ ...params, ...query }))
        .handle("revision", ({ params, query }) => pluginEngine.apps.revision({ ...params, ...query })),
    ),
    HttpApiBuilder.group(PluginEngineApi, "registry", (handlers) =>
      handlers
        .handle("list", ({ query }) => pluginEngine.registry.list(query))
        .handle("snapshot", ({ query }) => pluginEngine.registry.snapshot(query))
        .handle("file", ({ query }) => pluginEngine.registry.file(query)),
    ),
    HttpApiBuilder.group(PluginEngineApi, "owners", (handlers) =>
      handlers
        .handle("check", ({ params }) => pluginEngine.owners.check(params))
        .handle("remove", ({ params }) => pluginEngine.owners.remove(params)),
    ),
    HttpApiBuilder.group(PluginEngineApi, "appWorkflows", (handlers) =>
      handlers.handle("list", ({ params, query }) =>
        pluginEngine.apps.workflows.list({ ...params, ...query }),
      ),
    ),
    HttpApiBuilder.group(PluginEngineApi, "appWorkflowRuns", (handlers) =>
      handlers
        .handle("start", ({ params, payload }) =>
          pluginEngine.apps.workflowRuns.start({ ...params, ...payload }),
        )
        .handle("get", ({ params }) => pluginEngine.apps.workflowRuns.get(params))
        .handle("pinned", ({ params, query }) =>
          pluginEngine.apps.workflowRuns.pinned({ ...params, ...query }),
        )
        .handle("list", ({ params, query }) =>
          pluginEngine.apps.workflowRuns.list({ ...params, ...query }),
        )
        .handle("terminate", ({ params }) => pluginEngine.apps.workflowRuns.terminate(params)),
    ),
    HttpApiBuilder.group(PluginEngineApi, "webhooks", (handlers) =>
      handlers
        .handle("get", ({ params }) => pluginEngine.webhooks.get(params))
        .handle("confirmRemoval", ({ params }) => pluginEngine.webhooks.confirmRemoval(params))
        .handle("definitions", ({ params, query }) =>
          pluginEngine.webhooks.definitions({ ...params, ...query }),
        )
        .handle("list", ({ params }) => pluginEngine.webhooks.list(params))
        .handle("create", ({ params, payload }) =>
          pluginEngine.webhooks.create({ ...params, ...payload }),
        )
        .handle("reconcile", ({ params }) => pluginEngine.webhooks.reconcile(params))
        .handle("remove", ({ params }) => pluginEngine.webhooks.remove(params))
        .handle("sources", ({ params }) => pluginEngine.webhooks.sources(params))
        .handle("link", ({ params, payload }) => pluginEngine.webhooks.link({ ...params, ...payload }))
        .handle("configureSource", ({ params, payload }) =>
          pluginEngine.webhooks.configureSource({ ...params, ...payload }),
        )
        .handle("unlink", ({ params }) => pluginEngine.webhooks.unlink(params))
        .handle("deliver", ({ params, payload }) =>
          pluginEngine.webhooks.deliver({ ...params, ...payload }),
        ),
    ),
    HttpApiBuilder.group(PluginEngineApi, "appData", (handlers) =>
      handlers
        .handle("subscribe", ({ payload }) => pluginEngine.appData.subscribe(payload))
        .handle("query", ({ payload }) => pluginEngine.appData.query(payload))
        .handle("mutate", ({ payload }) => pluginEngine.appData.mutate(payload)),
    ),
    HttpApiBuilder.group(PluginEngineApi, "tools", (handlers) =>
      handlers
        .handle("list", ({ query }) => pluginEngine.tools.list(query))
        .handle("index", ({ query }) => pluginEngine.tools.index(query))
        .handle("get", ({ query }) => pluginEngine.tools.get(query))
        .handle("call", ({ payload }) => pluginEngine.tools.call(payload))
        .handle("resume", ({ payload }) => pluginEngine.tools.resume(payload))
        .handle("pruneApprovals", ({ payload }) => pluginEngine.tools.pruneApprovals(payload)),
    ),
  );
