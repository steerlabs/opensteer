import { randomBytes, randomUUID } from "node:crypto";
import { ControlPlaneAccountIdSchema } from "@opensteer/control-plane-protocol";
import {
  CreateHostedTeamRequestSchema,
  HostedTeamAvailabilityQuerySchema,
  HostedTeamIdSchema,
  hostedTeamsDomain,
  maximumLiveHostedTeamsPerAccount,
  type HostedTeamView,
} from "@opensteer/control-plane-protocol/hosted-teams";
import type { BrowserPageFonts } from "@opensteer/shared/browserPage";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { parseForm, requireExactOrigin } from "../portal/browser-http.js";
import {
  browserPagePolicyWithScript,
  createHostedTeamBody,
  hostedTeamProgressBody,
  hostedTeamRow,
  hostedTeamsUnavailableBody,
  sendBrowserPage,
} from "../portal/pages.js";
import type { PortalSession } from "../portal/portal-sessions.js";
import { ControlPlaneError } from "../server/errors.js";
import type { HostedTeamStore } from "./hosted-team-store.js";

export const portalCreateHostedTeamPath = "/teams/new";
const portalHostedTeamsPath = "/teams";
const portalAvailabilityPath = "/teams/availability";
const hostedTeamPath = (id: string) => `/teams/${encodeURIComponent(id)}`;

const TeamParamsSchema = z.strictObject({ id: HostedTeamIdSchema });
const CreateFormSchema = z.strictObject({
  requestId: z.string().max(64),
  name: z.string().max(256),
  slug: z.string().max(256),
});

/**
 * The portal's hosted-team pages, over the same store as the Account API: create a team, follow
 * its setup into the team, retry or cancel it, and delete it. Without a provisioner configured,
 * only the explanation remains.
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
    const live = await hostedTeams.listCreatedBy(accountOf(session));
    const created = live.filter((team) => team.stage !== "deleting").length;
    return renderCreate(reply, {
      failure: null,
      limitReached: created >= maximumLiveHostedTeamsPerAccount,
      name: "",
      slug: "",
    });
  });

  app.get(portalAvailabilityPath, async (request, reply) => {
    guard(request);
    void reply.header("cache-control", "no-store");
    if (!hostedTeams) throw new ControlPlaneError("not_found", "Route was not found");
    const session = await readSession(request, reply);
    if (!session) throw new ControlPlaneError("unauthorized", "Account sign-in required");
    const { slug } = HostedTeamAvailabilityQuerySchema.parse(request.query);
    return hostedTeams.availability(slug);
  });

  app.post(portalHostedTeamsPath, async (request, reply) => {
    guard(request);
    void reply.header("cache-control", "no-store");
    requireExactOrigin(request, portalOrigin.origin);
    if (!hostedTeams) return unavailable(reply);
    const session = await readSession(request, reply);
    if (!session) return signIn(reply, portalCreateHostedTeamPath);
    const form = CreateFormSchema.parse(parseForm(request.body));
    const typed = { name: form.name.trim(), slug: form.slug.trim().toLowerCase() };
    const input = CreateHostedTeamRequestSchema.safeParse({ requestId: form.requestId, ...typed });
    if (!input.success) {
      return renderCreate(reply.code(400), {
        failure: input.error.issues[0]?.message ?? "That address can’t be used.",
        limitReached: false,
        ...typed,
      });
    }
    let team: HostedTeamView;
    try {
      team = await hostedTeams.create(accountOf(session), input.data);
    } catch (error) {
      if (!(error instanceof ControlPlaneError) || error.code !== "conflict") throw error;
      return renderCreate(reply.code(409), {
        failure: error.message,
        limitReached: error.reason === "hosted-team-limit-reached",
        ...typed,
      });
    }
    return reply.redirect(hostedTeamPath(team.id), 303);
  });

  app.get(`${portalHostedTeamsPath}/:id`, async (request, reply) => {
    guard(request);
    void reply.header("cache-control", "no-store");
    if (!hostedTeams) return unavailable(reply);
    const session = await readSession(request, reply);
    const { id } = TeamParamsSchema.parse(request.params);
    if (!session) return signIn(reply, hostedTeamPath(id));
    const team = await hostedTeams.forAccount(accountOf(session), id);
    if (!team || team.stage === "deleting") return reply.redirect("/", 303);
    if (team.stage === "ready") return reply.redirect(team.origin, 303);
    const nonce = randomBytes(18).toString("base64url");
    return sendBrowserPage(reply, {
      body: hostedTeamProgressBody({
        cancelAction: `${hostedTeamPath(id)}/delete`,
        nonce,
        retryAction: `${hostedTeamPath(id)}/retry`,
        statusPath: `${hostedTeamPath(id)}/status`,
        team,
      }),
      fonts,
      layout: "card",
      policy: browserPagePolicyWithScript(nonce, ["connect-src 'self'"]),
      title: `Setting up ${team.name} · Opensteer`,
    });
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
    return team;
  });

  app.post(`${portalHostedTeamsPath}/:id/retry`, async (request, reply) => {
    guard(request);
    void reply.header("cache-control", "no-store");
    requireExactOrigin(request, portalOrigin.origin);
    if (!hostedTeams) return unavailable(reply);
    const session = await readSession(request, reply);
    if (!session) return signIn(reply, "/");
    const { id } = TeamParamsSchema.parse(request.params);
    await hostedTeams.retry(accountOf(session), id);
    return reply.redirect(hostedTeamPath(id), 303);
  });

  app.post(`${portalHostedTeamsPath}/:id/delete`, async (request, reply) => {
    guard(request);
    void reply.header("cache-control", "no-store");
    requireExactOrigin(request, portalOrigin.origin);
    if (!hostedTeams) return unavailable(reply);
    const session = await readSession(request, reply);
    if (!session) return signIn(reply, "/");
    const { id } = TeamParamsSchema.parse(request.params);
    await hostedTeams.remove(accountOf(session), id);
    return reply.redirect("/", 303);
  });

  function renderCreate(
    reply: FastifyReply,
    input: {
      readonly failure: string | null;
      readonly limitReached: boolean;
      readonly name: string;
      readonly slug: string;
    },
  ): string {
    const nonce = randomBytes(18).toString("base64url");
    return sendBrowserPage(reply, {
      body: createHostedTeamBody({
        action: portalHostedTeamsPath,
        availabilityPath: portalAvailabilityPath,
        domain: hostedTeamsDomain,
        limit: maximumLiveHostedTeamsPerAccount,
        nonce,
        requestId: randomUUID(),
        ...input,
      }),
      fonts,
      layout: "card",
      policy: browserPagePolicyWithScript(nonce, ["connect-src 'self'"]),
      title: "Create a team · Opensteer",
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
      id: team.id,
      name: team.name,
      origin: team.origin,
      progressHref: hostedTeamPath(team.id),
      removeAction: `${hostedTeamPath(team.id)}/delete`,
      stage: team.stage,
    }),
  );
}

function accountOf(session: PortalSession) {
  return ControlPlaneAccountIdSchema.parse(session.accountId);
}
