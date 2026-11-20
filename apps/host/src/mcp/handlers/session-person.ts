import { parseSignInSite } from "../../browser/sign-in-admission.js";
import { agentGrantAllows, refused, type RequestId } from "@opensteer/core";
import type { OpensteerStore } from "@opensteer/database";
import type { AgentSessionService } from "../../agent-sessions/agent-session-service.js";
import type { BrowserService } from "../../browser/browser-service.js";
import type { SavedLoginService } from "../../browser/saved-logins.js";
import type { ConnectionCaller } from "../agent-caller.js";
import { directResult } from "./direct.js";
import type { ToolCall } from "./types.js";

function tabRefusal() {
  return refused("forbidden", "This tab is unavailable to this connected agent.");
}

interface SessionPersonOptions {
  readonly sessions: AgentSessionService;
  readonly browser: Pick<BrowserService, "signInTarget">;
  readonly logins: Pick<SavedLoginService, "useSessionCredential" | "replaySessionCredential">;
  readonly store: Pick<
    OpensteerStore,
    "database" | "requests" | "admitExecution" | "requireSelfDeviceId"
  >;
}

type CredentialResult = {
  readonly loginStatus?: string;
  readonly loginRef?: string;
  readonly cardStatus?: string;
  readonly cardRef?: string;
  readonly reason?: string;
};

function matchesSite(url: string | null | undefined, site: string): boolean {
  if (!url) return false;
  try {
    return parseSignInSite(url) === site;
  } catch {
    return false;
  }
}

export class SessionPersonTools {
  readonly #options: SessionPersonOptions;
  constructor(options: SessionPersonOptions) {
    this.#options = options;
  }

  async credentials(
    call: (ToolCall<"saved_login_request"> | ToolCall<"card_request">) & {
      readonly caller: ConnectionCaller;
    },
    credential: "login" | "card",
  ) {
    const { caller, input, operationKey } = call;
    if (!input.tabId) throw tabRefusal();
    const tabId = input.tabId;
    const target = await this.#options.browser
      .signInTarget({ ownerId: caller.userId, tabId })
      .catch(() => null);
    if (
      !target?.live ||
      !target.profileId ||
      !agentGrantAllows(
        caller.grant,
        {
          kind: "browser-profile",
          profileId: target.profileId,
        },
        "read-write",
      )
    )
      throw tabRefusal();

    const site = parseSignInSite(input.site);
    if (!matchesSite(target.tabUrl, site))
      throw refused("bad_request", "Open the site's form in this tab before requesting Passwords.");
    const profileId = target.profileId;
    const device = target.computer
      ? {
          id: await this.#options.store.requireSelfDeviceId(target.computer.runnerId),
          name: target.computer.name,
        }
      : null;
    const tool = credential === "login" ? "saved_login_request" : "card_request";
    const { taskId: _taskId, ...argumentsForOperation } = input;
    return directResult(
      await this.#options.sessions.run<CredentialResult>({
        ownerUserId: caller.userId,
        agentConnectionId: caller.connectionId,
        taskId: input.taskId,
        operationKey,
        tool,
        input: argumentsForOperation,
        target: {
          grant: { kind: "browser-profile", profileId },
          name: target.profileName ?? "Browser profile",
          device,
        },
        targetGeneration: JSON.stringify([target.sessionId, tabId, target.tabGeneration]),
        effect: "read",
        calls: JSON.stringify({ tool, tabId, site: input.site }),
        reason: input.reason,
        passwordsApproval: true,
        timeoutMs: 15 * 60_000,
        replay: async (row) => {
          const ready = await this.#options.logins.replaySessionCredential(row.id);
          if (ready) return ready;
          const status = row.resultSummary?.status;
          const reason =
            typeof row.resultSummary?.reason === "string" ? row.resultSummary.reason : undefined;
          return {
            ...(credential === "login"
              ? { loginStatus: status === "declined" ? status : "unavailable" }
              : { cardStatus: status === "declined" ? status : "unavailable" }),
            ...(status === "ready" ? { reason: "expired" } : reason ? { reason } : {}),
          };
        },
        execute: async (context) => {
          await context.recheck();
          const authorized = async () => {
            try {
              const execution = await this.#options.store.admitExecution({
                ownerUserId: caller.userId,
                subject: { kind: "binding", bindingId: context.bindingId },
              });
              if (execution.agentConnection?.grantRevision !== context.grantRevision) return false;
              const live = await this.#options.browser.signInTarget({
                ownerId: caller.userId,
                agentBindingId: context.bindingId,
                tabId,
                sessionId: target.sessionId,
              });
              return (
                live?.live === true &&
                live.profileId === profileId &&
                live.tabGeneration === target.tabGeneration &&
                matchesSite(live.tabUrl, site)
              );
            } catch {
              return false;
            }
          };
          const result = await this.#options.logins.useSessionCredential({
            credential,
            target,
            ownerId: caller.userId,
            taskId: context.taskId,
            reason: input.reason,
            site: input.site,
            scope: {
              bindingId: context.bindingId,
              sessionId: context.sessionId,
              operationId: context.operationId,
              grantRevision: context.grantRevision,
              profileId,
              signal: context.signal,
              authorized,
            },
          });
          if (result.status === "ready") {
            if (!(await authorized())) throw tabRefusal();
            return "loginRef" in result
              ? { loginStatus: "ready" as const, loginRef: result.loginRef }
              : { cardStatus: "ready" as const, cardRef: result.cardRef };
          }
          return {
            ...(credential === "login"
              ? { loginStatus: result.status }
              : { cardStatus: result.status }),
            ...("reason" in result ? { reason: result.reason } : {}),
          };
        },
        summarize: (result) => ({
          status: result.loginStatus ?? result.cardStatus,
          ...(result.reason ? { reason: result.reason } : {}),
        }),
      }),
    );
  }

  async question(call: ToolCall<"ask_person"> & { readonly caller: ConnectionCaller }) {
    const { caller, input, operationKey } = call;
    const question = input.questions[0];
    if (input.questions.length !== 1 || !question || question.multiSelect)
      throw refused("bad_request", "Ask one question with a single answer.");
    const choices = (question.options ?? [{ label: "Done" }, { label: "Unable to do it" }]).map(
      ({ label }) => ({ label, value: label }),
    );
    const { taskId: _taskId, ...argumentsForOperation } = input;
    const answer = async (requestId: RequestId | null) => {
      const request = requestId && (await this.#options.store.requests.get(requestId));
      return request && request.status === "fulfilled" && request.response?.kind === "form"
        ? { answer: request.response.answers.question_1?.[0] }
        : {};
    };
    return directResult(
      await this.#options.sessions.run({
        ownerUserId: caller.userId,
        agentConnectionId: caller.connectionId,
        taskId: input.taskId,
        operationKey,
        tool: "ask_person",
        input: argumentsForOperation,
        target: null,
        targetName: "The person",
        effect: "read",
        calls: JSON.stringify(argumentsForOperation),
        question: async (taskId) => {
          const [{ label }, { title }] = await Promise.all([
            this.#options.store.database
              .selectFrom("agentConnections")
              .select("label")
              .where("userId", "=", caller.userId)
              .where("id", "=", caller.connectionId)
              .executeTakeFirstOrThrow(),
            this.#options.store.database
              .selectFrom("threads")
              .select("title")
              .where("id", "=", taskId)
              .executeTakeFirstOrThrow(),
          ]);
          const quote = [input.title, input.detail]
            .filter(Boolean)
            .join("\n\n")
            .split("\n")
            .map((line) => "> " + line)
            .join("\n");
          return {
            kind: "form",
            title: `Connected agent ${label} asks in ${title}`.slice(0, 200),
            detail: (
              "Enter passwords and codes only in the page.\n\nThe agent wrote:\n\n" + quote
            ).slice(0, 20_000),
            fields: [
              {
                id: "question_1",
                prompt: question.question,
                choices,
                custom: false,
                multiSelect: false,
                secret: false,
              },
            ],
          };
        },
        execute: (context) => answer(context.requestId),
        replay: (row) => answer(row.requestId),
        summarize: () => ({ answers: 1 }),
      }),
    );
  }
}
