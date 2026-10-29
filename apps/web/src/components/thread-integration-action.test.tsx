// @vitest-environment happy-dom

import { renderToStaticMarkup } from "react-dom/server";
import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  accessPlan,
  accessServerChoices,
  accountConnectable,
  effectiveIntegrationAccess,
  matchingInstallationForManifest,
  resolveIntegrationAccess,
  type LoadedAccessRequest,
} from "@opensteer/client/integrations";
import { activityStepHead } from "@opensteer/client/host";
import {
  MockHostClient,
  mockRejectedApiKey,
  mockTmdbProposal,
  mockVapi,
} from "@opensteer/client/mock";
import {
  RequestJsonObjectSchema,
  WorkspaceIdSchema,
  requestAgentProposedDetail,
} from "@opensteer/core";
import { createIntegrationId } from "@opensteer/integration-core";
import {
  integrationAccountCanChange,
  IntegrationAccountActions,
  ThreadIntegrationAction,
} from "./thread-integration-action.js";

const shellState = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("./app-shell.js", () => ({ useShell: () => shellState.current }));

const mountedRoots: Root[] = [];
const macMini = "rnr_11111111-1111-4111-8111-111111111111";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  for (const root of mountedRoots.splice(0)) act(() => root.unmount());
  shellState.current = null;
});

const render = (overrides: Partial<Parameters<typeof IntegrationAccountActions>[0]> = {}) =>
  renderToStaticMarkup(
    <IntegrationAccountActions
      authorizationActive={false}
      canAllow={false}
      canConnect={true}
      hasAccount={false}
      onAllow={vi.fn()}
      onConnect={vi.fn()}
      pending={false}
      primaryLabel="Use this account"
      {...overrides}
    />,
  );

describe("IntegrationAccountActions", () => {
  it("hides connection actions while OAuth is active or account creation is unavailable", () => {
    expect(render({ authorizationActive: true, canAllow: true, hasAccount: true })).toBe("");
    expect(render({ canAllow: true, canConnect: false, hasAccount: true })).not.toContain(
      "Connect another account",
    );
  });

  it("disables every available action while another request operation is pending", () => {
    const markup = render({ canAllow: true, hasAccount: true, pending: true });

    expect(markup.match(/disabled=""/gu)).toHaveLength(2);
  });
});

describe("ThreadIntegrationAction computer access", () => {
  it("requires an explicit computer ceiling upgrade before granting optional write access", async () => {
    const loaded = computerRequest();
    const dispatch = vi.fn(async (command: { readonly type: string }) =>
      command.type === "integration.computer.setup.request"
        ? {
            connection: {
              ...loaded.dashboard.connections[0]!,
              computer: { access: "read-write", runnerId: macMini },
            },
            type: command.type,
          }
        : { type: command.type },
    );
    const hostClient = {
      dispatch,
      getSnapshot: () => shellSnapshot(),
      loadEarlierWorkspaces: async () => undefined,
      refresh: async () => undefined,
      rpc: {
        "integration.platform.get": async () => ({ data: loaded.platform, ok: true as const }),
        "integrations.get": async () => ({ data: loaded.dashboard, ok: true as const }),
      },
    };
    shellState.current = {
      hostClient,
      reportActionError: vi.fn(),
      snapshot: shellSnapshot(),
    };
    const container = await mountThreadAction(computerRequestRecord());

    expect(container.textContent).toContain("Read and send");
    expect(container.textContent).toContain(
      "Agents can search and read your conversations, and send messages as you.",
    );
    expect(buttonWithText(container, "Allow in Support")).not.toBeNull();

    const optionalWrite = container.querySelector<HTMLInputElement>(
      '.check-item input[type="checkbox"]',
    );
    if (!optionalWrite) throw new Error("Missing computer app write-access choice");
    await act(async () => optionalWrite.click());

    expect(buttonWithText(container, "Request sending access on Mac mini")).not.toBeNull();
    expect(buttonWithText(container, "Allow in Support")).toBeNull();

    await act(async () => buttonWithText(container, "Request sending access on Mac mini")?.click());

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ access: "read-write", runnerId: macMini }),
        type: "integration.computer.setup.request",
      }),
    );
    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: "request.respond" }));
  });
});

describe("ThreadIntegrationAction finishing a GitHub sign-in the browser returned from", () => {
  // The ways it could fail: GitHub rejects the sign-in at the check that
  // follows the browser's return, and the card keeps the repository step,
  // whose recheck can only send the rejected sign-in again; Try again
  // opening that step once more; nothing saying why.
  it("sends a sign-in GitHub rejected back to connecting, not to the repository step", async () => {
    const rejected = "GitHub rejected the saved sign-in";
    const connectionId = "con_00000000-0000-4000-8000-0000000000b1";
    const loaded = oauthRequest({ provider: "github" });
    const account = {
      accountIdentifier: "steerlabs",
      definitionId: "provider-integration",
      displayName: "steerlabs",
      id: connectionId,
      provider: "github",
      status: "needs-attention",
      statusDetail: null as string | null,
      statusReason: "permissions" as string | null,
    };
    // The Host's answer to GitHub's 401: the account needs a new sign-in.
    const check = vi.fn(async () => {
      account.statusDetail = rejected;
      account.statusReason = null;
      return {
        error: { code: "conflict", message: rejected, retryable: false },
        ok: false as const,
      };
    });
    shellState.current = {
      hostClient: {
        dispatch: vi.fn(),
        getSnapshot: () => shellSnapshot(),
        loadEarlierWorkspaces: async () => undefined,
        refresh: async () => undefined,
        rpc: {
          "integration.authorization.get": async () => ({
            data: {
              connectionId,
              expiresAt: "2026-09-18T00:10:00.000Z",
              failureCode: null,
              status: "completed",
            },
            ok: true as const,
          }),
          "integration.platform.get": async () => ({ data: loaded.platform, ok: true as const }),
          "integration.repositoryAccess.check": check,
          "integrations.get": async () => ({
            data: { ...loaded.dashboard, connections: [{ ...account }] },
            ok: true as const,
          }),
        },
      },
      reportActionError: vi.fn(),
      snapshot: shellSnapshot(),
    };
    const container = await mountThreadAction(
      requestRecord(loaded, "Connect GitHub"),
      rejected,
      `/threads/thr_test?integrationAttempt=${createIntegrationId("oauthAttempt")}`,
    );

    expect(document.body.textContent).not.toContain("Recheck repository access");
    await act(async () => buttonWithText(container, "Try again")?.click());
    await vi.waitFor(() => expect(container.textContent).not.toContain("Checking account access"));

    expect(document.body.textContent).not.toContain("Recheck repository access");
    expect(check).toHaveBeenCalledTimes(1);
  });

  // The ways it could fail: the person sets the repository step aside and
  // opens a new sign-in, which cancels this return, and the return's check,
  // refused only now, puts its error on the card. The error replaces the new
  // sheet and abandons the sign-in it was waiting for. The same when the check
  // was refused earlier and only its account reload comes back now.
  it.each(["check", "reload"] as const)(
    "leaves a sign-in opened since alone when the cancelled return's %s answers late",
    async (late) => {
      const rejected = "GitHub rejected the saved sign-in";
      const connectionId = "con_00000000-0000-4000-8000-0000000000b1";
      const loaded = oauthRequest({ provider: "github" });
      const account = {
        accountIdentifier: "steerlabs",
        definitionId: "provider-integration",
        displayName: "steerlabs",
        id: connectionId,
        provider: "github",
        status: "needs-attention",
        statusDetail: null as string | null,
        statusReason: "permissions" as string | null,
      };
      const dashboard = () => ({
        data: { ...loaded.dashboard, connections: [{ ...account }] },
        ok: true as const,
      });
      let refuse = () => {};
      const check = vi.fn(
        () =>
          new Promise((resolve) => {
            refuse = () => {
              account.statusDetail = rejected;
              account.statusReason = null;
              resolve({
                error: { code: "conflict", message: rejected, retryable: false },
                ok: false,
              });
            };
          }),
      );
      const integrationsGet = vi.fn(async () => dashboard());
      shellState.current = {
        hostClient: {
          dispatch: vi.fn(),
          getSnapshot: () => shellSnapshot(),
          loadEarlierWorkspaces: async () => undefined,
          refresh: async () => undefined,
          rpc: {
            "integration.authorization.get": async () => ({
              data: {
                connectionId,
                expiresAt: "2026-09-18T00:10:00.000Z",
                failureCode: null,
                status: "completed",
              },
              ok: true as const,
            }),
            "integration.platform.get": async () => ({ data: loaded.platform, ok: true as const }),
            "integration.repositoryAccess.check": check,
            "integrations.get": integrationsGet,
          },
        },
        reportActionError: vi.fn(),
        snapshot: shellSnapshot(),
      };
      const container = await mountThreadAction(
        requestRecord(loaded, "Connect GitHub"),
        "Recheck repository access",
        `/threads/thr_test?integrationAttempt=${createIntegrationId("oauthAttempt")}`,
      );
      let answerReload = () => {};
      if (late === "reload") {
        integrationsGet.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              answerReload = () => resolve(dashboard());
            }),
        );
        await act(async () => refuse());
        await act(async () => buttonWithText(container, "Try again")?.click());
        await vi.waitFor(() =>
          expect(document.body.textContent).toContain("Recheck repository access"),
        );
      }

      await act(async () => buttonWithText(document.body, "Finish later")?.click());
      await act(async () => buttonWithText(container, "Connect account")?.click());
      expect(document.body.textContent).toContain("Connect Provider integration");
      await act(async () => (late === "check" ? refuse() : answerReload()));

      expect(document.body.textContent).toContain("Connect Provider integration");
      expect(document.body.textContent).not.toContain(rejected);
      expect(check).toHaveBeenCalledTimes(1);
    },
  );

  // The ways it could fail: the person sets the repository step aside with
  // "Finish later" while its check is out, the first one or a recheck, and
  // the check, answering now that repositories are still missing, opens the
  // step again.
  it.each(["first check", "recheck"] as const)(
    "keeps the repository step set aside when its %s answers late",
    async (late) => {
      const { answer, check, container } = await returnFromGitHubSignIn(
        late === "recheck" ? "Repository access is still required" : "Recheck repository access",
        late === "recheck" ? 1 : 0,
      );
      if (late === "recheck") {
        await act(async () => buttonWithText(document.body, "Recheck repository access")?.click());
      }

      await act(async () => buttonWithText(document.body, "Finish later")?.click());
      expect(document.body.textContent).not.toContain("Choose GitHub repositories");
      await act(async () => answer());

      expect(document.body.textContent).not.toContain("Choose GitHub repositories");
      expect(buttonWithText(container, "Connect account")?.disabled).toBe(false);
      expect(check).toHaveBeenCalledTimes(late === "recheck" ? 2 : 1);
    },
  );

  // The ways it could fail: the person rechecks while the return's own check
  // is still out, and the return's check is refused before the recheck finds
  // the repositories. Its error replaces the card with "Try again" once the
  // account is connected, or its account reload, reading the account still
  // waiting, leaves that error in place.
  it("keeps what a recheck found when the return's own check is refused first", async () => {
    const refused = "The return's repository check failed";
    const connectionId = "con_00000000-0000-4000-8000-0000000000b1";
    const loaded = oauthRequest({ provider: "github" });
    const account = {
      accountIdentifier: "steerlabs",
      createdAt: "2026-09-17T12:00:00.000Z",
      definitionId: "provider-integration",
      displayName: "steerlabs",
      id: connectionId,
      provider: "github",
      status: "needs-attention",
      statusDetail: null as string | null,
      statusReason: "permissions" as string | null,
    };
    let refuse = () => {};
    let answerRecheck = () => {};
    const check = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            refuse = () =>
              resolve({
                error: { code: "internal", message: refused, retryable: true },
                ok: false,
              });
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            answerRecheck = () => {
              account.status = "connected";
              account.statusReason = null;
              resolve({
                data: { installationUrl: null, installations: [], ready: true },
                ok: true,
              });
            };
          }),
      );
    shellState.current = {
      hostClient: {
        dispatch: vi.fn(),
        getSnapshot: () => shellSnapshot(),
        loadEarlierWorkspaces: async () => undefined,
        refresh: async () => undefined,
        rpc: {
          "integration.authorization.get": async () => ({
            data: {
              connectionId,
              expiresAt: "2026-09-18T00:10:00.000Z",
              failureCode: null,
              status: "completed",
            },
            ok: true as const,
          }),
          "integration.platform.get": async () => ({ data: loaded.platform, ok: true as const }),
          "integration.repositoryAccess.check": check,
          "integrations.get": async () => ({
            data: { ...loaded.dashboard, connections: [{ ...account }] },
            ok: true as const,
          }),
        },
      },
      reportActionError: vi.fn(),
      snapshot: shellSnapshot(),
    };
    const container = await mountThreadAction(
      requestRecord(loaded, "Connect GitHub"),
      "Recheck repository access",
      `/threads/thr_test?integrationAttempt=${createIntegrationId("oauthAttempt")}`,
    );

    await act(async () => buttonWithText(document.body, "Recheck repository access")?.click());
    await act(async () => refuse());
    await act(async () => answerRecheck());

    await vi.waitFor(() => expect(buttonWithText(container, "Allow in Support")).not.toBeNull());
    expect(document.body.textContent).not.toContain(refused);
    expect(buttonWithText(container, "Try again")).toBeNull();
    expect(document.body.textContent).not.toContain("Choose GitHub repositories");
    expect(check).toHaveBeenCalledTimes(2);
  });

  // The ways it could fail: the person sets the repository step aside and
  // opens a new sign-in, which cancels the return, then closes that sheet
  // without signing in; the return resumes and shows the step again.
  it("keeps the repository step set aside after a new sign-in is opened and closed", async () => {
    const { check, container } = await returnFromGitHubSignIn("Recheck repository access", 0);

    await act(async () => buttonWithText(document.body, "Finish later")?.click());
    await act(async () => buttonWithText(container, "Connect account")?.click());
    expect(document.body.textContent).toContain("Connect Provider integration");
    await act(async () =>
      document.querySelector<HTMLButtonElement>('button[aria-label="Close dialog"]')?.click(),
    );

    expect(document.body.textContent).not.toContain("Connect Provider integration");
    expect(document.body.textContent).not.toContain("Choose GitHub repositories");
    expect(buttonWithText(container, "Connect account")?.disabled).toBe(false);
    expect(check).toHaveBeenCalledTimes(1);
  });
});

describe("ThreadIntegrationAction finding its target Workspace", () => {
  // The ways it could fail: the card asks for earlier Workspaces because its
  // target is not loaded, a newer snapshot brings the target meanwhile, and
  // the person opens the Connect sheet. The earlier page, failing only now,
  // replaces the card and that sheet with its error.
  it("ignores an earlier page of Workspaces that fails after the target arrived", async () => {
    const failed = "Earlier Workspaces could not be loaded.";
    const loaded = oauthRequest({ provider: "github" });
    let failPage = (_reason: Error) => {};
    const hostClient = {
      dispatch: vi.fn(),
      getSnapshot: () => shellSnapshot(),
      loadEarlierWorkspaces: vi.fn(
        () =>
          new Promise<void>((_, reject) => {
            failPage = reject;
          }),
      ),
      refresh: async () => undefined,
      rpc: {
        "integration.platform.get": async () => ({ data: loaded.platform, ok: true as const }),
        "integrations.get": async () => ({ data: loaded.dashboard, ok: true as const }),
      },
    };
    shellState.current = {
      hostClient,
      reportActionError: vi.fn(),
      snapshot: { machines: [], workspaceWindow: { hasMore: true, itemCount: 0 }, workspaces: [] },
    };
    const request = requestRecord(loaded, "Connect GitHub");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    const card = () => (
      <MemoryRouter initialEntries={["/threads/thr_test"]}>
        <ThreadIntegrationAction request={request} threadId="thr_test" />
      </MemoryRouter>
    );
    await act(async () => root.render(card()));
    expect(container.textContent).toContain("Checking target Workspace");
    expect(hostClient.loadEarlierWorkspaces).toHaveBeenCalledTimes(1);

    shellState.current = { hostClient, reportActionError: vi.fn(), snapshot: shellSnapshot() };
    await act(async () => root.render(card()));
    await vi.waitFor(() => expect(buttonWithText(container, "Connect account")).not.toBeNull());
    await act(async () => buttonWithText(container, "Connect account")?.click());
    expect(document.body.textContent).toContain("Connect Provider integration");
    await act(async () => failPage(new Error(failed)));

    expect(document.body.textContent).toContain("Connect Provider integration");
    expect(document.body.textContent).not.toContain(failed);
  });
});

describe("ThreadIntegrationAction cancelling a sign-in", () => {
  // The ways it could fail: Cancel answers only after the sign-in it was
  // meant for has finished and the person has started another. The answer,
  // or its failure, ends the newer sign-in's wait and takes its Cancel away,
  // and that sign-in is abandoned.
  it.each(["answers", "fails"] as const)(
    "leaves a sign-in started since alone when an older Cancel %s late",
    async (late) => {
      const loaded = genericSpecializedRequest();
      const serverId = createIntegrationId("server");
      loaded.platform.installations[0]!.servers[0] = {
        ...loaded.platform.installations[0]!.servers[0]!,
        connectionRequirement: { kind: "mcp-oauth" },
        id: serverId,
      } as never;
      loaded.request.requestedServerId = serverId;
      const attempts = [createIntegrationId("oauthAttempt"), createIntegrationId("oauthAttempt")];
      const expiresAt = "2026-09-18T00:10:00.000Z";
      let begun = 0;
      let settleCancel = { answer: () => {}, fail: () => {} };
      const dispatch = vi.fn((command: { readonly type: string }) =>
        command.type === "integration.authorization.cancel"
          ? new Promise((resolve, reject) => {
              settleCancel = {
                answer: () =>
                  resolve({
                    connectionId: null,
                    expiresAt,
                    failureCode: null,
                    status: "completed",
                    type: command.type,
                  }),
                fail: () => reject(new Error("The cancellation could not be sent.")),
              };
            })
          : Promise.resolve({
              attemptId: attempts[begun++],
              expiresAt,
              launchTicket: "t".repeat(43),
              type: command.type,
            }),
      );
      let finishFirst = () => {};
      const first = new Promise((resolve) => {
        finishFirst = () =>
          resolve({
            data: { connectionId: null, expiresAt, failureCode: null, status: "completed" },
            ok: true,
          });
      });
      vi.spyOn(window, "open").mockReturnValue({
        close: vi.fn(),
        closed: false,
        location: { replace: vi.fn() },
        opener: null,
      } as unknown as Window);
      shellState.current = {
        hostClient: {
          dispatch,
          getSnapshot: () => shellSnapshot(),
          loadEarlierWorkspaces: async () => undefined,
          refresh: async () => undefined,
          rpc: {
            "integration.authorization.get": (input: { readonly attemptId: string }) =>
              input.attemptId === attempts[0] ? first : new Promise(() => {}),
            "integration.platform.get": async () => ({ data: loaded.platform, ok: true as const }),
            "integrations.get": async () => ({ data: loaded.dashboard, ok: true as const }),
          },
        },
        reportActionError: vi.fn(),
        snapshot: shellSnapshot(),
      };
      const container = await mountThreadAction(
        requestRecord(loaded, "Connect Test integration"),
        "Connect account",
      );
      const waiting = "Finish connecting in your browser.";
      await act(async () => buttonWithText(container, "Connect account")?.click());
      expect(container.textContent).toContain(waiting);
      await act(async () => buttonWithText(container, "Cancel")?.click());
      await act(async () => finishFirst());
      await vi.waitFor(() =>
        expect(buttonWithText(container, "Connect account")?.disabled).toBe(false),
      );
      await act(async () => buttonWithText(container, "Connect account")?.click());
      expect(container.textContent).toContain(waiting);

      await act(async () => (late === "answers" ? settleCancel.answer() : settleCancel.fail()));

      expect(container.textContent).toContain(waiting);
      expect(buttonWithText(container, "Cancel")).not.toBeNull();
      expect(container.textContent).not.toContain("The cancellation could not be sent.");
    },
  );
});

describe("ThreadIntegrationAction reconnecting the account a request names", () => {
  // The ways it could fail: the key hidden behind another click; no reason
  // given, or the old "exact account" wording; two accounts of one name told
  // apart by nothing; the access line repeating the names the card shows, or
  // miscounting "1 operations"; the same-named twin repaired, or a new account
  // made; the request answered, or another account offered, before the key is
  // in; no way to decline, or declining on a row of its own away from the
  // submit; the key that answers this request for Main given with nothing
  // said first; the request left waiting after the account is repaired.
  it("repairs the rejected key in place from the card, and the waiting request settles", async () => {
    const client = new MockHostClient({ automations: "absent", latencyMs: 0 });
    const request = client.getSnapshot().requests[mockVapi.threadId]?.[0];
    if (!request) throw new Error("The mock seeds the Vapi reconnect request.");
    const connectionsBefore = await mockConnections(client);
    shellState.current = {
      hostClient: client,
      reportActionError: vi.fn(),
      snapshot: client.getSnapshot(),
    };
    const container = await mountThreadAction(request, "Reconnect Vapi API");

    expect(container.textContent).toContain("Vapi API rejected the saved key");
    expect(container.textContent).toContain("Needs attention");
    // Both accounts are named Vapi API and were added the same morning.
    expect(container.textContent).toMatch(/Added Aug 9, \d{1,2}:\d{2}\s?[AP]M/u);
    expect(container.textContent).not.toContain("exact account");
    // The title names the integration and the row the account; this line is the access.
    expect(notes(container)).toContain("Read and write · 1 operation");
    expect(notes(container)).toContain(
      "Your tasks in Main can read and make changes with every account you connect, so connecting also allows this request.",
    );
    expect(container.textContent).not.toContain("Vapi API · Vapi API");
    const key = container.querySelector<HTMLInputElement>('input[type="password"]');
    if (!key) throw new Error("The key field is shown at once.");
    expect(
      container.querySelector<HTMLInputElement>('input[placeholder="Vapi API account"]')?.value,
    ).toBe("Vapi API");
    // The form's own submit is the only Reconnect: no step precedes the key field.
    expect(buttonWithText(container, "Reconnect account")?.getAttribute("type")).toBe("submit");
    // Declining sits in the submit's own row, the card's one row of answers.
    expect(actionRowLabels(container)).toEqual([["Not now", "Reconnect account"]]);
    for (const absent of ["Connect another account", "Use this account"]) {
      expect(buttonWithText(container, absent)).toBeNull();
    }
    expect(client.getSnapshot().requests[mockVapi.threadId]).toHaveLength(1);

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        key,
        "replacement-key",
      );
      key.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => key.form?.requestSubmit());

    await vi.waitFor(() =>
      expect(client.getSnapshot().requests[mockVapi.threadId] ?? []).toEqual([]),
    );
    const connectionsAfter = await mockConnections(client);
    expect(connectionsAfter).toHaveLength(connectionsBefore.length);
    expect(connectionsAfter.find(({ id }) => id === mockVapi.connectionId)).toMatchObject({
      displayName: "Vapi API",
      status: "connected",
      statusDetail: null,
    });
    expect(connectionsAfter.find(({ id }) => id === mockVapi.twinConnectionId)).toEqual(
      connectionsBefore.find(({ id }) => id === mockVapi.twinConnectionId),
    );
    expect(client.getSnapshot().transcripts[mockVapi.threadId]).toContainEqual(
      expect.objectContaining({
        kind: "request",
        outcome: "Allowed",
        title: "Vapi API access · Proposed by an agent",
      }),
    );
  });
});

describe("ThreadIntegrationAction adding another key beside a usable account", () => {
  // The ways it could fail: the key form the person opened leaves no way back
  // to the account they could have used; "Not now" in the form's row reads as
  // closing the form but declines the request; a second row of answers beside
  // the form's own.
  it("closes the form it opened back to the account choice", async () => {
    const client = new MockHostClient({ automations: "absent", latencyMs: 0 });
    const pinned = client.getSnapshot().requests[mockVapi.threadId]?.[0];
    if (pinned?.payload.kind !== "integration.access") {
      throw new Error("The mock seeds the Vapi access request.");
    }
    const request = { ...pinned, payload: { ...pinned.payload, requestedConnectionId: null } };
    const dispatch = vi.spyOn(client, "dispatch");
    shellState.current = {
      hostClient: client,
      reportActionError: vi.fn(),
      snapshot: client.getSnapshot(),
    };
    const container = await mountThreadAction(request, "Read and write · 1 operation");

    expect(actionRowLabels(container)).toEqual([
      ["Not now", "Connect another account", "Use this account"],
    ]);
    await act(async () => buttonWithText(container, "Connect another account")?.click());

    expect(container.querySelector('input[type="password"]')).not.toBeNull();
    expect(actionRowLabels(container)).toEqual([["Cancel", "Connect Vapi API"]]);
    await act(async () => buttonWithText(container, "Cancel")?.click());

    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(actionRowLabels(container)).toEqual([
      ["Not now", "Connect another account", "Use this account"],
    ]);
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe("ThreadIntegrationAction says what connecting does before it is done", () => {
  const allows =
    "Your tasks in Main can read and make changes with every account you connect, so connecting also allows this request.";
  // The ways it could fail: on a request for Main, a key that connects also
  // answers the request and resumes the agent with nothing said beforehand;
  // the note promised where it is false, for a specialized Workspace, whose
  // account still waits for Allow; the note on a card that offers nothing to
  // connect; connecting on Main not answering the request after all.
  it("tells a Main request that connecting allows it, and connecting does", async () => {
    const client = new MockHostClient({ automations: "absent", latencyMs: 0 });
    shellState.current = {
      hostClient: client,
      reportActionError: vi.fn(),
      snapshot: client.getSnapshot(),
    };
    const container = await mountLiveThreadAction(client, mockTmdbProposal.requestId);
    expect(notes(container)).not.toContain(allows);

    await act(async () => buttonWithText(container, "Install and continue")?.click());
    await vi.waitFor(() => expect(notes(container)).toContain("Read and write · 4 operations"));

    // What Main gets, not the read the agent asked for: its tasks use every operation.
    expect(notes(container)).toEqual(["Read and write · 4 operations", allows]);
    const setup = container.querySelector('a[href="https://www.themoviedb.org/settings/api"]');
    expect(setup?.textContent).toBe("www.themoviedb.org");
    expect(actionRowLabels(container)).toEqual([["Not now", "Connect TMDB"]]);
    const key = container.querySelector<HTMLInputElement>('input[type="password"]');
    if (!key) throw new Error("The key field is shown once TMDB is installed.");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        key,
        "tmdb-read-access-token",
      );
      key.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => key.form?.requestSubmit());

    await vi.waitFor(() =>
      expect(client.getSnapshot().requests[mockTmdbProposal.threadId] ?? []).toEqual([]),
    );
    expect(
      client
        .getSnapshot()
        .transcripts[mockTmdbProposal.threadId]?.find(
          (entry) => entry.kind === "request" && entry.requestId === mockTmdbProposal.requestId,
        ),
    ).toMatchObject({ outcome: "Allowed" });
  });

  it("promises nothing for a specialized Workspace, whose account still waits for Allow", async () => {
    const client = new MockHostClient({ automations: "absent", latencyMs: 0 });
    const pinned = client.getSnapshot().requests[mockVapi.threadId]?.[0];
    if (pinned?.payload.kind !== "integration.access") {
      throw new Error("The mock seeds the Vapi access request.");
    }
    const request = {
      ...pinned,
      payload: { ...pinned.payload, requestedConnectionId: null },
      targetWorkspaceId: WorkspaceIdSchema.parse("wsp_00000000-0000-4000-8000-000000000002"),
    };
    shellState.current = {
      hostClient: client,
      reportActionError: vi.fn(),
      snapshot: client.getSnapshot(),
    };
    const container = await mountThreadAction(request);

    expect(notes(container)).toEqual([
      "Read only · 1 operation",
      "Access will be granted to Customer launch.",
    ]);
    expect(actionRowLabels(container)).toEqual([
      ["Not now", "Connect another account", "Allow in Customer launch"],
    ]);
  });
});

describe("ThreadIntegrationAction when the account a request names is gone", () => {
  // The ways it could fail: a key form offered for an account that no longer
  // exists; the action named "Dismiss", as if it only hid the card, when it
  // sends a decline; the next step unsaid; the receipt reading "Fulfilled",
  // with a success mark, for a request that gave nothing; the request left
  // waiting, or the other Vapi account touched.
  it("declines the request, and its receipt says it was declined", async () => {
    const client = new MockHostClient({ automations: "absent", latencyMs: 0 });
    await client.dispatch({
      connectionId: mockVapi.connectionId,
      idempotencyKey: "test-disconnect",
      type: "integration.disconnect",
    });
    const twinBefore = (await mockConnections(client)).find(
      ({ id }) => id === mockVapi.twinConnectionId,
    );
    const request = client.getSnapshot().requests[mockVapi.threadId]?.[0];
    if (!request) throw new Error("The mock seeds the Vapi reconnect request.");
    shellState.current = {
      hostClient: client,
      reportActionError: vi.fn(),
      snapshot: client.getSnapshot(),
    };
    const container = await mountThreadAction(request, "This account is no longer available.");

    expect(container.textContent).toContain(
      "This account is no longer available. Decline this request, then ask the agent again when you want to reconnect.",
    );
    expect(container.textContent).not.toContain("Dismiss");
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(actionRowLabels(container)).toEqual([["Decline request"]]);

    await act(async () => buttonWithText(container, "Decline request")?.click());

    await vi.waitFor(() =>
      expect(client.getSnapshot().requests[mockVapi.threadId] ?? []).toEqual([]),
    );
    const receipt = client
      .getSnapshot()
      .transcripts[mockVapi.threadId]?.find(
        (entry) => entry.kind === "request" && entry.requestId === request.id,
      );
    expect(receipt).toMatchObject({
      declined: true,
      outcome: "Declined",
      title: "Vapi API access · Proposed by an agent",
    });
    expect(receipt?.kind === "request" ? activityStepHead(receipt) : null).toMatchObject({
      icon: "stop",
      tone: "stopped",
    });
    expect(
      (await mockConnections(client)).find(({ id }) => id === mockVapi.twinConnectionId),
    ).toEqual(twinBefore);
  });
});

describe("ThreadIntegrationAction installing an agent's proposal", () => {
  // The ways it could fail: the review naming the document's title
  // ("tmdb-api") rather than the service the agent named; nothing on what the
  // service does; the provenance said twice, or never explained; the research
  // source as a full URL, or said twice; nothing on
  // where the key goes or whether it is checked; an operation count that
  // disagrees with the access step's; two notes about what comes next; a
  // rejected key raised in the app-wide banner as well as on the card, or
  // saved anyway; the decline receipt repeating itself ("Declined · Not now").
  it("reviews it, installs it, keeps a rejected key on the card, and declines plainly", async () => {
    const client = new MockHostClient({ automations: "absent", latencyMs: 0 });
    const reportActionError = vi.fn();
    shellState.current = { hostClient: client, reportActionError, snapshot: client.getSnapshot() };
    const container = await mountLiveThreadAction(client, mockTmdbProposal.requestId);

    expect(reviewLines(container)).toEqual([
      "TMDB",
      requestAgentProposedDetail,
      "Movie and TV show details, search and ratings.",
      "Researched from developer.themoviedb.org.",
      "Your key is stored encrypted by your Opensteer and sent to api.themoviedb.org when used.",
      "Opensteer checks the key with TMDB before saving it.",
    ]);
    expect(notes(container)).toEqual([
      "After it’s installed, you’ll finish setting it up and review its access here.",
    ]);
    expect(container.textContent).not.toMatch(/tmdb-api|operation|Agent proposal|https:/u);
    expect(actionRowLabels(container)).toEqual([["Not now", "Install and continue"]]);

    await act(async () => buttonWithText(container, "Install and continue")?.click());
    await vi.waitFor(() => expect(notes(container)).toContain("Read and write · 4 operations"));
    expect(notes(container)).toContain(
      "Your tasks in Main can read and make changes with every account you connect, so connecting also allows this request.",
    );

    // The access step, not the review, says what is granted; the key form
    // repeats where the key goes in the review's own words.
    expect(container.querySelector(".action-field")).toBeNull();
    expect(container.textContent).toContain(
      "Your key is stored encrypted by your Opensteer and sent to api.themoviedb.org when used.",
    );
    expect(
      container.querySelector<HTMLInputElement>('input[placeholder="TMDB account"]'),
    ).not.toBeNull();
    expect(container.textContent?.split("paste it here")).toHaveLength(2);
    expect(container.textContent).toContain(
      "Get your TMDB API Read Access Token at www.themoviedb.org, then paste it here.",
    );
    expect(actionRowLabels(container)).toEqual([["Not now", "Connect TMDB"]]);
    const key = container.querySelector<HTMLInputElement>('input[type="password"]');
    if (!key) throw new Error("The key field is shown once TMDB is installed.");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        key,
        mockRejectedApiKey,
      );
      key.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => key.form?.requestSubmit());

    await vi.waitFor(() =>
      expect(container.querySelector(".form-actions__error")?.textContent).toBe(
        "TMDB rejected this key.",
      ),
    );
    expect(reportActionError).not.toHaveBeenCalled();
    expect(
      (await mockConnections(client)).filter(
        ({ definitionId }) => definitionId === "proposed-tmdb",
      ),
    ).toEqual([]);
    expect(client.getSnapshot().requests[mockTmdbProposal.threadId]).toHaveLength(1);

    await act(async () => buttonWithText(container, "Not now")?.click());

    await vi.waitFor(() =>
      expect(client.getSnapshot().requests[mockTmdbProposal.threadId] ?? []).toEqual([]),
    );
    expect(reportActionError).not.toHaveBeenCalled();
    expect(
      client
        .getSnapshot()
        .transcripts[mockTmdbProposal.threadId]?.find(
          (entry) => entry.kind === "request" && entry.requestId === mockTmdbProposal.requestId,
        ),
    ).toMatchObject({
      declined: true,
      outcome: "Declined",
      title: "TMDB access · Proposed by an agent",
    });
  });
});

describe("ThreadIntegrationAction reviewing what a request would install", () => {
  // The ways it could fail: a proposal without a name shown by anything but
  // the name it will be installed under; one stored before agents described
  // their proposals given words nobody wrote; an unchecked key said to be
  // checked; a preset described as an agent's proposal, or its description
  // dropped.
  const custody =
    "Your key is stored encrypted by your Opensteer and sent to api.themoviedb.org when used.";
  const described = "Movie and TV show details, search and ratings.";
  const researched = "Researched from developer.themoviedb.org.";
  it.each([
    [
      "named, its key unchecked",
      { check: false, description: true, name: true },
      [
        "TMDB",
        requestAgentProposedDetail,
        described,
        researched,
        custody,
        "TMDB checks the key the first time it’s used.",
      ],
    ],
    [
      "unnamed, its key checked",
      { check: true, description: true, name: false },
      [
        "tmdb-api",
        requestAgentProposedDetail,
        described,
        researched,
        custody,
        "Opensteer checks the key with tmdb-api before saving it.",
      ],
    ],
    [
      "unnamed and undescribed, its key unchecked",
      { check: false, description: false, name: false },
      [
        "tmdb-api",
        requestAgentProposedDetail,
        researched,
        custody,
        "tmdb-api checks the key the first time it’s used.",
      ],
    ],
  ])("states an agent's proposal, %s", async (_label, variant, lines) => {
    const client = new MockHostClient({ automations: "absent", latencyMs: 0 });
    const seeded = client.getSnapshot().requests[mockTmdbProposal.threadId]?.[0];
    const manifest = mockTmdbProposal.manifest;
    if (seeded?.payload.kind !== "integration.access" || manifest.kind !== "proposal") {
      throw new Error("The mock seeds the TMDB proposal.");
    }
    const { check, description, name, ...rest } = manifest.proposal;
    const proposal = {
      ...rest,
      apiKey: { ...manifest.proposal.apiKey!, check: variant.check },
      ...(variant.check ? { check } : {}),
      ...(variant.description ? { description } : {}),
      ...(variant.name ? { name } : {}),
    };
    shellState.current = {
      hostClient: client,
      reportActionError: vi.fn(),
      snapshot: client.getSnapshot(),
    };
    const container = await mountThreadAction(
      {
        ...seeded,
        payload: {
          ...seeded.payload,
          manifest: RequestJsonObjectSchema.parse({ kind: "proposal", proposal }),
        },
      },
      "Install and continue",
    );

    expect(reviewLines(container)).toEqual(lines);
  });

  it("states a catalog preset by its description, and its key only once it is disclosed", async () => {
    const client = new MockHostClient({ automations: "absent", latencyMs: 0 });
    const seeded = client.getSnapshot().requests[mockTmdbProposal.threadId]?.[0];
    const platform = await client.rpc["integration.platform.get"]({});
    if (seeded?.payload.kind !== "integration.access" || !platform.ok) {
      throw new Error("The mock seeds an access request and a catalog.");
    }
    const preset = (id: string) => {
      const entry = platform.data.catalog.find(({ definition }) => definition.id === id);
      if (!entry) throw new Error(`The mock catalog offers ${id}.`);
      return {
        ...seeded,
        payload: {
          ...seeded.payload,
          manifest: RequestJsonObjectSchema.parse({
            definition: entry.definition,
            digest: entry.digest,
            kind: "catalog",
          }),
        },
      };
    };
    shellState.current = {
      hostClient: client,
      reportActionError: vi.fn(),
      snapshot: client.getSnapshot(),
    };

    // Not installed, so no snapshot has said where its key would go yet.
    const resend = await mountThreadAction(preset("resend"), "Install and continue");
    expect(reviewLines(resend)).toEqual([
      "Resend REST",
      "Send transactional email and inspect sending domains through Resend.",
    ]);
    expect(notes(resend)).toEqual([
      "After it’s installed, you’ll finish setting it up and review its access here.",
    ]);

    const linear = await mountThreadAction(preset("linear"), "Install and continue");
    expect(reviewLines(linear)).toEqual([
      "Linear GraphQL",
      "Read and update Linear issues, projects, teams, and comments.",
      "Your key is stored encrypted by your Opensteer and sent to api.linear.app when used.",
      "Opensteer checks the key with Linear GraphQL before saving it.",
    ]);
    for (const container of [resend, linear]) {
      expect(container.textContent).not.toContain(requestAgentProposedDetail);
    }
  });
});

/** Each line of the install review, in order. */
function reviewLines(container: HTMLElement): readonly string[] {
  return [...(container.querySelector(".action-field")?.children ?? [])].map(
    (line) => line.textContent ?? "",
  );
}

/** The card for one Request as the Host keeps it, re-read as the mock Host changes it. */
async function mountLiveThreadAction(client: MockHostClient, requestId: string) {
  function Live() {
    const snapshot = useSyncExternalStore(
      (listener) => client.subscribe(listener),
      () => client.getSnapshot(),
    );
    const request = Object.values(snapshot.requests)
      .flat()
      .find(({ id }) => id === requestId);
    return request ? <ThreadIntegrationAction request={request} threadId="thr_test" /> : null;
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  await act(async () => {
    root.render(
      <MemoryRouter>
        <Live />
      </MemoryRouter>,
    );
  });
  await vi.waitFor(() => expect(buttonWithText(container, "Install and continue")).not.toBeNull());
  return container;
}

async function mockConnections(client: MockHostClient) {
  const result = await client.rpc["integrations.get"]({});
  if (!result.ok) throw new Error("The mock Host lists integrations.");
  return result.data.connections;
}

function notes(container: HTMLElement): readonly string[] {
  return [...container.querySelectorAll(".action-note")].map((note) => note.textContent ?? "");
}

/** Each row of answers on the card, as the labels of its buttons in order. */
function actionRowLabels(container: HTMLElement): readonly (readonly string[])[] {
  return [...container.querySelectorAll(".action-buttons, .form-actions")].map((row) =>
    [...row.querySelectorAll("button")].map((button) => button.textContent ?? ""),
  );
}

describe("resolveIntegrationAccess", () => {
  it("sends only the minimal fulfillment decision for a Main target", async () => {
    const dispatch = vi.fn(async () => ({ type: "request.respond" as const }));

    await resolveIntegrationAccess(
      { dispatch },
      {
        access: "read-write",
        accountsCount: 1,
        installationTitle: "Gmail",
        requestId: "request-main",
        selectedAccount: {
          accountIdentifier: "work@example.com",
          displayName: "Work",
          id: "connection-work",
        },
        targetKind: "main",
      },
    );

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "request-main",
        response: {
          kind: "external",
          value: { connectionId: "connection-work", decision: "fulfilled" },
        },
        type: "request.respond",
      }),
    );
  });

  it("sends the full grant decision for a specialized target", async () => {
    const dispatch = vi.fn(async () => ({ type: "request.respond" as const }));

    await resolveIntegrationAccess(
      { dispatch },
      {
        access: "read",
        accountsCount: 1,
        installationTitle: "Calendar",
        requestId: "request-specialized",
        selectedAccount: {
          accountIdentifier: null,
          displayName: "Client",
          id: "connection-client",
        },
        targetKind: "specialized",
      },
    );

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "request-specialized",
        response: {
          kind: "external",
          value: {
            access: "read",
            alias: "Client",
            connectionId: "connection-client",
            decision: "fulfilled",
            isDefault: true,
          },
        },
        type: "request.respond",
      }),
    );
  });
});

describe("accessPlan", () => {
  it("counts read and write operations and carries the requested class", () => {
    const plan = accessPlan(genericSpecializedRequest(), null);

    expect(plan).toMatchObject({ readCount: 1, requestedAccess: "read", writeCount: 1 });
  });

  it("offers in-thread credential entry for an API-key integration", () => {
    const plan = accessPlan(apiKeyRequest(), null);

    expect(plan?.apiKeyMethod?.id).toBe("api-key");
    expect(plan?.accounts).toEqual([]);
  });

  // The way it could fail: a key form offered for an integration whose snapshot
  // cannot say where a key goes, which renders nothing and hides every action.
  it("takes no key for an integration that cannot disclose where its key goes", () => {
    const plan = accessPlan(apiKeyRequest({ disclosed: false }), null);

    expect(plan?.apiKeyMethod).toBeNull();
    expect(plan && accountConnectable(plan)).toBe(false);
  });

  it("keeps an OAuth integration on the authorization path with no key form", () => {
    const plan = accessPlan(oauthRequest(), null);

    expect(plan?.apiKeyMethod).toBeNull();
    expect(plan?.requirement).toMatchObject({ kind: "provider" });
  });

  it("never substitutes another account for the exact account requested", () => {
    const loaded = oauthRequest({ connected: true });
    loaded.request.requestedConnectionId = "connection-no-longer-present";

    const plan = accessPlan(loaded, "connection-linear");

    expect(plan?.selectedAccount).toBeNull();
    expect(plan?.requestedAccountMissing).toBe(true);
  });

  it("does not offer account selection when the Request pins an exact account", () => {
    const loaded = oauthRequest({ connected: true });
    loaded.request.requestedConnectionId = "connection-linear";

    const plan = accessPlan(loaded, null);

    expect(plan?.selectedAccount?.id).toBe("connection-linear");
    expect(integrationAccountCanChange(plan!)).toBe(false);
  });

  it("keeps provider reauthorization available for the same pinned account row", () => {
    const loaded = oauthRequest({ connected: true });
    loaded.request.requestedConnectionId = "connection-linear";
    loaded.dashboard.connections[0]!.status = "needs-attention";

    expect(accessPlan(loaded, null)).toMatchObject({
      requestedAccountMissing: true,
      requestedAccountReconnect: {
        account: { displayName: "Alex", id: "connection-linear" },
        method: "sign-in",
      },
      selectedAccount: null,
    });
  });

  it("supports definitionless plugin installations", () => {
    const loaded = genericSpecializedRequest();
    loaded.platform.installations[0]!.installation.manifest = { name: "support-tools" };

    const plan = accessPlan(loaded, null);

    expect(plan).toMatchObject({
      definition: null,
      integrationName: "Test integration",
      readCount: 1,
      writeCount: 1,
    });
  });

  it("does not invent a credential-free server when the named MCP server is absent", () => {
    const loaded = genericSpecializedRequest();
    loaded.request.requestedServerId = "server-that-is-not-installed";

    expect(accessPlan(loaded, null)).toBeNull();
  });

  it.each(["active", "needs-attention"] as const)(
    "requires an explicit choice with another %s server",
    (status) => {
      const loaded = genericSpecializedRequest();
      loaded.request.requestedServerId = null;
      loaded.platform.installations[0]!.servers.push({
        ...loaded.platform.installations[0]!.servers[0]!,
        id: "server-second" as never,
        name: "secondary",
        status,
      });

      expect(accessPlan(loaded, null)).toBeNull();
      expect(accessServerChoices(loaded)).toEqual([
        expect.objectContaining({ id: "server-test" }),
        expect.objectContaining({ id: "server-second", name: "secondary" }),
      ]);
    },
  );

  it("pins a singleton unhealthy server instead of treating it as no-auth", () => {
    const loaded = oauthRequest();
    loaded.platform.installations[0]!.servers[0]!.status = "needs-attention";
    loaded.request.requestedServerId = null;

    expect(accessPlan(loaded, null)).toBeNull();
    expect(accessServerChoices(loaded)).toEqual([
      expect.objectContaining({ id: "server-provider" }),
    ]);
  });

  it("uses no-auth only for a true zero-server skills installation", () => {
    const loaded = genericSpecializedRequest();
    loaded.platform.installations[0]!.servers = [];
    loaded.platform.installations[0]!.tools = [];
    loaded.request.requestedServerId = null;

    expect(accessPlan(loaded, null)?.requirement).toEqual({ kind: "none" });
  });

  it("keeps an unprobed MCP account selectable while reporting zero discovered operations", () => {
    const loaded = genericSpecializedRequest();
    loaded.platform.installations[0]!.installation.manifest = { name: "tinycrm" };
    loaded.platform.installations[0]!.servers[0]!.connectionRequirement = { kind: "mcp-oauth" };
    loaded.platform.installations[0]!.tools = [];
    loaded.platform.connections = [
      {
        accountIdentifier: null,
        connectionId: "connection-mcp",
        displayName: "TinyCRM",
        installationId: "installation-test",
        serverId: "server-test",
        status: "connected",
      },
    ] as never;

    expect(accessPlan(loaded, null)).toMatchObject({
      definition: null,
      readCount: 0,
      selectedAccount: { id: "connection-mcp" },
      writeCount: 0,
    });
  });
});

describe("effectiveIntegrationAccess", () => {
  it("never downgrades requested read-write access, even before tools are discovered", () => {
    expect(effectiveIntegrationAccess("read-write", false)).toBe("read-write");
  });

  it("keeps write access optional for a read request", () => {
    expect(effectiveIntegrationAccess("read", false)).toBe("read");
    expect(effectiveIntegrationAccess("read", true)).toBe("read-write");
  });
});

describe("matchingInstallationForManifest", () => {
  it("matches only the exact active catalog digest", () => {
    const loaded = genericSpecializedRequest();
    loaded.platform.installations[0]!.installation.status = "active";
    loaded.platform.installations[0]!.installation.provenance = {
      definitionDigest: "d".repeat(43),
      definitionId: "test-integration",
    };
    const manifest = {
      definition: loaded.platform.installations[0]!.installation.manifest["definition"],
      digest: "d".repeat(43),
      kind: "catalog",
    };

    expect(matchingInstallationForManifest(loaded.platform, manifest)?.installation.id).toBe(
      "installation-test",
    );
    expect(
      matchingInstallationForManifest(loaded.platform, { ...manifest, digest: "x".repeat(43) }),
    ).toBeNull();
  });
});

describe("accountConnectable", () => {
  it("keeps connecting another account available once one is already connected", () => {
    const plan = accessPlan(oauthRequest({ connected: true }), null);

    // The selected account satisfies the Request, and the user can still
    // answer it with a different one: that is how an agent's "add another
    // account" ask is fulfilled.
    expect(plan?.selectedAccount?.id).toBe("connection-linear");
    expect(accountConnectable(plan!)).toBe(true);
  });

  it("offers connection for an API-key integration regardless of existing accounts", () => {
    expect(accountConnectable(accessPlan(apiKeyRequest(), null)!)).toBe(true);
  });

  it("offers nothing to connect when the integration needs no account", () => {
    expect(accountConnectable(accessPlan(genericSpecializedRequest(), null)!)).toBe(false);
  });
});

function providerRequest(input: {
  readonly apiKey?: { readonly check: boolean; readonly destinations: readonly string[] } | null;
  readonly authMethod: Readonly<Record<string, unknown>>;
  readonly connected?: boolean;
  readonly provider?: "github" | "linear";
  readonly providerApplicationRequired: boolean;
}): LoadedAccessRequest {
  const provider = input.provider ?? "linear";
  return {
    dashboard: {
      applications: [],
      callbackUrls: {},
      connections: input.connected
        ? [
            {
              accountIdentifier: "alex@example.com",
              definitionId: "provider-integration",
              displayName: "Alex",
              id: "connection-linear",
              status: "connected",
            },
          ]
        : [],
      hostedOAuthDisclosure: "Disclosure",
      isAdministrator: false,
      providerAuthorizations: {},
      providers: [],
    },
    platform: {
      catalog: [],
      connections: [],
      installations: [
        {
          installation: {
            id: "installation-provider",
            manifest: {
              definition: {
                adapter: "openapi",
                apiKey: input.apiKey ?? null,
                authMethods: [input.authMethod],
                description: "A provider integration.",
                id: "provider-integration",
                name: "Provider integration",
                provider,
              },
            },
            title: "Provider integration",
          },
          servers: [
            {
              connectionRequirement: {
                definitionId: "provider-integration",
                kind: "provider",
                provider,
                providerApplicationRequired: input.providerApplicationRequired,
              },
              id: "server-provider",
              status: "active",
            },
          ],
          skills: [],
          tools: [],
        },
      ],
    },
    request: {
      access: "read",
      installationId: "installation-provider",
      kind: "integration.access",
      reason: "Connect the account",
      requestedServerId: "server-provider",
    },
  } as unknown as LoadedAccessRequest;
}

/** An installed key integration discloses where its key goes unless its snapshot could not say. */
function apiKeyRequest(input: { readonly disclosed?: boolean } = {}): LoadedAccessRequest {
  return providerRequest({
    apiKey:
      input.disclosed === false ? null : { check: false, destinations: ["https://api.linear.app"] },
    authMethod: {
      id: "api-key",
      inputs: [{ label: "API key", secret: true, variable: "apiKey" }],
      kind: "api-key",
      label: "API key",
      placements: [{ carrier: "header", name: "Authorization", variable: "apiKey" }],
    },
    providerApplicationRequired: false,
  });
}

function oauthRequest(
  input: { readonly connected?: boolean; readonly provider?: "github" | "linear" } = {},
): LoadedAccessRequest {
  return providerRequest({
    ...input,
    authMethod: {
      id: "linear-oauth",
      kind: "oauth",
      label: "Linear sign-in",
      oauth: {
        authorizationUrl: "https://linear.app/oauth/authorize",
        clientAuth: "body",
        identity: { identityPath: "id", source: "token-response" },
        scopes: ["read"],
        tokenUrl: "https://api.linear.app/oauth/token",
        usesPkce: true,
      },
      placements: [
        { carrier: "header", name: "Authorization", prefix: "Bearer ", variable: "accessToken" },
      ],
    },
    providerApplicationRequired: true,
  });
}

function genericSpecializedRequest(): LoadedAccessRequest {
  const definition = {
    adapter: "openapi",
    authMethods: [{ id: "none", kind: "none", label: "No authentication" }],
    description: "A test integration.",
    id: "test-integration",
    name: "Test integration",
    provider: "github",
  };
  const tool = (id: string, title: string) => ({
    annotations: { readOnlyHint: id === "tool-prior" },
    connectionId: null,
    description: title,
    id,
    name: id,
    schemaDigest: "d".repeat(43),
    serverId: "server-test",
    status: "active",
    title,
  });
  const skill = (id: string, name: string) => ({
    description: name,
    digest: "s".repeat(43),
    id,
    installationId: "installation-test",
    name,
    status: "active",
    updatedAt: "2026-08-25T00:00:00.000Z",
  });
  return {
    dashboard: {
      applications: [],
      callbackUrls: {},
      connections: [],
      hostedOAuthDisclosure: "Disclosure",
      isAdministrator: false,
      providerAuthorizations: {},
      providers: [],
    },
    platform: {
      catalog: [],
      connections: [],
      installations: [
        {
          installation: {
            id: "installation-test",
            manifest: { definition },
            title: "Test integration",
          },
          servers: [
            {
              connectionRequirement: { kind: "none" },
              id: "server-test",
              name: "default",
              status: "active",
            },
          ],
          skills: [skill("skill-prior", "prior-skill"), skill("skill-other", "other-skill")],
          tools: [tool("tool-prior", "Prior tool"), tool("tool-other", "Other tool")],
        },
      ],
    },
    request: {
      access: "read",
      installationId: "installation-test",
      kind: "integration.access",
      reason: "Add another account",
      requestedServerId: "server-test",
    },
  } as unknown as LoadedAccessRequest;
}

/**
 * The browser returns to the card from a GitHub sign-in whose account waits
 * for repositories. The first `answered` repository checks find none at
 * once; the next waits until the test answers that none are chosen yet.
 */
async function returnFromGitHubSignIn(ready: string, answered: number) {
  const connectionId = "con_00000000-0000-4000-8000-0000000000b1";
  const loaded = oauthRequest({ provider: "github" });
  const missing = {
    data: { installationUrl: null, installations: [], ready: false },
    ok: true as const,
  };
  let answer = () => {};
  const check = vi.fn(
    () =>
      new Promise((resolve) => {
        answer = () => resolve(missing);
      }),
  );
  for (let index = 0; index < answered; index += 1) check.mockResolvedValueOnce(missing);
  shellState.current = {
    hostClient: {
      dispatch: vi.fn(),
      getSnapshot: () => shellSnapshot(),
      loadEarlierWorkspaces: async () => undefined,
      refresh: async () => undefined,
      rpc: {
        "integration.authorization.get": async () => ({
          data: {
            connectionId,
            expiresAt: "2026-09-18T00:10:00.000Z",
            failureCode: null,
            status: "completed",
          },
          ok: true as const,
        }),
        "integration.platform.get": async () => ({ data: loaded.platform, ok: true as const }),
        "integration.repositoryAccess.check": check,
        "integrations.get": async () => ({
          data: {
            ...loaded.dashboard,
            connections: [
              {
                accountIdentifier: "steerlabs",
                definitionId: "provider-integration",
                displayName: "steerlabs",
                id: connectionId,
                provider: "github",
                status: "needs-attention",
                statusDetail: null,
                statusReason: "permissions",
              },
            ],
          },
          ok: true as const,
        }),
      },
    },
    reportActionError: vi.fn(),
    snapshot: shellSnapshot(),
  };
  const container = await mountThreadAction(
    requestRecord(loaded, "Connect GitHub"),
    ready,
    `/threads/thr_test?integrationAttempt=${createIntegrationId("oauthAttempt")}`,
  );
  return { answer: () => answer(), check, container };
}

async function mountThreadAction(
  request: Parameters<typeof ThreadIntegrationAction>[0]["request"],
  ready = "Read only · 1 operation",
  path = "/threads/thr_test",
) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <ThreadIntegrationAction request={request} threadId="thr_test" />
      </MemoryRouter>,
    );
  });
  await vi.waitFor(() => expect(container.textContent).toContain(ready));
  return container;
}

function buttonWithText(container: HTMLElement, label: string): HTMLButtonElement | null {
  return (
    [...container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === label,
    ) ?? null
  );
}

function computerRequest(): LoadedAccessRequest {
  const definition = {
    adapter: "computer",
    authMethods: [{ id: "computer", kind: "computer", label: "This Mac" }],
    computerApp: {
      accessLabels: { read: "Read only", readWrite: "Read and send" },
      accessLevels: ["read", "read-write"],
      operations: [
        { name: "list_conversations", effect: "read" },
        { name: "read_messages", effect: "read" },
        { name: "send_message", effect: "write" },
      ],
      accessSummaries: {
        read: "Agents can search and read your conversations.",
        readWrite: "Agents can search and read your conversations, and send messages as you.",
      },
      platforms: ["darwin"],
    },
    description: "Search, read, and send Messages through an enrolled Mac.",
    id: "apple-messages",
    name: "Messages",
    provider: "apple-messages",
  };
  const connection = {
    accountIdentifier: null,
    computer: { access: "read", runnerId: macMini },
    createdAt: "2026-09-17T12:00:00.000Z",
    definitionId: "apple-messages",
    displayName: "Mac mini",
    id: "con_messages_mac_mini",
    status: "connected",
  };
  return {
    dashboard: { connections: [connection] },
    platform: {
      connections: [],
      installations: [
        {
          installation: {
            id: "iin_messages",
            manifest: { definition },
            title: "Messages",
          },
          servers: [
            {
              connectionRequirement: { definitionId: "apple-messages", kind: "computer" },
              id: "isv_messages",
              status: "active",
            },
          ],
          skills: [],
          // The read-only ceiling materialises no send tool. The catalog still
          // declares that the connection can deliberately be widened.
          tools: [
            {
              annotations: { readOnlyHint: true },
              connectionId: connection.id,
              id: "itl_read_messages",
              serverId: "isv_messages",
              status: "active",
            },
          ],
        },
      ],
    },
    request: {
      access: "read",
      installationId: "iin_messages",
      kind: "integration.access",
      reason: "Read Messages",
      requestedConnectionId: null,
      requestedServerId: "isv_messages",
    },
  } as unknown as LoadedAccessRequest;
}

function requestRecord(loaded: LoadedAccessRequest, title: string) {
  return {
    createdAt: "2026-09-18T00:00:00.000Z",
    id: "req_00000000-0000-4000-8000-000000000001",
    kind: "integration.access",
    mode: "live",
    payload: loaded.request,
    presentation: { kind: "external", title },
    status: "pending",
    targetWorkspaceId: "wsp_support",
  } as never;
}

function computerRequestRecord() {
  return {
    createdAt: "2026-09-18T00:00:00.000Z",
    id: "req_00000000-0000-4000-8000-000000000001",
    kind: "integration.access",
    mode: "live",
    payload: computerRequest().request,
    presentation: { kind: "external", title: "Connect Messages" },
    status: "pending",
    targetWorkspaceId: "wsp_support",
  } as never;
}

function shellSnapshot() {
  return {
    machines: [],
    workspaceWindow: { hasMore: false, itemCount: 1 },
    workspaces: [{ id: "wsp_support", kind: "specialized", name: "Support" }],
  } as never;
}
