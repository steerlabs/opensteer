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
  window.history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, status });

/** The team server at this origin: the mock team behind its HTTP routes. */
function serveTeam(options: { readonly signedIn: boolean }) {
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
      if (url.pathname === "/v1/team/setup/sign-in")
        return json({ redirectUrl: "https://account.opensteer.example/authorize?state=1" });
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

describe("a team's own web app", () => {
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
    const signIn = requests.find(({ path }) => path === "/v1/team/setup/sign-in");
    expect(signIn?.init?.method).toBe("POST");
    expect(new Headers(signIn?.init?.headers).get(teamApiVersionHeader)).toBe(
      String(teamApiVersion),
    );
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

  it("keeps a note's draft when someone else saved first, and saves it on top of theirs", async () => {
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
        writer: { kind: "human", userId: leo.userId, name: leo.displayName },
      });
    write("Ask Maya.");
    window.history.replaceState(
      null,
      "",
      `/teams/${mockTeamId}/knowledge/${topicId}/${noteId}/edit`,
    );
    const node = await render();
    const body = await act(async () =>
      vi.waitFor(() => node.querySelector<HTMLTextAreaElement>("textarea[aria-label='Note']")!, {
        timeout: 2_000,
      }),
    );
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        body,
        "Ask Maya. Over $500 needs two.",
      );
      body.dispatchEvent(new Event("input", { bubbles: true }));
    });
    write("Ask Maya or Dana.");

    await act(async () => button(node, "Save")?.click());
    await act(async () => {
      await vi.waitFor(
        () =>
          expect(node.textContent).toContain(
            "Leo Park changed this note while you were editing it.",
          ),
        { timeout: 2_000 },
      );
    });
    expect(body.value).toBe("Ask Maya. Over $500 needs two.");

    await act(async () => button(node, "Save")?.click());
    await act(async () => {
      await vi.waitFor(
        () => expect(window.location.pathname).toMatch(new RegExp(`/${noteId}$`, "u")),
        { timeout: 2_000 },
      );
    });
    expect(team.knowledge.notes.get(noteId)?.versions.at(-1)).toMatchObject({
      version: 3,
      body: "Ask Maya. Over $500 needs two.",
      writer: { kind: "human", userId: team.userId },
    });
  });
});
