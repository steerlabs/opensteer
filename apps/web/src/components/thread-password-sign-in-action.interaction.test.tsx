// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockPasswordSignInRequest, MockHostClient } from "@opensteer/client/mock";
import type { PasswordSignInCard } from "@opensteer/protocol";
import { PasswordSignInRequestBody } from "./thread-password-sign-in-action.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});
const account = {
  id: "00000000-0000-4000-8000-000000000001",
  revision: 3,
  username: "alex@example.com",
  host: "github.com",
  onPage: false,
  updatedAt: "2026-10-13T00:00:00.000Z",
  label: null,
};
async function mount(
  card: PasswordSignInCard = { stage: "approval", accounts: [account], permissionVersion: 6 },
) {
  const base = new MockHostClient({ latencyMs: 0 });
  const read = vi.fn(async () => ({ ok: true as const, data: card }));
  const dispatch = vi
    .fn<MockHostClient["dispatch"]>()
    .mockResolvedValue({ type: "browser.password-sign-in.respond", status: "fulfilled" });
  const client = { rpc: { ...base.rpc, "browser.password-sign-in.get": read }, dispatch };
  const page = document.createElement("div");
  document.body.append(page);
  const root = createRoot(page);
  roots.push(root);
  await act(async () =>
    root.render(
      <PasswordSignInRequestBody
        client={client}
        disabled={false}
        request={mockPasswordSignInRequest()}
      />,
    ),
  );
  return { page, dispatch, read, client };
}
function button(page: HTMLElement, label: string) {
  const found = [...page.querySelectorAll("button")].find((el) => el.textContent?.trim() === label);
  if (!found) throw new Error(`Missing ${label}`);
  return found;
}

describe("Passwords approval through the Host", () => {
  it.each([
    ["Allow", true],
    ["Only this time", false],
  ] as const)(
    "%s sends the exact offered account and consent without a desktop bridge",
    async (label, remember) => {
      const h = await mount();
      expect(h.read).toHaveBeenCalledTimes(1);
      expect(h.page.textContent).toContain(account.username);
      await act(async () => button(h.page, label).click());
      expect(h.dispatch).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          type: "browser.password-sign-in.respond",
          decision: {
            kind: "approve",
            loginId: account.id,
            revision: 3,
            remember,
            permissionVersion: 6,
          },
        }),
      );
    },
  );
  it("requires an explicit choice among accounts", async () => {
    const h = await mount({
      stage: "approval",
      permissionVersion: 6,
      accounts: [
        account,
        { ...account, id: "00000000-0000-4000-8000-000000000002", username: "work@example.com" },
      ],
    });
    expect(button(h.page, "Allow").disabled).toBe(true);
    await act(async () =>
      h.page.querySelector<HTMLInputElement>(`input[value="${account.id}"]`)!.click(),
    );
    expect(button(h.page, "Allow").disabled).toBe(false);
  });
  it("keeps a stale revision pending and displays the refreshed chooser", async () => {
    const h = await mount();
    h.dispatch.mockResolvedValue({
      type: "browser.password-sign-in.respond",
      status: "pending",
      message: "That account changed. Choose it again.",
      card: { stage: "approval", permissionVersion: 6, accounts: [{ ...account, revision: 4 }] },
    });
    await act(async () => button(h.page, "Allow").click());
    expect(h.page.textContent).toContain("That account changed");
    await act(async () => button(h.page, "Only this time").click());
    expect(h.dispatch.mock.calls[1]?.[0]).toMatchObject({
      decision: { revision: 4, remember: false },
    });
  });
  it("declines through the same command even when the authority is gone", async () => {
    const h = await mount({ stage: "gone" });
    await act(async () => button(h.page, "Don’t allow").click());
    expect(h.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ decision: { kind: "decline" } }),
    );
    expect(h.page.textContent).not.toContain("Only this time");
  });
  it("never offers approval after expiry", async () => {
    const client = new MockHostClient({ latencyMs: 0 });

    const request = mockPasswordSignInRequest();
    if (request.payload.kind !== "browser.password-sign-in") throw new Error("Wrong request");
    request.payload.expiresAt = new Date(0).toISOString();
    const page = document.createElement("div");
    const root = createRoot(page);
    roots.push(root);
    await act(async () =>
      root.render(<PasswordSignInRequestBody client={client} disabled={false} request={request} />),
    );
    expect(page.textContent).not.toContain("Only this time");
  });
});
