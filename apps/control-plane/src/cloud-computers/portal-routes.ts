import { randomUUID } from "node:crypto";
import {
  CloudComputerIdSchema,
  ControlPlaneAccountIdSchema,
  cloudWords,
  type CloudComputerView,
  type ControlPlaneAccountId,
} from "@opensteer/control-plane-protocol";
import type { DeploymentId } from "@opensteer/core";
import type { BrowserPageFonts } from "@opensteer/shared/browserPage";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { parseForm, requireExactOrigin } from "../portal/browser-http.js";
import { sendBrowserPage } from "../portal/pages.js";
import type { PortalSession } from "../portal/portal-sessions.js";
import { ControlPlaneError } from "../server/errors.js";
import {
  cloudComputerActionPortalPath,
  cloudComputerBillingPortalPath,
  cloudComputerCheckoutBody,
  cloudComputerCheckoutPortalPath,
  cloudComputerLandingBody,
  cloudComputerPortalPath,
  cloudComputerRefusal,
  cloudComputerUnavailableBody,
  type CloudComputerLanding,
  type CloudComputerRefusal,
  type WorkHomeCard,
} from "./portal-pages.js";
import type { OrganizationStore } from "../organizations/store.js";
import type { CloudComputerStore } from "./store.js";

/** How often a page still being set up asks the browser to load it again, in seconds. */
export const cloudComputerPreparingRefreshSeconds = 5;
const titles = cloudWords("cloud.web.title");
const CheckoutFormSchema = z.strictObject({ requestId: z.string().max(64) });
const ActionFormSchema = z.strictObject({ id: z.string().max(64) });
const DeleteFormSchema = z.strictObject({ id: z.string().max(64), confirm: z.string().max(64) });
const notices = { "no-billing": "cloud.web.noBilling" } as const;
const NoticeQuerySchema = z.object({ notice: z.enum(["no-billing"]).optional() }).loose();

/**
 * The Opensteer website's Cloud Computer pages, over the same store as the Account API.
 * Checkout and billing are taken only from this signed-in website session, never from an
 * app's token, so the apps open these pages in a browser. What a page shows is always
 * read from the store; nothing a URL carries decides it.
 */
export function registerCloudComputerPortal(
  app: FastifyInstance,
  options: {
    readonly cloudComputers: CloudComputerStore | undefined;
    /** Present when this Account offers organizations, so a person's work Homes show too. */
    readonly organizations?: OrganizationStore | undefined;
    /** Where this person opens a Home, found by its pinned deployment; null when unknown. */
    readonly openHome?: (
      account: ControlPlaneAccountId,
      deploymentId: DeploymentId,
    ) => Promise<string | null>;
    readonly fonts: BrowserPageFonts | undefined;
    readonly guard: (request: FastifyRequest) => void;
    readonly portalOrigin: URL;
    readonly readSession: (
      request: FastifyRequest,
      reply: FastifyReply,
    ) => Promise<PortalSession | undefined>;
    readonly signInPath: string;
  },
): void {
  const { cloudComputers, fonts, guard, portalOrigin, readSession } = options;

  app.get(cloudComputerPortalPath, async (request, reply) => {
    guard(request);
    void reply.header("cache-control", "no-store");
    if (!cloudComputers) return unavailable(reply);
    const session = await readSession(request, reply);
    const { notice } = NoticeQuerySchema.parse(request.query ?? {});
    return renderLanding(reply, cloudComputers, session, {
      refusal: null,
      notice: notice ? cloudWords(notices[notice]) : null,
    });
  });

  app.get(cloudComputerCheckoutPortalPath, async (request, reply) => {
    guard(request);
    void reply.header("cache-control", "no-store");
    if (!cloudComputers) return unavailable(reply);
    const session = await readSession(request, reply);
    if (!session) return signIn(reply, cloudComputerCheckoutPortalPath);
    const current = currentComputer(await cloudComputers.list(accountOf(session)));
    // Nothing to buy while one is set up or running: its own page says where it stands.
    if (current) return reply.redirect(cloudComputerPortalPath, 303);
    return renderCheckout(reply, cloudComputers, null);
  });

  app.post(cloudComputerCheckoutPortalPath, async (request, reply) => {
    guard(request);
    void reply.header("cache-control", "no-store");
    requireExactOrigin(request, portalOrigin.origin);
    if (!cloudComputers) return unavailable(reply);
    const session = await readSession(request, reply);
    if (!session) return signIn(reply, cloudComputerCheckoutPortalPath);
    const { requestId } = CheckoutFormSchema.parse(parseForm(request.body));
    if (!z.uuid().safeParse(requestId).success)
      return renderCheckout(
        reply.code(400),
        cloudComputers,
        cloudComputerRefusal("bad_request", "This checkout link is incomplete. Start again."),
      );
    try {
      const { url } = await cloudComputers.checkout(accountOf(session), requestId);
      return reply.redirect(url, 303);
    } catch (error) {
      const refusal = refused(error);
      if (!refusal) throw error;
      return renderCheckout(reply.code(refusal.status), cloudComputers, refusal.refusal);
    }
  });

  app.get(cloudComputerBillingPortalPath, async (request, reply) => {
    guard(request);
    void reply.header("cache-control", "no-store");
    if (!cloudComputers) return unavailable(reply);
    const session = await readSession(request, reply);
    if (!session) return signIn(reply, cloudComputerBillingPortalPath);
    try {
      const { url } = await cloudComputers.billingPortal(accountOf(session));
      return reply.redirect(url, 303);
    } catch (error) {
      if (!(error instanceof ControlPlaneError) || error.code !== "not_found") throw error;
      return reply.redirect(`${cloudComputerPortalPath}?notice=no-billing`, 303);
    }
  });

  for (const action of ["suspend", "resume", "delete"] as const) {
    app.post(cloudComputerActionPortalPath(action), async (request, reply) => {
      guard(request);
      void reply.header("cache-control", "no-store");
      requireExactOrigin(request, portalOrigin.origin);
      if (!cloudComputers) return unavailable(reply);
      const session = await readSession(request, reply);
      if (!session) return signIn(reply, cloudComputerPortalPath);
      const form = parseForm(request.body);
      const parsed =
        action === "delete"
          ? DeleteFormSchema.parse(form)
          : { ...ActionFormSchema.parse(form), confirm: undefined };
      const id = CloudComputerIdSchema.safeParse(parsed.id);
      if (!id.success) throw new ControlPlaneError("bad_request", "Cloud Computer is invalid");
      if (
        action === "delete" &&
        parsed.confirm?.trim().toLowerCase() !== cloudWords("cloud.delete.word")
      )
        return renderLanding(reply.code(400), cloudComputers, session, {
          refusal: {
            sentence: cloudWords("cloud.web.typeWord"),
            next: cloudWords("cloud.delete.body"),
          },
          notice: null,
        });
      try {
        await cloudComputers.mutate(id.data, action, accountOf(session));
      } catch (error) {
        const refusal = refused(error);
        if (!refusal) throw error;
        return renderLanding(reply.code(refusal.status), cloudComputers, session, {
          refusal: refusal.refusal,
          notice: null,
        });
      }
      return reply.redirect(cloudComputerPortalPath, 303);
    });
  }

  async function renderLanding(
    reply: FastifyReply,
    store: CloudComputerStore,
    session: PortalSession | undefined,
    input: { readonly refusal: CloudComputerRefusal | null; readonly notice: string | null },
  ): Promise<string> {
    let state: CloudComputerLanding;
    if (!session) {
      state = {
        kind: "signed-out",
        plan: store.plan,
        signInHref: signInHref(cloudComputerPortalPath),
      };
    } else {
      const account = accountOf(session);
      const [computers, work] = await Promise.all([store.list(account), workHomes(store, account)]);
      const current = currentComputer(computers);
      state = current
        ? {
            kind: "computer",
            plan: store.plan,
            computer: current,
            openHref: await open(account, current),
            work,
          }
        : {
            kind: "offer",
            plan: store.plan,
            deleted: computers[0]?.status === "deleted",
            work,
          };
    }
    // A plain timed reload follows setup without a script.
    if (
      (state.kind === "computer" && state.computer.status === "preparing") ||
      (state.kind !== "signed-out" &&
        state.work.some(({ assignment }) => assignment.homeStatus === "preparing"))
    )
      void reply.header("refresh", String(cloudComputerPreparingRefreshSeconds));
    return sendBrowserPage(reply, {
      body: `${cloudComputerStyles}${cloudComputerLandingBody({ state, ...input })}`,
      fonts,
      layout: "card",
      title: titles,
    });
  }

  /** The person's work Homes, each with the Account's own view of its computer. */
  async function workHomes(
    store: CloudComputerStore,
    account: ControlPlaneAccountId,
  ): Promise<readonly WorkHomeCard[]> {
    const organizations = options.organizations;
    if (!organizations) return [];
    const mine = await organizations.mine(account);
    const homes = await Promise.all(
      mine.organizations.map(({ id }) => organizations.memberHome(id, account)),
    );
    return Promise.all(
      homes
        .flatMap((home) => (home ? [home] : []))
        .map(async ({ assignment, policy }) => {
          const computer = await store
            .show(assignment.computerId, account)
            .catch((error: unknown) => {
              if (error instanceof ControlPlaneError && error.code === "not_found") return null;
              throw error;
            });
          return {
            assignment,
            policy,
            computer,
            openHref:
              computer && !assignment.signInCut && assignment.homeStatus === "ready"
                ? await open(account, computer)
                : null,
          };
        }),
    );
  }

  async function open(account: ControlPlaneAccountId, computer: CloudComputerView) {
    if (computer.status !== "ready" || !computer.deploymentId || !options.openHome) return null;
    return options.openHome(account, computer.deploymentId);
  }

  function renderCheckout(
    reply: FastifyReply,
    store: CloudComputerStore,
    refusal: CloudComputerRefusal | null,
  ): string {
    return sendBrowserPage(reply, {
      body: `${cloudComputerStyles}${cloudComputerCheckoutBody({
        plan: store.plan,
        requestId: randomUUID(),
        refusal,
      })}`,
      fonts,
      layout: "card",
      title: titles,
    });
  }

  function unavailable(reply: FastifyReply): string {
    return sendBrowserPage(reply.code(404), {
      body: cloudComputerUnavailableBody(),
      fonts,
      layout: "plain",
      title: titles,
    });
  }

  function signInHref(returnPath: string): string {
    return `${options.signInPath}?${new URLSearchParams({ return: returnPath })}`;
  }

  function signIn(reply: FastifyReply, returnPath: string): FastifyReply {
    return reply.redirect(signInHref(returnPath), 303);
  }
}

/** The person's one Cloud Computer: the newest that isn't deleted. */
function currentComputer(
  computers: readonly CloudComputerView[],
): Exclude<CloudComputerView, { status: "deleted" }> | null {
  return (
    computers.find(
      (computer): computer is Exclude<CloudComputerView, { status: "deleted" }> =>
        computer.status !== "deleted",
    ) ?? null
  );
}

/** A refusal the store wrote for people, with what to do next; anything else is thrown on. */
function refused(
  error: unknown,
): { readonly status: number; readonly refusal: CloudComputerRefusal } | null {
  if (!(error instanceof ControlPlaneError)) return null;
  if (!["conflict", "unavailable", "forbidden", "bad_request"].includes(error.code)) return null;
  return {
    status: error.status,
    refusal: cloudComputerRefusal(error.code, error.message, error.reason),
  };
}

function accountOf(session: PortalSession): ControlPlaneAccountId {
  return ControlPlaneAccountIdSchema.parse(session.accountId);
}

/**
 * The few rules these pages add to the portal's stylesheet: confirmations that open in
 * place, and the danger summary. Inline styles are what the portal's policy allows.
 */
const cloudComputerStyles = `<style>
.cloud-computer .places{margin:0}
.cloud-computer__price strong{color:var(--text);font-weight:600}
.cloud-computer__ready{display:flex;gap:8px;align-items:flex-start;color:var(--text)}
.cloud-computer__ready .icon{flex:none;color:var(--green)}
.cloud-computer__power,.cloud-computer__confirm{display:grid;gap:10px}
.cloud-computer__confirm>summary{list-style:none;cursor:pointer}
.cloud-computer__confirm>summary::-webkit-details-marker{display:none}
.cloud-computer__confirm[open]>summary{opacity:.6}
.cloud-computer__danger{color:var(--red)}
.step[data-state="failed"]{color:color-mix(in srgb,var(--amber) 70%,var(--text))}
.step[data-state="failed"]::before{background:var(--amber)}
.cloud-computer__work{display:grid;grid-template-columns:minmax(0,1fr);gap:12px;padding-top:18px;border-top:1px solid var(--rim-plate)}
.cloud-computer__work-title{display:grid;gap:8px;justify-items:start;margin:0;color:var(--text);font-family:var(--font-display);font-size:20px;font-weight:500}
.cloud-computer__badge{padding:3px 9px;border:1px solid var(--rim-accent);border-radius:999px;color:var(--text-soft);font-family:var(--font-sans);font-size:11.5px;font-weight:600}
.cloud-computer__list-title{margin:0;color:var(--text);font-size:13px;font-weight:600}
.cloud-computer__list{display:grid;gap:6px;margin:0;padding:0;list-style:none;color:var(--muted);font-size:13px;line-height:1.45}
.cloud-computer__list li{position:relative;padding-left:18px}
.cloud-computer__list li::before{position:absolute;left:0}
.cloud-computer__list--sees li::before{content:"·";color:var(--text)}
.cloud-computer__list--never li::before{content:"✕";color:var(--red)}
</style>`;
