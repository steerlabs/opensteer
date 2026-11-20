import {
  ControlPlaneAccountIdSchema,
  defaultWorkPolicy,
  OrganizationIdSchema,
  OrganizationInvitationIdSchema,
  orgWords,
  workAuditExcluded,
  workAuditRecordKinds,
  WorkAssignmentIdSchema,
  type OrganizationAdminResponse,
  type WorkAssignmentView,
} from "@opensteer/control-plane-protocol";
import { escapeHtml } from "@opensteer/shared/browserPage";
import { describe, expect, it } from "vitest";
import {
  auditDescription,
  offboardSteps,
  organizationAdminBody,
  organizationCreateBody,
  organizationInvitationBody,
  organizationListBody,
  organizationRefusedBody,
  organizationUnavailableBody,
} from "./portal-pages.js";

const words = (text: string) => escapeHtml(text);
const orgId = OrganizationIdSchema.parse("org_00000000-0000-4000-8000-000000000001");
const adminId = ControlPlaneAccountIdSchema.parse("acct_00000000-0000-4000-8000-00000000000a");
const memberId = ControlPlaneAccountIdSchema.parse("acct_00000000-0000-4000-8000-00000000000b");
const offer = {
  priceId: "price_seat",
  name: "Work seat",
  currency: "usd",
  amountMinor: 4900,
  interval: "month" as const,
};
const invitationId = OrganizationInvitationIdSchema.parse(
  "oi_00000000-0000-4000-8000-000000000002",
);

function assignment(patch: Partial<WorkAssignmentView> = {}): WorkAssignmentView {
  return {
    organizationId: orgId,
    organizationName: "Acme",
    assignmentId: WorkAssignmentIdSchema.parse("was_00000000-0000-4000-8000-000000000003"),
    assignee: { accountId: memberId, displayName: "Mia Member", email: "mia@example.test" },
    computerId: "cc_00000000-0000-4000-8000-000000000004" as WorkAssignmentView["computerId"],
    state: "active",
    homeStatus: "ready",
    reason: null,
    address: "https://mia.home.example.test",
    policyRevision: 2,
    appliedRevision: 2,
    policyStatus: "Applied",
    signInCut: false,
    suspended: false,
    deleted: false,
    retainUntil: null,
    audit: { lastSequence: 0, lastReceivedAt: null, gap: null },
    ...patch,
  };
}

function view(patch: Partial<OrganizationAdminResponse> = {}): OrganizationAdminResponse {
  return {
    id: orgId,
    name: "Acme",
    seats: { paid: 3, assigned: 1, free: 2, pending: null },
    billingStatus: "active",
    members: [
      { accountId: adminId, displayName: "Ada Admin", email: "ada@example.test", role: "admin" },
      { accountId: memberId, displayName: "Mia Member", email: "mia@example.test", role: "member" },
    ],
    invitations: [],
    assignments: [assignment()],
    policy: defaultWorkPolicy,
    policyRevision: 2,
    ...patch,
  };
}

const admin = (
  section: Parameters<typeof organizationAdminBody>[0]["section"],
  patch: Partial<OrganizationAdminResponse> = {},
) =>
  organizationAdminBody({
    view: view(patch),
    section,
    self: adminId,
    portalOrigin: "https://opensteer.example.test",
    requestId: "00000000-0000-4000-8000-000000000009",
    refusal: null,
    notice: null,
  });

describe("organization website pages", () => {
  it("lists organizations, invitations and a way to create one", () => {
    const body = organizationListBody({
      mine: {
        organizations: [
          { id: orgId, name: "Acme", role: "admin" },
          {
            id: OrganizationIdSchema.parse("org_00000000-0000-4000-8000-000000000005"),
            name: "Beta",
            role: "member",
          },
        ],
        invitations: [
          {
            id: invitationId,
            email: "ada@example.test",
            role: "member",
            createdAt: "2026-11-20T10:00:00.000Z",
            organization: { id: orgId, name: "Gamma" },
          },
        ],
      },
      canCreate: true,
      notice: null,
      refusal: null,
    });
    expect(body).toContain(`href="/organizations/${orgId}"`);
    expect(body).toContain('href="/cloud-computer"');
    expect(body).toContain(`href="/organizations/invitations/${invitationId}"`);
    expect(body).toContain('href="/organizations/new"');
    const none = organizationListBody({
      mine: { organizations: [], invitations: [] },
      canCreate: false,
      notice: null,
      refusal: null,
    });
    expect(none).toContain(words(orgWords("org.none")));
    expect(none).not.toContain('href="/organizations/new"');
  });

  it("creates with the honest split, the per-seat price and its total", () => {
    const body = organizationCreateBody({
      offer,
      requestId: "r",
      name: "Acme <&>",
      seats: 3,
      refusal: null,
    });
    expect(body).toContain(words(orgWords("org.split.lead")));
    expect(body).toContain(words(orgWords("org.cannot.signIn")));
    expect(body).toContain("$49.00 a seat a month");
    expect(body).toContain("3 × $49.00 = $147.00 a month");
    expect(body).toContain('value="Acme &lt;&amp;&gt;"');
    expect(body).toContain('type="submit">Continue to checkout</button>');
    expect(body).not.toContain("<script");
    const refused = organizationCreateBody({
      offer,
      requestId: "r",
      name: "",
      seats: 1,
      refusal: { sentence: "This organization checkout expired", next: null },
    });
    expect(refused).toContain('role="alert"');
  });

  it("says when organizations aren't sold, and refuses a non-admin with the Account's sentence", () => {
    expect(organizationUnavailableBody()).toContain(words(orgWords("org.unavailable.title")));
    const refused = organizationRefusedBody({
      sentence: "Organization access is not allowed",
      next: orgWords("org.refused.forbiddenNext"),
    });
    expect(refused).toContain("Organization access is not allowed");
    expect(refused).toContain(words(orgWords("org.refused.forbiddenNext")));
  });

  it("shows an invited person what joining means, or that the invitation isn't theirs", () => {
    const body = organizationInvitationBody({
      invitation: {
        id: invitationId,
        email: "ada@example.test",
        role: "member",
        createdAt: "2026-11-20T10:00:00.000Z",
        organization: { id: orgId, name: "Acme" },
      },
      email: "ada@example.test",
      refusal: null,
    });
    expect(body).toContain(words(orgWords("org.invite.lead")));
    expect(body).toContain(`action="/organizations/invitations/${invitationId}/accept"`);
    const missing = organizationInvitationBody({
      invitation: null,
      email: "sam@example.test",
      refusal: null,
    });
    expect(missing).toContain(words(orgWords("org.invite.wrongEmail")));
    expect(missing).not.toContain("<form");
  });

  it("shows seats, billing and a seat change, or the pending change instead", () => {
    const body = admin("overview");
    expect(body).toMatch(/org__stat-value">2<\/span><span class="org__stat-label">Free/u);
    expect(body).toContain(`action="/organizations/${orgId}/seats"`);
    expect(body).toContain(`href="/organizations/${orgId}/billing"`);
    expect(body).toContain(words(orgWords("org.seats.changeDetail")));
    expect(body).toContain(words(orgWords("org.split.lead")));
    const pending = admin("overview", { seats: { paid: 3, assigned: 1, free: 2, pending: 5 } });
    expect(pending).toContain(words(orgWords("org.seats.pendingDetail", { seats: 5 })));
    expect(pending).not.toContain(`action="/organizations/${orgId}/seats"`);
    const unpaid = admin("overview", { billingStatus: "past_due" });
    expect(unpaid).toContain(words(orgWords("org.billing.attention")));
  });

  it("lists people, keeps the last admin and anyone with a work Home, and shows invitation links", () => {
    const body = admin("people", {
      invitations: [
        {
          id: invitationId,
          email: "ivy@example.test",
          role: "member",
          createdAt: "2026-11-20T10:00:00.000Z",
        },
      ],
    });
    expect(body).toContain(words(orgWords("org.people.lastAdmin")));
    expect(body).toContain(words(orgWords("org.people.hasHome")));
    expect(body).not.toContain(
      `name="accountId" value="${adminId}"><input type="hidden" name="action" value="member"`,
    );
    expect(body).toContain(
      `name="accountId" value="${memberId}"><input type="hidden" name="action" value="admin"`,
    );
    expect(body).not.toContain(
      `name="accountId" value="${memberId}"><input type="hidden" name="action" value="remove"`,
    );
    expect(body).toContain(
      `https://opensteer.example.test/organizations/invitations/${invitationId}`,
    );
    expect(body).toContain(`action="/organizations/${orgId}/invitations"`);
  });

  it("shows each work Home's status, policy and audit, and offboards with the real sequence", () => {
    const body = admin("work-homes", {
      assignments: [
        assignment({
          policyStatus: "Pending on Home",
          appliedRevision: 1,
          audit: {
            lastSequence: 4,
            lastReceivedAt: "2026-11-20T10:00:00.000Z",
            gap: { expected: 5, received: 9 },
          },
        }),
      ],
    });
    expect(body).toContain(words(orgWords("org.policy.pending", { revision: 2, applied: 1 })));
    expect(body).toContain(words(orgWords("org.audit.gap", { expected: 5, received: 9 })));
    for (const id of [
      "org.offboard.step.cut",
      "org.offboard.step.off",
      "org.offboard.step.delete",
      "org.offboard.step.recall",
    ] as const)
      expect(body).toContain(words(orgWords(id)));
    for (const seconds of [0, 604800, 2592000, 7776000])
      expect(body).toContain(`value="${seconds}"`);
    expect(body).toContain(`<option value="${adminId}">`);
    expect(body).not.toContain(`<option value="${memberId}">`);
  });

  it("states offboarding progress as the Account reports it", () => {
    expect(offboardSteps(assignment())).toEqual([]);
    const later = new Date(Date.now() + 86_400_000).toISOString();
    expect(
      offboardSteps(assignment({ state: "offboarding", signInCut: true, retainUntil: later })),
    ).toEqual([
      orgWords("org.offboard.cut"),
      orgWords("org.offboard.offPending"),
      expect.stringMatching(/^Deletes after /u),
    ]);
    expect(
      offboardSteps(
        assignment({ state: "offboarding", signInCut: true, suspended: true, retainUntil: null }),
      ),
    ).toEqual([
      orgWords("org.offboard.cut"),
      orgWords("org.offboard.off"),
      orgWords("org.offboard.deletesNow"),
    ]);
    expect(offboardSteps(assignment({ state: "ended", signInCut: true, deleted: true }))).toEqual([
      orgWords("org.offboard.cut"),
      orgWords("org.offboard.off"),
      orgWords("org.offboard.deleted"),
    ]);
    const shown = admin("work-homes", {
      assignments: [assignment({ state: "offboarding", signInCut: true })],
    });
    expect(shown).toContain(words(orgWords("org.status.signInCut")));
    expect(shown).not.toContain("/offboard");
  });

  it("offers a free seat to members without a work Home, and says when none is free", () => {
    const body = admin("work-homes", { assignments: [] });
    expect(body).toContain(`<option value="${adminId}">`);
    expect(body).toContain(`<option value="${memberId}">`);
    const everyone = admin("work-homes", {
      members: view().members.filter(({ role }) => role === "member"),
    });
    expect(everyone).toContain(words(orgWords("org.homes.nobody")));
    expect(
      admin("work-homes", { seats: { paid: 1, assigned: 1, free: 0, pending: null } }),
    ).toContain(words(orgWords("org.homes.noSeat")));
  });

  it("shows the four switches by their design names with what each changes", () => {
    const body = admin("policy", {
      policy: { ...defaultWorkPolicy, allowTasks: true, externalMaxMode: "auto" },
    });
    for (const key of ["externalMaxMode", "allowTasks", "allowEverything", "devices"])
      expect(body).toContain(`>${key}<`);
    for (const id of [
      "org.policy.externalMaxMode.detail",
      "org.policy.allowTasks.detail",
      "org.policy.allowEverything.detail",
      "org.policy.devices.detail",
    ] as const)
      expect(body).toContain(words(orgWords(id)));
    expect(body).toContain('<option value="auto" selected>');
    expect(body).toMatch(/name="allowTasks" value="on" checked/u);
    expect(body).toContain('name="expectedRevision" value="2"');
    expect(body).toContain(words(orgWords("org.policy.homes", { applied: 1, total: 1 })));
  });

  it("describes the audit export from the record schema and offers each download", () => {
    const description = auditDescription();
    for (const { words: kind } of workAuditRecordKinds) expect(description).toContain(words(kind));
    for (const item of workAuditExcluded) expect(description).toContain(words(item));
    const body = admin("audit");
    expect(body).toContain(`/audit/was_00000000-0000-4000-8000-000000000003/export.jsonl`);
    expect(body).toContain(words(orgWords("org.audit.none")));
  });
});
