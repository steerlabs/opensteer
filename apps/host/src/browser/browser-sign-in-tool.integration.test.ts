import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { BrowserSessionIdSchema } from "@opensteer/protocol";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  connectCallerMachine,
  createMachineAccessDatabase,
  dispatchCallerRun,
  startPersonalMachineAccessHost,
  waitForValue,
} from "../runtime/machine-access.test-support.js";
import { hostInternalRoutePaths } from "../server/internal-routes.js";
import { startBrowserRuntime } from "./browser-runtime.test-support.js";
import { passwordsAnywhereJourneys } from "./passwords-anywhere.test-support.js";
import { passwordFixture, startPasswordsAuthority } from "./passwords-authority.test-support.js";
import { PasswordsJourneyEvidence } from "./passwords-evidence.test-support.js";

passwordsAnywhereJourneys();

const command =
  "pnpm test:integration apps/host/src/browser/browser-sign-in-tool.integration.test.ts apps/host/src/browser/browser-source-service.integration.test.ts";
const cases = [
  "sessionless-before-browser",
  "sessionful-sign-in",
  "workspace-reuse",
  "foreign-workspace-denied",
  "browser-close-keeps-lease",
  "revocation",
];

describe.skipIf(!process.env.OPENSTEER_TEST_DATABASE_URL)(
  "agent login authorization across authority and browser streams",
  () => {
    it("keeps sessionful sign_in and origin-fill admission while the Workspace lease outlives a browser", async () => {
      const evidence = new PasswordsJourneyEvidence("host/browser-reuse", command, cases, [
        passwordFixture.password,
      ]);
      const cleanups: (() => Promise<unknown>)[] = [];
      let traffic: unknown = [];
      try {
        const database = await createMachineAccessDatabase(
          process.env.OPENSTEER_TEST_DATABASE_URL!,
        );
        cleanups.push(() => database.drop());
        const host = await startPersonalMachineAccessHost(database.url);
        cleanups.push(() => host.close());
        const caller = await connectCallerMachine(host, {
          name: "Personal vault Mac",
          environmentId: host.ownerEnvironmentId,
          localDirectory: true,
          loginFill: true,
          runnerKind: "main",
          token: host.mainRunnerEnrollmentToken,
          integrations: { platform: "darwin", protocolVersion: 5, passwordSignIn: 1 },
          browser: {
            runtimeId: "browser-runtime-integration",
            wireVersion: 1,
            cdpBoundary: 1,
            sharedControl: 1,
            signIn: { version: 3 },
          },
        });
        cleanups.push(() => caller.close());
        const authority = await startPasswordsAuthority(host.hostPort, caller.primary);
        cleanups.push(() => authority.close());
        const main = await host.store.findMainWorkspaceForOwner(host.ownerId);
        if (!main) throw new Error("Missing Main Workspace");
        const run = await dispatchCallerRun(host, caller, {
          key: "browser-reuse",
          title: "Login reuse",
          workspaceId: main.id,
        });
        const connect = async (token: string) => {
          const client = new Client({ name: "passwords-browser-reuse", version: "1" });
          await client.connect(
            new StreamableHTTPClientTransport(new URL(hostInternalRoutePaths.mcp, host.origin), {
              requestInit: { headers: { authorization: `Bearer ${token}` } },
            }) as unknown as Transport,
          );
          cleanups.push(() => client.close());
          return client;
        };
        const client = await connect(run.agentControlToken);
        let loginRef = "";
        await evidence.run("sessionless-before-browser", async () => {
          expect(await host.store.listBrowserSessions(host.ownerId)).toEqual([]);
          const result = await client.callTool({
            name: "sign_in",
            arguments: { site: passwordFixture.site, reason: "Sign in to the fixture app" },
          });
          await evidence.write("sessionless-result.json", result);
          loginRef = z
            .object({
              status: z.literal("ready"),
              loginRef: z.string(),
              account: z.literal(passwordFixture.account),
            })
            .parse(result.structuredContent).loginRef;
          expect(authority.commands.filter((c) => c.type === "login.authorize")).toHaveLength(1);
          expect(await host.store.listBrowserSessions(host.ownerId)).toEqual([]);
        });
        const runtime = await startBrowserRuntime(host.hostPort, "unused-existing-main", {
          primary: caller.primary,
          agentReady: true,
          signIn: true,
          targetedStreaming: true,
        });
        cleanups.push(() => runtime.close());
        await waitForValue(async () => (host.runtime.browser.available ? true : undefined));
        const open = async () => {
          const result = await client.callTool({
            name: "browser_session_open",
            arguments: { fresh: true },
          });
          expect(result.isError).not.toBe(true);
          return z
            .object({ session: z.object({ id: BrowserSessionIdSchema }) })
            .parse(result.structuredContent).session.id;
        };
        const sessionId = await open();
        await evidence.run("sessionful-sign-in", async () => {
          const result = await client.callTool({
            name: "sign_in",
            arguments: { sessionId, site: passwordFixture.site, reason: "Continue in browser" },
          });
          expect(result.structuredContent).toEqual({
            status: "ready",
            site: passwordFixture.site,
            loginRef,
            account: passwordFixture.account,
          });
          expect(authority.commands.filter((c) => c.type === "login.authorize")).toHaveLength(1);
          expect(runtime.receivedCommands().filter((c) => c.type === "login.authorize")).toEqual(
            [],
          );
        });
        const attach = async (binding: typeof run, browserSessionId = sessionId) => {
          const connection = await host.runtime.browser.attachCdpForAgent(
            {
              agentBindingId: binding.runId,
              ownerId: host.ownerId,
              sessionId: browserSessionId,
              workspaceId: binding.workspaceId,
            },
            () => undefined,
          );
          cleanups.push(async () => connection.close());
          return connection;
        };
        const fill = {
          method: "Opensteer.fillLogin",
          sessionId: "page-cdp",
          parameters: { loginRef, field: "password" },
        };
        const connection = await attach(run);
        const fulfillFill = async (
          connection: Awaited<ReturnType<typeof attach>>,
          browserSessionId = sessionId,
        ) => {
          const count = runtime.receivedCommands().length;
          const pending = connection.request(fill);
          void pending.catch(() => undefined);
          const forwarded = await waitForValue(async () =>
            runtime
              .receivedCommands()
              .slice(count)
              .find(
                (m) =>
                  m.type === "cdp.command" &&
                  (m.command as { method: string }).method === fill.method,
              ),
          );
          runtime.sendServer(
            { type: "cdp.result", requestId: forwarded.requestId, result: { status: "filled" } },
            browserSessionId,
          );
          expect(await pending).toEqual({ status: "filled" });
        };
        await evidence.run("workspace-reuse", async () => {
          await fulfillFill(connection);
        });
        await evidence.run("foreign-workspace-denied", async () => {
          const other = await dispatchCallerRun(host, caller, {
            key: "foreign",
            title: "Other Workspace",
          });
          const foreignClient = await connect(other.agentControlToken);
          const opened = await foreignClient.callTool({
            name: "browser_session_open",
            arguments: { fresh: true },
          });
          const foreignSession = z
            .object({ session: z.object({ id: BrowserSessionIdSchema }) })
            .parse(opened.structuredContent).session.id;
          const foreign = await attach(other, foreignSession);
          const count = runtime.receivedCommands().length;
          expect(await foreign.request(fill)).toEqual({ status: "expired" });
          expect(runtime.receivedCommands()).toHaveLength(count);
        });
        await evidence.run("browser-close-keeps-lease", async () => {
          const secondSession = await open();
          const second = await attach(run, secondSession);
          await host.runtime.browser.closeAgentSession({
            agentBindingId: run.runId,
            ownerId: host.ownerId,
            sessionId,
            workspaceId: run.workspaceId,
          });
          expect(await connection.request(fill)).toEqual({ status: "expired" });
          await fulfillFill(second, secondSession);
          const result = await client.callTool({
            name: "sign_in",
            arguments: { site: passwordFixture.site, reason: "Return to the phone app" },
          });
          expect(result.structuredContent).toMatchObject({ status: "ready", loginRef });
          expect(authority.commands.filter((c) => c.type === "login.authorize")).toHaveLength(1);
        });
        await evidence.run("revocation", async () => {
          const operation = authority.commands.find((c) => c.type === "login.authorize");
          if (operation?.type !== "login.authorize") throw new Error("Missing authorization");
          authority.end(operation.operationId);
          const next = await client.callTool({
            name: "sign_in",
            arguments: { site: passwordFixture.site, reason: "Reauthorize" },
          });
          const ready = z
            .object({ status: z.literal("ready"), loginRef: z.string() })
            .parse(next.structuredContent);
          expect(ready.loginRef).not.toBe(loginRef);
        });
        expect(authority.protocolErrors).toEqual([]);
        expect(runtime.protocolErrors()).toEqual([]);
        traffic = { authority: authority.commands, browser: runtime.receivedCommands() };
      } finally {
        const teardown: unknown[] = [];
        for (const close of cleanups.reverse()) {
          try {
            await close();
            teardown.push({ stopped: true });
          } catch (error) {
            teardown.push({ stopped: false, message: String(error) });
          }
        }
        await evidence.write("platform-traffic.json", traffic);
        await evidence.write("teardown.json", teardown);
        await evidence.finish();
        expect(
          teardown.every(
            (entry) => z.object({ stopped: z.literal(true) }).safeParse(entry).success,
          ),
        ).toBe(true);
      }
    });
  },
);
