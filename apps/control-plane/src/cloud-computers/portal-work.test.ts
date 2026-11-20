import {
  CloudComputerIdSchema,
  cloudWords,
  defaultWorkPolicy,
  OrganizationIdSchema,
  orgWords,
  WorkAssignmentIdSchema,
  type CloudComputerView,
} from "@opensteer/control-plane-protocol";
import { escapeHtml } from "@opensteer/shared/browserPage";
import { describe, expect, it } from "vitest";
import {
  cloudComputerLandingBody,
  cloudComputerManagedByOrganization,
  cloudComputerRefusal,
  type WorkHomeCard,
} from "./portal-pages.js";

const plan = {
  name: "Cloud Computer",
  currency: "usd",
  amountMinor: 2900,
  interval: "month" as const,
};
const id = CloudComputerIdSchema.parse("cc_00000000-0000-4000-8000-000000000001");
const workId = CloudComputerIdSchema.parse("cc_00000000-0000-4000-8000-000000000002");
const words = (text: string) => escapeHtml(text);
const work: WorkHomeCard = {
  assignment: {
    organizationId: OrganizationIdSchema.parse("org_00000000-0000-4000-8000-000000000003"),
    organizationName: "Acme",
    assignmentId: WorkAssignmentIdSchema.parse("was_00000000-0000-4000-8000-000000000004"),
    computerId: workId,
    state: "active",
    homeStatus: "ready",
    reason: null,
    address: "https://acme-mia.home.example.test",
    policyRevision: 1,
    appliedRevision: 1,
    policyStatus: "Applied",
    signInCut: false,
    suspended: false,
    deleted: false,
    retainUntil: null,
  },
  policy: defaultWorkPolicy,
  computer: {
    id: workId,
    egress: "assigned",
    status: "ready",
    address: "https://acme-mia.home.example.test",
    region: { id: "ash", label: "Ashburn, Virginia" },
  } as CloudComputerView,
  openHref: "https://acme-mia.home.example.test",
};

function landing(
  computer: CloudComputerView & { status: Exclude<CloudComputerView["status"], "deleted"> },
  cards: readonly WorkHomeCard[] = [],
) {
  return cloudComputerLandingBody({
    state: { kind: "computer", plan, computer, openHref: null, work: cards },
    refusal: null,
    notice: null,
  });
}

function workSection(body: string): string {
  const start = body.indexOf('<section class="cloud-computer__work"');
  return start < 0 ? "" : body.slice(start, body.indexOf("</section>", start));
}

describe("Cloud Computer website page: work Homes and the Account's newer facts", () => {
  it("shows a work Home as its own card, with its policy and no billing or power controls", () => {
    const body = cloudComputerLandingBody({
      state: { kind: "offer", plan, deleted: false, work: [work] },
      refusal: null,
      notice: null,
    });
    const card = workSection(body);
    expect(card).toContain(words(orgWords("org.work.title", { organization: "Acme" })));
    expect(card).toContain(words(orgWords("org.work.badge", { organization: "Acme" })));
    expect(card).toContain(words(orgWords("org.work.managed", { organization: "Acme" })));
    expect(card).toContain(words(orgWords("org.policy.devices.cloud-computer-only")));
    expect(card).toContain("Ashburn, Virginia");
    expect(card).toContain('href="https://acme-mia.home.example.test"');
    expect(card).toContain(words(orgWords("org.work.see.never", { organization: "Acme" })));
    for (const forbidden of [
      "/cloud-computer/suspend",
      "/cloud-computer/delete",
      "/cloud-computer/billing",
      "/cloud-computer/resume",
    ])
      expect(card).not.toContain(forbidden);
    expect(body).toContain(words(cloudWords("cloud.web.personal")));
    expect(body).toContain('href="/cloud-computer/checkout"');
  });

  it("shows both a personal and a work Cloud Computer", () => {
    const body = landing(
      { id, egress: "assigned", status: "ready", address: "https://me.home.example.test" },
      [work],
    );
    expect(body).toContain('action="/cloud-computer/suspend"');
    expect(workSection(body)).toContain("Acme");
  });

  it("treats a computer as the organization's by its work marker, its reason code, or its id", () => {
    const base = {
      id,
      egress: "pending",
      status: "ready",
      address: "https://x.example.test",
    } as const;
    expect(cloudComputerManagedByOrganization(base, new Set())).toBe(false);
    expect(cloudComputerManagedByOrganization(base, new Set([id]))).toBe(true);
    expect(
      cloudComputerManagedByOrganization(
        {
          ...base,
          work: {
            organizationId: work.assignment.organizationId,
            organizationName: "Acme",
            assignmentId: work.assignment.assignmentId,
          },
        },
        new Set(),
      ),
    ).toBe(true);
    expect(
      cloudComputerManagedByOrganization(
        {
          id,
          egress: "pending",
          status: "suspended",
          reason: "Your organization suspended this Cloud Computer.",
          reasonCode: "cloud-computer-work-managed",
        },
        new Set(),
      ),
    ).toBe(true);
    const managed = landing({
      ...base,
      work: {
        organizationId: work.assignment.organizationId,
        organizationName: "Acme",
        assignmentId: work.assignment.assignmentId,
      },
    });
    expect(managed).toContain(words(cloudWords("cloud.web.managed")));
    expect(managed).not.toContain('action="/cloud-computer/suspend"');
    expect(managed).not.toContain('href="/cloud-computer/billing"');
  });

  it("shows region, Browser IP and renewal only when the Account knows them", () => {
    const known = landing({
      id,
      egress: "assigned",
      status: "ready",
      address: "https://me.home.example.test",
      region: { id: "ash", label: "Ashburn, Virginia" },
      egressAddress: "203.0.113.7",
      renewsAt: "2026-12-20T00:00:00.000Z",
    });
    expect(known).toContain("Ashburn, Virginia");
    expect(known).toContain('class="place__name">Browser IP</span>');
    expect(known).toContain("203.0.113.7");
    expect(known).toContain(words(cloudWords("cloud.renews", { date: "December 20, 2026" })));
    const unknown = landing({
      id,
      egress: "assigned",
      status: "ready",
      address: "https://me.home.example.test",
    });
    expect(unknown).not.toContain(words(cloudWords("cloud.region")));
    expect(unknown).not.toContain('class="place__name">Browser IP</span>');
    expect(unknown).not.toContain("Renews");
  });

  it("shows the Account's preparation steps, or the one honest step without them", () => {
    const steps = landing({
      id,
      egress: "pending",
      status: "preparing",
      steps: [
        { id: "payment", state: "done" },
        { id: "machine", state: "current" },
        { id: "opensteer", state: "pending" },
        { id: "claim", state: "pending" },
      ],
    });
    expect(steps).toContain(
      `<li class="step" data-state="done">${words(cloudWords("cloud.step.payment"))}</li>`,
    );
    expect(steps).toContain(
      `<li class="step" data-state="active">${words(cloudWords("cloud.step.machine"))}</li>`,
    );
    expect(steps).toContain(words(cloudWords("cloud.step.claim")));
    expect(steps).not.toContain(words(cloudWords("cloud.step.ready")));
    const failed = landing({
      id,
      egress: "pending",
      status: "preparing",
      steps: [{ id: "machine", state: "failed" }],
    });
    expect(failed).toContain('data-state="failed"');
    expect(failed).toContain(words(cloudWords("cloud.step.failed")));
    const none = landing({ id, egress: "pending", status: "preparing" });
    expect(none).toContain(
      `<li class="step" data-state="active">${words(cloudWords("cloud.step.machine"))}</li><li class="step">${words(cloudWords("cloud.step.ready"))}</li>`,
    );
  });

  it("uses its own words for a reason code and the Account's sentence otherwise", () => {
    const own = landing({
      id,
      egress: "pending",
      status: "suspended",
      reason: "Account words",
      reasonCode: "cloud-computer-owner-suspended",
    });
    expect(own).toContain(words(cloudWords("cloud.reason.owner-suspended")));
    expect(own).not.toContain("Account words");
    const given = landing({
      id,
      egress: "pending",
      status: "suspended",
      reason: "Maintenance until 14:00 UTC.",
      reasonCode: "cloud-computer-operator-suspended",
    });
    expect(given).toContain("Maintenance until 14:00 UTC.");
    const noCode = landing({
      id,
      egress: "pending",
      status: "needs_attention",
      reason: "Something happened.",
    });
    expect(noCode).toContain("Something happened.");
  });

  it("shows only the pending state while a deletion waits on the payment provider", () => {
    const body = landing({
      id,
      egress: "pending",
      status: "needs_attention",
      reason: "Deletion is waiting for Stripe cancellation.",
      reasonCode: "cloud-computer-deletion-pending",
    });
    expect(body).toContain(words(cloudWords("cloud.reason.deletion-pending")));
    expect(body).not.toContain('action="/cloud-computer/suspend"');
    expect(body).not.toContain('action="/cloud-computer/delete"');
  });

  it("takes a refusal's next step from its reason code", () => {
    expect(cloudComputerRefusal("conflict", "No capacity", "cloud-computer-no-capacity")).toEqual({
      sentence: cloudWords("cloud.reason.no-capacity"),
      next: cloudWords("cloud.next.no-capacity"),
    });
    expect(cloudComputerRefusal("conflict", "Something else").next).toBe(
      cloudWords("cloud.web.next.other"),
    );
  });
});
