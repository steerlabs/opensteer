import { requestOperationCallsMaxLength, type AgentGrant } from "@opensteer/core";
import { z } from "zod";
import type { AgentTool, AgentToolName } from "./tools/index.js";
import { opensteer_task_create } from "./tools/threads.js";
import {
  connectionStateAreas,
  connectionStateDescription,
  type StateArea,
} from "./tools/commands.js";
import { ask_person } from "./tools/person.js";

const callsLimit = requestOperationCallsMaxLength.toLocaleString("en-US");

const descriptions = {
  saved_login_request:
    'Request a login for tabId and site in a shared profile. In browser_use: const page = await openPage(tabId); focus the field, then await page.cdp("Opensteer.fillLogin", {loginRef, field: "password"}). Fields: username, password, code. A script controlling the page can read filled values. Never read them back, print or store them.',
  card_request:
    'Request a card for tabId and site. In browser_use: const page = await openPage(tabId); focus the field; await page.cdp("Opensteer.fillCard", {cardRef, field: "number"}). Fields: expiry, expiry-month, expiry-year, cvc, name, billing-postal-code. Opensteer fills the card into the page without returning it. A script in that page can read it. Never read back or store it. Get purchase approval.',
  plugin_call: `Call one plugin's {path,input} from discover (max ${callsLimit} JSON characters). Pending input: plugin_resume with executionId and taskId. Pending approval: repeat with operationId.`,
  plugin_execute: `Run JavaScript in one namespace from discover, up to ${callsLimit} characters. Pending input: plugin_resume with executionId and taskId. Pending approval: repeat with operationId.`,
  plugin_resume:
    "Resume plugin input with executionId and its direct-work taskId. Repeat while pending to wait up to 25 seconds.",
  opensteer_task_create:
    "Start a task for one of the person's agents. Uses the person's default account and model. Use the returned taskId with opensteer_task_wait or opensteer_task_read.",
  opensteer_task_read:
    "Read messages or activity for a task run by the person's agent. Pass itemId for one full item.",
  opensteer_task_send:
    "Send context to a task run by one of the person's agents. report leaves context, queue requests a turn and waits if paused, and steer speaks to its current turn. freshContext applies only to queue. Accepted does not mean read.",
  opensteer_task_interrupt:
    "Stop the current turn of a task run by one of the person's agents and pause its queue. Only the person can resume it.",
  opensteer_task_wait:
    "Wait for the person's agent to settle or ask a question. Pass a child taskId from discover to get its delegated result. A timeout leaves work running. If hasMore, wait again after the last itemId.",
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
  "opensteer_task_wait",
]);

export function connectionTaskKind(name: string) {
  if (name === "discover" || connectionDirectTools.has(name)) return "direct";
  if (personAgentTaskTools.has(name)) return "person-agent";
  return undefined;
}

export function connectionToolDescription(tool: AgentTool, grant: AgentGrant): string {
  const description = describeConnectionTool(tool, grant);
  return connectionTaskKind(tool.name) === "direct" &&
    tool.name !== "plugin_resume" &&
    tool.name !== "discover"
    ? description + " Uses a direct-work taskId."
    : description;
}

function describeConnectionTool(tool: AgentTool, grant: AgentGrant): string {
  if (tool.name === "opensteer_state")
    return connectionStateDescription(connectionStateAreas(grant));
  const profile = connectionHasBrowserProfiles(grant);
  const chrome = connectionHasChromeTabs(grant);
  const { apps, phones } = connectionComputerKinds(grant);
  if (
    tool.name === "plugin_call" &&
    grant.scope === "selected" &&
    !grant.resources.some(
      (resource) => resource.kind === "plugin" && resource.access === "read-write",
    )
  )
    return descriptions.plugin_call + " Only read tools run.";
  if (tool.name === "discover")
    return tool.description + " A taskId applies only to live reads and names direct work.";
  if (tool.name === "computer_use")
    return [
      `Run JavaScript against one target from discover, up to ${callsLimit} characters. Pass computerId.`,
      ...(apps
        ? ["For a Mac app pass app (name or bundleId), then await (await target).window()."]
        : []),
      ...(phones ? ["For a phone use await (await target).observe()."] : []),
      "help() prints the API. Await calls, print() results. Set readOnly to observe only.",
    ].join(" ");
  if (tool.name === "browser_use")
    return [
      `Run one browser script, up to ${callsLimit} characters. Await pages(), openPage(tabId), page.goto() and page.locator() actions. Page methods use Playwright names where supported. Use print() for results and help() for the full API.`,
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
      ...(profile
        ? [
            "A profile connection controls your task's own pages, with access to every cookie and signed-in site in the profile for up to 10 minutes. Using a profile without tabId opens a new blank tab.",
          ]
        : []),
      ...(chrome
        ? ["Pass tabId for a Chrome tab the person shared. Access covers the tab and its popups."]
        : []),
    ].join(" ");
  return descriptions[tool.name as keyof typeof descriptions] ?? tool.description;
}

const { question, options } = ask_person.input.shape.questions.element.shape;
const singleQuestion = z.strictObject({ question, options });
const pluginArguments = z.strictObject({ path: z.string(), input: z.unknown().nonoptional() });

export const connectionTaskCreateInput = z
  .strictObject(opensteer_task_create.input.shape)
  .omit({ observationId: true, aiAccountId: true, model: true });

export function connectionToolInput(tool: AgentTool, grant: AgentGrant): z.ZodObject {
  let input: z.ZodObject = tool.input;
  switch (tool.name) {
    case "opensteer_state":
      input = z.strictObject({
        area: z.enum(connectionStateAreas(grant) as [StateArea, ...StateArea[]]),
      });
      break;
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
        .safeExtend({ code: z.string().min(1).max(requestOperationCallsMaxLength) });
      const { apps, phones } = connectionComputerKinds(grant);
      if (!apps) input = z.strictObject(input.shape).omit({ app: true });
      if (!phones) input = z.strictObject(input.shape).required({ app: true });
      break;
    case "browser_use":
      input = tool.input.safeExtend({
        code: z.string().min(1).max(requestOperationCallsMaxLength),
      });
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
        .safeExtend({ code: z.string().min(1).max(requestOperationCallsMaxLength) });
      break;
    case "plugin_resume":
      input = tool.input.required({ taskId: true });
      break;
    case "opensteer_task_send":
      input = z.strictObject(tool.input.shape).omit({ observationId: true });
      break;
    case "opensteer_task_create":
      input = connectionTaskCreateInput;
      break;
  }
  if (
    (tool.name === "browser_use" || tool.name === "browser_connect") &&
    !connectionHasBrowserProfiles(grant)
  )
    input = z.strictObject(input.shape).omit({ profileId: true }).required({ tabId: true });
  if (connectionTaskKind(tool.name) === "person-agent" && "taskId" in input.shape)
    input = z.strictObject(input.shape).required({ taskId: true });
  return input;
}

export function connectionToolSchema(tool: AgentTool, grant: AgentGrant) {
  const input = connectionToolInput(tool, grant);
  const advertised =
    "operationId" in input.shape ? input.safeExtend({ operationId: z.string().optional() }) : input;
  return z.toJSONSchema(advertised, {
    io: "input",
    override: ({ jsonSchema }) => {
      delete jsonSchema.description;
      delete jsonSchema.default;
      if (jsonSchema.additionalProperties === true) delete jsonSchema.additionalProperties;
      if (jsonSchema.enum !== undefined || jsonSchema.const !== undefined) delete jsonSchema.type;
      if (jsonSchema.format === "uuid") delete jsonSchema.format;
      if (jsonSchema.minLength === 1) delete jsonSchema.minLength;
      if (jsonSchema.maxLength !== requestOperationCallsMaxLength) delete jsonSchema.maxLength;
      if (jsonSchema.minimum === 1) delete jsonSchema.minimum;
      if (jsonSchema.minimum === 0) delete jsonSchema.minimum;
      delete jsonSchema.maximum;
    },
  });
}
