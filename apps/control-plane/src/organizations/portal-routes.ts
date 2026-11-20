import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { createPublicHttpsFetch } from "@opensteer/access/host";
import {
  ControlPlaneAccountIdSchema,
  OrganizationIdSchema,
  OrganizationInvitationIdSchema,
  OrganizationNameSchema,
  OrganizationRoleSchema,
  OrganizationSeatQuantitySchema,
  WorkAssignmentIdSchema,
  WorkPolicySchema,
  offboardRetentionChoices,
  orgWords,
  type ControlPlaneAccountId,
  type OrganizationId,
} from "@opensteer/control-plane-protocol";
import { IdentityEmailSchema, ThreadAccessModeSchema } from "@opensteer/core";
import type { BrowserPageFonts } from "@opensteer/shared/browserPage";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ControlPlaneAuth } from "../auth/auth.js";
import type { CloudComputerStore } from "../cloud-computers/store.js";
import { parseForm, requireExactOrigin } from "../portal/browser-http.js";
import { sendBrowserPage } from "../portal/pages.js";
import type { PortalSession } from "../portal/portal-sessions.js";
import { ControlPlaneError } from "../server/errors.js";
import {
  organizationAdminBody,
  organizationCreateBody,
  organizationCreatePortalPath,
  organizationInvitationBody,
  organizationInvitationPortalPath,
  organizationListBody,
  organizationPortalPath,
  organizationRefusedBody,
  organizationSections,
  organizationStyles,
  organizationUnavailableBody,
  organizationsPortalPath,
  type OrganizationRefusal,
  type OrganizationSection,
} from "./portal-pages.js";
import { offboardWorkAssignment } from "./routes.js";
import type { OrganizationStore } from "./store.js";

const title = orgWords("org.web.title");
const OrgParamsSchema = z.object({ organizationId: OrganizationIdSchema });
const SectionParamsSchema = OrgParamsSchema.extend({ section: z.enum(organizationSections) });
const AssignmentParamsSchema = OrgParamsSchema.extend({ assignmentId: WorkAssignmentIdSchema });
const InvitationParamsSchema = z.object({ invitationId: OrganizationInvitationIdSchema });
const CreateFormSchema = z.object({
  requestId: z.uuid(),
  name: OrganizationNameSchema,
  seats: z.coerce.number().pipe(OrganizationSeatQuantitySchema),
});
const SeatsFormSchema = z.object({
  requestId: z.uuid(),
  seats: z.coerce.number().pipe(OrganizationSeatQuantitySchema),
});
const InviteFormSchema = z.object({ email: IdentityEmailSchema, role: OrganizationRoleSchema });
const MemberFormSchema = z.object({
  accountId: ControlPlaneAccountIdSchema,
  action: z.enum(["admin", "member", "remove"]),
});
const AssignFormSchema = z.object({ requestId: z.uuid(), accountId: ControlPlaneAccountIdSchema });
const retentionValues = offboardRetentionChoices.map(({ seconds }) => String(seconds));
const OffboardFormSchema = z.object({
  retentionSeconds: z
    .string()
    .refine((value) => retentionValues.includes(value))
    .transform(Number),
});
const PolicyFormSchema = z.object({
  expectedRevision: z.coerce.number().int().positive(),
  externalMaxMode: ThreadAccessModeSchema,
  allowTasks: z.literal("on").optional(),
  allowEverything: z.literal("on").optional(),
  devices: WorkPolicySchema.shape.devices,
});
const NoticeQuerySchema = z
  .object({
    organization: z.literal("checkout-completed").optional(),
    joined: z.literal("1").optional(),
  })
  .loose();
const formRefusal: OrganizationRefusal = {
  sentence: orgWords("org.refused.form"),
  next: orgWords("org.refused.formNext"),
};

/**
 * The Opensteer website's organization pages, over the same store as the Account API.
 * Checkout and billing are taken only from this signed-in website session. Every role
 * check is the store's; a page shows the store's own sentence when it says no.
 */
export function registerOrganizationPortal(
  app: FastifyInstance,
  options: {
    readonly organizations: OrganizationStore | undefined;
    readonly cloudComputers: CloudComputerStore | undefined;
    readonly auth: ControlPlaneAuth;
    readonly publicOrigin: URL;
    readonly workHomeFetch?: typeof globalThis.fetch;
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
  const { organizations, fonts, guard, portalOrigin, readSession } = options;
  const workHomeFetch =
    options.workHomeFetch ?? createPublicHttpsFetch({ maxResponseBytes: 4_096, timeoutMs: 2_000 });

  /** A signed-in page: the guard, no caching, the store, and the session or sign-in. */
  async function enter(
    request: FastifyRequest,
    reply: FastifyReply,
    returnPath: string,
    post = false,
  ) {
    guard(request);
    void reply.header("cache-control", "no-store");
    if (post) requireExactOrigin(request, portalOrigin.origin);
    if (!organizations) return { reply: unavailable(reply) } as const;
    const session = await readSession(request, reply);
    if (!session) return { reply: reply.redirect(signInHref(returnPath), 303) } as const;
    return { organizations, session, account: accountOf(session) } as const;
  }

  app.get(organizationsPortalPath, async (request, reply) => {
    const entered = await enter(request, reply, organizationsPortalPath);
    if ("reply" in entered) return entered.reply;
    const { organization, joined } = NoticeQuerySchema.parse(request.query ?? {});
    return renderList(reply, entered.organizations, entered.account, {
      notice: organization
        ? orgWords("org.checkout.completed")
        : joined
          ? orgWords("org.done.joined")
          : null,
      refusal: null,
    });
  });

  app.get(organizationCreatePortalPath, async (request, reply) => {
    const entered = await enter(request, reply, organizationCreatePortalPath);
    if ("reply" in entered) return entered.reply;
    const offer = entered.organizations.offer;
    if (!offer) return unavailable(reply);
    return page(
      reply,
      organizationCreateBody({ offer, requestId: randomUUID(), name: "", seats: 1, refusal: null }),
    );
  });

  app.post(organizationCreatePortalPath, async (request, reply) => {
    const entered = await enter(request, reply, organizationCreatePortalPath, true);
    if ("reply" in entered) return entered.reply;
    const offer = entered.organizations.offer;
    if (!offer) return unavailable(reply);
    const form = parseForm(request.body);
    const parsed = CreateFormSchema.safeParse(form);
    const again = (status: number, refusal: OrganizationRefusal) =>
      page(
        reply.code(status),
        organizationCreateBody({
          offer,
          requestId: parsed.success ? parsed.data.requestId : randomUUID(),
          name: (form.name ?? "").slice(0, 120),
          seats: Number(form.seats) > 0 ? Math.min(1000, Math.floor(Number(form.seats))) : 1,
          refusal,
        }),
      );
    if (!parsed.success) return again(400, formRefusal);
    try {
      const { url } = await entered.organizations.checkout(entered.account, parsed.data);
      return reply.redirect(url, 303);
    } catch (error) {
      const refusal = refused(error);
      if (!refusal) throw error;
      return again(refusal.status, refusal.refusal);
    }
  });

  app.get("/organizations/invitations/:invitationId", async (request, reply) => {
    const { invitationId } = InvitationParamsSchema.parse(request.params);
    const entered = await enter(request, reply, organizationInvitationPortalPath(invitationId));
    if ("reply" in entered) return entered.reply;
    return renderInvitation(reply, entered.organizations, entered.session, invitationId, null);
  });

  app.post("/organizations/invitations/:invitationId/accept", async (request, reply) => {
    const { invitationId } = InvitationParamsSchema.parse(request.params);
    const entered = await enter(
      request,
      reply,
      organizationInvitationPortalPath(invitationId),
      true,
    );
    if ("reply" in entered) return entered.reply;
    try {
      await entered.organizations.accept(invitationId, entered.account);
      return reply.redirect(`${organizationsPortalPath}?joined=1`, 303);
    } catch (error) {
      const refusal = refused(error);
      if (!refusal) throw error;
      const sentence =
        refusal.status === 403
          ? { sentence: orgWords("org.invite.wrongEmail"), next: null }
          : refusal.refusal;
      return renderInvitation(
        reply.code(refusal.status),
        entered.organizations,
        entered.session,
        invitationId,
        sentence,
      );
    }
  });

  app.get("/organizations/:organizationId", async (request, reply) =>
    adminPage(request, reply, "overview"),
  );
  app.get("/organizations/:organizationId/:section", async (request, reply) => {
    const parsed = SectionParamsSchema.safeParse(request.params);
    if (!parsed.success) throw new ControlPlaneError("not_found", "Route was not found");
    return adminPage(request, reply, parsed.data.section);
  });

  app.get("/organizations/:organizationId/billing", async (request, reply) => {
    const { organizationId } = OrgParamsSchema.parse(request.params);
    const entered = await enter(request, reply, organizationPortalPath(organizationId));
    if ("reply" in entered) return entered.reply;
    try {
      const { url } = await entered.organizations.billingPortal(organizationId, entered.account);
      return reply.redirect(url, 303);
    } catch (error) {
      const refusal = refused(error);
      if (!refusal) throw error;
      return refusedPage(reply.code(refusal.status), refusal.refusal);
    }
  });

  app.get(
    "/organizations/:organizationId/audit/:assignmentId/export.jsonl",
    async (request, reply) => {
      const { organizationId, assignmentId } = AssignmentParamsSchema.parse(request.params);
      const entered = await enter(request, reply, organizationPortalPath(organizationId, "audit"));
      if ("reply" in entered) return entered.reply;
      let result;
      try {
        result = await entered.organizations.auditExport(
          organizationId,
          entered.account,
          assignmentId,
          0,
        );
      } catch (error) {
        const refusal = refused(error);
        if (!refusal) throw error;
        return refusedPage(reply.code(refusal.status), refusal.refusal);
      }
      void reply
        .type("application/x-ndjson")
        .header("content-disposition", `attachment; filename="${assignmentId}.jsonl"`)
        .header("x-opensteer-audit-last-sequence", result.status.lastSequence);
      if (result.status.lastReceivedAt)
        void reply.header("x-opensteer-audit-last-received-at", result.status.lastReceivedAt);
      if (result.status.gap)
        void reply
          .header("x-opensteer-audit-gap-expected", result.status.gap.expected)
          .header("x-opensteer-audit-gap-received", result.status.gap.received);
      return reply.send(Readable.from(result.lines));
    },
  );

  /** One admin action: parse its form, call the store, then show the section again. */
  function action<T>(
    url: string,
    section: OrganizationSection,
    schema: z.ZodType<T>,
    run: (input: {
      readonly organizations: OrganizationStore;
      readonly organizationId: OrganizationId;
      readonly account: ControlPlaneAccountId;
      readonly form: T;
      readonly params: unknown;
    }) => Promise<string | null>,
  ) {
    app.post(url, async (request, reply) => {
      const { organizationId } = OrgParamsSchema.parse(request.params);
      const entered = await enter(
        request,
        reply,
        organizationPortalPath(organizationId, section),
        true,
      );
      if ("reply" in entered) return entered.reply;
      const parsed = schema.safeParse(parseForm(request.body));
      if (!parsed.success)
        return renderAdmin(reply.code(400), entered, organizationId, section, formRefusal, null);
      let notice: string | null;
      try {
        notice = await run({
          organizations: entered.organizations,
          organizationId,
          account: entered.account,
          form: parsed.data,
          params: request.params,
        });
      } catch (error) {
        const refusal = refused(error);
        if (!refusal) throw error;
        return renderAdmin(
          reply.code(refusal.status),
          entered,
          organizationId,
          section,
          refusal.refusal,
          null,
        );
      }
      const target = organizationPortalPath(organizationId, section);
      return reply.redirect(notice ? `${target}?done=${encodeURIComponent(notice)}` : target, 303);
    });
  }

  action("/organizations/:organizationId/seats", "overview", SeatsFormSchema, async (input) => {
    await input.organizations.changeSeats(input.organizationId, input.account, input.form);
    return "seats";
  });
  action(
    "/organizations/:organizationId/invitations",
    "people",
    InviteFormSchema,
    async (input) => {
      await input.organizations.invite(input.organizationId, input.account, input.form);
      return "invited";
    },
  );
  action("/organizations/:organizationId/members", "people", MemberFormSchema, async (input) => {
    await input.organizations.changeMember(
      input.organizationId,
      input.account,
      input.form.accountId,
      input.form.action === "remove" ? null : input.form.action,
    );
    return input.form.action === "remove" ? "removed" : "role";
  });
  action(
    "/organizations/:organizationId/work-homes",
    "work-homes",
    AssignFormSchema,
    async (input) => {
      const cloudComputers = options.cloudComputers;
      if (!cloudComputers)
        throw new ControlPlaneError("unavailable", "Cloud Computers aren’t available");
      await input.organizations.assign(
        input.organizationId,
        input.account,
        input.form,
        (tx, id, assignmentId) => cloudComputers.createWorkComputer(tx, id, assignmentId),
      );
      return "assigned";
    },
  );
  action(
    "/organizations/:organizationId/work-homes/:assignmentId/offboard",
    "work-homes",
    OffboardFormSchema,
    async (input) => {
      const { assignmentId } = AssignmentParamsSchema.parse(input.params);
      await offboardWorkAssignment(
        {
          organizations: input.organizations,
          auth: options.auth,
          publicOrigin: options.publicOrigin,
          workHomeFetch,
        },
        {
          organizationId: input.organizationId,
          account: input.account,
          assignmentId,
          retentionSeconds: input.form.retentionSeconds,
        },
      );
      return "offboarded";
    },
  );
  action("/organizations/:organizationId/policy", "policy", PolicyFormSchema, async (input) => {
    const { form } = input;
    await input.organizations.setPolicy(input.organizationId, input.account, {
      expectedRevision: form.expectedRevision,
      policy: WorkPolicySchema.parse({
        externalMaxMode: form.externalMaxMode,
        allowTasks: form.allowTasks === "on",
        allowEverything: form.allowEverything === "on",
        devices: form.devices,
      }),
    });
    return "policy";
  });

  async function adminPage(
    request: FastifyRequest,
    reply: FastifyReply,
    section: OrganizationSection,
  ) {
    const { organizationId } = OrgParamsSchema.parse(request.params);
    const entered = await enter(request, reply, organizationPortalPath(organizationId, section));
    if ("reply" in entered) return entered.reply;
    const done = z
      .object({ done: z.string().max(32).optional() })
      .loose()
      .parse(request.query ?? {});
    return renderAdmin(reply, entered, organizationId, section, null, doneNotice(done.done));
  }

  async function renderAdmin(
    reply: FastifyReply,
    entered: { readonly organizations: OrganizationStore; readonly account: ControlPlaneAccountId },
    organizationId: OrganizationId,
    section: OrganizationSection,
    refusal: OrganizationRefusal | null,
    notice: string | null,
  ) {
    let view;
    try {
      view = await entered.organizations.admin(organizationId, entered.account);
    } catch (error) {
      const denied = refused(error);
      if (!denied) throw error;
      return refusedPage(reply.code(denied.status), denied.refusal);
    }
    return page(
      reply,
      organizationAdminBody({
        view,
        section,
        self: entered.account,
        portalOrigin: portalOrigin.origin,
        requestId: randomUUID(),
        refusal,
        notice,
      }),
    );
  }

  async function renderList(
    reply: FastifyReply,
    store: OrganizationStore,
    account: ControlPlaneAccountId,
    input: { readonly notice: string | null; readonly refusal: OrganizationRefusal | null },
  ) {
    return page(
      reply,
      organizationListBody({
        mine: await store.mine(account),
        canCreate: store.offer !== undefined,
        ...input,
      }),
    );
  }

  async function renderInvitation(
    reply: FastifyReply,
    store: OrganizationStore,
    session: PortalSession,
    invitationId: string,
    refusal: OrganizationRefusal | null,
  ) {
    const mine = await store.mine(accountOf(session));
    const invitation = mine.invitations.find(({ id }) => id === invitationId) ?? null;
    if (!invitation && reply.statusCode === 200) void reply.code(404);
    return page(reply, organizationInvitationBody({ invitation, email: session.email, refusal }));
  }

  function page(reply: FastifyReply, body: string): string {
    return sendBrowserPage(reply, {
      body: `${organizationStyles}${body}`,
      fonts,
      layout: "card",
      title,
    });
  }

  function refusedPage(reply: FastifyReply, refusal: OrganizationRefusal): string {
    return sendBrowserPage(reply, {
      body: organizationRefusedBody(refusal),
      fonts,
      layout: "plain",
      title,
    });
  }

  function unavailable(reply: FastifyReply): string {
    return sendBrowserPage(reply.code(404), {
      body: organizationUnavailableBody(),
      fonts,
      layout: "plain",
      title,
    });
  }

  function signInHref(returnPath: string): string {
    return `${options.signInPath}?${new URLSearchParams({ return: returnPath })}`;
  }
}

const notices = {
  seats: "org.done.seats",
  invited: "org.done.invited",
  removed: "org.done.removed",
  role: "org.done.role",
  assigned: "org.done.assigned",
  offboarded: "org.done.offboarded",
  policy: "org.done.policy",
} as const;
function doneNotice(value: string | undefined): string | null {
  return value && Object.hasOwn(notices, value)
    ? orgWords(notices[value as keyof typeof notices])
    : null;
}

/** A refusal the store wrote for people, with what to do next; anything else is thrown on. */
function refused(
  error: unknown,
): { readonly status: number; readonly refusal: OrganizationRefusal } | null {
  if (!(error instanceof ControlPlaneError)) return null;
  if (!["conflict", "unavailable", "forbidden", "bad_request", "not_found"].includes(error.code))
    return null;
  return {
    status: error.status,
    refusal: {
      sentence: error.message,
      next: error.code === "forbidden" ? orgWords("org.refused.forbiddenNext") : null,
    },
  };
}

function accountOf(session: PortalSession): ControlPlaneAccountId {
  return ControlPlaneAccountIdSchema.parse(session.accountId);
}
