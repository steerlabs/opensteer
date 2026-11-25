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
   * so (`users.synthetic_at`) by the very insert that made it, never an Account a person already
   * has under that email. Nothing else signs in a marked Account (`auth.ts`).
   */
  readonly synthetic?: true;
}

/** The path of this sign-in, the only one that opens a session for a marked Account. */
export const appReviewSignInPath = "/sign-in/app-review";

/**
 * Password sign-in for a fixed few configured accounts only: App Review's, and the synthetic
 * purchase's own. Each signs in only as itself.
 */
export function appReviewSignIn(configs: AppReviewSignInConfig | readonly AppReviewSignInConfig[]) {
  const accounts = (Array.isArray(configs) ? configs : [configs]).map((config) => ({
    email: normalizeIdentityEmail(config.email),
    passwordDigest: createHash("sha256").update(config.password).digest(),
    synthetic: config.synthetic === true,
  }));
  return {
    id: "app-review",
    endpoints: {
      signInAppReview: createAuthEndpoint(
        appReviewSignInPath,
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
          return runWithTransaction(ctx.context.adapter, async () => {
            const adapter = ctx.context.internalAdapter;
            const existing = await adapter.findUserByEmail(email);
            // The synthetic purchase signs in only the Account it made, and App Review's never
            // one so marked: either other reads as a wrong password, so a person's computers are
            // never the synthetic purchase's to delete, nor its Account anyone else's.
            const marked = (existing?.user as { syntheticAt?: Date | null } | undefined)
              ?.syntheticAt;
            if (existing && synthetic !== (marked != null)) throw refuse();
            const user = existing
              ? existing.user.emailVerified
                ? existing.user
                : await adapter.updateUser(existing.user.id, { emailVerified: true })
              : await adapter.createUser(
                  {
                    email,
                    emailVerified: true,
                    name: synthetic ? "Synthetic purchase" : "App Review",
                    // Marked by the insert itself: no sign-in ever sees it unmarked.
                    ...(synthetic ? { syntheticAt: new Date() } : {}),
                  },
                  { method: "app-review" },
                );
            if (!user) throw new APIError("INTERNAL_SERVER_ERROR");
            const session = await adapter.createSession(user.id);
            if (!session) throw new APIError("INTERNAL_SERVER_ERROR");
            await setSessionCookie(ctx, { session, user });
            return ctx.json({
              redirect: true,
              url: ctx.body.callbackURL ?? new URL(ctx.context.baseURL).origin,
            });
          });
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}
