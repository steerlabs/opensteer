import { OpensteerError } from "@opensteer/core";
import type { IntegrationRepositoryAccess } from "@opensteer/integration-core";
import { readBoundedJson } from "@opensteer/shared/boundedJson";
import { z } from "zod";

const installationSchema = z.object({
  id: z.number().int().positive().safe(),
  account: z.object({ login: z.string().min(1).max(256) }),
  repository_selection: z.enum(["all", "selected"]),
  html_url: z
    .url()
    .refine((value) =>
      /^https:\/\/github\.com\/(?:organizations\/[A-Za-z0-9-]+\/)?settings\/installations\/[0-9]+$/u.test(
        value,
      ),
    ),
  suspended_at: z.string().nullable(),
});
const installationsSchema = z.object({
  total_count: z.number().int().nonnegative(),
  installations: z.array(installationSchema).max(100),
});
const repositoriesSchema = z.object({ total_count: z.number().int().nonnegative() });

/** GitHub answered 401: it no longer accepts the token itself. */
class GitHubTokenRejected extends Error {}

/**
 * The repositories this token reaches, or "credential-rejected" when GitHub
 * refuses the token itself. Any other failure throws, and proves nothing about
 * the account. GitHub's user-token endpoint already restricts results to this
 * exact app and user.
 */
export async function inspectGitHubRepositoryAccess(input: {
  readonly accessToken: string;
  readonly fetch: typeof globalThis.fetch;
  readonly installationUrl: string | null;
}): Promise<IntegrationRepositoryAccess | "credential-rejected"> {
  try {
    return await inspect(input);
  } catch (error) {
    if (error instanceof GitHubTokenRejected) return "credential-rejected";
    throw error;
  }
}

async function inspect(input: {
  readonly accessToken: string;
  readonly fetch: typeof globalThis.fetch;
  readonly installationUrl: string | null;
}): Promise<IntegrationRepositoryAccess> {
  const signal = AbortSignal.timeout(30_000);
  const get = async (path: string) => {
    const response = await input.fetch(`https://api.github.com${path}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${input.accessToken}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      redirect: "error",
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401) throw new GitHubTokenRejected();
      throw new OpensteerError({
        code: response.status === 403 ? "forbidden" : "internal",
        message:
          response.status === 403
            ? "GitHub refused repository access. Check organization approval, SSO, and API limits, then retry."
            : "GitHub repository access could not be checked. Retry in a moment.",
      });
    }
    return readBoundedJson(response, { maximumBytes: 2_000_000, signal });
  };
  const installations: IntegrationRepositoryAccess["installations"] = [];
  const seen = new Set<number>();
  for (let page = 1; page <= 10; page++) {
    const result = installationsSchema.parse(
      await get(`/user/installations?per_page=100&page=${page}`),
    );
    const rows = await Promise.all(
      result.installations.map(async (installation) => {
        if (seen.has(installation.id))
          throw new Error("GitHub installation list changed; retry the check.");
        seen.add(installation.id);
        const suspended = installation.suspended_at !== null;
        const count = suspended
          ? 0
          : repositoriesSchema.parse(
              await get(`/user/installations/${installation.id}/repositories?per_page=1`),
            ).total_count;
        return {
          id: String(installation.id),
          accountLogin: installation.account.login,
          repositorySelection: installation.repository_selection,
          repositoryCount: count,
          configureUrl: installation.html_url,
          suspended,
        };
      }),
    );
    installations.push(...rows);
    if (installations.length >= result.total_count) {
      return {
        installationUrl: input.installationUrl,
        installations,
        ready: installations.some((row) => row.repositoryCount > 0 && !row.suspended),
      };
    }
    if (result.installations.length === 0) break;
  }
  throw new OpensteerError({
    code: "internal",
    message: "GitHub returned an incomplete installation list. Retry the check.",
  });
}
