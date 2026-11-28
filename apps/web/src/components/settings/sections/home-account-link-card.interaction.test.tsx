// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HomeAccountLinkSnapshot } from "@opensteer/client/host";
import { HomeAccountLinkCardView } from "./home-account-link-card.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

const status = (accountLink: "active" | null, managed = false) =>
  ({
    accountIssuer: "https://accounts.example.test",
    accountLink:
      accountLink === null
        ? null
        : {
            generation: "g".repeat(43),
            issuer: "https://accounts.example.test",
            state: accountLink,
            subject: "acct_0192f4a1-1111-4000-8000-000000000001",
          },
    authorityEnvelope: {},
    managed,
  }) as unknown as HomeAccountLinkSnapshot["status"];

async function mount(state: HomeAccountLinkSnapshot) {
  const onLink = vi.fn();
  const onUnlink = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(<HomeAccountLinkCardView onLink={onLink} onUnlink={onUnlink} state={state} />),
  );
  return { container, onLink, onUnlink };
}

const button = (container: HTMLElement) => container.querySelector("button");
const idle = { error: null, actionError: null, working: false } as const;

describe("the Opensteer account card on a Home at its own address", () => {
  it("links a Home that isn't linked", async () => {
    const { container, onLink } = await mount({ ...idle, status: status(null) });
    expect(container.textContent).toContain("Not linked to an Opensteer account");
    await act(async () => button(container)!.click());
    expect(onLink).toHaveBeenCalledOnce();
  });

  it("asks before unlinking, and unlinks only when the person agrees", async () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    const { container, onUnlink } = await mount({ ...idle, status: status("active") });
    expect(container.textContent).toContain("Linked to your Opensteer account");
    await act(async () => button(container)!.click());
    expect(confirm).toHaveBeenCalledOnce();
    expect(onUnlink).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    await act(async () => button(container)!.click());
    expect(onUnlink).toHaveBeenCalledOnce();
  });

  it("offers nothing to change on a Cloud Computer, and says a failure plainly", async () => {
    const { container } = await mount({
      ...idle,
      actionError: "A Cloud Computer stays linked to the Opensteer account that owns it.",
      status: status("active", true),
    });
    expect(button(container)).toBeNull();
    expect(container.textContent).toContain("stays linked to the Opensteer account that owns it");
  });
});
