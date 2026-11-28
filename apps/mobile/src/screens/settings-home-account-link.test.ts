import { describe, expect, it, vi } from "vitest";
import type { HomeAccountLinkSnapshot } from "@opensteer/client/host";
import { homeAccountLinkSections } from "./settings-home-account-link.js";

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
const idle = { error: null, actionError: null, working: false } as const;

function rows(state: HomeAccountLinkSnapshot) {
  const act = { link: vi.fn(), unlink: vi.fn(), confirm: vi.fn() };
  const [section] = homeAccountLinkSections(state, act);
  return { act, section: section! };
}

describe("the phone's Opensteer account card for a Home at its own address", () => {
  it("links a Home that isn't linked", () => {
    const { act, section } = rows({ ...idle, status: status(null) });
    const action = section.rows.find((row) => row.kind === "button");
    expect(action).toMatchObject({ label: "Link account", destructive: false });
    (action as { onPress: () => void }).onPress();
    expect(act.link).toHaveBeenCalledOnce();
  });

  it("asks before unlinking", () => {
    const { act, section } = rows({ ...idle, status: status("active") });
    expect(section.rows[0]).toMatchObject({ kind: "status", tone: "good" });
    const action = section.rows.find((row) => row.kind === "button") as { onPress: () => void };
    action.onPress();
    expect(act.unlink).not.toHaveBeenCalled();
    expect(act.confirm).toHaveBeenCalledWith(expect.stringContaining("signed out"), act.unlink);
  });

  it("offers nothing to change on a Cloud Computer, and says a failure plainly", () => {
    const { section } = rows({
      ...idle,
      actionError: "A Cloud Computer stays linked to the Opensteer account that owns it.",
      status: status("active", true),
    });
    expect(section.rows.filter((row) => row.kind === "button")).toEqual([]);
    expect(section.footer).toMatchObject({ tone: "danger" });
  });
});
