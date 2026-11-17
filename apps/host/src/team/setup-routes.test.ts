import { runInNewContext } from "node:vm";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { teamApiVersion, teamApiVersionHeader } from "@opensteer/deployment-authority";
import type { IdentityService } from "@opensteer/identity";
import type { TeamInvitesStore } from "@opensteer/database/team-invites";
import { registerTeamSetupRoutes } from "./setup-routes.js";

async function invitePage(authorize: string | null) {
  const app = Fastify();
  registerTeamSetupRoutes(app, {
    identity: {} as IdentityService,
    invites: {} as TeamInvitesStore,
    teamName: "Acme",
    accountPortalOrigin: "https://account.example",
  });
  let html: string;
  try {
    html = (await app.inject({ url: `/invite/${"s".repeat(32)}` })).body;
  } finally {
    await app.close();
  }
  const elements = new Map<
    string,
    { onclick?: () => Promise<void>; hidden: boolean; textContent: string }
  >();
  const element = (id: string) => {
    let found = elements.get(id);
    if (!found) {
      found = { hidden: true, textContent: "" };
      elements.set(id, found);
    }
    return found;
  };
  let admit!: () => void;
  const admitted = new Promise<void>((resolve) => {
    admit = resolve;
  });
  const fetch = vi.fn(async (path: string, _init: RequestInit) => {
    if (path.endsWith("/exchange")) await admitted;
    return new Response(
      JSON.stringify(
        path.endsWith("/auth.oidc.begin")
          ? { ok: true, data: { redirectUrl: "https://account.example/sign-in" } }
          : { teamName: "Acme", admitted: true },
      ),
    );
  });
  const location = {
    hash: `#${"v".repeat(43)}`,
    pathname: `/invite/${"s".repeat(32)}`,
    origin: "https://team.example",
    search: authorize === null ? "" : `?authorize=${encodeURIComponent(authorize)}`,
    assign: vi.fn(),
    replace: vi.fn(),
  };
  runInNewContext(html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/u)![1]!, {
    document: { getElementById: element, querySelectorAll: () => [] },
    location,
    history: { replaceState: vi.fn() },
    navigator: { userAgent: "Android" },
    URLSearchParams,
    fetch,
  });
  return { element, location, fetch, admit };
}

describe("team invitation browser admission", () => {
  it("admits before continuing the exact native authorization request", async () => {
    const query = "client_id=opensteer-mobile&state=opaque&code_challenge=pkce";
    const page = await invitePage(query);
    expect(page.fetch).toHaveBeenCalledOnce();
    expect(page.location.replace).not.toHaveBeenCalled();
    expect(JSON.parse(String(page.fetch.mock.calls[0]![1].body))).toEqual({
      selector: "s".repeat(32),
      verifier: "v".repeat(43),
    });
    expect(new Headers(page.fetch.mock.calls[0]![1].headers).get(teamApiVersionHeader)).toBe(
      String(teamApiVersion),
    );
    page.admit();
    await vi.waitFor(
      () =>
        expect(page.location.replace).toHaveBeenCalledWith(
          `/v1/auth/native/oauth2/authorize?${query}`,
        ),
      { timeout: 1000 },
    );
    expect(page.fetch).toHaveBeenCalledOnce();
  });

  it("admits before beginning normal web OIDC through the identity RPC", async () => {
    const page = await invitePage(null);
    const signingIn = page.element("sign-in").onclick!();
    expect(page.fetch.mock.calls.map(([path]) => path)).toEqual([
      "/v1/team/invites/preview",
      "/v1/team/invites/exchange",
    ]);
    expect(page.location.assign).not.toHaveBeenCalled();
    page.admit();
    await signingIn;
    expect(page.fetch.mock.calls.at(-1)?.[0]).toBe("/v1/rpc/auth.oidc.begin");
    expect(page.location.assign).toHaveBeenCalledWith("https://account.example/sign-in");
  });
});
