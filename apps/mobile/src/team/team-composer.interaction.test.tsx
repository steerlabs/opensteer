// @vitest-environment happy-dom
import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { TeamComposer } from "./team-composer.js";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
vi.mock("react-native", () => ({
  Platform: {
    OS: "ios",
    select: (options: { ios?: unknown; default?: unknown }) => options.ios ?? options.default,
  },
  StyleSheet: { create: (styles: object) => styles, hairlineWidth: 1 },
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Pressable: ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) => (
    <button onClick={onPress}>{children}</button>
  ),
  TextInput: () => null,
}));
vi.mock("../thread/composer-bar.js", () => ({
  ComposerBar: () => null,
  ComposerGlyph: () => null,
  composerLaneHeight: 44,
}));
vi.mock("../ui/primitives.js", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../ui/symbol.js", () => ({ Symbol: () => null }));
vi.mock("../ui/composer-action.js", () => ({ ComposerAction: () => null }));
vi.mock("./attachments.js", () => ({ StagedAttachments: () => null }));
vi.mock("./mention-list.js", () => ({ MentionList: () => null }));
vi.mock("./team-marks.js", () => ({ AgentOrb: () => null, PeopleOnlyBadge: () => null }));
it.each(["people-only", "not-connected"] as const)(
  "can disable an enabled recipient after the agent becomes %s",
  (agent) => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const change = vi.fn();
    const props: ComponentProps<typeof TeamComposer> = {
      placeholder: "Reply",
      text: "",
      onChangeText: vi.fn(),
      agent: "available",
      sticky: true,
      toMyAgent: true,
      onToMyAgentChange: change,
      onAgentUnavailable: vi.fn(),
      mentions: null,
      onPickMention: vi.fn(),
      onMention: vi.fn(),
      attachments: [],
      onAttach: vi.fn(),
      onRemoveAttachment: vi.fn(),
      onSend: vi.fn(),
    };
    try {
      act(() => root.render(<TeamComposer {...props} />));
      act(() => root.render(<TeamComposer {...props} agent={agent} />));
      const button = [...host.querySelectorAll("button")].find((b) =>
        b.textContent?.includes("→ your agent"),
      );
      expect(button, "The enabled recipient must remain removable").toBeDefined();
      act(() => button!.click());
      expect(change).toHaveBeenCalledExactlyOnceWith(false);
      act(() => root.render(<TeamComposer {...props} agent={agent} toMyAgent={false} />));
      expect(host.textContent).not.toContain("+ your agent");
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  },
);
