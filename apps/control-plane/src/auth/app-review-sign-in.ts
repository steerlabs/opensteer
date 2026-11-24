import { runWithTransaction } from "@better-auth/core/context";
import { normalizeIdentityEmail } from "@opensteer/core";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, formCsrfMiddleware } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export interface AppReviewSignInConfig {
  readonly email: string;
  readonly password: string;
  /**
   * The synthetic purchase's own Account: it signs in only an Account it created itself, marked
   * so (`users.synthetic_at`), never an Account a person already has under that email.
   */
  readonly synthetic?: true;
}

/** Reads and sets the synthetic mark on an Account, in the account service's own database. */
export interface SyntheticAccountMarks {
  isSynthetic(userId: string): Promise<boolean>;
  markSynthetic(userId: string): Promise<void>;
}

/**
 * Password sign-in for a fixed few configured accounts only: App Review's, and the synthetic
 * purchase's own. Each signs in only as itself.
 */
export function appReviewSignIn(
  configs: AppReviewSignInConfig | readonly AppReviewSignInConfig[],
  marks?: SyntheticAccountMarks,
) {
  const accounts = (Array.isArray(configs) ? configs : [configs]).map((config) => ({
    email: normalizeIdentityEmail(config.email),
    passwordDigest: createHash("sha256").update(config.password).digest(),
    synthetic: config.synthetic === true,
  }));
  if (accounts.some((account) => account.synthetic) && !marks)
    throw new Error("The synthetic purchase's sign-in needs the Account marks");
  return {
    id: "app-review",
    endpoints: {
      signInAppReview: createAuthEndpoint(
        "/sign-in/app-review",
        {
          method: "POST",
          use: [formCsrfMiddleware],
          body: z.object({
            email: z.string().max(320),
            password: z.string().max(4_096),
            callbackURL: z.url().optional(),
            oauth_query: z.string().optional(),
          }),
        },
        async (ctx) => {
          if (ctx.headers?.get("origin") !== new URL(ctx.context.baseURL).origin) {
            throw new APIError("FORBIDDEN", { message: "Request origin is not allowed" });
          }
          const given = createHash("sha256").update(ctx.body.password).digest();
          const named = ctx.body.email.normalize("NFKC").trim().toLowerCase();
          // Every account's password is compared, so the time taken names none of them.
          const matched = accounts.filter(
            (account) => timingSafeEqual(account.passwordDigest, given) && account.email === named,
          );
          const email = matched[0]?.email;
          const refuse = () => {
            ctx.context.logger.warn("App Review sign-in refused: invalid credentials");
            return new APIError("UNAUTHORIZED", { message: "Email or password is incorrect" });
          };
          if (!email) throw refuse();
          const synthetic = matched[0]!.synthetic;
          let created: string | undefined;
          const answer = await runWithTransaction(ctx.context.adapter, async () => {
            const adapter = ctx.context.internalAdapter;
            const existing = await adapter.findUserByEmail(email);
            // The synthetic purchase signs in only the Account it made: one a person already had
            // under this email reads as a wrong password, so its computers are never touched.
            if (synthetic && existing && !(await marks!.isSynthetic(existing.user.id)))
              throw refuse();
            const user = existing
              ? existing.user.emailVerified
                ? existing.user
                : await adapter.updateUser(existing.user.id, { emailVerified: true })
              : await adapter.createUser(
                  {
                    email,
                    emailVerified: true,
                    name: synthetic ? "Synthetic purchase" : "App Review",
                  },
                  { method: "app-review" },
                );
            if (!user) throw new APIError("INTERNAL_SERVER_ERROR");
            if (synthetic && !existing) created = user.id;
            const session = await adapter.createSession(user.id);
            if (!session) throw new APIError("INTERNAL_SERVER_ERROR");
            await setSessionCookie(ctx, { session, user });
            return ctx.json({
              redirect: true,
              url: ctx.body.callbackURL ?? new URL(ctx.context.baseURL).origin,
            });
          });
          // Marked once its Account exists for everyone: should this fail, the next sign-in
          // finds an unmarked Account and is refused, never the other way round.
          if (created) await marks!.markSynthetic(created);
          return answer;
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}
