import { AgentOperationIdSchema, requestTextMaxLength, type AgentGrant } from "@opensteer/core";
import { z } from "zod";
import type { AgentTool, AgentToolName } from "./tools/index.js";
import { ask_person } from "./tools/person.js";

const descriptions = {
  opensteer_ai_account_list:
    "Find AI accounts and models. Copy the exact selections. Pass aiAccountId to page through models.",
  opensteer_ai_account_update:
    "Rename, enable or disable an AI account, set an engine's default account, or change model limits.",
  opensteer_defaults_read: "Read the person's default AI account, model and mode for new tasks.",
  opensteer_defaults_update:
    "Change defaults for new tasks within your access ceiling. Existing tasks keep their settings.",
  app_list:
    "Find published apps by name or folder. Results include the localUrl and status of each server.",
  computer_list:
    "Check which visible devices are online, asleep or stopped, and which have a phone screen.",
  computer_update: "Rename a computer the person enrolled.",
  computer_remove:
    "Remove a device or end a session. Removing a computer revokes its sessions and deletes browser profiles.",
  browser_profile_list:
    "Find the browser profiles shared with you. A profile stays on its own device and its name does not prove that you are signed in.",
  browser_profile_update: "Rename a browser profile.",
  browser_profile_remove:
    "Delete a profile, clear its history, remove a URL from history, or forget a site whose Chrome cookies were copied.",
  saved_login_request:
    'Request a login for tabId and site in a shared profile. In browser_use: const page = await openPage(tabId); focus the field, then await page.cdp("Opensteer.fillLogin", {loginRef, field: "password"}). Fields: username, password, code. A script controlling the page can read filled values. Never read them back, print or store them.',
  card_request:
    'Request a card for tabId and site in a shared profile. In browser_use: const page = await openPage(tabId); focus the field, then await page.cdp("Opensteer.fillCard", {cardRef, field: "number"}). Other fields: expiry, expiry-month, expiry-year, cvc, name, billing-postal-code. Never read back or store a fill. The purchase needs authorization.',
  plugin_search: "Find shared plugin tools and their paths and argument types. Pass next to page.",
  opensteer_plugin_catalog:
    "Find plugins available to install. Pass cursor to continue. Installing does not link an account.",
  plugin_skills:
    "Read instructions provided by a shared plugin. List with {} or {app: namespace}, read with {app,name}, and get a referenced file with {app,name,file}.",
  plugin_resources:
    "Read plugin schedules, workflows, webhooks and run history. Pass the returned cursor for older runs.",
  opensteer_plugin_resource_update:
    "Change a plugin schedule, workflow or webhook subscription. The person handles any required approval.",
  plugin_describe:
    "Read full argument and result types for exact paths from plugin_search. Missing paths include suggestions.",
  plugin_call:
    "Call exact paths from plugin_search. Pass one {path,input} or an array of independent calls to the same plugin. If the plugin itself pauses with executionId, wait for the person in Needs you, then call plugin_resume with executionId and the returned taskId.",
  plugin_execute:
    "Run JavaScript over tools.<plugin>.<tool>() to chain results or filter output. Pass one namespace from plugin_search. If it pauses with executionId, use plugin_resume and the returned taskId after the person answers.",
  plugin_resume:
    "Use executionId and the originating direct-work taskId after the person answers the plugin in Needs you. If it ended or expired, check current state before acting again.",
  opensteer_plugin_list:
    "List installed plugins, connected accounts, versions and access. Pass pluginId to see its versions and cursor for the next page.",
  opensteer_plugin_install:
    "Install the selected plugin from opensteer_plugin_catalog. The person links its accounts.",
  opensteer_plugin_export: "Export an installed plugin's source bundle for its selected version.",
  opensteer_plugin_activate: "Change the active version of an installed plugin.",
  opensteer_plugin_remove: "Remove an installed plugin.",
  local_server_list:
    "List shared local servers and the namespaces they use in plugin_search. Launch settings and secrets stay private.",
  local_server_add: "Register a local tool server. The person must approve launching it.",
  local_server_remove: "Remove a registered local tool server.",
  opensteer_messaging_bridge_list:
    "List messaging bridges and their routes into the person's tasks.",
  opensteer_messaging_bridge_update:
    "Pause or resume a messaging bridge. The person controls sign-in and route access.",
  opensteer_messaging_bridge_remove: "Remove a messaging route so its chats stop reaching tasks.",
  opensteer_request_list:
    "List visible Requests, newest first. Pending Requests confer no permission. Use the returned links when referring to them.",
  opensteer_request_read:
    "Read the status of a visible Request by ID. Use its returned link when referring to it.",
  opensteer_task_create:
    "Start a task for one of the person's agents. Omit aiAccountId and model for defaults, or choose with opensteer_ai_account_list. Use the returned taskId with opensteer_task_wait or opensteer_task_read.",
  opensteer_delegation_wait:
    "Wait for an existing visible delegation to finish or ask the person. A timeout leaves its work running.",
  opensteer_delegation_status: "Read the status and result of an existing visible delegation.",
  opensteer_subagent_read:
    "Read the messages or activity of a visible subagent by subagentId, with optional paging.",
  opensteer_task_list:
    "Find visible tasks. Filter by title, recent messages or parentTaskId of a task run by the person's agent.",
  opensteer_task_read:
    "Read messages or activity for a task run by the person's agent. Pass itemId for one full item.",
  opensteer_task_send:
    "Send context to a task run by one of the person's agents. report leaves context, queue requests a turn, and steer speaks to its current turn. freshContext applies only to queue. Accepted does not mean read.",
  opensteer_task_interrupt:
    "Stop the current turn of a task run by one of the person's agents and pause its queue.",
  opensteer_task_update:
    "Rename a task run by one of the person's agents, mark it Done and stop its work, or reopen it.",
  opensteer_task_resume:
    "Release the paused message queue of a task run by one of the person's agents. Honor a pause the person asked for.",
  opensteer_task_wait:
    "Wait for the person's agent to settle or ask a question. A timeout leaves work running. If hasMore, wait again after the last itemId.",
  opensteer_task_configure:
    "Change the AI account or model of a task run by one of the person's agents. Copy selections from opensteer_ai_account_list.",
  opensteer_task_queue:
    "Inspect, cancel, move or steer waiting messages for a task run by one of the person's agents. Move needs beforeMessageId (null for last); steer needs expectedRunId.",
  opensteer_automation_read: "Read the current revision and recent runs of an automation by ID.",
  opensteer_automation_update:
    "Use expectedRevisionId to change an automation's name, code or source. Code changes need full access.",
  opensteer_automation_control:
    "Pause, resume, archive, reschedule, run an automation now or cancel pending runs. run_now and archive need full access. Work already started keeps running.",
  opensteer_automation_list: "List visible schedules, reminders, webhooks and watches.",
  opensteer_automation_create:
    "Create a schedule, reminder, webhook or watch for a task run by one of the person's agents. Requires full access and program contract version 5. ownTask keeps its runs in a separate task.",
  ask_person:
    "Ask the person one question with a single choice. Put the decision in title and the prepared work in detail. Give at least two options or omit options for Done and Unable to do it. Never ask for secrets in chat.",
} satisfies Partial<Record<AgentToolName, string>>;

export function connectionHasBrowserProfiles(grant: AgentGrant) {
  return (
    grant.scope === "everything" || grant.resources.some(({ kind }) => kind === "browser-profile")
  );
}

export function connectionComputerKinds(grant: AgentGrant) {
  return {
    apps:
      grant.scope === "everything" ||
      grant.resources.some((r) => r.kind === "computer-app" && r.app.kind === "mac-app"),
    phones:
      grant.scope === "everything" ||
      grant.resources.some((r) => r.kind === "computer-app" && r.app.kind === "phone-screen"),
  };
}

export function connectionHasChromeTabs(grant: AgentGrant) {
  return grant.scope === "everything" || grant.resources.some(({ kind }) => kind === "chrome-tabs");
}

export const connectionDirectTools: ReadonlySet<string> = new Set([
  "tab_list",
  "browser_use",
  "browser_connect",
  "computer_use",
  "plugin_call",
  "plugin_execute",
  "plugin_resume",
  "ask_person",
  "saved_login_request",
  "card_request",
]);

const personAgentTaskTools: ReadonlySet<string> = new Set([
  "opensteer_task_read",
  "opensteer_task_send",
  "opensteer_task_interrupt",
  "opensteer_task_update",
  "opensteer_task_resume",
  "opensteer_task_wait",
  "opensteer_task_configure",
  "opensteer_task_queue",
  "opensteer_automation_create",
]);

export function connectionTaskKind(name: string) {
  if (connectionDirectTools.has(name)) return "direct";
  if (personAgentTaskTools.has(name)) return "person-agent";
  return undefined;
}

export function connectionToolDescription(tool: AgentTool, grant: AgentGrant): string {
  const description = describeConnectionTool(tool, grant);
  return connectionTaskKind(tool.name) === "direct" && tool.name !== "plugin_resume"
    ? description + " Uses a direct-work taskId."
    : description;
}

function describeConnectionTool(tool: AgentTool, grant: AgentGrant): string {
  const profile = connectionHasBrowserProfiles(grant);
  const chrome = connectionHasChromeTabs(grant);
  const { apps, phones } = connectionComputerKinds(grant);
  if (tool.name === "computer_apps")
    return `Find shared ${apps && phones ? "Mac apps and phone screens" : apps ? "Mac apps" : "phone screens"} for computer_use. Results show access. Pass computerId for installed apps.`;
  if (tool.name === "computer_use")
    return [
      "Run JavaScript against one target from computer_apps. Pass computerId.",
      ...(apps
        ? ["For a Mac app pass app (name or bundleId), then await (await target).window()."]
        : []),
      ...(phones ? ["For a phone use await (await target).observe()."] : []),
      "help() prints the API. Await calls, print() results. Set readOnly to observe only.",
    ].join(" ");
  if (tool.name === "tab_list") {
    const kinds = [
      profile ? "tabs in shared profiles" : null,
      chrome ? "Chrome tabs the person shared" : null,
    ]
      .filter(Boolean)
      .join(" and ");
    return `Find ${kinds}. Use tabId with browser_use or browser_connect. Keep the same filters when following nextCursor.`;
  }
  if (tool.name === "browser_use")
    return [
      "Run one browser script. Use await pages(), await openPage(tabId), page.goto(), page.locator() and print(). Page methods use Playwright names where supported. help() prints the script API.",
      ...(profile
        ? [
            "In a shared profile, await newPage(url, {profileId}) opens a tab and await page.close() closes it.",
          ]
        : []),
      ...(chrome
        ? [
            "For a Chrome tab the person shared, pass its tabId. You can follow its popups but cannot create or close tabs there.",
          ]
        : []),
    ].join(" ");
  if (tool.name === "browser_connect")
    return [
      "Use chromium.connectOverCDP(endpoint) with stock Playwright, or Puppeteer. context.newCDPSession(page) works. Attach within a minute. Renew with the returned tabId.",
      ...(profile ? ["Using a profile without tabId opens a new blank tab."] : []),
      ...(chrome
        ? ["Pass tabId for a Chrome tab the person shared. Access covers the tab and its popups."]
        : []),
    ].join(" ");
  return descriptions[tool.name as keyof typeof descriptions] ?? tool.description;
}

const { question, options } = ask_person.input.shape.questions.element.shape;
const singleQuestion = z.strictObject({ question, options });
const pluginArguments = z.strictObject({ path: z.string(), input: z.unknown().nonoptional() });

export function connectionToolInput(tool: AgentTool, grant: AgentGrant): z.ZodObject {
  let input: z.ZodObject = tool.input;
  switch (tool.name) {
    case "ask_person":
      input = tool.input.safeExtend({ questions: z.array(singleQuestion).length(1) });
      break;
    case "saved_login_request":
    case "card_request":
      input = z.strictObject(tool.input.shape).required({ tabId: true });
      break;
    case "computer_use":
      input = tool.input
        .required({ computerId: true })
        .safeExtend({ code: z.string().min(1).max(requestTextMaxLength) });
      const { apps, phones } = connectionComputerKinds(grant);
      if (!apps) input = z.strictObject(input.shape).omit({ app: true });
      if (!phones) input = z.strictObject(input.shape).required({ app: true });
      break;
    case "browser_use":
      input = tool.input.safeExtend({ code: z.string().min(1).max(requestTextMaxLength) });
      break;
    case "plugin_call":
      input = z.strictObject({
        ...tool.input.shape,
        calls: z.union([pluginArguments, z.array(pluginArguments).min(1).max(100)]),
      });
      break;
    case "plugin_execute":
      input = tool.input
        .required({ namespace: true })
        .safeExtend({ code: z.string().min(1).max(requestTextMaxLength) });
      break;
    case "plugin_resume":
      input = tool.input.required({ taskId: true });
      break;
    case "opensteer_task_send":
      input = z.strictObject(tool.input.shape).omit({ observationId: true });
      break;
    case "opensteer_task_create":
      input = z.strictObject(tool.input.shape).omit({ observationId: true });
      break;
  }
  if (
    (tool.name === "browser_use" || tool.name === "browser_connect") &&
    !connectionHasBrowserProfiles(grant)
  )
    input = z.strictObject(input.shape).omit({ profileId: true }).required({ tabId: true });
  if (connectionTaskKind(tool.name) === "person-agent" && "taskId" in input.shape)
    input = z.strictObject(input.shape).required({ taskId: true });
  if (connectionDirectTools.has(tool.name))
    input = input.safeExtend({ operationId: AgentOperationIdSchema.optional() });
  return input;
}

export function connectionToolSchema(tool: AgentTool, grant: AgentGrant) {
  return z.toJSONSchema(connectionToolInput(tool, grant), {
    io: "input",
    override: ({ jsonSchema }) => {
      delete jsonSchema.description;
      delete jsonSchema.default;
      if (jsonSchema.additionalProperties === true) delete jsonSchema.additionalProperties;
      if (jsonSchema.enum !== undefined || jsonSchema.const !== undefined) delete jsonSchema.type;
      if (jsonSchema.format === "uuid") delete jsonSchema.format;
      if (jsonSchema.minLength === 1) delete jsonSchema.minLength;
      if (jsonSchema.maxLength !== requestTextMaxLength) delete jsonSchema.maxLength;
      if (jsonSchema.minimum === 1) delete jsonSchema.minimum;
      if (jsonSchema.minimum === 0) delete jsonSchema.minimum;
      delete jsonSchema.maximum;
    },
  });
}
