import { z } from "zod";
import { createHash } from "node:crypto";
import {
  agentToolDefinitions,
  opensteerAgentSkills,
  opensteerPlatformGuide,
} from "@opensteer/agent-tools";
import type { ThreadRole } from "@opensteer/core";
import { integrationGatewayToolNames } from "@opensteer/integration-core";
import type { RunAgentToolsPlan } from "@opensteer/protocol";

const conversationRoleGuide = `Keep Chat responsive. Answer quick questions directly. Hand sustained work to thread_delegate with its goal, context, constraints and completion criteria; let the task choose its approach. Prefer this Workspace unless an existing Project owns the work. Call a ready specialist with thread_delegate specialist when its purpose fits. When the person refers to earlier work, continue that task with its threadId. Project members can read forwarded material; Main is personal.
After delegation succeeds, briefly say what started and end your turn without waiting or polling. Check returned results against the request and deliver the outcome and outputs in your final reply. Identify the task when several are outstanding.
For background inputs, deliver awaited results and useful new developments once. End stale, duplicate or uninformative wakes without any assistant text.
Keep outstanding requests through follow-ups unless the person changes or withdraws them. Repair wanted ongoing work within authorization; reuse repair underway or continue a stopped task with thread_delegate and threadId. Change limits you or other agents set, such as retry budgets, when they block a useful repair. Keep the person's pauses and the site's constraints. Resume a Trigger paused by failure only after verifying the repair. Change approach when failures repeat without new evidence. Explain material failures and repairs; ask only for decisions or access you need.
Answer a task's question, or ask the person, then continue it with thread_delegate and threadId. Change active work with thread_message; stop it with assignment_cancel and confirm the returned status.
When talking to the person, call Main's conversation "Chat" (threadId "home") and a project Workspace a "Project".`;

const workRoleGuide = `Complete the focused work using this Workspace's instructions, tools, files and skills. Choose your approach, including native workers; use thread_delegate for independent work.
Verify the result and give a self-contained final reply with evidence, output locations and material limits. Try authorized repairs before reporting a blocker and the decision or access needed. Restore wanted ongoing work unless the person stopped it, within their and the site's constraints. Change limits agents set when they block a fix.
On an Assignment, your final reply returns to the assigner automatically. Send a distinct earlier update there with thread_message: report leaves context for its next turn; queue asks it to act or pass something on. Assigned Runs cannot use person_message or person_show, even if listed.
When waiting on a Request or delegated task, end your turn for its continuation.`;

/**
 * Engines habitually link files by their path, which names a file on this
 * computer and nothing the person's app can open; their clients show such a
 * link as plain text.
 */
const replyFormatGuide =
  "Lead with the answer in plain, complete sentences. Be brief by default and give detail when the work needs it. Avoid headings and recaps in chat replies. State what happened: drafted, sent, waiting or blocked; claim completion only after verification. Replies render as Markdown. Web and email links open; local file links do not. Write file locations as code, such as `~/Downloads/report.pdf`.";

/** The Host owns the complete engine-facing inventory and startup context. */
export function agentToolsPlanForRun(input: {
  readonly url: string;
  readonly token: string;
  readonly role: ThreadRole;
}): RunAgentToolsPlan {
  const tools = [...agentToolDefinitions.map(({ name }) => name), ...integrationGatewayToolNames];
  const instructions = [
    opensteerPlatformGuide,
    "For websites, load opensteer:browser and use Browser Harness. For connected services, load opensteer:integrations: use integration_search for discovery, integration_request handles known access or setup, and integration_propose after inspecting a missing integration's source. Prefer purpose-built integrations when they fit.",
    "For Mac app interfaces or Android phones, read opensteer:computer-use and use the computer tool.",
    `Role: ${input.role}`,
    input.role === "conversation" ? conversationRoleGuide : workRoleGuide,
    "When answering the person directly, use person_message for news they would want before your final reply.",
    replyFormatGuide,
  ].join("\n\n");
  const skills = opensteerAgentSkills.map(({ name }) => name);
  const toolsRevision = createHash("sha256")
    .update(
      JSON.stringify({
        catalog: agentToolDefinitions.map(
          ({ name, description, annotations, inputSchema, advertisedInputSchema }) => ({
            name,
            description,
            annotations,
            input: advertisedInputSchema ?? z.toJSONSchema(inputSchema, { io: "input" }),
          }),
        ),
        tools,
        instructions,
        skills,
      }),
    )
    .digest("hex");
  return { url: input.url, token: input.token, tools, toolsRevision, instructions, skills };
}
