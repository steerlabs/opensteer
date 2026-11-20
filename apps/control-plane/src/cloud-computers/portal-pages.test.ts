import { CloudComputerIdSchema, cloudWords } from "@opensteer/control-plane-protocol";
import { escapeHtml } from "@opensteer/shared/browserPage";
import { describe, expect, it } from "vitest";
import {
  cloudComputerCheckoutBody,
  cloudComputerLandingBody,
  cloudComputerRefusal,
  cloudComputerUnavailableBody,
} from "./portal-pages.js";

const plan = {
  name: "Cloud Computer",
  currency: "usd",
  amountMinor: 2900,
  interval: "month" as const,
};
const id = CloudComputerIdSchema.parse("cc_00000000-0000-4000-8000-000000000001");
const words = (text: string) => escapeHtml(text);

describe("Cloud Computer website pages", () => {
  it("offers sign-in with the price when signed out, and never a checkout form", () => {
    const body = cloudComputerLandingBody({
      state: { kind: "signed-out", plan, signInHref: "/sign-in?return=%2Fcloud-computer" },
      refusal: null,
      notice: null,
    });
    expect(body).toContain("$29.00 a month");
    expect(body).toContain(words(cloudWords("cloud.point.awake.title")));
    expect(body).toContain('href="/sign-in?return=%2Fcloud-computer"');
    expect(body).not.toContain("<form");
  });

  it("links an offer to the checkout page and says when the last one was deleted", () => {
    const body = cloudComputerLandingBody({
      state: { kind: "offer", plan, deleted: true, work: [] },
      refusal: null,
      notice: null,
    });
    expect(body).toContain('href="/cloud-computer/checkout"');
    expect(body).toContain(words(cloudWords("cloud.web.deleted.detail")));
    expect(body).not.toContain("<form");
  });

  it("asks for one explicit click to buy, carrying the request id", () => {
    const body = cloudComputerCheckoutBody({
      plan,
      requestId: "00000000-0000-4000-8000-000000000009",
      refusal: cloudComputerRefusal("conflict", "This Account already has a checkout in progress"),
    });
    expect(body).toContain('<form method="post" action="/cloud-computer/checkout">');
    expect(body).toContain('name="requestId" value="00000000-0000-4000-8000-000000000009"');
    expect(body).toContain('type="submit">Continue to checkout</button>');
    expect(body).toContain(words(cloudWords("cloud.web.next.inProgress")));
    expect(body).not.toContain("<script");
  });

  it("shows setup steps without power controls while preparing", () => {
    const body = cloudComputerLandingBody({
      state: {
        kind: "computer",
        plan,
        openHref: null,
        work: [],
        computer: { id, egress: "pending", status: "preparing" },
      },
      refusal: null,
      notice: null,
    });
    expect(body).toContain(words(cloudWords("cloud.preparing.title")));
    expect(body).toContain(words(cloudWords("cloud.web.preparing.refresh")));
    expect(body).not.toContain("/cloud-computer/suspend");
    expect(body).not.toContain("/cloud-computer/delete");
  });

  it("shows a ready computer's address, browser IP, billing and confirmed power actions", () => {
    const body = cloudComputerLandingBody({
      state: {
        kind: "computer",
        plan,
        openHref: null,
        work: [],
        computer: {
          id,
          egress: "assigned",
          status: "ready",
          address: "https://a.home.example.test",
        },
      },
      refusal: null,
      notice: null,
    });
    expect(body).toContain("https://a.home.example.test");
    expect(body).toContain(words(cloudWords("cloud.ip.assignedDetail")));
    expect(body).toContain('href="/cloud-computer/billing"');
    expect(body).toMatch(/<details[^>]*><summary[^>]*>Suspend<\/summary>/u);
    expect(body).toContain('action="/cloud-computer/suspend"');
    expect(body).toContain(`name="id" value="${id}"`);
    expect(body).toContain('action="/cloud-computer/delete"');
    expect(body).not.toContain("/cloud-computer/resume");
  });

  it("offers resume for a suspended computer and shows the store's reason", () => {
    const body = cloudComputerLandingBody({
      state: {
        kind: "computer",
        plan,
        openHref: null,
        work: [],
        computer: {
          id,
          egress: "pending",
          status: "suspended",
          reason: "You paused this Cloud Computer.",
        },
      },
      refusal: null,
      notice: null,
    });
    expect(body).toContain("You paused this Cloud Computer.");
    expect(body).toContain('action="/cloud-computer/resume"');
    expect(body).not.toContain('action="/cloud-computer/suspend"');
  });

  it("warns when it needs attention or its browser IP is paused, and opens delete after a mistyped word", () => {
    const body = cloudComputerLandingBody({
      state: {
        kind: "computer",
        plan,
        openHref: null,
        work: [],
        computer: {
          id,
          egress: "unavailable",
          status: "needs_attention",
          reason: "Boot failed <badly>",
        },
      },
      refusal: {
        sentence: cloudWords("cloud.web.typeWord"),
        next: cloudWords("cloud.delete.body"),
      },
      notice: null,
    });
    expect(body).toContain(words(cloudWords("cloud.status.attention")));
    expect(body).toContain("Boot failed &lt;badly&gt;");
    expect(body).toContain(words(cloudWords("cloud.ip.pausedDetail")));
    expect(body).toContain('role="alert"');
    expect(body).toMatch(/<details class="cloud-computer__confirm" open>/u);
  });

  it("explains the next step for each kind of refusal", () => {
    expect(cloudComputerRefusal("unavailable", "Not now").next).toBe(
      cloudWords("cloud.web.next.unavailable"),
    );
    expect(
      cloudComputerRefusal("conflict", "This Account already has a Cloud Computer subscription")
        .next,
    ).toBe(cloudWords("cloud.web.next.subscribed"));
    expect(cloudComputerRefusal("conflict", "This checkout expired").next).toBe(
      cloudWords("cloud.web.next.expired"),
    );
    expect(cloudComputerRefusal("conflict", "Something else").next).toBe(
      cloudWords("cloud.web.next.other"),
    );
  });

  it("says plainly when this Account offers no Cloud Computers", () => {
    expect(cloudComputerUnavailableBody()).toContain(
      words(cloudWords("cloud.web.unavailable.title")),
    );
  });
});
