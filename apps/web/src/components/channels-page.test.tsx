// @vitest-environment happy-dom

import {
  ChannelBindingSchema,
  ChannelDashboardSchema,
  createChannelId,
  type ChannelAccount,
  type ChannelBinding,
  type ChannelDashboard,
  type ChannelAccessPolicy,
} from "@opensteer/channel-core";
import type { WorkspaceSummary } from "@opensteer/client/host";
import { act, type ComponentProps, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  AccessRequests,
  AccessPolicyEditor,
  AccountRoutes,
  LinkIdentityForm,
  normalizeChannelIds,
  normalizeLinkCode,
} from "./channels-page.js";

const mountedRoots: Root[] = [];
const workspaceId = "wsp_11111111-1111-4111-8111-111111111111";
const otherWorkspaceId = "wsp_22222222-2222-4222-8222-222222222222";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  for (const root of mountedRoots.splice(0)) act(() => root.unmount());
});

describe("normalizeLinkCode", () => {
  it("reads a code out of what a person pastes from chat", () => {
    expect(normalizeLinkCode("abcd2345")).toBe("ABCD2345");
    expect(normalizeLinkCode("ab cd-23 45")).toBe("ABCD2345");
    // I, O, 0, 1 are not in the alphabet, so they are never part of a code.
    expect(normalizeLinkCode("AIBOCD01")).toBe("ABCD");
    expect(normalizeLinkCode("ABCD2345EFGH")).toBe("ABCD2345");
  });
});

describe("normalizeChannelIds", () => {
  it("reads Slack channel IDs from links and keeps provider IDs", () => {
    expect(
      normalizeChannelIds(
        "https://acme.slack.com/archives/C0123ABC/p123?thread_ts=1, C0456DEF C0123ABC",
      ),
    ).toEqual(["C0123ABC", "C0456DEF"]);
  });
});

describe("LinkIdentityForm", () => {
  it("submits the eight-character code the bot issued", async () => {
    const codes: string[] = [];
    const spend = async (code: string) => {
      codes.push(code);
      return true;
    };
    const { container } = await mount(
      <LinkIdentityForm error={null} linked={null} onLink={spend} pending />,
    );
    const field = input(container);
    // Nothing to redeem while another command is in flight.
    expect(button(container, "Link account").disabled).toBe(true);

    await act(async () => {
      root(container).render(
        <LinkIdentityForm error={null} linked={null} onLink={spend} pending={false} />,
      );
    });
    // A partial code is not a code.
    await type(field, "abcd");
    expect(button(container, "Link account").disabled).toBe(true);
    await type(field, "abcd2345");
    expect(field.value).toBe("ABCD2345");
    expect(button(container, "Link account").disabled).toBe(false);
    await act(async () => {
      button(container, "Link account").click();
    });
    expect(codes).toEqual(["ABCD2345"]);
    // A spent code leaves the field.
    expect(input(container).value).toBe("");
  });

  it("keeps a code that was refused, so a typo can be corrected", async () => {
    const { container } = await mount(
      <LinkIdentityForm error={null} linked={null} onLink={async () => false} pending={false} />,
    );
    await type(input(container), "ABCD2345");
    await act(async () => {
      button(container, "Link account").click();
    });
    expect(input(container).value).toBe("ABCD2345");
  });
});

describe("AccountRoutes", () => {
  it("creates a route from the channel ID, Workspace and access mode", async () => {
    const created: { account: ChannelAccount; route: unknown }[] = [];
    const { container } = await mount(
      <AccountRoutes
        {...routeProps({
          onAddRoute: async (account, route) => {
            created.push({ account, route });
            return true;
          },
        })}
      />,
    );
    await act(async () => {
      button(container, "Add route").click();
    });
    await type(input(container), "C0123ABC");
    const [workspaceSelect, accessSelect] = [...container.querySelectorAll("select")];
    if (!workspaceSelect || !accessSelect) throw new Error("Missing route selects.");
    await select(workspaceSelect, otherWorkspaceId);
    await select(accessSelect, "anyone");
    await act(async () => {
      submitButton(container).click();
    });

    expect(created).toEqual([
      {
        account: account(),
        route: {
          accessPolicy: {
            channels: {
              conversationIds: [],
              scope: "selected",
              sender: { allowedExternalUserIds: [], mode: "anyone" },
            },
            directMessages: { allowedExternalUserIds: [], mode: "off" },
          },
          conversationId: "C0123ABC",
          workspaceId: otherWorkspaceId,
        },
      },
    ]);
    // A created route closes the form again.
    expect([...container.querySelectorAll("select")]).toHaveLength(0);
  });

  it("removes a route once, after the row asks for confirmation", async () => {
    const revoked: string[] = [];
    const only = binding({ conversationId: "C0123ABC" });
    const { container } = await mount(
      <AccountRoutes
        {...routeProps({
          bindings: [only],
          onRevokeRoute: (bindingId) => revoked.push(bindingId),
        })}
      />,
    );
    await act(async () => {
      button(container, "Remove").click();
    });
    // Nothing is dispatched by opening the confirmation.
    expect(revoked).toEqual([]);
    expect(container.textContent).toContain("Stop routing this conversation?");
    // Backing out leaves the route alone.
    await act(async () => {
      button(container, "Keep").click();
    });
    expect(revoked).toEqual([]);

    await act(async () => {
      button(container, "Remove").click();
    });
    await act(async () => {
      button(container, "Remove route").click();
    });
    expect(revoked).toEqual([only.id]);
  });

  it("updates channel and DM access without recreating the route", async () => {
    const updated: unknown[] = [];
    const only = binding({ conversationId: "C0123ABC" });
    const { container } = await mount(
      <AccountRoutes
        {...routeProps({
          bindings: [only],
          onUpdateAccess: async (_binding, accessPolicy) => {
            updated.push(accessPolicy);
            return true;
          },
        })}
      />,
    );
    await act(async () => button(container, "Access").click());
    const dmSelect = container.querySelector<HTMLSelectElement>(
      "select[aria-label='Who can send direct messages']",
    );
    if (!dmSelect) throw new Error("Missing DM access select.");
    await select(dmSelect, "approved");
    await act(async () => button(container, "Save access").click());

    expect(updated).toEqual([
      {
        channels: {
          conversationIds: ["C0123ABC"],
          scope: "selected",
          sender: { allowedExternalUserIds: [], mode: "linked-members" },
        },
        directMessages: { allowedExternalUserIds: [], mode: "approved" },
      },
    ]);
    expect(container.textContent).not.toContain("Save access");
  });
});

describe("AccessPolicyEditor", () => {
  it("shows, edits, and clears migrated external user restrictions", async () => {
    const initialPolicy: ChannelAccessPolicy = {
      channels: {
        conversationIds: ["C0123ABC"],
        scope: "selected",
        sender: { allowedExternalUserIds: ["UOLD1", "UOLD2"], mode: "approved" },
      },
      directMessages: { allowedExternalUserIds: [], mode: "owner" },
    };
    const changes: ChannelAccessPolicy[] = [];
    function ControlledEditor() {
      const [policy, setPolicy] = useState(initialPolicy);
      return (
        <AccessPolicyEditor
          channelInput="C0123ABC"
          onChange={(next) => {
            changes.push(next);
            setPolicy(next);
          }}
          policy={policy}
          providerLabel="Slack"
        />
      );
    }

    const { container } = await mount(<ControlledEditor />);
    const restrictions = container.querySelector<HTMLDetailsElement>(
      "details.channel-access-editor__restrictions",
    );
    if (!restrictions) throw new Error("Missing existing user restrictions.");
    expect(restrictions.textContent).toContain("Existing user restrictions");
    restrictions.open = true;
    const userIds = restrictions.querySelector<HTMLTextAreaElement>("textarea");
    if (!userIds) throw new Error("Missing channel user IDs field.");
    expect(userIds.value).toBe("UOLD1\nUOLD2");

    await typeTextArea(userIds, "UNEW1, UNEW2");
    expect(changes.at(-1)?.channels.sender.allowedExternalUserIds).toEqual(["UNEW1", "UNEW2"]);
    expect(restrictions.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("UNEW1\nUNEW2");

    const updatedUserIds = restrictions.querySelector<HTMLTextAreaElement>("textarea");
    if (!updatedUserIds) throw new Error("Missing updated channel user IDs field.");
    await typeTextArea(updatedUserIds, "");
    expect(changes.at(-1)?.channels.sender.allowedExternalUserIds).toEqual([]);
    expect(container.querySelector("details.channel-access-editor__restrictions")).toBeNull();
  });
});

describe("AccessRequests", () => {
  it("keeps a pending request actionable and allows approved access to be revoked", async () => {
    const reviews: string[] = [];
    const grants = dashboard({
      accessGrants: [
        accessGrant({ displayName: "Ada", externalUserId: "UADA", status: "pending" }),
        accessGrant({ displayName: "Grace", externalUserId: "UGRACE", status: "approved" }),
      ],
    }).accessGrants;
    const { container } = await mount(
      <AccessRequests
        accounts={[account()]}
        grants={grants}
        onReview={(grant, decision) => reviews.push(`${grant.externalUserId}:${decision}`)}
        pending={false}
      />,
    );
    expect(container.textContent).toContain(
      "Requests stay here until you approve or decline them.",
    );
    await act(async () => button(container, "Approve").click());
    const history = container.querySelector("details");
    if (!history) throw new Error("Missing access history.");
    history.open = true;
    await act(async () => button(container, "Revoke").click());
    expect(reviews).toEqual(["UADA:approved", "UGRACE:revoked"]);
  });

  it("shows external IDs and lets declined or revoked history be approved again", async () => {
    const reviews: string[] = [];
    const grants = dashboard({
      accessGrants: [
        accessGrant({ displayName: "Alex", externalUserId: "UDECLINED", status: "declined" }),
        accessGrant({ displayName: "Alex", externalUserId: "UREVOKED", status: "revoked" }),
      ],
    }).accessGrants;
    const { container } = await mount(
      <AccessRequests
        accounts={[account()]}
        grants={grants}
        onReview={(grant, decision) => reviews.push(`${grant.externalUserId}:${decision}`)}
        pending={false}
      />,
    );
    const history = container.querySelector<HTMLDetailsElement>("details");
    if (!history) throw new Error("Missing access history.");
    history.open = true;
    const historyRows = [...history.querySelectorAll(".card__row")].map(
      (row) => row.textContent ?? "",
    );
    expect(historyRows).toEqual(
      expect.arrayContaining([
        expect.stringContaining("UDECLINED"),
        expect.stringContaining("UREVOKED"),
      ]),
    );
    const approveButtons = [...history.querySelectorAll("button")].filter(
      (candidate) => candidate.textContent === "Approve",
    );
    expect(approveButtons).toHaveLength(2);
    await act(async () => approveButtons[0]?.click());
    await act(async () => approveButtons[1]?.click());
    expect(reviews).toEqual(["UDECLINED:approved", "UREVOKED:approved"]);
  });
});

const workspaces: readonly WorkspaceSummary[] = [
  workspace({ id: workspaceId, name: "Engineering" }),
  workspace({ id: otherWorkspaceId, name: "Support" }),
];

function workspace(fields: { id: string; name: string }): WorkspaceSummary {
  return {
    description: "",
    fileCount: 0,
    homeThreadId: null,
    harnessLabel: "Claude",
    icon: null,
    kind: "specialized",
    machineName: null,
    runnerLabel: "Main",
    status: "ready",
    storageIssue: null,
    color: "blue",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...fields,
  };
}

function account(fields: Partial<ChannelAccount> = {}): ChannelAccount {
  return {
    connectionId,
    createdAt: "2026-01-01T00:00:00.000Z",
    displayName: "Opensteer bot",
    externalAccountId: "T0123ABC",
    handle: "opensteer",
    id: accountId,
    metadata: {},
    provider: "slack",
    routingMode: "shared",
    status: "connected",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...fields,
  };
}

const accountId = createChannelId("account");
const connectionId = createChannelId("connection");

function dashboard(fields: Partial<ChannelDashboard> = {}): ChannelDashboard {
  return ChannelDashboardSchema.parse({
    accounts: [],
    accessGrants: [],
    bindings: [],
    connections: [],
    deliveriesNeedingAttention: 0,
    providers: [],
    ...fields,
  });
}

function routeProps(
  overrides: Partial<ComponentProps<typeof AccountRoutes>> = {},
): ComponentProps<typeof AccountRoutes> {
  return {
    account: account(),
    bindings: [],
    homeWorkspaceId: workspaceId,
    onAddRoute: async () => true,
    onRevokeRoute: () => undefined,
    onUpdateAccess: async () => true,
    pending: false,
    providerLabel: "Slack",
    workspaces,
    ...overrides,
  };
}

function binding(
  selector: { conversationId: string | null },
  status: ChannelBinding["status"] = "active",
): ChannelBinding {
  return ChannelBindingSchema.parse({
    accessPolicy: {
      channels: {
        conversationIds: selector.conversationId ? [selector.conversationId] : [],
        scope: selector.conversationId ? "selected" : "all",
        sender: { allowedExternalUserIds: [], mode: "linked-members" },
      },
      directMessages: { allowedExternalUserIds: [], mode: "owner" },
    },
    accountId,
    createdAt: "2026-01-01T00:00:00.000Z",
    createdBy: "usr_44444444-4444-4444-8444-444444444444",
    executionPolicy: { harness: "default", harnessInstanceId: null },
    id: createChannelId("binding"),
    revision: 1,
    selector: { ...selector, conversationType: null, scopeId: null, threadId: null },
    status,
    updatedAt: "2026-01-01T00:00:00.000Z",
    workspaceId,
  });
}

function accessGrant(
  fields: Partial<ChannelDashboard["accessGrants"][number]> = {},
): ChannelDashboard["accessGrants"][number] {
  return {
    accountId,
    bindingId: createChannelId("binding"),
    decidedAt: null,
    decidedBy: null,
    displayName: "Ada",
    externalUserId: "U0123ABC",
    requestedAt: "2026-01-01T00:00:00.000Z",
    revision: 1,
    status: "pending",
    ...fields,
  };
}

async function mount(element: React.ReactElement) {
  const container = document.createElement("div");
  document.body.append(container);
  const created = createRoot(container);
  mountedRoots.push(created);
  roots.set(container, created);
  await act(async () => {
    created.render(element);
  });
  return { container };
}

const roots = new WeakMap<HTMLElement, Root>();

function root(container: HTMLElement): Root {
  const found = roots.get(container);
  if (!found) throw new Error("Missing React root.");
  return found;
}

function input(container: HTMLElement): HTMLInputElement {
  const found = container.querySelector("input");
  if (!found) throw new Error("Missing input.");
  return found;
}

/** React listens for the bubbled "input" event, not for a value assignment. */
async function type(field: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    setter?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function typeTextArea(field: HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    setter?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function select(field: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLSelectElement.prototype,
      "value",
    )?.set;
    setter?.call(field, value);
    field.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function button(container: HTMLElement, text: string): HTMLButtonElement {
  const match = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === text,
  );
  if (!match) throw new Error(`Missing button: ${text}`);
  return match;
}

function submitButton(container: HTMLElement): HTMLButtonElement {
  const match = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.type === "submit",
  );
  if (!match) throw new Error("Missing submit button.");
  return match;
}
