// @vitest-environment happy-dom
// @vitest-environment-options {"url": "https://chat.acme.example/"}
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createId } from "@opensteer/core";
import { teamApiVersion, teamApiVersionHeader } from "@opensteer/protocol";
import { MockTeamHost, mockTeamChannelId, mockTeamId, seedBusyTeam } from "@opensteer/client/team";
import { TeamWebApp } from "./team-web-app.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, status });

/** The team server at this origin: the mock team behind its HTTP routes. */
function serveTeam(options: {
  readonly signedIn: boolean;
  readonly consentError?: string;
  readonly refusedReason?: string | null;
}) {
  const team = new MockTeamHost();
  seedBusyTeam(team, { name: "Acme", index: 1 });
  const requests: { readonly path: string; readonly init: RequestInit | undefined }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input), window.location.origin);
      requests.push({ path: url.pathname, init });
      if (url.pathname === "/v1/team/setup/state")
        return json({ complete: true, accountReady: true });
      if (url.pathname === "/v1/rpc/auth.oidc.begin")
        return json({
          ok: true,
          data: { redirectUrl: "https://account.opensteer.example/authorize?state=1" },
        });
      if (url.pathname === "/v1/rpc/auth.native.complete")
        return options.consentError
          ? json({
              ok: false,
              error: { code: "bad_request", message: options.consentError, retryable: false },
            })
          : json({
              ok: true,
              data: { url: "com.opensteer.opensteer:/oauth/callback?code=returned" },
            });
      if (url.pathname === "/v1/rpc/team.bootstrap.get" && options.refusedReason !== undefined)
        return json(
          {
            ok: false,
            error: {
              code: "forbidden",
              message: "Active team membership required",
              retryable: false,
              ...(options.refusedReason ? { reason: options.refusedReason } : {}),
            },
          },
          403,
        );
      const name = url.pathname.replace("/v1/rpc/", "") as keyof MockTeamHost["rpc"];
      if (!options.signedIn)
        return json({ ok: false, error: { code: "unauthenticated", message: "Sign in." } }, 401);
      const payload: unknown = JSON.parse(
        url.searchParams.get("input") ?? (typeof init?.body === "string" ? init.body : "{}"),
      );
      const call = team.rpc[name] as (payload: unknown) => Promise<unknown>;
      return json(await call(payload));
    }),
  );
  vi.stubGlobal(
    "WebSocket",
    class {
      constructor() {
        return team.connect();
      }
    },
  );
  return { requests, team };
}

async function render() {
  const node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  await act(async () => root?.render(<TeamWebApp />));
  await act(async () => {
    await vi.waitFor(() => expect(node.textContent).not.toBe(""), { timeout: 2_000 });
  });
  return node;
}

const button = (node: HTMLElement, label: string) =>
  [...node.querySelectorAll<HTMLButtonElement | HTMLAnchorElement>("button, a")].find(
    (candidate) => candidate.textContent === label,
  );

const nativeQuery = new URLSearchParams({
  response_type: "code",
  client_id: "opensteer-desktop",
  redirect_uri: "com.opensteer.opensteer:/oauth/callback",
  code_challenge: "a".repeat(43),
  code_challenge_method: "S256",
  ba_iat: "1786499200000",
  ba_param: "client_id",
  sig: "signed-value",
}).toString();

describe("a team's own web app", () => {
  it.each(["removed", null])(
    "gives a refused reader invite guidance on first load (reason %s)",
    async (refusedReason) => {
      serveTeam({ signedIn: true, refusedReason });
      const node = await render();
      expect(node.textContent).toContain("Ask a team member for a new invite");
      expect(node.textContent).not.toContain("Active team membership required");
    },
  );

  it("signs a signed-out member in through the team server", async () => {
    const { requests } = serveTeam({ signedIn: false });
    const assign = vi.spyOn(window.location, "assign").mockImplementation(() => undefined);
    const node = await render();
    expect(node.textContent).toContain("Sign in to your team");

    await act(async () => button(node, "Continue with Opensteer Account")?.click());
    await act(async () => {
      await vi.waitFor(() => expect(assign).toHaveBeenCalled(), { timeout: 2_000 });
    });

    expect(assign).toHaveBeenCalledWith("https://account.opensteer.example/authorize?state=1");
    const signIn = requests.find(({ path }) => path === "/v1/rpc/auth.oidc.begin");
    expect(signIn?.init?.method).toBe("POST");
    expect(new Headers(signIn?.init?.headers).get(teamApiVersionHeader)).toBe(
      String(teamApiVersion),
    );
  });

  it("retains the native continuation through Account sign-in and reload", async () => {
    window.history.replaceState(null, "", `/?${nativeQuery}`);
    const { requests } = serveTeam({ signedIn: false });
    const assign = vi.spyOn(window.location, "assign").mockImplementation(() => undefined);
    let node = await render();
    expect(window.location.search).toBe("");
    expect(window.history.state.nativeOAuthQuery).toBe(nativeQuery);
    act(() => root?.unmount());
    root = null;
    node = await render();
    await act(async () => button(node, "Continue with Opensteer Account")?.click());
    expect(assign).toHaveBeenCalled();
    expect(
      JSON.parse(
        String(requests.find(({ path }) => path.endsWith("/auth.oidc.begin"))?.init?.body),
      ),
    ).toEqual({
      providerId: "opensteer-account",
      returnPath: "/",
      oauthQuery: nativeQuery,
    });
  });

  it.each([true, false])(
    "requires consent before chat and returns the app callback (accept=%s)",
    async (accept) => {
      window.history.replaceState(null, "", `/?${nativeQuery}`);
      const { requests } = serveTeam({ signedIn: true });
      const assign = vi.spyOn(window.location, "assign").mockImplementation(() => undefined);
      const node = await render();
      expect(node.textContent).toContain("Connect Opensteer");
      expect(node.querySelector(".sidebar")).toBeNull();
      expect(requests.some(({ path }) => path.endsWith("/auth.native.complete"))).toBe(false);
      await act(async () => button(node, accept ? "Allow" : "Deny")?.click());
      const complete = requests.find(({ path }) => path.endsWith("/auth.native.complete"));
      expect(JSON.parse(String(complete?.init?.body))).toEqual({ accept, oauthQuery: nativeQuery });
      expect(new Headers(complete?.init?.headers).get(teamApiVersionHeader)).toBe(
        String(teamApiVersion),
      );
      expect(assign).toHaveBeenCalledWith("com.opensteer.opensteer:/oauth/callback?code=returned");
      expect(window.history.state).not.toHaveProperty("nativeOAuthQuery");
    },
  );

  it("explains how to recover an expired consent without opening chat", async () => {
    window.history.replaceState(null, "", `/?${nativeQuery}`);
    serveTeam({ signedIn: true, consentError: "Consent has expired." });
    const assign = vi.spyOn(window.location, "assign").mockImplementation(() => undefined);
    const node = await render();
    await act(async () => button(node, "Allow")?.click());
    expect(node.textContent).toContain("Consent has expired.");
    expect(node.textContent).toContain("start sign-in again in the Opensteer app");
    expect(assign).not.toHaveBeenCalled();
    expect(button(node, "Deny")?.hasAttribute("disabled")).toBe(false);
  });

  it("shows an upstream OAuth failure with app retry guidance", async () => {
    window.history.replaceState(
      null,
      "",
      "/auth/error?error=access_denied&error_description=Sign-in+cancelled",
    );
    serveTeam({ signedIn: true });
    const node = await render();
    expect(node.textContent).toContain("Sign-in cancelled");
    expect(node.textContent).toContain("start sign-in again there");
    expect(node.querySelector(".sidebar")).toBeNull();
    const assign = vi.spyOn(window.location, "assign").mockImplementation(() => undefined);
    await act(async () => button(node, "Sign in again")?.click());
    expect(assign).toHaveBeenCalledWith("/");
  });

  it("opens the team's first channel after asking who is signed in once", async () => {
    const { requests } = serveTeam({ signedIn: true });
    const node = await render();
    await act(async () => {
      await vi.waitFor(
        () => expect(window.location.pathname).toContain(`/c/${mockTeamChannelId}`),
        { timeout: 2_000 },
      );
    });

    expect(node.querySelector(".sidebar__title")?.textContent).toBe("Acme");
    expect(requests.filter(({ path }) => path.endsWith("/team.bootstrap.get"))).toHaveLength(1);
  });

  it("offers a shared channel link to the app, and reads it here on request", async () => {
    window.history.replaceState(null, "", `/c/${mockTeamChannelId}`);
    serveTeam({ signedIn: true });
    const node = await render();

    const open = button(node, "Open in Opensteer") as HTMLAnchorElement | undefined;
    expect(new URL(open!.href).searchParams.get("url")).toBe(
      `https://chat.acme.example/c/${mockTeamChannelId}`,
    );
    await act(async () => button(node, "Continue in this browser")?.click());
    expect(window.location.pathname).toMatch(new RegExp(`/teams/.+/c/${mockTeamChannelId}$`, "u"));
  });

  it("opens an old note link beside the list and restores an earlier version", async () => {
    const { team } = serveTeam({ signedIn: true });
    const noteId = createId("knowledgeNote");
    const topicId = team.knowledge.starterTopicId;
    const leo = team.members.find((member) => member.handle === "leo")!;
    const write = (body: string) =>
      team.knowledge.addVersion({
        noteId,
        topicId,
        title: "Refunds",
        body,
        writer: { kind: "agent", userId: leo.userId, name: leo.displayName },
      });
    write("Ask Maya.");
    write("Ask Dana.");
    window.history.replaceState(
      null,
      "",
      `/teams/${mockTeamId}/knowledge/${topicId}/${noteId}/edit`,
    );
    const node = await render();
    await act(async () => {
      await vi.waitFor(
        () => {
          expect(window.location.search).toBe(`?note=${noteId}`);
          expect(
            node.querySelector(`tr[data-note-id="${noteId}"]`)?.getAttribute("aria-selected"),
          ).toBe("true");
          expect(node.querySelector(".kb-note")?.textContent).toContain("Ask Dana.");
        },
        { timeout: 2_000 },
      );
    });

    await act(async () => button(node, "Show 2")?.click());
    const first = await act(async () =>
      vi.waitFor(
        () =>
          [...node.querySelectorAll<HTMLButtonElement>(".kb-version")].find((row) =>
            row.textContent?.startsWith("v1"),
          )!,
        { timeout: 2_000 },
      ),
    );
    await act(async () => first.click());
    expect(node.querySelector(".kb-note")?.textContent).toContain("Ask Maya.");
    await act(async () => button(node, "Restore")?.click());
    await act(async () => {
      await vi.waitFor(
        () =>
          expect(team.knowledge.notes.get(noteId)?.versions.at(-1)).toMatchObject({
            version: 3,
            body: "Ask Maya.",
            writer: { kind: "human", userId: team.userId },
          }),
        { timeout: 2_000 },
      );
    });
  });
  it("follows Back to the search the address holds", async () => {
    serveTeam({ signedIn: true });
    window.history.replaceState(null, "", `/teams/${mockTeamId}/knowledge?q=refunds`);
    const node = await render();
    const field = () => node.querySelector<HTMLInputElement>("input[aria-label='Search notes']");
    await act(async () => {
      await vi.waitFor(() => expect(field()?.value).toBe("refunds"), { timeout: 2_000 });
    });
    await act(async () => {
      window.history.pushState(null, "", `/teams/${mockTeamId}/knowledge?q=maya`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await act(async () => {
      await vi.waitFor(() => expect(field()?.value).toBe("maya"), { timeout: 2_000 });
    });
    expect(window.location.search).toBe("?q=maya");
  });
});

it.each(["thread", "knowledge-topic", "knowledge-note"] as const)(
  "opens a public %s page through the existing team screen after the landing",
  async (kind) => {
    const { team } = serveTeam({ signedIn: true });
    const topicId = team.knowledge.starterTopicId;
    const noteId = createId("knowledgeNote");
    team.knowledge.addVersion({
      noteId,
      topicId,
      title: "Shared note",
      body: "Shared content",
      writer: { kind: "human", userId: team.userId, name: "Reader" },
    });
    const root = team.post({ channelId: mockTeamChannelId, bodyMarkdown: "Shared thread" });
    const path =
      kind === "thread"
        ? "/c/" + mockTeamChannelId + "/t/" + root.id
        : "/knowledge/" + topicId + (kind === "knowledge-note" ? "?note=" + noteId : "");
    window.history.replaceState(null, "", path);
    const node = await render();
    const native = button(node, "Open in Opensteer") as HTMLAnchorElement;
    expect(new URL(native.href).searchParams.get("url")).toBe("https://chat.acme.example" + path);
    await act(async () => button(node, "Continue in this browser")?.click());
    await act(async () => {
      await vi.waitFor(
        () => {
          expect(window.location.pathname + window.location.search).toBe(
            "/teams/" + mockTeamId + path,
          );
          expect(node.textContent).toContain(kind === "thread" ? "Shared thread" : "Shared note");
        },
        { timeout: 2_000 },
      );
    });
  },
);

it("keeps a signed-out knowledge link through Account sign-in at the root", async () => {
  const { requests, team } = serveTeam({ signedIn: false });
  const topicId = team.knowledge.starterTopicId,
    noteId = createId("knowledgeNote");
  const path = `/knowledge/${topicId}?note=${noteId}`;
  window.history.replaceState(null, "", path);
  vi.spyOn(window.location, "assign").mockImplementation(() => undefined);
  let node = await render();
  await act(async () => button(node, "Sign in here instead")?.click());
  await act(async () => button(node, "Continue with Opensteer Account")?.click());
  const signIn = requests.find(({ path }) => path.endsWith("/auth.oidc.begin"));
  expect(JSON.parse(String(signIn?.init?.body)).returnPath).toBe("/");
  act(() => root?.unmount());
  root = null;
  window.history.replaceState(null, "", "/");
  const signedIn = serveTeam({ signedIn: true });
  signedIn.team.knowledge.addVersion({
    noteId,
    topicId,
    title: "Returned note",
    body: "Still here",
    writer: { kind: "human", userId: signedIn.team.userId, name: "Reader" },
  });
  node = await render();
  await act(async () => {
    await vi.waitFor(
      () => {
        expect(window.location.pathname + window.location.search).toBe(
          "/teams/" + mockTeamId + path,
        );
        expect(node.querySelector(".kb-note")?.textContent).toContain("Still here");
      },
      { timeout: 2_000 },
    );
  });
});
