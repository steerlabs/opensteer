// @vitest-environment happy-dom

import { HostClientRequestError, unwrapRpcResult, type HostClient } from "@opensteer/client/host";
import type { ComputerUseData } from "@opensteer/client/integrations";
import { MockHostClient } from "@opensteer/client/mock";
import type { MachineSummary } from "@opensteer/protocol";
import { act, useCallback, useEffect, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IphoneAppId } from "../platform/iphone-apps.js";
import type { IphoneAppsController as Controller } from "./controller.js";
import type { FakeIphoneApps } from "./fake-bridge.js";

/*
 * The iPhone's own screens, rendered with the app's components over the real
 * in-memory Host and the labelled JS fake of the native bridge. These prove
 * the screens' words and the order of what a tap sends; they do not prove
 * Swift, iOS prompts or a real Host.
 *
 * Failure cases, written before the screens:
 * - adding offers itself on a Host without iPhone apps, names nothing of what
 *   is shared, or sends the person nowhere useful when the Host refuses;
 * - an app is turned on, or widened, without its consent sheet naming what
 *   agents can do, that it goes to the AI service, and that iOS asks next;
 * - iOS is asked before Allow is tapped, or Cancel still sends something;
 * - a request shows on its own more than once, or cannot be answered later;
 * - Opensteer access and iPhone Settings are merged into one "permission";
 * - choosing a level in the sheet sends, prompts or signs anything before the
 *   one explicit review is confirmed, or closing the sheet keeps the draft;
 * - an app reads as "on" (green) while iPhone Settings blocks it or the iPhone
 *   is not connected, or a fresh iOS refusal still turns it on;
 * - turning off promises to undo what agents already received or saved;
 * - another device's view of the iPhone offers to turn an app on or widen it,
 *   loses the way to decline a waiting request, or cannot lower or turn off an
 *   app while a wider request waits or the iPhone is offline;
 * - Remove leaves the iPhone sharing, or forgets to tell the Host.
 *
 * Location and Photos, written before their rows:
 * - either offers Can read and change, or a review that doesn't say, before
 *   iOS asks, that Allow Once ends, that Precise Location may be off, or that
 *   iPhone's Photos prompt is broader than the read-only details agents get;
 * - an older Host without the definition, or an older iPhone build without
 *   the app, shows a row that opens a review or asks iOS, or shows no reason;
 * - a denied Location sends the Host anything;
 * - an approximate Location, or limited Photos, reads as anything but on
 *   with that limit named, or Choose photos is missing or reads closing the
 *   picker as a refusal;
 * - a temporary Location permission that ended still reads as on, or asks
 *   iOS without a tap;
 * - another device can turn either on, or loses decline, lower or turn off.
 */

const harness = vi.hoisted(() => ({
  alerts: [] as {
    buttons: { onPress?: () => void; style?: string; text: string }[];
    message: string;
    title: string;
  }[],
  appState: "active",
  appStateListeners: new Set<(state: string) => void>(),
  openSettings: vi.fn(async () => undefined),
}));

vi.mock("react-native", () => ({
  ActivityIndicator: () => <span>Working…</span>,
  Alert: {
    alert: (
      title: string,
      message: string,
      buttons: { onPress?: () => void; style?: string; text: string }[],
    ) => harness.alerts.push({ buttons, message, title }),
  },
  AppState: {
    get currentState() {
      return harness.appState;
    },
    addEventListener: (_event: string, listener: (state: string) => void) => {
      harness.appStateListeners.add(listener);
      return { remove: () => harness.appStateListeners.delete(listener) };
    },
  },
  Linking: { openSettings: harness.openSettings },
  Pressable: ({
    accessibilityLabel,
    accessibilityRole,
    accessibilityState,
    children,
    disabled,
    onPress,
  }: {
    accessibilityLabel?: string;
    accessibilityRole?: string;
    accessibilityState?: { checked?: boolean };
    children?: ReactNode | ((state: { pressed: boolean }) => ReactNode);
    disabled?: boolean;
    onPress?: () => void;
  }) => (
    <button
      aria-checked={
        accessibilityRole === "radio" ? accessibilityState?.checked === true : undefined
      }
      aria-label={accessibilityLabel}
      disabled={disabled}
      onClick={onPress}
      role={accessibilityRole === "radio" ? "radio" : undefined}
    >
      {typeof children === "function" ? children({ pressed: false }) : children}
    </button>
  ),
  ScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  StyleSheet: { create: (styles: object) => styles, hairlineWidth: 1 },
  View: ({
    accessibilityLabel,
    children,
  }: {
    accessibilityLabel?: string;
    children?: ReactNode;
  }) => <div aria-label={accessibilityLabel}>{children}</div>,
}));
vi.mock("../theme.js", () => ({ color: {}, radius: {}, space: {}, touchTarget: 44 }));
vi.mock("expo-haptics", () => ({
  NotificationFeedbackType: { Success: "success" },
  notificationAsync: vi.fn(async () => undefined),
  selectionAsync: vi.fn(async () => undefined),
}));
vi.mock("react-native-reanimated", () => ({
  default: { View: ({ children }: { children?: ReactNode }) => <div>{children}</div> },
}));
vi.mock("../ui/motion.js", () => ({ appear: {}, enter: {}, exit: {} }));
vi.mock("../client/mobile-client.js", () => ({
  operationDetail: (error: unknown, fallback: string) =>
    error instanceof Error ? error.message : fallback,
}));
vi.mock("../ui/symbol.js", () => ({ Symbol: () => null }));
vi.mock("@react-navigation/native", () => ({
  StackActions: { replace: vi.fn() },
  useNavigation: () => ({ dispatch: vi.fn() }),
}));
vi.mock("../ui/screen.js", () => ({
  Screen: ({ children }: { children?: ReactNode }) => <main>{children}</main>,
  useListContentInsets: () => ({}),
  useReadingColumn: () => ({}),
}));
vi.mock("../ui/mobile-client-context.js", () => ({
  useHostValue: () => false,
  useMobileState: () => ({ rows: [], selection: { deploymentId: null, hostClient: null } }),
}));
vi.mock("../ui/sheet.js", () => ({
  Sheet: (props: {
    children?: ReactNode;
    footer?: ReactNode;
    onClose: () => void;
    open: boolean;
    title: string;
  }) =>
    props.open ? (
      <section aria-label={props.title}>
        <h1>{props.title}</h1>
        {props.children}
        {props.footer}
        <button onClick={props.onClose}>{`Close ${props.title}`}</button>
      </section>
    ) : null,
}));
vi.mock("../ui/primitives.js", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  ChoiceRow: (props: {
    description: string;
    disabled?: boolean;
    onPress: () => void;
    title: string;
  }) => (
    <button
      aria-label={`${props.title}, ${props.description}`}
      disabled={props.disabled}
      onClick={props.onPress}
    >
      {props.title}
      <small>{props.description}</small>
    </button>
  ),
  Field: (props: {
    hint?: string;
    input: { onChangeText?: (value: string) => void; value?: string };
    label: string;
  }) => (
    <label>
      {props.label}
      <input
        aria-label={props.label}
        onChange={(event) => props.input.onChangeText?.(event.target.value)}
        value={props.input.value ?? ""}
      />
      {props.hint === undefined ? null : <small>{props.hint}</small>}
    </label>
  ),
  Notice: (props: {
    action?: { label: string; onPress: () => void };
    detail: string;
    title: string;
  }) => (
    <div>
      <strong>{props.title}</strong>
      <p>{props.detail}</p>
      {props.action === undefined ? null : (
        <button onClick={props.action.onPress}>{props.action.label}</button>
      )}
    </div>
  ),
  PrimaryButton: (props: {
    busy?: boolean;
    disabled?: boolean;
    label: string;
    onPress: () => void;
  }) => (
    <button disabled={props.disabled === true || props.busy === true} onClick={props.onPress}>
      {props.label}
    </button>
  ),
  RowGroup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SecondaryButton: (props: {
    accessibilityLabel?: string;
    busy?: boolean;
    disabled?: boolean;
    label: string;
    onPress: () => void;
  }) => (
    <button
      aria-label={props.accessibilityLabel ?? props.label}
      disabled={props.disabled === true || props.busy === true}
      onClick={props.onPress}
    >
      {props.label}
    </button>
  ),
  SectionLabel: ({ children }: { children: string }) => <h2>{children}</h2>,
  StatusDot: ({ tone }: { tone: string }) => <i data-tone={tone} />,
}));

const { IphoneAppsController } = await import("./controller.js");
const { createFakeIphoneApps, observeMockHostCommand } = await import("./fake-bridge.js");
const { AddIphoneForm } = await import("./add-iphone.js");
const { IphoneAppsBlock } = await import("./iphone-apps-block.js");
const { RemoteIphoneAppsBlock } = await import("./remote-iphone-apps-block.js");
const { IphoneApprovalPrompt } = await import("./approval-prompt.js");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/** The mock Host's own identity, which its pairing target names. */
const deploymentId = "dep_00000000-0000-4000-8000-000000000001";
const opensteer = "Opensteer on Mac mini";
const roots: Root[] = [];
const disposers: (() => void)[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  for (const dispose of disposers.splice(0)) dispose();
  harness.alerts.splice(0);
  harness.appState = "active";
  harness.openSettings.mockClear();
  document.body.replaceChildren();
});

describe("Add this iPhone", () => {
  it("says what is shared, then adds the iPhone and hands back its computer", async () => {
    const phone = iphone();
    const onAdded = vi.fn();
    await mount(
      <AddIphoneForm
        controller={phone.controller}
        deploymentId={deploymentId}
        hostClient={phone.host}
        iphoneAppsAvailable
        onAdded={onAdded}
        opensteer={opensteer}
      />,
    );

    expect(text()).toContain(
      "Agents working in Opensteer on Mac mini can use the apps you turn on here, while Opensteer is open on this iPhone. Nothing is shared until you turn an app on.",
    );
    expect(input("Name").value).toBe("Alex's iPhone");
    expect(text()).toContain("This is how it's listed on Computers.");
    expect(text()).toContain("Apps you can share");
    expect(text()).toContain("See events, and add or change them if you allow it");
    expect(text()).toContain("Find people. Agents can't change contacts.");
    expect(text()).toContain("See reminders, and add or change them if you allow it");
    expect(text()).toContain("See your current location, precise or approximate");
    expect(text()).toContain("See photo and album details only");
    expect(text()).toContain(
      "Available apps depend on the Opensteer versions on this iPhone and your Deployment.",
    );
    expect(text()).toContain(
      "Agents can't use anything else on this iPhone: not its other apps, files, messages or screen.",
    );

    await type(input("Name"), "Work iPhone");
    await click(button("Add Work iPhone"));

    await vi.waitFor(() => expect(onAdded).toHaveBeenCalledOnce());
    const runnerId = phone.fake.device.runnerId();
    expect(onAdded).toHaveBeenCalledWith(runnerId);
    const listed = phone.host.getSnapshot().machines.find(({ id }) => id === runnerId);
    expect(listed).toMatchObject({
      device: { form: "phone", platform: "ios" },
      name: "Work iPhone",
      status: "online",
    });
    expect(phone.fake.device.calls).not.toContainEqual(
      expect.stringMatching(/^requestPermission/u),
    );
  });

  it("offers nothing to add on an Opensteer that cannot take an iPhone yet", async () => {
    const phone = iphone();
    await mount(
      <AddIphoneForm
        controller={phone.controller}
        deploymentId={deploymentId}
        hostClient={phone.host}
        iphoneAppsAvailable={false}
        onAdded={vi.fn()}
        opensteer={opensteer}
      />,
    );

    expect(text()).toContain("Update Opensteer on Mac mini to add this iPhone.");
    expect(maybeButton("Add Alex's iPhone")).toBeNull();
    expect(phone.fake.device.calls).toEqual([]);
  });

  it("says to turn on remote access when the Host refuses for that reason", async () => {
    const phone = iphone();
    const refusing = {
      ...phone.host,
      dispatch: async () => {
        throw new HostClientRequestError({
          code: "conflict",
          message: "Remote access is off.",
          reason: "personal-remote-access-off",
          status: 409,
        });
      },
    } as unknown as HostClient;
    await mount(
      <AddIphoneForm
        controller={phone.controller}
        deploymentId={deploymentId}
        hostClient={refusing}
        iphoneAppsAvailable
        onAdded={vi.fn()}
        opensteer={opensteer}
      />,
    );

    await click(button("Add Alex's iPhone"));

    await vi.waitFor(() =>
      expect(text()).toContain(
        "Turn on remote access on Opensteer on Mac mini first, then try again.",
      ),
    );
    expect(button("Add Alex's iPhone").disabled).toBe(false);
  });
});

describe("This iPhone's apps", () => {
  it("turns Calendar on only after one reviewed commit, and asks iOS only then", async () => {
    const phone = await addedIphone();
    const dispatch = vi.spyOn(phone.host, "dispatch");
    await mount(<ThisIphone phone={phone} />);

    expect(text()).toContain("Online · Agents can use its apps while Opensteer is open");
    expect(rowLabels()).toEqual([
      "Calendar, Off",
      "Contacts, Off",
      "Reminders, Off",
      "Location, Off",
      "Photos, Off",
    ]);

    await click(button("Calendar, Off"));
    expect(text()).toContain("Agent access");
    expect(text()).toContain("iPhone Settings");
    expect(text()).toContain("Not asked yet");
    expect(radios()).toEqual([
      "Can read: unchecked",
      "Can read and change: unchecked",
      "Off, current access: checked",
    ]);

    // Choosing is a draft: nothing is sent, prompted or signed.
    await click(radio("Can read and change"));
    expect(radios()).toEqual([
      "Can read: unchecked",
      "Can read and change: checked",
      "Off, current access: unchecked",
    ]);
    expect(dispatch).not.toHaveBeenCalled();
    expect(phone.fake.device.calls).not.toContainEqual(
      expect.stringMatching(/^requestPermission/u),
    );

    await click(button("Review"));
    expect(text()).toContain("Let agents see and change Calendar?");
    expect(text()).toContain(
      "Agents working in Opensteer on Mac mini can see your calendars and events, and add, change or delete events on this iPhone while Opensteer is open.",
    );
    expect(text()).toContain(
      "This lasts until you change it, not only for one task. Tasks in Main can use it; a specialist can use it only once you allow that specialist.",
    );
    expect(text()).toContain(
      "What agents see is sent to Opensteer on Mac mini and to the AI service the task uses.",
    );
    expect(text()).toContain("iPhone will ask you next whether Opensteer can use Calendar.");
    expect(dispatch).not.toHaveBeenCalled();

    await click(button("Allow"));

    await vi.waitFor(() => expect(rowLabels()[0]).toBe("Calendar, On · Can read and change"));
    expect(
      phone.fake.device.calls.filter((call) => !call.startsWith("prepare") && call !== "enroll"),
    ).toEqual([
      "requestPermission:apple-calendar",
      "answerApproval:" + phone.lastRequestId() + ":allow:apple-calendar:read-write",
    ]);
  });

  it("sends nothing when the sheet is closed with a draft, and forgets the draft", async () => {
    const phone = await addedIphone();
    const dispatch = vi.spyOn(phone.host, "dispatch");
    await mount(<ThisIphone phone={phone} />);

    await click(button("Contacts, Off"));
    expect(radios()).toEqual(["Can read: unchecked", "Off, current access: checked"]);
    await click(radio("Can read"));
    await click(button("Review"));
    expect(text()).toContain("Let agents find people in Contacts?");
    await click(button("Back"));
    await click(button("Close Contacts"));

    await click(button("Contacts, Off"));
    expect(radios()).toEqual(["Can read: unchecked", "Off, current access: checked"]);
    expect(maybeButton("Review")).toBeNull();
    expect(dispatch).not.toHaveBeenCalled();
    expect(phone.fake.device.calls).not.toContainEqual(
      expect.stringMatching(/^requestPermission/u),
    );
  });

  it("turns nothing on when iOS says no, and says that iPhone Settings stopped it", async () => {
    const phone = await addedIphone();
    const dispatch = vi.spyOn(phone.host, "dispatch");
    phone.fake.device.answerPermissionWith("apple-reminders", "denied");
    await mount(<ThisIphone phone={phone} />);

    await click(button("Reminders, Off"));
    await click(radio("Can read"));
    await click(button("Review"));
    await click(button("Allow"));

    await vi.waitFor(() =>
      expect(text()).toContain(
        "iPhone Settings doesn't let Opensteer use Reminders, so it wasn't turned on.",
      ),
    );
    expect(rowLabels()[2]).toBe("Reminders, Off");
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "integration.computer.setup.request" }),
    );
    expect(phone.fake.device.calls).not.toContainEqual(expect.stringMatching(/^answerApproval/u));

    // Already refused: review offers Settings, never Allow.
    await click(button("Reminders, Off"));
    await click(radio("Can read"));
    await click(button("Review"));
    expect(maybeButton("Allow")).toBeNull();
    await click(button("Open Settings"));
    expect(harness.openSettings).toHaveBeenCalledOnce();
  });

  it("keeps agent access, iPhone Settings and the connection apart in each row", async () => {
    const phone = await addedIphone();
    await turnOn(phone, "apple-calendar", "read");
    await turnOn(phone, "apple-contacts", "read");
    phone.fake.device.setPermission("apple-calendar", "denied");
    phone.fake.device.setPermission("apple-contacts", "limited");
    await mount(<ThisIphone phone={phone} />);

    await vi.waitFor(() =>
      expect(rowLabels()).toEqual([
        "Calendar, Blocked · Can read · Not allowed in iPhone Settings",
        "Contacts, On · Can read · Only contacts you chose",
        "Reminders, Off",
        "Location, Off",
        "Photos, Off",
      ]),
    );
    // The first dot is the iPhone's own status line.
    expect(tones().slice(1)).toEqual(["amber", "green", "muted", "muted", "muted"]);
    expect(text()).toContain("Allow Calendar in iPhone Settings");
    await click(button("Open Settings"));
    expect(harness.openSettings).toHaveBeenCalledOnce();

    // Closing the picker is not a refusal: the row reads iOS again.
    await click(button("Choose contacts"));
    expect(phone.fake.device.calls.at(-1)).toBe("chooseContacts");
    expect(rowLabels()[1]).toBe("Contacts, On · Can read · Only contacts you chose");

    // Not connected: nothing reads as on, and the access is still shown.
    act(() => phone.fake.device.raise("host-unreachable"));
    await settle();
    expect(rowLabels()[1]).toBe("Contacts, Paused · Can read");
    expect(tones()[2]).toBe("muted");
  });

  it("lowers and turns off after review, saying what stays, without signing anything", async () => {
    const phone = await addedIphone();
    await turnOn(phone, "apple-calendar", "read-write");
    await mount(<ThisIphone phone={phone} />);
    const calls = phone.fake.device.calls.length;

    await click(button("Calendar, On · Can read and change"));
    await click(radio("Can read"));
    await click(button("Review"));
    expect(text()).toContain("Lower Calendar to Can read?");
    expect(text()).toContain("Agents will no longer add, change or delete events.");
    await click(button("Lower access"));
    await vi.waitFor(() => expect(rowLabels()[0]).toBe("Calendar, On · Can read"));

    await click(button("Calendar, On · Can read"));
    await click(radio("Off"));
    await click(button("Review"));
    expect(text()).toContain("Turn off Calendar?");
    expect(text()).toContain("Turning this off removes agents' access in every Workspace.");
    expect(text()).toContain(
      "What agents already received, and changes they already saved, stay as they are.",
    );
    await click(button("Turn off"));
    await vi.waitFor(() => expect(rowLabels()[0]).toBe("Calendar, Off"));

    expect(harness.alerts).toEqual([]);
    expect(phone.fake.device.calls.slice(calls)).toEqual([]);
  });

  it("shows an upgrade that cannot be confirmed as unverified, beside the access it has", async () => {
    const phone = await addedIphone();
    await turnOn(phone, "apple-reminders", "read");
    await mount(<ThisIphone phone={phone} />);
    const dispatch = phone.host.dispatch.bind(phone.host);
    const rpc = phone.host.rpc;
    let lost = true;
    phone.host.dispatch = async (command) => {
      if (lost && command.type === "integration.computer.setup.request") {
        throw new Error("The connection was lost.");
      }
      return dispatch(command);
    };
    // The Host's own record cannot be read back either, until it can.
    Object.defineProperty(phone.host, "rpc", {
      value: new Proxy(rpc, {
        get: (target, key, receiver) =>
          lost && key === "integration.computer.setup.list"
            ? async () => {
                throw new Error("Still unreachable.");
              }
            : Reflect.get(target, key, receiver),
      }),
    });

    await click(button("Reminders, On · Can read"));
    await click(radio("Can read and change"));
    await click(button("Review"));
    await click(button("Allow"));

    await vi.waitFor(() =>
      expect(rowLabels()[2]).toBe("Reminders, On · Can read · Change not verified"),
    );
    expect(text()).toContain(
      "Opensteer may or may not have Can read and change for Reminders. Checking reads it again; nothing is asked twice.",
    );
    // While unverified it can still be lowered or turned off, but not asked for again.
    await click(button("Reminders, On · Can read · Change not verified"));
    expect(radios()).toEqual(["Can read, current access: checked", "Off: unchecked"]);
    lost = false;
    await click(button("Check status"));
    await vi.waitFor(() => expect(rowLabels()[2]).toBe("Reminders, On · Can read"));
    expect(text()).toContain(
      "That request is no longer waiting. Review the current access before trying again.",
    );
  });

  it("removes the iPhone: it stops at once and the Host forgets it", async () => {
    const phone = await addedIphone();
    const onRemoved = vi.fn();
    await mount(<ThisIphone onRemoved={onRemoved} phone={phone} />);
    const runnerId = phone.fake.device.runnerId();

    await click(button("Remove Alex's iPhone"));
    const confirm = harness.alerts.at(-1);
    expect(confirm?.title).toBe("Remove Alex's iPhone from Opensteer on Mac mini?");
    expect(confirm?.message).toBe("Agents will stop using its apps. You can add it again later.");
    await act(async () => confirm?.buttons.find(({ text }) => text === "Remove")?.onPress?.());

    expect(phone.fake.device.calls).toContain("disconnect");
    await vi.waitFor(() => expect(onRemoved).toHaveBeenCalledOnce());
    expect(phone.host.getSnapshot().machines.some(({ id }) => id === runnerId)).toBe(false);
    expect(phone.controller.getState().notice).toBeNull();
  });

  it("allows the local iPhone to stop sharing while the Host is unreachable", async () => {
    const phone = await addedIphone();
    const onRemoved = vi.fn();
    await mount(<ThisIphone canRespond={false} onRemoved={onRemoved} phone={phone} />);
    vi.spyOn(phone.host, "dispatch").mockRejectedValue(new Error("Host unreachable"));

    expect(button("Remove Alex's iPhone").disabled).toBe(false);
    await click(button("Remove Alex's iPhone"));
    const confirm = harness.alerts.at(-1);
    await act(async () => confirm?.buttons.find(({ text }) => text === "Remove")?.onPress?.());

    expect(phone.fake.device.calls.at(-1)).toBe("disconnect");
    expect(phone.fake.bridge.getSnapshot().enrollment).toBeNull();
    await vi.waitFor(() => expect(onRemoved).toHaveBeenCalledOnce());
    expect(phone.controller.getState().notice?.kind).toBe("not-told");
  });
});

describe("Location and Photos on this iPhone", () => {
  it("offers only Can read or Off, and says what each limits before iOS asks", async () => {
    const phone = await addedIphone();
    const dispatch = vi.spyOn(phone.host, "dispatch");
    phone.fake.device.setLocationAccuracy("approximate");
    phone.fake.device.answerPermissionWith("iphone-photos", "limited");
    await mount(<ThisIphone phone={phone} />);
    expect(rowLabels().slice(3)).toEqual(["Location, Off", "Photos, Off"]);

    await click(button("Location, Off"));
    expect(radios()).toEqual(["Can read: unchecked", "Off, current access: checked"]);
    expect(text()).toContain("Not asked yet");
    await click(radio("Can read"));
    await click(button("Review"));
    expect(text()).toContain("Let agents use Location?");
    expect(text()).toContain(
      "Agents working in Opensteer on Mac mini can get your current location, one reading at a time with its accuracy, on this iPhone while Opensteer is open.",
    );
    expect(text()).toContain(
      "If you allow it only once, that ends a while after you leave Opensteer, and agents can't get your location until you allow it here again. With Precise Location off, agents get an approximate area.",
    );
    expect(text()).toContain("iPhone will ask you next whether Opensteer can use Location.");
    expect(dispatch).not.toHaveBeenCalled();
    expect(phone.fake.device.calls).not.toContainEqual(
      expect.stringMatching(/^requestPermission/u),
    );
    await click(button("Allow"));
    await vi.waitFor(() => expect(rowLabels()[3]).toBe("Location, On · Can read · Approximate"));
    expect(tones()[4]).toBe("green");

    await click(button("Photos, Off"));
    expect(radios()).toEqual(["Can read metadata: unchecked", "Off, current access: checked"]);
    await click(radio("Can read metadata"));
    await click(button("Review"));
    expect(text()).toContain("Let agents see details in Photos?");
    expect(text()).toContain(
      "iPhone asks about your whole photo library. Agents get only read-only details, never the photos themselves or where they were taken. To send a photo, attach it in a chat.",
    );
    await click(button("Allow"));
    await vi.waitFor(() =>
      expect(rowLabels()[4]).toBe("Photos, On · Can read metadata · Only photos you chose"),
    );
    expect(text()).toContain(
      "Agents see details only of the photos you chose, and none until you choose some.",
    );

    // Closing the picker is not a refusal: the row reads iOS again.
    await click(button("Choose photos"));
    expect(phone.fake.device.calls.at(-1)).toBe("choosePhotos");
    expect(rowLabels()[4]).toBe("Photos, On · Can read metadata · Only photos you chose");
    expect(
      phone.fake.device.calls.filter((call) => !call.startsWith("prepare") && call !== "enroll"),
    ).toEqual([
      "requestPermission:iphone-location",
      expect.stringMatching(/^answerApproval:.+:allow:iphone-location:read$/u),
      "requestPermission:iphone-photos",
      expect.stringMatching(/^answerApproval:.+:allow:iphone-photos:read$/u),
      "choosePhotos",
    ]);
  });

  it("shows an older Host's missing apps as not offered there, and asks nothing", async () => {
    const phone = await addedIphone({ olderHost: true });
    const dispatch = vi.spyOn(phone.host, "dispatch");
    await mount(<ThisIphone phone={phone} />);

    await vi.waitFor(() =>
      expect(rowLabels().slice(3)).toEqual([
        "Location, Not available · Opensteer on Mac mini doesn't offer it yet",
        "Photos, Not available · Opensteer on Mac mini doesn't offer it yet",
      ]),
    );
    expect(
      button("Location, Not available · Opensteer on Mac mini doesn't offer it yet").disabled,
    ).toBe(true);
    expect(rowLabels()[0]).toBe("Calendar, Off");
    expect(dispatch).not.toHaveBeenCalled();
    expect(phone.fake.device.calls).not.toContainEqual(
      expect.stringMatching(/^requestPermission/u),
    );
  });

  it("shows apps an older iPhone build lacks as needing an update here, and asks nothing", async () => {
    const phone = await addedIphone({
      offers: ["apple-calendar", "apple-contacts", "apple-reminders"],
    });
    await mount(<ThisIphone phone={phone} />);

    await vi.waitFor(() =>
      expect(rowLabels().slice(3)).toEqual([
        "Location, Not available · Update Opensteer on this iPhone",
        "Photos, Not available · Update Opensteer on this iPhone",
      ]),
    );
    expect(button("Photos, Not available · Update Opensteer on this iPhone").disabled).toBe(true);
    expect(phone.fake.device.calls).not.toContainEqual(
      expect.stringMatching(/^(requestPermission|choosePhotos)/u),
    );
  });

  it("sends nothing when iOS refuses Location", async () => {
    const phone = await addedIphone();
    const dispatch = vi.spyOn(phone.host, "dispatch");
    phone.fake.device.answerPermissionWith("iphone-location", "denied");
    await mount(<ThisIphone phone={phone} />);

    await click(button("Location, Off"));
    await click(radio("Can read"));
    await click(button("Review"));
    await click(button("Allow"));

    await vi.waitFor(() =>
      expect(text()).toContain(
        "iPhone Settings doesn't let Opensteer use Location, so it wasn't turned on.",
      ),
    );
    expect(rowLabels()[3]).toBe("Location, Off");
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "integration.computer.setup.request" }),
    );
  });

  it("reads a temporary Location permission that ended as blocked, and asks again only on a tap", async () => {
    const phone = await addedIphone();
    await turnOn(phone, "iphone-location", "read");
    await mount(<ThisIphone phone={phone} />);
    await vi.waitFor(() => expect(rowLabels()[3]).toBe("Location, On · Can read"));
    const calls = phone.fake.device.calls.length;

    act(() => phone.fake.device.setPermission("iphone-location", "not-determined"));
    await settle();
    expect(rowLabels()[3]).toBe("Location, Blocked · Can read · iPhone hasn't asked yet");
    expect(tones()[4]).toBe("amber");
    expect(text()).toContain(
      "iPhone will ask you whether Opensteer can use Location. If you allowed it only once, that has ended.",
    );
    expect(phone.fake.device.calls.slice(calls)).toEqual([]);

    await click(button("Continue"));
    await vi.waitFor(() => expect(rowLabels()[3]).toBe("Location, On · Can read"));
    expect(phone.fake.device.calls.slice(calls)).toEqual(["requestPermission:iphone-location"]);
  });

  it("shows a task's Photos request with what agents get, and asks iOS only on Allow", async () => {
    const phone = await addedIphone();
    await requestFromTask(phone, "iphone-photos", "read");
    await mount(<ThisIphone phone={phone} />);

    expect(text()).toContain("Let agents see details in Photos?");
    expect(text()).toContain(
      "iPhone asks about your whole photo library. Agents get only read-only details, never the photos themselves or where they were taken. To send a photo, attach it in a chat.",
    );
    expect(phone.fake.device.calls).not.toContainEqual(
      expect.stringMatching(/^requestPermission/u),
    );
    await click(button("Allow"));
    await vi.waitFor(() => expect(rowLabels()[4]).toBe("Photos, On · Can read metadata"));
    expect(phone.fake.device.calls.slice(-2)).toEqual([
      "requestPermission:iphone-photos",
      `answerApproval:${phone.lastRequestId()}:allow:iphone-photos:read`,
    ]);
  });

  it("lets another device only decline a request or turn either off", async () => {
    const phone = await addedIphone();
    await turnOn(phone, "iphone-location", "read");
    await requestFromTask(phone, "iphone-photos", "read");
    await mount(<OtherDevice phone={phone} />);

    // Another device lists them by name.
    await vi.waitFor(() =>
      expect(rowLabels().slice(2, 4)).toEqual([
        "Location, On · Can read",
        "Photos, Off · Waiting for approval on Alex's iPhone",
      ]),
    );
    expect(maybeButton("Photos, Off · Waiting for approval on Alex's iPhone")?.disabled).toBe(true);
    await click(button("Location, On · Can read"));
    expect(radios()).toEqual(["Can read, current access: checked", "Off: unchecked"]);
    await click(radio("Off"));
    await click(button("Review"));
    await click(button("Turn off"));
    await vi.waitFor(() =>
      expect(rowLabels()[2]).toBe("Location, Off · Turn it on in Opensteer on Alex's iPhone"),
    );

    await click(button("Decline Photos"));
    await vi.waitFor(() =>
      expect(rowLabels()[3]).toBe("Photos, Off · Turn it on in Opensteer on Alex's iPhone"),
    );
    expect(text()).not.toContain("Allow");
  });
});

describe("A request waiting on this iPhone", () => {
  it("shows on its own once, then stays answerable on the computer's page", async () => {
    const phone = await addedIphone();
    await requestFromTask(phone, "apple-reminders", "read");
    await mount(
      <IphoneApprovalPrompt controller={phone.controller} opensteerFor={() => opensteer} />,
    );

    await vi.waitFor(() => expect(section(opensteer)).not.toBeNull());
    expect(section(opensteer)?.textContent).toContain("Let agents see Reminders?");
    expect(section(opensteer)?.textContent).toContain(
      "What agents see is sent to Opensteer on Mac mini and to the AI service the task uses.",
    );
    expect(phone.fake.device.calls).not.toContainEqual(
      expect.stringMatching(/^requestPermission/u),
    );
    await click(button(`Close ${opensteer}`));
    expect(section(opensteer)).toBeNull();

    // A later launch of the prompt does not show it again.
    for (const root of roots.splice(0)) act(() => root.unmount());
    await mount(
      <IphoneApprovalPrompt controller={phone.controller} opensteerFor={() => opensteer} />,
    );
    await settle();
    expect(section(opensteer)).toBeNull();

    await mount(<ThisIphone phone={phone} />);
    expect(text()).toContain("Waiting for you");
    expect(text()).toContain("Let agents see Reminders?");
    await click(button("Allow"));
    await vi.waitFor(() => expect(rowLabels()[2]).toBe("Reminders, On · Can read"));
    expect(phone.fake.device.calls.slice(-2)).toEqual([
      "requestPermission:apple-reminders",
      `answerApproval:${phone.lastRequestId()}:allow:apple-reminders:read`,
    ]);
  });

  it("is not shown while the app is in the background, and declines without asking iOS", async () => {
    harness.appState = "background";
    const phone = await addedIphone();
    await requestFromTask(phone, "apple-calendar", "read-write");
    await mount(
      <IphoneApprovalPrompt controller={phone.controller} opensteerFor={() => opensteer} />,
    );
    await settle();
    expect(section(opensteer)).toBeNull();

    harness.appState = "active";
    await act(async () => {
      for (const listener of harness.appStateListeners) listener("active");
    });
    await vi.waitFor(() =>
      expect(section(opensteer)?.textContent).toContain("Let agents see and change Calendar?"),
    );
    await click(button("Don't allow"));
    await vi.waitFor(() => expect(section(opensteer)).toBeNull());
    expect(phone.fake.device.calls.at(-1)).toBe(
      `answerApproval:${phone.lastRequestId()}:deny:apple-calendar:read-write`,
    );
    expect(phone.fake.device.calls).not.toContainEqual(
      expect.stringMatching(/^requestPermission/u),
    );
  });
});

describe("An iPhone seen from another device", () => {
  it("offers lowering, turning off and declining, never turning on or widening", async () => {
    const phone = await addedIphone();
    await turnOn(phone, "apple-calendar", "read-write");
    await requestFromTask(phone, "apple-reminders", "read");
    // This phone is another device: its own iPhone apps are not the iPhone on screen.
    await mount(<OtherDevice phone={phone} />);

    await vi.waitFor(() =>
      expect(rowLabels()).toEqual([
        "Calendar, On · Can read and change",
        "Contacts, Off · Turn it on in Opensteer on Alex's iPhone",
        "Location, Off · Turn it on in Opensteer on Alex's iPhone",
        "Photos, Off · Turn it on in Opensteer on Alex's iPhone",
        "Reminders, Off · Waiting for approval on Alex's iPhone",
      ]),
    );
    expect(maybeButton("Contacts, Off · Turn it on in Opensteer on Alex's iPhone")?.disabled).toBe(
      true,
    );

    await click(button("Calendar, On · Can read and change"));
    expect(radios()).toEqual([
      "Can read: unchecked",
      "Can read and change, current access: checked",
      "Off: unchecked",
    ]);
    await click(radio("Can read"));
    await click(button("Review"));
    await click(button("Lower access"));
    await vi.waitFor(() => expect(rowLabels()[0]).toBe("Calendar, On · Can read"));

    await click(button("Decline Reminders"));
    await vi.waitFor(() =>
      expect(rowLabels()[4]).toBe("Reminders, Off · Turn it on in Opensteer on Alex's iPhone"),
    );
    expect(text()).not.toContain("Allow");
  });

  it("lowers or turns off while the iPhone is offline and a wider request waits", async () => {
    const phone = await addedIphone();
    await turnOn(phone, "apple-reminders", "read");
    await requestFromTask(phone, "apple-reminders", "read-write");
    await mount(<OtherDevice offline phone={phone} />);

    // An away iPhone lists only the apps that are on or asked for.
    await vi.waitFor(() =>
      expect(rowLabels()).toEqual([
        "Reminders, Paused · Can read · Alex's iPhone is offline · More access waiting for approval",
      ]),
    );
    expect(tones()).toEqual(["muted"]);
    expect(maybeButton("Decline Reminders")?.disabled).toBe(false);

    await click(
      button(
        "Reminders, Paused · Can read · Alex's iPhone is offline · More access waiting for approval",
      ),
    );
    expect(radios()).toEqual(["Can read, current access: checked", "Off: unchecked"]);
    await click(radio("Off"));
    await click(button("Review"));
    expect(text()).toContain(
      "What agents already received, and changes they already saved, stay as they are.",
    );
    await click(button("Turn off"));
    // Off is off; a request still waiting at the Host stays the iPhone's to answer.
    const waiting = async () =>
      (await phone.host.rpc["integration.computer.setup.list"]({})).ok &&
      unwrapRpcResult(await phone.host.rpc["integration.computer.setup.list"]({})).requests.some(
        ({ definitionId }) => definitionId === "apple-reminders",
      );
    await vi.waitFor(async () =>
      expect(rowLabels()).toEqual([
        (await waiting())
          ? "Reminders, Off · Waiting for approval on Alex's iPhone"
          : "Reminders, Off · Turn it on in Opensteer on Alex's iPhone",
      ]),
    );
  });
});

/* ------------------------------------------------------------------------- */

interface Phone {
  readonly controller: Controller;
  readonly fake: FakeIphoneApps;
  readonly host: MockHostClient;
  lastRequestId(): string;
}

function iphone(
  options: {
    /** A Host from before Location and Photos: its catalog doesn't list them. */
    readonly olderHost?: boolean;
    readonly offers?: readonly IphoneAppId[];
  } = {},
): Phone {
  const host = new MockHostClient({ latencyMs: 0 });
  disposers.push(() => host.dispose());
  if (options.olderHost === true) {
    const rpc = host.rpc;
    Object.defineProperty(host, "rpc", {
      value: new Proxy(rpc, {
        get: (target, key, receiver) =>
          key === "integration.platform.get"
            ? async () => {
                const result = await target["integration.platform.get"]({});
                return result.ok
                  ? {
                      ...result,
                      data: {
                        ...result.data,
                        catalog: result.data.catalog.filter(
                          ({ definition }) => !definition.id.startsWith("iphone-"),
                        ),
                      },
                    }
                  : result;
              }
            : Reflect.get(target, key, receiver),
      }),
    });
  }
  const fake = createFakeIphoneApps({
    deviceName: "Alex's iPhone",
    host: () => host,
    ...(options.offers === undefined ? {} : { offers: options.offers }),
  });
  // The mock Host's stand-in for pushing a registered key back to the iPhone.
  const dispatch = host.dispatch.bind(host);
  host.dispatch = async (command) => {
    const result = await dispatch(command);
    await observeMockHostCommand(fake, command);
    return result;
  };
  const shown: { expiresAt: string; id: string }[] = [];
  const controller = new IphoneAppsController({
    bridge: fake.bridge,
    shownApprovals: {
      read: async () => [...shown],
      write: async (entries) => {
        shown.splice(0, shown.length, ...entries);
      },
    },
    timing: { approvalWaitMs: 2_000, enrollWaitMs: 2_000, revokeMs: 2_000 },
  });
  disposers.push(() => controller.dispose());
  controller.attachHost({ deploymentId, hostClient: host });
  return {
    controller,
    fake,
    host,
    lastRequestId: () => {
      const answered = [...fake.device.calls]
        .reverse()
        .find((call) => call.startsWith("answerApproval:"));
      return answered?.split(":")[1] ?? "";
    },
  };
}

async function addedIphone(options?: Parameters<typeof iphone>[0]): Promise<Phone> {
  const phone = iphone(options);
  await phone.controller.load();
  const outcome = await phone.controller.add({
    deploymentId,
    hostClient: phone.host,
    iphoneAppsAvailable: true,
    name: "Alex's iPhone",
  });
  if (outcome.kind !== "added") throw new Error(`The fake iPhone was not added: ${outcome.kind}.`);
  await vi.waitFor(() =>
    expect(phone.controller.getState().snapshot.approvalKey?.registered).toBe(true),
  );
  return phone;
}

async function turnOn(
  phone: Phone,
  app: IphoneAppId,
  access: "read" | "read-write",
): Promise<void> {
  phone.fake.device.setPermission(app, "granted");
  await phone.controller.allow({ access, app, hostClient: phone.host });
}

/** What a task asking for an app does: the Host keeps a request the iPhone lists. */
async function requestFromTask(
  phone: Phone,
  app: IphoneAppId,
  access: "read" | "read-write",
): Promise<void> {
  await phone.host.dispatch({
    idempotencyKey: `task-asks-${app}`,
    input: {
      access,
      app: null,
      definitionId: app,
      kind: "app",
      runnerId: phone.fake.device.runnerId(),
    },
    type: "integration.computer.setup.request",
  });
  await vi.waitFor(() =>
    expect(
      phone.controller
        .getState()
        .snapshot.approvals.some(({ definitionId }) => definitionId === app),
    ).toBe(true),
  );
}

/** The Computer page's own reload: what the Host says now, after every change. */
function useAppsData(host: MockHostClient): {
  readonly data: ComputerUseData | null;
  readonly machine: MachineSummary | null;
  readonly reload: () => Promise<void>;
} {
  const [data, setData] = useState<ComputerUseData | null>(null);
  const [machine, setMachine] = useState<MachineSummary | null>(null);
  const reload = useCallback(async () => {
    const [dashboard, platform, setup] = await Promise.all([
      host.rpc["integrations.get"]({}).then(unwrapRpcResult),
      host.rpc["integration.platform.get"]({}).then(unwrapRpcResult),
      host.rpc["integration.computer.setup.list"]({}).then(unwrapRpcResult),
    ]);
    setData({
      connections: dashboard.connections,
      definitions: platform.catalog.map(({ definition }) => definition),
      setupRequests: setup.requests,
    });
  }, [host]);
  useEffect(() => {
    void reload();
    return host.subscribe(() => void reload());
  }, [host, reload]);
  useEffect(() => {
    const read = () =>
      setMachine(
        host.getSnapshot().machines.find(({ device }) => device?.platform === "ios") ?? null,
      );
    read();
    return host.subscribe(read);
  }, [host]);
  return { data, machine, reload };
}

function ThisIphone(props: {
  readonly canRespond?: boolean;
  readonly onRemoved?: () => void;
  readonly phone: Phone;
}): ReactNode {
  const { data, machine, reload } = useAppsData(props.phone.host);
  if (machine === null) return <p>No iPhone</p>;
  return (
    <IphoneAppsBlock
      canRespond={props.canRespond ?? true}
      controller={props.phone.controller}
      data={data}
      hostClient={props.phone.host}
      machine={machine}
      onChanged={reload}
      onRemoved={props.onRemoved ?? (() => undefined)}
      opensteer={opensteer}
    />
  );
}

function OtherDevice(props: { readonly offline?: boolean; readonly phone: Phone }): ReactNode {
  const { data, machine, reload } = useAppsData(props.phone.host);
  if (machine === null) return <p>No iPhone</p>;
  return (
    <RemoteIphoneAppsBlock
      canRespond
      data={data}
      hostClient={props.phone.host}
      // The Host lists the iPhone as away; it is reachable from this device.
      machine={props.offline === true ? { ...machine, status: "offline" } : machine}
      onChanged={reload}
    />
  );
}

async function mount(element: ReactNode): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(element));
  await settle();
  return container;
}

function text(): string {
  return document.body.textContent ?? "";
}

/** Each app row, as its accessible label reads: its name, then its line. */
function rowLabels(): readonly string[] {
  return [...document.querySelectorAll<HTMLButtonElement>("button[aria-label]")]
    .map((row) => row.getAttribute("aria-label") ?? "")
    .filter((label) => /^(Calendar|Contacts|Reminders|Location|Photos), /u.test(label));
}

/** Each row's status colour, in order. */
function tones(): readonly string[] {
  return [...document.querySelectorAll<HTMLElement>("i[data-tone]")].map(
    (dot) => dot.dataset.tone ?? "",
  );
}

/** The access levels a sheet offers, as a screen reader hears each and whether it is chosen. */
function radios(): readonly string[] {
  return [...document.querySelectorAll<HTMLButtonElement>('button[role="radio"]')].map(
    (choice) =>
      `${choice.getAttribute("aria-label") ?? ""}: ${choice.getAttribute("aria-checked") === "true" ? "checked" : "unchecked"}`,
  );
}

function radio(level: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button[role="radio"]')].find(
    (choice) => (choice.getAttribute("aria-label") ?? "").split(", ")[0] === level,
  );
  if (found === undefined) throw new Error(`Missing access level: ${level}\n${text()}`);
  return found;
}

function section(label: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`section[aria-label="${CSS.escape(label)}"]`);
}

function button(label: string): HTMLButtonElement {
  const found = maybeButton(label);
  if (found === null) throw new Error(`Missing button: ${label}\n${text()}`);
  return found;
}

function maybeButton(label: string): HTMLButtonElement | null {
  return (
    [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) =>
        candidate.getAttribute("aria-label") === label || candidate.textContent === label,
    ) ?? null
  );
}

function input(label: string): HTMLInputElement {
  const found = document.querySelector<HTMLInputElement>(
    `input[aria-label="${CSS.escape(label)}"]`,
  );
  if (found === null) throw new Error(`Missing input: ${label}`);
  return found;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => element.click());
  await settle();
}

async function type(element: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setValue?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let pass = 0; pass < 5; pass += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
