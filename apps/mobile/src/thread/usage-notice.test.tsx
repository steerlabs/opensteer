// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import {
  createUsageNoticeDismissals,
  type UsageLimitNotice,
  type UsageNoticeDismissals,
} from "@opensteer/client/host";
import { MemoryPrivateFilesystem } from "@opensteer/client/test-support";
import { createUsageNoticesFile } from "../client/usage-notices-file.js";

let dismissals: UsageNoticeDismissals;
vi.mock("../ui/mobile-client-context.js", () => ({
  useMobileClient: () => ({ usageNotices: dismissals }),
}));
vi.mock("react-native", () => ({
  Platform: { OS: "ios", Version: "26" },
  Pressable: (props: {
    accessibilityLabel?: string;
    children?: ReactNode;
    onPress: () => void;
  }) => (
    <button aria-label={props.accessibilityLabel} onClick={props.onPress} type="button">
      {props.children}
    </button>
  ),
  StyleSheet: { create: (styles: object) => styles },
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../ui/symbol.js", () => ({ Symbol: () => null }));
vi.mock("../ui/primitives.js", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
const { UsageNotice } = await import("./usage-notice.js");
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const notice = (key: string): UsageLimitNotice => ({
  accountTitle: "work@example.test",
  engineName: "Codex",
  key,
  resetsAt: "Wed 1:35 AM",
});

it("keeps a dismissed limit hidden across launches, and says the next one", async () => {
  const privateFiles = new MemoryPrivateFilesystem();
  const launch = async () => {
    dismissals = createUsageNoticeDismissals(
      createUsageNoticesFile({ filePath: "/private/usage-notices.json", privateFiles }),
    );
    // The file is read before anything is shown.
    await vi.waitFor(() => expect(dismissals.getSnapshot()).not.toBeNull(), { timeout: 1_000 });
  };
  const container = document.createElement("div");
  const root = createRoot(container);
  const open = vi.fn();
  const show = (key: string) =>
    act(() => root.render(<UsageNotice notice={notice(key)} onOpen={open} />));
  try {
    await launch();
    show("deployment/user/main/codex/weekly-1");
    expect(container.textContent).toBe("Codex usage limit · Resets Wed 1:35 AM");
    act(() => container.querySelector<HTMLButtonElement>("button")?.click());
    expect(open).toHaveBeenCalledOnce();

    act(() =>
      container.querySelector<HTMLButtonElement>('[aria-label="Dismiss usage notice"]')?.click(),
    );
    expect(container.textContent).toBe("");

    await launch();
    show("deployment/user/main/codex/weekly-1");
    expect(container.textContent).toBe("");
    show("deployment/user/main/codex/weekly-2");
    expect(container.textContent).toBe("Codex usage limit · Resets Wed 1:35 AM");
  } finally {
    act(() => root.unmount());
  }
});
