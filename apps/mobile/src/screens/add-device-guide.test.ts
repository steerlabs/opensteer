import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  Platform: { OS: "ios", select: (values: { ios?: unknown }) => values.ios },
  StyleSheet: { create: (styles: object) => styles, hairlineWidth: 1 },
  View: () => null,
}));
vi.mock("../ui/primitives.js", () => ({}));

const { addDeviceGuideSections } = await import("./add-device-guide.js");

function macRows(portalOrigin: string | null) {
  const share = vi.fn();
  const sections = addDeviceGuideSections({
    onConnectSomethingElse: () => undefined,
    mac: { homeName: "Mac mini", portalOrigin, onShareLink: share },
  });
  const rows = sections.find((section) => section.key === "mac")!.rows;
  return { rows, share };
}

describe("Add a device › A Mac on the phone", () => {
  it("sends the Mac app's link from the Opensteer account, then says what to do on the Mac", () => {
    const { rows, share } = macRows("https://opensteer.example");
    expect(rows.map((row) => row.label)).toEqual([
      "1. Install Opensteer on the Mac.",
      "Send me the Mac link",
      "2. Sign in with the same Opensteer account.",
      "3. Open Mac mini there and choose Connect. You choose what your agent can use on the Mac.",
    ]);
    const send = rows.find((row) => row.kind === "button")!;
    if (send.kind !== "button") throw new Error("Expected the link's button");
    send.onPress();
    expect(share).toHaveBeenCalledExactlyOnceWith("https://opensteer.example/mac");
  });

  it("points a Home with no Opensteer account to its pairing code, with no link", () => {
    const { rows } = macRows(null);
    expect(rows.some((row) => row.kind === "button")).toBe(false);
    expect(rows.map((row) => row.label)).toEqual([
      "1. Install Opensteer on the Mac.",
      "2. Connect it with a pairing code: in Opensteer on Mac mini, choose Add a device › Advanced › Use a pairing code.",
    ]);
    expect(rows.map((row) => row.label).join(" ")).not.toContain("Opensteer account");
  });
});
