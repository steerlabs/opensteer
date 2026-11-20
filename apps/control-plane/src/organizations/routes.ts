import { createPublicHttpsFetch } from "@opensteer/access/host";
import { Readable } from "node:stream";
import {
  accountOrganizationsPath,
  organizationWorkPath,
  workAuditFlushPath,
  workPolicyChangedPath,
  WorkPolicyChangedClaimsSchema,
  ControlPlaneAccountIdSchema,
  MyOrganizationsResponseSchema,
  OrganizationAdminResponseSchema,
  OrganizationAssignmentRequestSchema,
  OrganizationCheckoutRequestSchema,
  OrganizationCheckoutResponseSchema,
  OrganizationIdSchema,
  OrganizationInvitationIdSchema,
  OrganizationInviteRequestSchema,
  OrganizationInviteResponseSchema,
  OrganizationMemberRequestSchema,
  OrganizationOffboardRequestSchema,
  OrganizationPolicyRequestSchema,
  OrganizationSeatsRequestSchema,
  WorkAssignmentIdSchema,
  WorkAssignmentViewSchema,
  WorkAuditAcknowledgmentSchema,
  WorkAuditExportQuerySchema,
  WorkAuditFlushClaimsSchema,
  WorkAuditFlushRequestSchema,
  WorkAuditPushSchema,
  WorkHomeResponseSchema,
  WorkPolicyAppliedRequestSchema,
  WorkPolicyAppliedResponseSchema,
  WorkPolicyUpdateResponseSchema,
  WorkPolicyClaimsSchema,
  WorkPolicyResponseSchema,
  type ControlPlaneAccountId,
  type OrganizationId,
  type WorkAssignmentId,
} from "@opensteer/control-plane-protocol";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  signAccountDocument,
  type ControlPlaneAuth,
  type ControlPlaneAuthenticator,
} from "../auth/auth.js";
import type { CloudComputerStore } from "../cloud-computers/store.js";
import type { ControlPlaneStore } from "../database/store.js";
import { toWebHeaders } from "../portal/routes.js";
import { ControlPlaneError } from "../server/errors.js";
import type { OrganizationStore } from "./store.js";

const orgParams = z.object({ organizationId: OrganizationIdSchema });
const assignmentParams = orgParams.extend({ assignmentId: WorkAssignmentIdSchema });
const memberParams = orgParams.extend({ accountId: ControlPlaneAccountIdSchema });
const hostParams = z.object({ assignmentId: WorkAssignmentIdSchema });
const orgPath = `${accountOrganizationsPath}/:organizationId`;
const assignmentPath = `${orgPath}/assignments/:assignmentId`;
const hostPath = `${organizationWorkPath}/:assignmentId`;

export function registerOrganizationRoutes(
  app: FastifyInstance,
  options: {
    organizations: OrganizationStore;
    cloudComputers: CloudComputerStore;
    authenticator: ControlPlaneAuthenticator;
    auth: ControlPlaneAuth;
    store: ControlPlaneStore;
    publicOrigin: URL;
    workHomeFetch?: typeof globalThis.fetch;
  },
) {
  const { organizations, authenticator } = options;
  const workHomeFetch =
    options.workHomeFetch ?? createPublicHttpsFetch({ maxResponseBytes: 4_096, timeoutMs: 2_000 });
  const read = async (request: FastifyRequest) =>
    (await authenticator.authenticate(toWebHeaders(request.headers), { scope: "deployments:read" }))
      .accountId;
  const write = (request: FastifyRequest) =>
    authenticator.authenticate(toWebHeaders(request.headers), {
      scope: "deployments:write",
      mutation: true,
    });
  const writer = async (request: FastifyRequest) => (await write(request)).accountId;
  const host = async (request: FastifyRequest) =>
    (await options.store.authenticateHostCredential(request.headers.authorization)).deploymentId;

  app.register(async (privateApp) => {
    privateApp.addHook("onRequest", async (_request, reply) => {
      void reply.header("cache-control", "no-store");
    });
    privateApp.get(accountOrganizationsPath, async (request) =>
      MyOrganizationsResponseSchema.parse(await organizations.mine(await read(request))),
    );
    privateApp.post(`${accountOrganizationsPath}/checkout`, async (request) => {
      const principal = await write(request);
      if (principal.kind !== "session")
        throw new ControlPlaneError("forbidden", "Open billing from the Opensteer Account website");
      return OrganizationCheckoutResponseSchema.parse(
        await organizations.checkout(
          principal.accountId,
          OrganizationCheckoutRequestSchema.parse(request.body),
        ),
      );
    });
    privateApp.post(
      `${accountOrganizationsPath}/invitations/:invitationId/accept`,
      async (request) => {
        const principal = await write(request);
        if (principal.kind !== "session")
          throw new ControlPlaneError(
            "forbidden",
            "Sign in to accept this organization invitation",
          );
        const { invitationId } = z
          .object({ invitationId: OrganizationInvitationIdSchema })
          .parse(request.params);
        return MyOrganizationsResponseSchema.parse(
          await organizations.accept(invitationId, principal.accountId),
        );
      },
    );
    privateApp.get(`${orgPath}/work-home`, async (request) =>
      WorkHomeResponseSchema.parse(
        await organizations.memberHome(
          orgParams.parse(request.params).organizationId,
          await read(request),
        ),
      ),
    );
    privateApp.get(`${orgPath}/admin`, async (request) =>
      OrganizationAdminResponseSchema.parse(
        await organizations.admin(
          orgParams.parse(request.params).organizationId,
          await read(request),
        ),
      ),
    );
    privateApp.post(`${orgPath}/seats`, async (request) =>
      OrganizationAdminResponseSchema.parse(
        await organizations.changeSeats(
          orgParams.parse(request.params).organizationId,
          await writer(request),
          OrganizationSeatsRequestSchema.parse(request.body),
        ),
      ),
    );
    privateApp.post(`${orgPath}/invitations`, async (request) =>
      OrganizationInviteResponseSchema.parse(
        await organizations.invite(
          orgParams.parse(request.params).organizationId,
          await writer(request),
          OrganizationInviteRequestSchema.parse(request.body),
        ),
      ),
    );
    for (const method of ["PUT", "DELETE"] as const) {
      privateApp.route({
        method,
        url: `${orgPath}/members/:accountId`,
        handler: async (request, reply) => {
          const { organizationId, accountId } = memberParams.parse(request.params);
          await organizations.changeMember(
            organizationId,
            await writer(request),
            accountId,
            method === "PUT" ? OrganizationMemberRequestSchema.parse(request.body).role : null,
          );
          return reply.code(204).send();
        },
      });
    }
    privateApp.post(`${orgPath}/assignments`, async (request) =>
      WorkAssignmentViewSchema.parse(
        await organizations.assign(
          orgParams.parse(request.params).organizationId,
          await writer(request),
          OrganizationAssignmentRequestSchema.parse(request.body),
          (tx, id, assignmentId) => options.cloudComputers.createWorkComputer(tx, id, assignmentId),
        ),
      ),
    );
    privateApp.post(`${assignmentPath}/offboard`, async (request) => {
      const principal = await writer(request);
      const { organizationId, assignmentId } = assignmentParams.parse(request.params);
      const { retentionSeconds } = OrganizationOffboardRequestSchema.parse(request.body);
      return WorkAssignmentViewSchema.parse(
        await offboardWorkAssignment(
          { ...options, workHomeFetch },
          { organizationId, account: principal, assignmentId, retentionSeconds },
        ),
      );
    });
    privateApp.put(`${orgPath}/policy`, async (request) => {
      const { organizationId } = orgParams.parse(request.params);
      const result = await organizations.setPolicy(
        organizationId,
        await writer(request),
        OrganizationPolicyRequestSchema.parse(request.body),
      );
      await notifyWorkPolicy({ ...options, workHomeFetch }, organizationId);
      return WorkPolicyUpdateResponseSchema.parse(result);
    });
    privateApp.get(`${assignmentPath}/audit`, async (request, reply) => {
      const { organizationId, assignmentId } = assignmentParams.parse(request.params);
      const { after } = WorkAuditExportQuerySchema.parse(request.query);
      const result = await organizations.auditExport(
        organizationId,
        await read(request),
        assignmentId,
        after,
      );
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
    });

    privateApp.get(`${hostPath}/policy`, async (request) => {
      const document = await organizations.hostPolicy(
        hostParams.parse(request.params).assignmentId,
        await host(request),
      );
      const claims = WorkPolicyClaimsSchema.parse({
        ...document,
        tokenUse: "opensteer-work-policy",
        iss: options.publicOrigin.origin,
        aud: document.deploymentId,
        iat: Math.floor(Date.now() / 1000),
      });
      return WorkPolicyResponseSchema.parse({
        assertion: await signAccountDocument(options.auth, claims),
      });
    });
    privateApp.post(`${hostPath}/applied`, async (request) => {
      const deploymentId = await host(request);
      return WorkPolicyAppliedResponseSchema.parse(
        await organizations.applied(
          hostParams.parse(request.params).assignmentId,
          deploymentId,
          WorkPolicyAppliedRequestSchema.parse(request.body).revision,
        ),
      );
    });
    privateApp.post(`${hostPath}/audit`, async (request, reply) => {
      const deploymentId = await host(request);
      const result = await organizations.auditPush(
        hostParams.parse(request.params).assignmentId,
        deploymentId,
        WorkAuditPushSchema.parse(request.body),
      );
      return reply
        .code(result.accepted ? 200 : 409)
        .send(WorkAuditAcknowledgmentSchema.parse({ lastSequence: result.lastSequence }));
    });
  });
}

/**
 * Ends a work assignment: cuts sign-in, asks a live Home to flush its audit outbox (best
 * effort, bounded), then powers it off and schedules its deletion. Repeating it reports
 * where the assignment stands.
 */
export async function offboardWorkAssignment(
  options: {
    readonly organizations: OrganizationStore;
    readonly auth: ControlPlaneAuth;
    readonly publicOrigin: URL;
    readonly workHomeFetch: typeof globalThis.fetch;
  },
  input: {
    readonly organizationId: OrganizationId;
    readonly account: ControlPlaneAccountId;
    readonly assignmentId: WorkAssignmentId;
    readonly retentionSeconds: number;
  },
) {
  const { organizations } = options;
  const { organizationId, account, assignmentId } = input;
  const offboard = await organizations.beginOffboard(
    organizationId,
    account,
    assignmentId,
    input.retentionSeconds,
  );
  if (!offboard.started)
    return organizations.offboardingStatus(organizationId, account, assignmentId);
  const { home } = offboard;
  let confirmed = false;
  if (home) {
    try {
      const iat = Math.floor(Date.now() / 1000);
      const claims = WorkAuditFlushClaimsSchema.parse({
        tokenUse: "opensteer-work-audit-flush",
        iss: options.publicOrigin.origin,
        aud: home.origin,
        assignmentId,
        deploymentId: home.deploymentId,
        iat,
        exp: iat + 30,
      });
      const { token } = await options.auth.api.signJWT({ body: { payload: claims } });
      const response = await options.workHomeFetch(new URL(workAuditFlushPath, home.origin), {
        method: "POST",
        redirect: "manual",
        credentials: "omit",
        cache: "no-store",
        signal: AbortSignal.timeout(2_000),
        headers: { "content-type": "application/json" },
        body: JSON.stringify(WorkAuditFlushRequestSchema.parse({ assertion: token })),
      });
      confirmed = response.ok;
      await response.body?.cancel();
    } catch {
      // Offboarding cannot wait for an unreachable Home or its audit outbox.
    }
  }
  return organizations.finishOffboard(organizationId, account, assignmentId, confirmed);
}

export async function notifyWorkPolicy(
  options: {
    readonly organizations: OrganizationStore;
    readonly auth: ControlPlaneAuth;
    readonly publicOrigin: URL;
    readonly workHomeFetch: typeof globalThis.fetch;
  },
  organizationId: OrganizationId,
): Promise<void> {
  const signal = AbortSignal.timeout(2_000);
  try {
    const homes = await options.organizations.policyNoticeHomes(organizationId);
    for (let offset = 0; offset < homes.length && !signal.aborted; offset += 8) {
      await Promise.allSettled(
        homes.slice(offset, offset + 8).map(async (home) => {
          const origin = new URL(`https://${home.hostname}`);
          const iat = Math.floor(Date.now() / 1_000);
          const claims = WorkPolicyChangedClaimsSchema.parse({
            tokenUse: "opensteer-work-policy-changed",
            iss: options.publicOrigin.origin,
            aud: origin.origin,
            assignmentId: home.assignmentId,
            deploymentId: home.deploymentId,
            iat,
            exp: iat + 30,
          });
          const assertion = await signAccountDocument(options.auth, claims);
          const response = await options.workHomeFetch(new URL(workPolicyChangedPath, origin), {
            method: "POST",
            credentials: "omit",
            redirect: "manual",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ assertion }),
            signal,
          });
          await response.body?.cancel();
        }),
      );
    }
  } catch {
    // The Home also reads periodically, including after a lost notice.
  }
}
