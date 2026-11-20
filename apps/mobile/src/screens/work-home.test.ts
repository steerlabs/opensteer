import { workHomeCard } from "@opensteer/client/computers";
import { mockWorkHome } from "@opensteer/client/mock";
import { WorkAuditRecordSchema } from "@opensteer/control-plane-protocol";
import { describe, expect, it, vi } from "vitest";

vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({}) }));
vi.mock("../ui/mobile-client-context.js", () => ({ useMobileClient: () => ({}) }));
vi.mock("./native-settings-page.js", () => ({ NativeSettingsPage: () => null }));
const { homeWorkSection, workHomeSeeSections } = await import("./work-home.js");

const card = workHomeCard(mockWorkHome("dep_00000000-0000-4000-8000-0000000000dd"), "en-US");

describe("what an organization can see, on the phone", () => {
  it("lists every record kind the Home sends, and what never leaves it", () => {
    const sections = workHomeSeeSections(card);
    expect(sections.find(({ key }) => key === "records")?.rows).toHaveLength(
      WorkAuditRecordSchema.options.length,
    );
    expect(sections.find(({ key }) => key === "sees")?.title).toBe("Acme Robotics can see");
    const never = sections.find(({ key }) => key === "never");
    expect(never?.title).toBe("Acme Robotics can never see");
    expect(never?.rows.map(({ label }) => label)).toEqual(
      expect.arrayContaining([
        "Addresses or titles of pages",
        "Messages or prompts",
        "Screenshots",
        "Your personal Opensteer and your own computers",
      ]),
    );
  });

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
