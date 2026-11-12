import { randomBytes } from "node:crypto";
import { ControlPlaneAccountIdSchema } from "@opensteer/control-plane-protocol";
import {
  HostedTeamIdSchema,
  HostedTeamSlugSchema,
  hostedTeamsDomain,
  maximumLiveHostedTeamsPerAccount,
} from "@opensteer/control-plane-protocol/hosted-teams";
import type { BrowserPageFonts } from "@opensteer/shared/browserPage";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { parseForm, requireExactOrigin } from "../portal/browser-http.js";
import {
  browserPagePolicyWithScript,
  createHostedTeamBody,
  hostedTeamRow,
  hostedTeamStartingBody,
  hostedTeamsUnavailableBody,
  sendBrowserPage,
} from "../portal/pages.js";
import type { PortalSession } from "../portal/portal-sessions.js";
import { ControlPlaneError } from "../server/errors.js";
import type { HostedTeamStore, HostedTeamView, IssuedSetupLink } from "./hosted-team-store.js";

export const portalCreateHostedTeamPath = "/teams/new";
const portalHostedTeamsPath = "/teams";
const hostedTeamPath = (id: string) => `/teams/${encodeURIComponent(id)}`;

const TeamParamsSchema = z.strictObject({ id: HostedTeamIdSchema });
const CreateFormSchema = z.strictObject({ slug: z.string().max(256) });

/**
 * The portal's hosted-team pages: create one, wait for it to start, get a new first-owner
 * setup link, and delete it. Without a provisioner configured, only the explanation remains.
 */
export function registerHostedTeamPortal(
  app: FastifyInstance,
  options: {
    readonly fonts: BrowserPageFonts | undefined;
    readonly guard: (request: FastifyRequest) => void;
    readonly hostedTeams: HostedTeamStore | undefined;
    readonly portalOrigin: URL;
    readonly readSession: (
      request: FastifyRequest,
      reply: FastifyReply,
    ) => Promise<PortalSession | undefined>;
    readonly signInPath: string;
  },
): void {
  const { fonts, guard, hostedTeams, portalOrigin, readSession } = options;

  app.get(portalCreateHostedTeamPath, async (request, reply) => {
    guard(request);
    void reply.header("cache-control", "no-store");
    if (!hostedTeams) return unavailable(reply);
    const session = await readSession(request, reply);
    if (!session) return signIn(reply, portalCreateHostedTeamPath);
    const live = await hostedTeams.listForAccount(accountOf(session));
    return renderCreate(reply, {
      failure: null,
      limitReached: live.length >= maximumLiveHostedTeamsPerAccount,
      slug: "",
    });
  });

  app.post(portalHostedTeamsPath, async (request, reply) => {
    guard(request);
    void reply.header("cache-control", "no-store");
    requireExactOrigin(request, portalOrigin.origin);
    if (!hostedTeams) return unavailable(reply);
    const session = await readSession(request, reply);
    if (!session) return signIn(reply, portalCreateHostedTeamPath);
    const form = CreateFormSchema.parse(parseForm(request.body));
    const typed = form.slug.trim().toLowerCase();
    const slug = HostedTeamSlugSchema.safeParse(typed);
    if (!slug.success) {
      return renderCreate(reply.code(400), {
        failure: slug.error.issues[0]?.message ?? "That address can’t be used.",
        limitReached: false,
        slug: typed,
      });
    }
    let issued: IssuedSetupLink;
    try {
      issued = await hostedTeams.create(accountOf(session), slug.data);
    } catch (error) {
      if (!(error instanceof ControlPlaneError) || error.code !== "conflict") throw error;
      return renderCreate(reply.code(409), {
        failure: error.message,
        limitReached: false,
        slug: typed,
      });
    }
    return renderStarting(reply, issued);
  });

  app.get(`${portalHostedTeamsPath}/:id/status`, async (request, reply) => {
    guard(request);
    void reply.header("cache-control", "no-store");
    if (!hostedTeams) throw new ControlPlaneError("not_found", "Route was not found");
    const session = await readSession(request, reply);
    if (!session) throw new ControlPlaneError("unauthorized", "Account sign-in required");
    const { id } = TeamParamsSchema.parse(request.params);
    const team = await hostedTeams.forAccount(accountOf(session), id);
    if (!team) throw new ControlPlaneError("not_found", "Hosted team was not found");
    return { phase: team.phase, ready: team.ready, state: team.state };
  });

  app.post(`${portalHostedTeamsPath}/:id/setup-link`, async (request, reply) => {
    guard(request);
    void reply.header("cache-control", "no-store");
    requireExactOrigin(request, portalOrigin.origin);
    if (!hostedTeams) return unavailable(reply);
    const session = await readSession(request, reply);
    if (!session) return signIn(reply, "/");
    const { id } = TeamParamsSchema.parse(request.params);
    const issued = await hostedTeams.newSetupLink(accountOf(session), id);
    if ("setupComplete" in issued) return reply.redirect(`${issued.origin}/`, 303);
    return renderStarting(reply, issued);
  });

  app.post(`${portalHostedTeamsPath}/:id/delete`, async (request, reply) => {
    guard(request);
    void reply.header("cache-control", "no-store");
    requireExactOrigin(request, portalOrigin.origin);
    if (!hostedTeams) return unavailable(reply);
    const session = await readSession(request, reply);
    if (!session) return signIn(reply, "/");
    const { id } = TeamParamsSchema.parse(request.params);
    await hostedTeams.deleteForAccount(accountOf(session), id);
    return reply.redirect("/", 303);
  });

  function renderCreate(
    reply: FastifyReply,
    input: {
      readonly failure: string | null;
      readonly limitReached: boolean;
      readonly slug: string;
    },
  ): string {
    return sendBrowserPage(reply, {
      body: createHostedTeamBody({
        action: portalHostedTeamsPath,
        domain: hostedTeamsDomain,
        limit: maximumLiveHostedTeamsPerAccount,
        ...input,
      }),
      fonts,
      layout: "card",
      title: "Create a team · Opensteer",
    });
  }

  function renderStarting(reply: FastifyReply, issued: IssuedSetupLink): string {
    const nonce = randomBytes(18).toString("base64url");
    const host = new URL(issued.team.origin).host;
    void reply.header("referrer-policy", "no-referrer");
    return sendBrowserPage(reply, {
      body: hostedTeamStartingBody({
        host,
        nonce,
        setupUrl: `${issued.team.origin}/setup#${issued.setupToken}`,
        statusPath: `${hostedTeamPath(issued.team.id)}/status`,
      }),
      fonts,
      layout: "card",
      policy: browserPagePolicyWithScript(nonce, ["connect-src 'self'"]),
      title: `Starting ${host} · Opensteer`,
    });
  }

  function unavailable(reply: FastifyReply): string {
    return sendBrowserPage(reply.code(404), {
      body: hostedTeamsUnavailableBody(),
      fonts,
      layout: "plain",
      title: "Hosted teams · Opensteer",
    });
  }

  function signIn(reply: FastifyReply, returnPath: string): FastifyReply {
    return reply.redirect(
      `${options.signInPath}?${new URLSearchParams({ return: returnPath })}`,
      303,
    );
  }
}

export function hostedTeamRows(teams: readonly HostedTeamView[]): readonly string[] {
  return teams.map((team) =>
    hostedTeamRow({
      claimed: team.claimed,
      deleteAction: `${hostedTeamPath(team.id)}/delete`,
      host: new URL(team.origin).host,
      id: team.id,
      origin: team.origin,
      phase: team.phase,
      setupLinkAction: team.state === "active" ? `${hostedTeamPath(team.id)}/setup-link` : null,
      state: team.state,
    }),
  );
}

function accountOf(session: PortalSession) {
  return ControlPlaneAccountIdSchema.parse(session.accountId);
}
