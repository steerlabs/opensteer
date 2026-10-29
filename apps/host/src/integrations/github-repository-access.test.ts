import { describe, expect, it, vi } from "vitest";
import { inspectGitHubRepositoryAccess } from "./github-repository-access.js";

const installation = (id: number, suspended = false) => ({
  id,
  account: { login: `org-${id}` },
  repository_selection: "selected",
  html_url: `https://github.com/organizations/org-${id}/settings/installations/${id}`,
  suspended_at: suspended ? "2026-09-18T00:00:00Z" : null,
});

describe("GitHub repository access inspection", () => {
  it("does not mistake user authorization or an empty installation for repository access", async () => {
    for (const installations of [[], [installation(1)]]) {
      const fetch = vi.fn<typeof globalThis.fetch>(async (url) =>
        Response.json(
          String(url).includes("/repositories?")
            ? { total_count: 0 }
            : { total_count: installations.length, installations },
        ),
      );
      expect(
        await inspectGitHubRepositoryAccess({ accessToken: "token", fetch, installationUrl: null }),
      ).toMatchObject({ ready: false });
    }
  });

  it("counts only the selected app/user repositories, skips suspended installs, and uses fixed API URLs", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, options) => {
      expect(options?.redirect).toBe("error");
      expect(new Headers(options?.headers).get("authorization")).toBe("Bearer token");
      return Response.json(
        String(url).includes("/repositories?")
          ? { total_count: 4 }
          : { total_count: 2, installations: [installation(1), installation(2, true)] },
      );
    });
    const result = await inspectGitHubRepositoryAccess({
      accessToken: "token",
      fetch,
      installationUrl: "https://github.com/apps/example/installations/new",
    });
    expect(result).toMatchObject({
      ready: true,
      installations: [{ repositoryCount: 4 }, { repositoryCount: 0 }],
    });
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.github.com/user/installations?per_page=100&page=1",
      "https://api.github.com/user/installations/1/repositories?per_page=1",
    ]);
  });

  it("continues installation pagination without trusting response links", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) => {
      if (String(url).includes("/repositories?")) return Response.json({ total_count: 1 });
      const second = String(url).endsWith("page=2");
      return Response.json({ total_count: 2, installations: [installation(second ? 2 : 1)] });
    });
    const result = await inspectGitHubRepositoryAccess({
      accessToken: "token",
      fetch,
      installationUrl: null,
    });
    expect(result).toMatchObject({ installations: [{ id: "1" }, { id: "2" }] });
  });

  // A 401 is GitHub refusing the token itself; the readiness check records it.
  it.each([403, 429, 503])("does not turn HTTP %i into successful empty access", async (status) => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response("provider detail", { status }),
    );
    await expect(
      inspectGitHubRepositoryAccess({ accessToken: "token", fetch, installationUrl: null }),
    ).rejects.toThrow(/GitHub/);
  });

  it("refuses unsafe configuration URLs and inconsistent pagination", async () => {
    const unsafe = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({
        total_count: 1,
        installations: [{ ...installation(1), html_url: "https://attacker.test" }],
      }),
    );
    await expect(
      inspectGitHubRepositoryAccess({ accessToken: "token", fetch: unsafe, installationUrl: null }),
    ).rejects.toThrow();
    const incomplete = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ total_count: 2, installations: [] }),
    );
    await expect(
      inspectGitHubRepositoryAccess({
        accessToken: "token",
        fetch: incomplete,
        installationUrl: null,
      }),
    ).rejects.toThrow(/incomplete/);
  });
});
