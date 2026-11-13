// @vitest-environment happy-dom
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import type { TeamSessionClient } from "@opensteer/client/team";
import { expect, it, vi } from "vitest";
vi.mock("@react-navigation/native", () => ({
  useFocusEffect: (effect: () => (() => void) | undefined) => useEffect(effect, [effect]),
}));
vi.mock("react-native", () => ({
  StyleSheet: { create: (s: object) => s },
  Platform: { OS: "ios", select: () => 0 },
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("../ui/primitives.js", () => ({}));
import { useFocusedRead } from "./knowledge-parts.js";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
it("never shows Account A's private note while Account B's read is pending", async () => {
  const a = {} as TeamSessionClient,
    b = {} as TeamSessionClient;
  const pending = Promise.withResolvers<string>();
  function Note({ session }: { session: TeamSessionClient | null }) {
    const read = useFocusedRead(
      session,
      (team) => (team === a ? Promise.resolve("Private note A") : pending.promise),
      "note",
    );
    return <p>{read.value}</p>;
  }
  const host = document.createElement("div"),
    root = createRoot(host);
  try {
    await act(async () => root.render(<Note session={a} />));
    expect(host.textContent).toBe("Private note A");
    act(() => root.render(<Note session={null} />));
    expect(host.textContent).not.toContain("Private note A");
    act(() => root.render(<Note session={b} />));
    expect(host.textContent).not.toContain("Private note A");
    await act(async () => pending.resolve("Private note B"));
    expect(host.textContent).toBe("Private note B");
  } finally {
    act(() => root.unmount());
  }
});
