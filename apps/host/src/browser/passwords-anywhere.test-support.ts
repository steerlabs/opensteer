import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { toolsForCapabilityProfile } from "@opensteer/agent-tools";
import { hostApiVersion } from "@opensteer/deployment-authority";
import { BrowserSessionIdSchema, hostApiVersionHeader } from "@opensteer/protocol";
import { afterEach, describe, expect, it } from "vitest";
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
import { passwordFixture, startPasswordsAuthority } from "./passwords-authority.test-support.js";
import { PasswordsJourneyEvidence } from "./passwords-evidence.test-support.js";

const command =
  "pnpm test:integration apps/host/src/browser/browser-sign-in-tool.integration.test.ts apps/host/src/browser/browser-source-service.integration.test.ts";
const cases = [
  "sessionless-no-browser",
  "workspace-approval-continuation",
  "same-workspace-reuse",
  "capability-loss",
  "declined",
  "epoch-47-refusal",
  "browser-loginFill-required",
] as const;

/** Real PostgreSQL, HTTP MCP, enrolled Personal authority and durable Requests. */
export function passwordsAnywhereJourneys() {
  describe.skipIf(!process.env.OPENSTEER_TEST_DATABASE_URL)(
    "Passwords anywhere over the Personal control stream",
    () => {
      const cleanups: (() => Promise<void>)[] = [];
      afterEach(async () => {
        const failures: unknown[] = [];
        for (const close of cleanups.splice(0).reverse()) {
          try {
            await close();
          } catch (error) {
            failures.push(error);
          }
        }
        expect(failures, "all owned resources stopped").toEqual([]);
      });
      it.each(cases)("%s", async (name) => {
        const evidence = new PasswordsJourneyEvidence(
          `host/${name}`,
          command,
          [name],
          [passwordFixture.password],
        );
        let traffic: unknown = [];
        try {
          await evidence.run(name, async () => {
            const database = await createMachineAccessDatabase(
              process.env.OPENSTEER_TEST_DATABASE_URL!,
            );
            cleanups.push(() => database.drop());
            const host = await startPersonalMachineAccessHost(database.url);
            cleanups.push(() => host.close());
            const caller = await connectCallerMachine(host, {
              environmentId: host.ownerEnvironmentId,
              localDirectory: true,
              name: "Personal vault Mac",
              runnerKind: "main",
              token: host.mainRunnerEnrollmentToken,
              // Deliberately no loginFill: app sign-in must not depend on Browser Harness.
              ...(name === "browser-loginFill-required"
                ? {
                    browser: {
                      runtimeId: "browser-runtime-integration",
                      wireVersion: 1 as const,
                      cdpBoundary: 1 as const,
                      sharedControl: 1 as const,
                      signIn: { version: 3 as const },
                    },
                  }
                : {}),
              integrations: {
                platform: "darwin",
                protocolVersion: 5,
                passwordSignIn: 1,
                computerAppApprovals: true,
              },
            });
            cleanups.push(() => caller.close());
            const authority = await startPasswordsAuthority(host.hostPort, caller.primary);
            traffic = authority.commands;
            cleanups.push(() => authority.close());
            const main = await host.store.findMainWorkspaceForOwner(host.ownerId);
            if (!main) throw new Error("Missing Main Workspace");
            const run = await dispatchCallerRun(host, caller, {
              key: name,
              title: name,
              workspaceId: main.id,
            });
            const connect = async (token: string) => {
              const client = new Client({ name: "passwords-anywhere-e2e", version: "1" });
              await client.connect(
                new StreamableHTTPClientTransport(
                  new URL(hostInternalRoutePaths.mcp, host.origin),
                  { requestInit: { headers: { authorization: `Bearer ${token}` } } },
                ) as unknown as Transport,
              );
              cleanups.push(() => client.close());
              return client;
            };
            const client = await connect(run.agentControlToken);
            expect(
              (await client.listTools()).tools.map(({ name }) => name),
              "sign_in is a first-class tool without a Browser Session",
            ).toContain("sign_in");
            // The Host still serves browser_sign_in to previous-release Runners;
            // a current driver enables only its own catalog, which offers sign_in.
            expect(toolsForCapabilityProfile("main").map(({ name }) => name)).not.toContain(
              "browser_sign_in",
            );
            expect(await host.store.listBrowserSessions(host.ownerId)).toEqual([]);
            if (name === "browser-loginFill-required") {
              const browser = await startBrowserRuntime(host.hostPort, "unused-main", {
                primary: caller.primary,
                agentReady: true,
                signIn: true,
              });
              cleanups.push(() => browser.close());
              await waitForValue(async () => (host.runtime.browser.available ? true : undefined));
              const opened = await client.callTool({
                name: "browser_session_open",
                arguments: { fresh: true },
              });
              const sessionId = z
                .object({ session: z.object({ id: BrowserSessionIdSchema }) })
                .parse(opened.structuredContent).session.id;
              const before = authority.commands.length;
              const result = await client.callTool({
                name: "sign_in",
                arguments: { sessionId, site: passwordFixture.site, reason: "Read the account" },
              });
              expect(result.structuredContent).toEqual({
                status: "unavailable",
                site: passwordFixture.site,
                reason: "runtime-outdated",
              });
              expect(authority.commands).toHaveLength(before);
              expect(
                await host.store.requests.listPendingPasswordSignIns({ after: null, limit: 64 }),
              ).toEqual([]);
              return;
            }
            const signIn = () =>
              client.callTool({
                name: "sign_in",
                arguments: { site: passwordFixture.site, reason: "Sign in to the synthetic app" },
              });
            if (name === "epoch-47-refusal") {
              expect(hostApiVersion).toBeGreaterThanOrEqual(48);
              const response = await fetch(`${host.origin}/v1/rpc/requests.list`, {
                method: "POST",
                headers: {
                  ...host.ownerHeaders,
                  "content-type": "application/json",
                  [hostApiVersionHeader]: "47",
                },
                body: "{}",
              });
              expect(
                response.ok,
                "old readers cannot consume workspace consent under epoch 47",
              ).toBe(false);
              return;
            }
            authority.policy.approval =
              name === "workspace-approval-continuation" || name === "declined";
            authority.policy.declined = name === "declined";
            const first = await signIn();
            await evidence.write("tool-result.json", first);
            if (name === "declined") {
              const pending = z
                .object({ status: z.literal("pending"), requestId: z.string() })
                .parse(first.structuredContent);
              const operation = authority.commands.findLast((c) => c.type === "login.authorize");
              if (operation?.type !== "login.authorize") throw new Error("Missing authorization");
              authority.authorize(operation.operationId);
              const declined = await waitForValue(async () => {
                const row = (
                  await host.store.requests.listPendingPasswordSignIns({ after: null, limit: 64 })
                ).find((r) => r.id === pending.requestId);
                if (row) return undefined;
                return host.store.requests.get(
                  pending.requestId as Parameters<typeof host.store.requests.get>[0],
                );
              });
              expect(declined?.status).toBe("declined");
              expect(authority.commands.filter((c) => c.type === "login.seal")).toHaveLength(0);
              await evidence.write("declined-request.json", declined);
              return;
            }
            if (name === "workspace-approval-continuation") {
              const pending = z
                .object({ status: z.literal("pending"), requestId: z.string() })
                .parse(first.structuredContent);
              const rows = await host.store.requests.listPendingPasswordSignIns({
                after: null,
                limit: 64,
              });
              expect(rows.filter(({ id }) => id === pending.requestId)).toHaveLength(1);
              const request = rows.find(({ id }) => id === pending.requestId)!;
              expect(request.payload).toMatchObject({
                kind: "browser.password-sign-in",
                scope: "workspace",
                permissionVersion: 5,
                site: passwordFixture.site,
              });
              expect(request.payload).not.toHaveProperty("sessionId");
              const start = authority.commands.find((c) => c.type === "login.authorize");
              if (!start || start.type !== "login.authorize")
                throw new Error("Missing authority authorization");
              expect(start.workspaceId).toBe(main.id);
              authority.authorize(start.operationId);
              const fulfilled = await waitForValue(async () => {
                const row = await host.store.requests.get(request.id);
                return row?.status === "fulfilled" ? row : undefined;
              });
              expect(fulfilled.response).toEqual({
                kind: "external",
                value: { outcome: "authorized", account: passwordFixture.account },
              });
              expect(JSON.stringify(fulfilled)).not.toContain(start.loginRef);
              const continuation = await waitForValue(async () =>
                (await host.store.readThreadForOwner(run.threadId, host.ownerId))?.messages.find(
                  (m) => JSON.stringify(m.content).includes(start.loginRef),
                ),
              );
              expect(JSON.stringify(continuation.content)).toContain("sign_in");
              await evidence.write("request.json", fulfilled);
              await evidence.write("continuation.json", continuation);
            } else {
              const ready = z
                .object({ status: z.literal("ready"), loginRef: z.string(), account: z.string() })
                .parse(first.structuredContent);
              expect(ready.account).toBe(passwordFixture.account);
              if (name === "same-workspace-reuse") {
                const count = authority.commands.length;
                const secondRun = await dispatchCallerRun(host, caller, {
                  key: `${name}-second`,
                  title: "Same Workspace",
                  workspaceId: main.id,
                });
                const second = await connect(secondRun.agentControlToken);
                const reused = await second.callTool({
                  name: "sign_in",
                  arguments: { site: passwordFixture.site, reason: "Continue in an app" },
                });
                expect(reused.structuredContent).toEqual(first.structuredContent);
                expect(authority.commands).toHaveLength(count);
              }
              if (name === "capability-loss") {
                authority.status(false);
                await new Promise<void>((resolve) => setImmediate(resolve));
                const next = await signIn();
                expect(next.structuredContent).toMatchObject({ status: "unavailable" });
                expect(next.structuredContent).not.toHaveProperty("loginRef");
              }
            }
            expect(
              await host.store.listBrowserSessions(host.ownerId),
              "the entire journey opens no Browser Session",
            ).toEqual([]);
            expect(authority.protocolErrors).toEqual([]);
          });
        } finally {
          await evidence.write("authority-traffic.json", traffic);
          await evidence.finish();
        }
      });
    },
  );
}
