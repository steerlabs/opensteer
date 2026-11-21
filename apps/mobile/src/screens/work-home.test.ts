import { workHomeCard } from "@opensteer/client/computers";
import { mockWorkHome } from "@opensteer/client/mock";
import { describe, expect, it, vi } from "vitest";

vi.mock("../ui/mobile-client-context.js", () => ({ useMobileClient: () => ({}) }));
const { homeWorkSection } = await import("./work-home.js");

const card = workHomeCard(mockWorkHome("dep_00000000-0000-4000-8000-0000000000dd"), "en-US");

describe("what an organization can see, on the phone", () => {
  it("puts the badge and the way to it on the work Home's own page", () => {
    const onSee = vi.fn();
    const section = homeWorkSection(card, onSee);
    expect(section.rows[0]).toMatchObject({
      label: "Work · Acme Robotics",
      detail: "What Acme Robotics can see",
    });
    const first = section.rows[0];
    if (first?.kind !== "button") throw new Error("not a button");
    first.onPress();
    expect(onSee).toHaveBeenCalledWith(card);
    expect(section.footer?.text).toContain("Managed by Acme Robotics");
  });
});
