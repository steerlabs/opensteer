import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import {
  BrowserRuntime,
  BrowserRuntimeServer,
  Ed25519AttachTicketVerifier,
  pageWithTarget,
  type LaunchedBrowser,
} from "../packages/browser-runtime-core/src/index.js";
import { type BrowserAttachPublicKey } from "../packages/protocol/src/browser.js";
import { PlaywrightChromiumLauncher } from "../apps/browser-runtime/src/browser/playwright-launcher.js";
import { BrowserModuleRelay } from "../packages/runner-client/src/browser-relay.js";
import { LocalBrowserRuntimeBridge } from "../packages/runner-client/src/browser-bridge.js";
import {
  Client,
  StreamableHTTPClientTransport,
  type Transport,
} from "../apps/host/src/mcp/mcp-sdk-client.test-support.js";
import { AgentConnectionStore } from "../packages/database/src/index.js";
import { NotificationStore } from "../packages/database/src/notification-store.js";
import {
  BrowserSurfaceIdSchema,
  ThreadIdSchema,
  type Request,
} from "../packages/core/src/index.js";
import { z } from "zod";
import { expect, it } from "vitest";
import {
  connectCallerMachine,
  createMachineAccessDatabase,
  startPrivateMachineHost,
} from "../apps/host/src/runtime/private-machine-host.test-support.js";
import {
  credentialHash,
  connectionCredentialPrefix,
} from "../apps/host/src/mcp/connections/connection-authenticator.js";
import { mcpResourcePath } from "../apps/host/src/mcp/connections/connection-oauth.js";
import { testRpcData } from "../apps/host/src/server/test-host-api-request.js";
import { startBrowserRuntime } from "../apps/host/src/browser/browser-runtime.test-support.js";
import {
  passwordFixture,
  startPasswordsAuthority,
} from "../apps/host/src/browser/passwords-authority.test-support.js";

it.skipIf(!process.env.OPENSTEER_TEST_DATABASE_URL)(
  "lets a selected browser agent ask the person, fill approved Passwords, and lose the reference on Disconnect",
  async () => {
    const database = await createMachineAccessDatabase(process.env.OPENSTEER_TEST_DATABASE_URL!);
    const close: (() => Promise<unknown>)[] = [() => database.drop()];
    const notices = new Map<
      Request["kind"],
      (
        reaction: Extract<
          import("../packages/database/src/personal-mutation.js").PersonalCommitReaction,
          { type: "requestChanged" }
        >,
      ) => void
    >();
    try {
      const site = await signInFixture();
      close.push(site.close);
      const scratch = await mkdtemp(join(tmpdir(), "opensteer-session-person-"));
      close.push(() => rm(scratch, { recursive: true, force: true }));
      const launcher = new PlaywrightChromiumLauncher({
        executablePath: chromium.executablePath(),
        headless: true,
        chromiumSandbox: false,
        args: ["--no-proxy-server", "--host-resolver-rules=MAP passwords-fixture.test 127.0.0.1"],
      });
      let chromiumBrowser: LaunchedBrowser | undefined;
      let keys: readonly BrowserAttachPublicKey[] = [];
      let passwords: Awaited<ReturnType<typeof startPasswordsAuthority>> | undefined;
      const runtimeId = "browser-runtime-integration";
      const runtime = new BrowserRuntime({
        runtimeId,
        launcher: {
          localProfiles: launcher.localProfiles,
          launch: async (request, signal) => {
            chromiumBrowser = await launcher.launch(request, signal);
            return chromiumBrowser;
          },
        },
        localProfiles: { root: join(scratch, "profiles") },
        sessionFilesRoot: join(scratch, "files"),
        ticketVerifier: await Ed25519AttachTicketVerifier.create({
          replayLedgerPath: join(scratch, "private", "replay.json"),
          resolvePublicKey: (id) => keys.find((key) => key.keyId === id)?.publicKeyPem ?? null,
        }),
        loginAuthority: {
          probe: async () => "has-login",
          authorize: async () => ({ kind: "ended", outcome: { kind: "expired" } }),
          end: async () => undefined,
          fill: async () => "expired",
          fillReference: async ({ loginRef, field, targetId, lease }) => {
            const value = passwords?.releasedLogin(loginRef, field);
            if (!value || !chromiumBrowser) return "expired";
            const page = await pageWithTarget(
              chromiumBrowser.context.pages(),
              targetId,
              1_000,
              (entry) => !entry.isClosed(),
            );
            if (!page || new URL(page.url()).origin !== site.origin) return "wrong-site";
            const cdp = await page.agentCdp();
            try {
              lease.throwIfAborted();
              await cdp.send("Input.insertText", { text: value });
              return "filled";
            } finally {
              await cdp.detach();
            }
          },
        },
      });
      const bridgeToken = randomBytes(32).toString("base64url");
      const runtimeServer = new BrowserRuntimeServer({
        runtime,
        port: 0,
        relayBridge: {
          token: bridgeToken,
          updateAttachKeys: (next) => {
            keys = next;
          },
        },
      });
      close.push(() => runtimeServer.close());
      const address = await runtimeServer.start();
      const runtimeRelay = new BrowserModuleRelay(
        new LocalBrowserRuntimeBridge({
          runtimeId,
          bridgeToken,
          url: new URL(`http://${address.host}:${address.port}`),
        }),
      );
      const host = await startPrivateMachineHost(database.url, {
        onPersonalReaction: (reaction) => {
          if (reaction.type === "requestChanged" && reaction.status === "pending")
            notices.get(reaction.kind)?.(reaction);
        },
      });
      close.push(() => host.close());
      const mac = await connectCallerMachine(host, {
        name: "Passwords Mac",
        environmentId: host.ownerEnvironmentId,
        loginFill: true,
        token: host.hostingRunnerEnrollmentToken,
        integrations: { platform: "darwin", protocolVersion: 5, passwordSignIn: 2, cardUse: 1 },
        browser: {
          runtimeId,
          wireVersion: 2,
          cdpBoundary: 1,
          sharedControl: 1,
          tabRestoreVersion: 1,
          surfaceState: 1,
          signIn: { version: 3 },
          cardFill: 1,
          localProfileStorage: runtime.localProfileStorage!,
        },
      });
      close.push(() => mac.close());
      const witnessed: boolean[] = [];
      const authority = (passwords = await startPasswordsAuthority(
        host.hostPort,
        mac.primary,
        async (operationId) => {
          const witness = await host.store.database
            .selectFrom("requests")
            .innerJoin("agentOperations", "agentOperations.requestId", "requests.id")
            .select("requests.status")
            .where("requests.payload", "@>", JSON.stringify({ operationId }))
            .where("agentOperations.state", "=", "handed-off")
            .executeTakeFirst();
          witnessed.push(witness?.status === "pending");
        },
      ));
      close.push(() => authority.close());
      const browser = await startBrowserRuntime(host.hostPort, "existing-main", {
        primary: mac.primary,
        runtimeRelay,
        keepAlive: true,
      });
      close.push(() => browser.close());
      const profile = await host.store.createBrowserProfile({
        ownerId: host.ownerId,
        homeRunnerId: browser.runnerId,
        idempotencyKey: "work",
        name: "Work",
      });
      const endpoint = new URL(mcpResourcePath, host.origin);
      const transcript: unknown[] = [];
      const connection = new AgentConnectionStore(host.store.database);
      const agent = await connection.create({
        userId: host.ownerId,
        label: "Research assistant",
        clientName: "Research assistant",
        resource: endpoint.href,
        expiresAt: new Date(Date.now() + 60 * 60_000),
        accessMode: "full-access",
        grant: {
          scope: "selected",
          tasks: false,
          resources: [{ kind: "browser-profile", profileId: profile.id }],
        },
      });
      const token = connectionCredentialPrefix + randomBytes(32).toString("base64url");
      expect(await connection.activate(agent.id, credentialHash(token))).toBe(true);
      const connectAgent = async (bearer: string) => {
        const transport = new StreamableHTTPClientTransport(endpoint, {
          requestInit: { headers: { authorization: "Bearer " + bearer } },
        });
        let receive: typeof transport.onmessage;
        Object.defineProperty(transport, "onmessage", {
          get: () => receive,
          set: (receiver: typeof transport.onmessage) => {
            receive = (message) => {
              transcript.push(message);
              receiver?.(message);
            };
          },
        });
        const client = new Client({ name: "external-session", version: "1" });
        close.push(() => client.close());
        await client.connect(transport as unknown as Transport);
        return (name: string, args: Record<string, unknown>) => {
          const context = new Error(
            `MCP ${name} (${args.operationKey ?? "no operation key"}) did not return`,
          );
          return client.callTool({ name, arguments: args }).catch((error: unknown) => {
            context.cause = error;
            throw context;
          });
        };
      };
      const call = await connectAgent(token);
      const refusedOrDisconnected = (result: ReturnType<typeof call>) =>
        result.then(
          (reply) => reply.isError === true,
          (error: unknown) => {
            if (
              z
                .object({
                  cause: z.object({ cause: z.object({ code: z.literal("UND_ERR_SOCKET") }) }),
                })
                .safeParse(error).success
            )
              return true;
            throw error;
          },
        );
      const opened = await call("tab_open", {
        target: { kind: "page", url: site.origin, profileId: profile.id },
        operationKey: "open-form",
      });
      expect(
        opened.isError,
        JSON.stringify({
          content: opened.content,
          errors: browser.protocolErrors(),
          attached: browser.connectionCount(),
          stream: browser.streamOpen(),
        }),
      ).not.toBe(true);
      const {
        taskId,
        tab: { tabId },
      } = z
        .object({
          taskId: ThreadIdSchema,
          tab: z.object({ tabId: BrowserSurfaceIdSchema }),
        })
        .parse(opened.structuredContent);
      const owner = { headers: host.ownerHeaders };
      const pending = async (
        kind: Request["kind"],
        invoke: () => ReturnType<typeof call>,
        expectedTask: string | null = taskId,
      ) => {
        const shown =
          Promise.withResolvers<Parameters<NonNullable<ReturnType<typeof notices.get>>>[0]>();
        notices.set(kind, shown.resolve);
        const result = invoke();
        const reaction = await Promise.race([
          shown.promise,
          result.then((response) => {
            throw new Error("Call ended before opening its Request: " + JSON.stringify(response));
          }),
        ]);
        notices.delete(kind);
        const { requestId } = reaction;
        const row = await host.store.database
          .selectFrom("requests")
          .selectAll()
          .where("id", "=", requestId)
          .executeTakeFirstOrThrow();
        if (expectedTask) expect(row.originatingThreadId).toBe(expectedTask);
        expect(row.originatingAgentSessionId).toBeTruthy();
        return { reaction, requestId, expectedRevision: row.revision, row, result };
      };

      const question = await pending("person.question", () =>
        call("ask_person", {
          taskId,
          operationKey: "ask",
          title: "Check the phone",
          detail: "Enter the code in the tab.",
          questions: [{ question: "Did you enter it?" }],
        }),
      );
      expect(question.row.agentOperation).toBeNull();
      expect(question.row.presentation).toMatchObject({
        title: expect.stringContaining("Connected agent Research assistant asks in"),
        detail: expect.stringContaining("> Enter the code in the tab."),
        fields: [expect.objectContaining({ custom: false, secret: false })],
      });
      const needs = await testRpcData(host.origin, "requests.list", {}, owner);
      expect(needs.requests).toContainEqual(
        expect.objectContaining({
          request: expect.objectContaining({ id: question.requestId, originatingThreadId: taskId }),
        }),
      );
      expect(await new NotificationStore(host.store.database).decide(question.reaction)).toEqual([
        expect.objectContaining({
          userId: host.ownerId,
          view: expect.objectContaining({
            threadId: taskId,
            requestId: question.requestId,
            body: expect.stringContaining("Connected agent Research assistant"),
          }),
        }),
      ]);
      const answer = {
        type: "request.respond" as const,
        requestId: question.requestId,
        expectedRevision: question.expectedRevision,
      };
      await expect(
        testRpcData(
          host.origin,
          "commands.dispatch",
          {
            ...answer,
            idempotencyKey: "invalid-answer",
            response: { kind: "form", answers: { question_1: ["123456"] } },
          },
          owner,
        ),
      ).rejects.toThrow();
      await testRpcData(
        host.origin,
        "commands.dispatch",
        {
          ...answer,
          idempotencyKey: "answer",
          response: { kind: "form", answers: { question_1: ["Done"] } },
        },
        owner,
      );
      expect((await question.result).structuredContent).toMatchObject({
        status: "completed",
        answer: "Done",
      });

      const script = (operationKey: string, code: string) =>
        call("browser_use", {
          taskId,
          tabId,
          operationKey,
          code,
        });
      const pageBinding = `const page = await openPage(${JSON.stringify(tabId)});`;
      const form = await script(
        "detect-form",
        pageBinding + 'print(await page.locator("h1").innerText());',
      );
      expect(form.isError, JSON.stringify(form.content)).not.toBe(true);
      expect(form.content).toContainEqual({ type: "text", text: "Sign in" });

      const login = await pending("browser.password-sign-in", () =>
        call("saved_login_request", {
          taskId,
          tabId,
          site: site.origin,
          reason: "Continue in the browser",
          operationKey: "login",
        }),
      );
      const chooser = await testRpcData(
        host.origin,
        "browser.password-sign-in.get",
        { requestId: login.requestId },
        owner,
      );
      if (chooser.stage !== "approval") throw new Error("Expected a Passwords picker");
      const choice = chooser.accounts[0]!;
      await testRpcData(
        host.origin,
        "commands.dispatch",
        {
          type: "browser.password-sign-in.respond",
          requestId: login.requestId,
          expectedRevision: login.expectedRevision,
          idempotencyKey: "login-approve",
          decision: {
            kind: "approve",
            loginId: choice.id,
            revision: choice.revision,
            permissionVersion: 6,
            remember: true,
          },
        },
        owner,
      );
      const ready = z
        .object({
          status: z.literal("completed"),
          loginStatus: z.literal("ready"),
          loginRef: z.string(),
        })
        .parse((await login.result).structuredContent);
      expect(authority.commands).toContainEqual(
        expect.objectContaining({ type: "login.authorize", alwaysAsk: true }),
      );
      expect(authority.commands).toContainEqual(
        expect.objectContaining({ type: "login.approve", remember: false }),
      );
      const fill = await script(
        "fill-login",
        pageBinding +
          `
        const reference = ${JSON.stringify(ready.loginRef)};
        const fill = async (field) => {
          await page.js(\`document.querySelector('[name=\${field}]').focus()\`);
          const result = await page.cdp("Opensteer.fillLogin", { loginRef: reference, field });
          if (result.status !== "filled") throw new Error(JSON.stringify(result));
        };
        await fill("username");
        await fill("password");
        await page.getByRole("button", { name: "Sign in" }).click();
        const signedIn = page.getByRole("heading", { name: "Signed in" });
        await signedIn.waitFor();
        print(await signedIn.innerText());
      `,
      );
      expect(fill.isError, JSON.stringify(fill.content)).not.toBe(true);
      expect(fill.content).toContainEqual({ type: "text", text: "Signed in" });

      const card = await pending("browser.password-sign-in", () =>
        call("card_request", {
          taskId,
          tabId,
          site: site.origin,
          reason: "Prepare a checkout",
          operationKey: "card",
        }),
      );
      const cardChooser = await testRpcData(
        host.origin,
        "browser.password-sign-in.get",
        { requestId: card.requestId },
        owner,
      );
      if (cardChooser.stage !== "card-approval") throw new Error("Expected a card picker");
      const cardChoice = cardChooser.cards[0]!;
      await testRpcData(
        host.origin,
        "commands.dispatch",
        {
          type: "browser.password-sign-in.respond",
          requestId: card.requestId,
          expectedRevision: card.expectedRevision,
          idempotencyKey: "card-allow",
          decision: {
            kind: "approve-card",
            cardId: cardChoice.id,
            revision: cardChoice.revision,
            permissionVersion: 7,
          },
        },
        owner,
      );
      const cardReply = (await card.result).structuredContent;
      expect(cardReply).not.toHaveProperty("lastFour");
      expect(cardReply).not.toHaveProperty("brand");
      expect(cardReply).toMatchObject({
        status: "completed",
        cardStatus: "ready",
        cardRef: expect.stringMatching(/^crd_/u),
      });
      expect(witnessed).toEqual([true, true]);

      const stillWaiting = await pending("person.question", () =>
        call("ask_person", {
          taskId,
          operationKey: "still-waiting",
          title: "Check the approval",
          questions: [{ question: "Did it go through?" }],
        }),
      );
      await expect(
        testRpcData(
          host.origin,
          "commands.dispatch",
          {
            ...answer,
            idempotencyKey: "old-answer",
            response: { kind: "form", answers: { question_1: ["Done"] } },
          },
          owner,
        ),
      ).rejects.toThrow();
      expect((await host.store.requests.get(stillWaiting.requestId))?.status).toBe("pending");

      const waitingLogin = await pending("browser.password-sign-in", () =>
        call("saved_login_request", {
          taskId,
          tabId,
          site: site.origin,
          reason: "Sign in again",
          operationKey: "cancel-login",
        }),
      );
      const pendingPicker = await testRpcData(
        host.origin,
        "browser.password-sign-in.get",
        { requestId: waitingLogin.requestId },
        owner,
      );
      expect(pendingPicker.stage).toBe("approval");
      expect(witnessed).toEqual([true, true, true]);
      const tab = await host.store.database
        .selectFrom("personalTabs")
        .select("pageBinding")
        .where("id", "=", tabId)
        .executeTakeFirstOrThrow();
      if (!tab.pageBinding) throw new Error("Missing Browser Session");
      const staleRef = {
        method: "Opensteer.fillLogin",
        parameters: { loginRef: ready.loginRef, field: "password" },
      };
      const bind = {
        ownerId: host.ownerId,
        agentBindingId: "session:" + login.row.originatingAgentSessionId,
        sessionId: tab.pageBinding.sessionId,
        scriptTabId: tabId,
        scriptThreadId: taskId,
      };
      const attachment = await host.runtime.browser.attachCdpForAgent(bind, () => undefined);
      close.push(async () => attachment.close());
      const lastFill = browser
        .receivedCommands()
        .findLast(
          (entry) =>
            z.object({ method: z.literal("Opensteer.fillLogin") }).safeParse(entry.command).success,
        );
      const {
        command: { sessionId },
      } = z.object({ command: z.object({ sessionId: z.string() }) }).parse(lastFill);
      await testRpcData(
        host.origin,
        "commands.dispatch",
        {
          type: "connection.revoke",
          connectionId: agent.id,
          idempotencyKey: "disconnect",
        },
        owner,
      );
      expect(await refusedOrDisconnected(stillWaiting.result)).toBe(true);
      expect((await host.store.requests.get(stillWaiting.requestId))?.status).toBe("cancelled");
      expect((await host.store.requests.get(waitingLogin.requestId))?.status).toBe("cancelled");
      await expect(refusedOrDisconnected(waitingLogin.result)).resolves.toBe(true);
      const approvals = authority.commands.filter(({ type }) => type === "login.approve").length;
      expect(
        await testRpcData(
          host.origin,
          "commands.dispatch",
          {
            type: "browser.password-sign-in.respond",
            requestId: waitingLogin.requestId,
            expectedRevision: waitingLogin.expectedRevision,
            idempotencyKey: "late-login",
            decision: {
              kind: "approve",
              loginId: choice.id,
              revision: choice.revision,
              remember: false,
              permissionVersion: 6,
            },
          },
          owner,
        ),
      ).toMatchObject({ status: "cancelled" });
      expect(authority.commands.filter(({ type }) => type === "login.approve")).toHaveLength(
        approvals,
      );
      const forwardedBefore = browser.receivedCommands().length;
      expect(
        await attachment.request({ ...staleRef, sessionId }).catch(() => ({ status: "expired" })),
      ).toEqual({ status: "expired" });
      expect(
        browser
          .receivedCommands()
          .slice(forwardedBefore)
          .filter(
            (entry) =>
              z.object({ method: z.literal("Opensteer.fillLogin") }).safeParse(entry.command)
                .success,
          ),
      ).toHaveLength(0);
      const other = await host.store.createBrowserProfile({
        ownerId: host.ownerId,
        homeRunnerId: browser.runnerId,
        idempotencyKey: "private",
        name: "Private",
      });
      const newAgent = async (label: string) => {
        const grant = {
          scope: "selected" as const,
          tasks: true,
          resources: [{ kind: "browser-profile" as const, profileId: other.id }],
        };
        const entry = await connection.create({
          userId: host.ownerId,
          label,
          clientName: label,
          resource: endpoint.href,
          expiresAt: new Date(Date.now() + 60 * 60_000),
          accessMode: "approval-required",
          grant,
        });
        const bearer = connectionCredentialPrefix + randomBytes(32).toString("base64url");
        expect(await connection.activate(entry.id, credentialHash(bearer))).toBe(true);
        return { entry, call: await connectAgent(bearer) };
      };
      const restricted = await newAgent("Other agent");
      const authorityCalls = authority.commands.length;
      const requestLogin = (target: string, operationKey: string) =>
        restricted.call("saved_login_request", {
          tabId: target,
          site: site.origin,
          reason: "Continue",
          operationKey,
        });
      const unshared = await requestLogin(tabId, "unshared");
      const missing = await requestLogin("does-not-exist", "missing");
      expect(unshared.isError).toBe(true);
      expect(unshared.content).toEqual(missing.content);
      expect(authority.commands).toHaveLength(authorityCalls);

      for (const action of ["stop", "narrow", "expire"] as const) {
        const agent = await newAgent(action);
        const open = await pending(
          "person.question",
          () =>
            agent.call("ask_person", {
              title: "Finish sign-in",
              questions: [{ question: "Did you finish?" }],
              operationKey: "ask",
            }),
          null,
        );
        if (action === "stop") {
          expect(
            await testRpcData(
              host.origin,
              "commands.dispatch",
              {
                type: "agent.session.stop",
                threadId: open.row.originatingThreadId,
                agentSessionId: open.row.originatingAgentSessionId!,
                idempotencyKey: action,
              },
              owner,
            ),
          ).toMatchObject({ ended: true });
        } else if (action === "narrow") {
          const current = (await connection.list(host.ownerId)).find(
            ({ id }) => id === agent.entry.id,
          )!;
          await testRpcData(
            host.origin,
            "commands.dispatch",
            {
              type: "connection.update",
              connectionId: agent.entry.id,
              expectedRevision: current.grantRevision,
              grant: { scope: "selected", tasks: true, resources: [] },
              idempotencyKey: action,
            },
            owner,
          );
        } else {
          await host.store.database
            .updateTable("agentConnections")
            .set({ expiresAt: new Date(1) })
            .where("id", "=", agent.entry.id)
            .execute();
          const result = await host.store.driveConnectionCleanups();
          expect(result.failures).toEqual([]);
        }
        expect(
          action === "stop"
            ? (await open.result).isError
            : await refusedOrDisconnected(open.result),
          action,
        ).toBe(true);
        expect((await host.store.requests.get(open.requestId))?.status).toBe("cancelled");
        await expect(
          testRpcData(
            host.origin,
            "commands.dispatch",
            {
              type: "request.respond",
              requestId: open.requestId,
              expectedRevision: open.expectedRevision,
              idempotencyKey: "late-" + action,
              response: { kind: "form", answers: { question_1: ["Done"] } },
            },
            owner,
          ),
        ).rejects.toThrow();
      }

      const traffic = JSON.stringify(transcript);
      for (const value of [
        passwordFixture.username,
        passwordFixture.password,
        passwordFixture.code,
      ])
        expect(traffic).not.toContain(value);
    } finally {
      for (const dispose of close.reverse()) await dispose().catch(() => undefined);
    }
  },
);

async function signInFixture() {
  const server = createServer(async (request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    if (request.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = new URLSearchParams(Buffer.concat(chunks).toString());
      const valid =
        body.get("username") === passwordFixture.username &&
        body.get("password") === passwordFixture.password;
      response.end(valid ? "<h1>Signed in</h1>" : "<h1>Wrong login</h1>");
      return;
    }
    response.end(`<h1>Sign in</h1><form method="post">
      <label>Email <input name="username" type="email"></label>
      <label>Password <input name="password" type="password"></label>
      <button>Sign in</button></form>`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    origin: `http://passwords-fixture.test:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
