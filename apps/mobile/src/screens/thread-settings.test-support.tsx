import { type ReactNode } from "react";

import { createUsageNoticeDismissals, type HostClient } from "@opensteer/client/host";

import { vi } from "vitest";
import { Window } from "happy-dom";

// Keep the actual screens, picker controller, shared client, HTTP, Runner and
// database. Only native display/navigation controls get DOM equivalents.
vi.mock("react-native", () => ({
  KeyboardAvoidingView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Platform: { OS: "ios" },
  useWindowDimensions: () => ({ fontScale: 1, height: 844, width: 390 }),
  ActivityIndicator: () => <span>Checking…</span>,
  Alert: { alert: vi.fn() },
  Text: ({
    children,
    numberOfLines,
    ellipsizeMode,
  }: {
    children?: ReactNode;
    numberOfLines?: number;
    ellipsizeMode?: string;
  }) => (
    <span data-lines={numberOfLines} data-ellipsis={ellipsizeMode}>
      {children}
    </span>
  ),
  BackHandler: { addEventListener: () => ({ remove: () => undefined }) },
  FlatList: ({
    data,
    ListHeaderComponent,
    ListFooterComponent,
    renderItem,
  }: {
    data: readonly unknown[];
    ListHeaderComponent: ReactNode;
    ListFooterComponent: ReactNode;
    renderItem: (input: { item: unknown }) => ReactNode;
  }) => (
    <div>
      {ListHeaderComponent}
      {data.map((item, index) => (
        <div key={index}>{renderItem({ item })}</div>
      ))}
      {ListFooterComponent}
    </div>
  ),
  Pressable: ({
    accessibilityLabel,
    accessibilityRole,
    accessibilityHint,
    accessibilityState,
    children,
    disabled,
    onPress,
  }: {
    accessibilityLabel?: string;
    accessibilityRole?: string;
    accessibilityHint?: string;
    accessibilityState?: { selected?: boolean };
    children?: ReactNode;
    disabled?: boolean;
    onPress?: () => void;
  }) => (
    <button
      aria-label={accessibilityLabel}
      aria-description={accessibilityHint}
      aria-checked={accessibilityState?.selected}
      disabled={disabled}
      onClick={onPress}
      role={accessibilityRole}
    >
      {children}
    </button>
  ),
  ScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  StyleSheet: { create: (styles: object) => styles, hairlineWidth: 1 },
  TextInput: ({
    accessibilityLabel,
    value,
    onChangeText,
  }: {
    accessibilityLabel: string;
    value: string;
    onChangeText: (text: string) => void;
  }) => (
    <input
      aria-label={accessibilityLabel}
      value={value}
      onInput={(event) => onChangeText(event.currentTarget.value)}
    />
  ),
  View: ({
    children,
    accessibilityRole,
    accessibilityLabel,
    onAccessibilityAction,
  }: {
    children?: ReactNode;
    accessibilityRole?: string;
    accessibilityLabel?: string;
    onAccessibilityAction?: (event: { nativeEvent: { actionName: string } }) => void;
  }) => (
    <div
      role={accessibilityRole}
      aria-label={accessibilityLabel}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight")
          onAccessibilityAction?.({
            nativeEvent: { actionName: event.key === "ArrowLeft" ? "decrement" : "increment" },
          });
      }}
    >
      {children}
    </div>
  ),
}));
const navigation = vi.hoisted(() => ({
  goBack: vi.fn(),
  isFocused: () => true,
  addListener: () => () => undefined,
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => navigation,
  useFocusEffect: () => undefined,
  useIsFocused: () => true,
}));
vi.mock("expo-haptics", () => ({ selectionAsync: async () => undefined }));
vi.mock("../thread/composer-menu.js", () => ({
  NativeMenu: ({
    accessibilityLabel,
    children,
    options,
  }: {
    accessibilityLabel: string;
    children?: ReactNode;
    options: readonly { id: string; label: string; disabled?: boolean; onPress: () => void }[];
  }) => (
    <div aria-label={accessibilityLabel}>
      {children}
      {options.map((option) => (
        <button key={option.id} disabled={option.disabled} onClick={option.onPress}>
          {option.label}
        </button>
      ))}
    </div>
  ),
}));
vi.mock("@react-navigation/elements", () => ({ useHeaderHeight: () => 0 }));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
}));
vi.mock("../ui/keyboard.js", () => ({ useKeyboardVisible: () => false }));
vi.mock("../thread/attachment-views.js", () => ({ AttachmentStrip: () => null }));
vi.mock("../platform/attachment-draft-files.js", () => ({
  copyFirstMessageDraftFileToThread: vi.fn(),
}));
vi.mock("../thread/draft-attachments.js", () => ({
  attachmentKey: vi.fn(),
  draftAttachmentPart: vi.fn(),
  forgetDraftFiles: vi.fn(),
}));
vi.mock("../thread/composer-bar.js", () => ({
  ComposerBar: ({
    accessory,
    action,
    field,
  }: {
    accessory: ReactNode;
    action: ReactNode;
    field: ReactNode;
  }) => (
    <div>
      {accessory}
      {field}
      {action}
    </div>
  ),
  ComposerGlyph: () => null,
  composerLaneHeight: 44,
}));
vi.mock("../ui/composer-action.js", () => ({
  ComposerAction: ({
    disabled,
    label,
    onPress,
  }: {
    disabled: boolean;
    label: string;
    onPress: () => void;
  }) => (
    <button aria-label={label} disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("../ui/screen.js", () => ({
  useListContentInsets: () => ({}),
  useReadingColumn: () => ({}),
  useGutter: () => 16,
}));
vi.mock("react-native-svg", () => ({
  default: ({ children }: { children?: ReactNode }) => <svg>{children}</svg>,
  Path: ({ d }: { d: string }) => <path d={d} />,
}));
vi.mock("../ui/symbol.js", () => ({ Symbol: () => null }));
vi.mock("../ui/primitives.js", () => ({
  AppText: ({
    children,
    numberOfLines,
    ellipsizeMode,
  }: {
    children?: ReactNode;
    numberOfLines?: number;
    ellipsizeMode?: string;
  }) => (
    <span data-lines={numberOfLines} data-ellipsis={ellipsizeMode}>
      {children}
    </span>
  ),
  Notice: ({ title, detail }: { title: string; detail: string }) => (
    <p>
      {title}: {detail}
    </p>
  ),
  PrimaryButton: ({
    label,
    onPress,
    disabled,
  }: {
    label: string;
    onPress: () => void;
    disabled?: boolean;
  }) => (
    <button disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
  SecondaryButton: ({
    label,
    onPress,
    disabled,
  }: {
    label: string;
    onPress: () => void;
    disabled?: boolean;
  }) => (
    <button disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
  RowGroup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SwitchRow: ({
    label,
    value,
    disabled,
    onChange,
  }: {
    label: string;
    value: boolean;
    disabled: boolean;
    onChange: (value: boolean) => void;
  }) => (
    <button
      role="switch"
      aria-label={label}
      aria-checked={value}
      disabled={disabled}
      onClick={() => onChange(!value)}
    >
      {label}
    </button>
  ),
}));
const usageNotices = createUsageNoticeDismissals({ read: () => [], write: () => undefined });
const mobile = vi.hoisted(() => ({ hostClient: null as HostClient | null }));
vi.mock("../ui/mobile-client-context.js", () => ({
  useMobileState: () => ({
    selection: { deploymentId: "test-deployment", hostClient: mobile.hostClient },
  }),
  useMobileClient: () => ({
    usageNotices,
    getSnapshot: () => ({
      selection: { deploymentId: "test-deployment", hostClient: mobile.hostClient },
    }),
  }),
}));
const dom = new Window();
vi.stubGlobal("window", dom);
vi.stubGlobal("document", dom.document);
vi.stubGlobal("HTMLElement", dom.HTMLElement);
const { ThreadSettingsScreen, NewThreadScreen } = await import("./thread-settings.js");
const { FirstMessageComposer, firstMessageExecution, firstMessageBlocker } =
  await import("../thread/first-message.js");
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

export {
  mobile,
  navigation,
  ThreadSettingsScreen,
  NewThreadScreen,
  FirstMessageComposer,
  firstMessageExecution,
  firstMessageBlocker,
};
