import {
  cloudComputerDeleteInput,
  cloudComputerWebsite,
  cloudWords,
  type CloudComputerDetail,
  type CloudComputerScreen as CloudScreen,
} from "@opensteer/client/computers";
import { useCloudComputer } from "@opensteer/client/react";
import type { DesktopCloudComputerActInput } from "@opensteer/protocol/desktop";
import { useNavigation } from "@react-navigation/native";
import { useEffect, useState, type ReactNode } from "react";
import { Alert, AppState } from "react-native";
import { resetToDeployment } from "../navigation-ref.js";
import { useCopy } from "../ui/copy-mark.js";
import { useMobileClient, useMobileState } from "../ui/mobile-client-context.js";
import { NativeSettingsPage } from "./native-settings-page.js";
import type { NativeSettingsRow, NativeSettingsSection } from "./native-settings-page.types.js";

/**
 * Opensteer Cloud Computer on the phone. Checkout and billing happen on the Opensteer
 * website, never from inside this app: it shows the price and the website's address to
 * open in a browser, and no purchase button.
 */
export function CloudComputerScreen(): ReactNode {
  const client = useMobileClient();
  const { rows } = useMobileState();
  const navigation = useNavigation();
  const cloud = useCloudComputer(client.cloudComputers);
  const { copy, copied } = useCopy();
  const [deleting, setDeleting] = useState<CloudComputerDetail | null>(null);
  const [typed, setTyped] = useState("");
  const refresh = cloud.refresh;
  // Coming back to the app, from the website or anywhere else, reads the status again.
  useEffect(() => {
    if (!refresh) return;
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void refresh();
    });
    return () => subscription.remove();
  }, [refresh]);
  const listed = (address: string) => {
    const origin = new URL(address).origin;
    return rows.find((row) => safeOrigin(row.origin) === origin) ?? null;
  };
  const open = (address: string, then: "home" | "agents") => {
    const row = listed(address);
    if (!row) return;
    void client.openDeployment(row.deploymentId).then(() => {
      if (then === "home") resetToDeployment(row.deploymentId);
      else navigation.navigate("SettingsExternalAgents", { deploymentId: row.deploymentId });
    });
  };
  const act = (input: DesktopCloudComputerActInput) => void cloud.act?.(input);
  const sections = cloudComputerSections({
    screen: cloud.screen,
    pending: cloud.pending,
    actionFailure: cloud.actionFailure,
    portalOrigin: client.portalOrigin,
    copied,
    onCopy: (text) => void copy(text),
    onRetry: () => void refresh?.(),
    onSignIn: () => navigation.goBack(),
    listed: (address) => listed(address) !== null,
    onOpen: (address) => open(address, "home"),
    onAgents: (address) => open(address, "agents"),
    onSuspend: (computer) =>
      Alert.alert(cloudWords("cloud.suspend.title"), cloudWords("cloud.suspend.body"), [
        { text: "Cancel", style: "cancel" },
        {
          text: cloudWords("cloud.suspend"),
          onPress: () => act({ action: "suspend", id: computer.id }),
        },
      ]),
    onResume: (computer) => act({ action: "resume", id: computer.id }),
    onDelete: (computer) => {
      setTyped("");
      setDeleting(computer);
    },
  });
  const remove = deleting ? cloudComputerDeleteInput(deleting.id, typed) : null;
  return (
    <>
      <NativeSettingsPage sections={sections} />
      {deleting === null ? null : (
        <NativeSettingsPage
          sheet={{ title: cloudWords("cloud.delete.title"), onClose: () => setDeleting(null) }}
          sections={[
            {
              key: "delete",
              title: "",
              rows: [
                {
                  key: "word",
                  kind: "input",
                  label: cloudWords("cloud.delete.typeToConfirm"),
                  value: typed,
                  onChange: setTyped,
                },
                {
                  key: "confirm",
                  kind: "button",
                  label: cloudWords("cloud.delete.confirm"),
                  destructive: true,
                  disabled: remove === null,
                  onPress: () => {
                    if (!remove) return;
                    setDeleting(null);
                    act(remove);
                  },
                },
              ],
              footer: { text: cloudWords("cloud.delete.body") },
            },
          ]}
        />
      )}
    </>
  );
}

function safeOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

const points = [
  ["cloud.point.awake.title", "cloud.point.awake.detail"],
  ["cloud.point.ip.title", "cloud.point.ip.detail"],
  ["cloud.point.backup.title", "cloud.point.backup.detail"],
  ["cloud.point.mac.title", "cloud.point.mac.detail"],
] as const;

function whatItIs(): NativeSettingsSection {
  return {
    key: "points",
    title: "",
    rows: points.map(([title, detail]) => ({
      key: title,
      kind: "text",
      label: cloudWords(title),
      detail: cloudWords(detail),
    })),
  };
}

function changes(): NativeSettingsSection {
  return {
    key: "changes",
    title: cloudWords("cloud.changes.title"),
    rows: [{ key: "changes", kind: "text", label: cloudWords("cloud.changes.detail") }],
  };
}

/** The screen as Settings sections: pure, so each state is checked without a device. */
export function cloudComputerSections(props: {
  readonly screen: CloudScreen;
  readonly pending: "suspend" | "resume" | "delete" | null;
  readonly actionFailure: string | null;
  readonly portalOrigin: string | null;
  readonly copied: boolean;
  readonly onCopy: (text: string) => void;
  readonly onRetry: () => void;
  readonly onSignIn: () => void;
  readonly listed: (address: string) => boolean;
  readonly onOpen: (address: string) => void;
  readonly onAgents: (address: string) => void;
  readonly onSuspend: (computer: CloudComputerDetail) => void;
  readonly onResume: (computer: CloudComputerDetail) => void;
  readonly onDelete: (computer: CloudComputerDetail) => void;
}): readonly NativeSettingsSection[] {
  const { screen } = props;
  const lead: NativeSettingsSection = {
    key: "lead",
    title: "",
    rows: [],
    footer: { text: cloudWords("cloud.lead") },
  };
  const website = (page: "checkout" | "billing", text: string): NativeSettingsSection => {
    const url = props.portalOrigin ? cloudComputerWebsite(props.portalOrigin, page) : null;
    return {
      key: `website-${page}`,
      title: "",
      rows:
        url === null
          ? []
          : [
              {
                key: "address",
                kind: "status",
                tone: "neutral",
                label: cloudWords("cloud.checkoutWebAddress"),
                detail: url,
              },
              {
                key: "copy",
                kind: "button",
                label: props.copied ? cloudWords("cloud.copied") : cloudWords("cloud.copy"),
                onPress: () => props.onCopy(url),
              },
            ],
      footer: { text },
    };
  };
  if (screen.kind === "loading")
    return [
      lead,
      {
        key: "loading",
        title: "",
        rows: [{ key: "placeholder", kind: "placeholder", label: cloudWords("cloud.loading") }],
      },
    ];
  if (screen.kind === "failed")
    return [
      lead,
      {
        key: "failed",
        title: "",
        rows:
          screen.failure.kind === "signed-out"
            ? [
                {
                  key: "sign-in",
                  kind: "button",
                  label: cloudWords("cloud.account.signIn"),
                  onPress: props.onSignIn,
                },
              ]
            : screen.failure.kind === "unavailable"
              ? []
              : [
                  {
                    key: "retry",
                    kind: "button",
                    label: cloudWords("cloud.tryAgain"),
                    onPress: props.onRetry,
                  },
                ],
        footer: {
          text: screen.failure.message,
          ...(screen.failure.kind === "unavailable" ? {} : { tone: "danger" as const }),
        },
      },
    ];
  if (screen.kind === "offer")
    return [
      lead,
      ...(screen.deleted
        ? [{ key: "deleted", title: "", rows: [], footer: { text: cloudWords("cloud.deleted") } }]
        : []),
      whatItIs(),
      {
        key: "price",
        title: "",
        rows: [
          {
            key: "price",
            kind: "text",
            label: screen.plan.line,
            detail: cloudWords("cloud.priceDetail"),
          },
        ],
      },
      changes(),
      website("checkout", cloudWords("cloud.checkoutWebDetail")),
    ];
  if (screen.kind === "preparing")
    return [
      lead,
      {
        key: "preparing",
        title: "",
        rows: [
          {
            key: "status",
            kind: "status",
            tone: "neutral",
            label: cloudWords("cloud.preparing.title"),
            steps: [
              { label: cloudWords("cloud.step.machine"), state: "current" },
              { label: cloudWords("cloud.step.ready"), state: "pending" },
            ],
          },
        ],
        footer: {
          text: `${cloudWords("cloud.step.machineDetail")} ${cloudWords("cloud.preparing.footer")}`,
        },
      },
      changes(),
    ];
  const { computer } = screen;
  const busy = props.pending !== null;
  const address = computer.address;
  const sections: NativeSettingsSection[] = [lead];
  if (address !== null) {
    const listed = props.listed(address);
    sections.push({
      key: "ready",
      title: "",
      rows: [
        {
          key: "open",
          kind: "button",
          label: cloudWords("cloud.ready.open"),
          detail: computer.host ?? address,
          disabled: !listed,
          onPress: () => props.onOpen(address),
        },
        {
          key: "agents",
          kind: "button",
          label: cloudWords("cloud.ready.reconnect"),
          opens: true,
          disabled: !listed,
          onPress: () => props.onAgents(address),
        },
      ],
      ...(listed ? {} : { footer: { text: cloudWords("cloud.ready.notListed") } }),
    });
  }
  sections.push({
    key: "status",
    title: cloudWords("cloud.status.title"),
    rows: [
      {
        key: "status",
        kind: "status",
        tone: computer.status.tone,
        label: computer.status.label,
        ...(address === null ? {} : { detail: address }),
      },
      ...(address === null
        ? []
        : [
            {
              key: "copy",
              kind: "button" as const,
              label: props.copied ? cloudWords("cloud.copied") : cloudWords("cloud.copy"),
              onPress: () => props.onCopy(address),
            },
          ]),
      {
        key: "ip",
        kind: "text",
        label: `${cloudWords("cloud.ip.title")} · ${computer.browserIp.label}`,
        detail: computer.browserIp.detail,
      },
    ],
    ...(computer.status.reason ? { footer: { text: computer.status.reason } } : {}),
  });
  sections.push({
    key: "plan",
    title: cloudWords("cloud.plan.title"),
    rows: [{ key: "plan", kind: "text", label: screen.plan.line }],
  });
  sections.push(website("billing", cloudWords("cloud.plan.manageWeb")));
  const power: NativeSettingsRow[] = [];
  if (computer.canSuspend)
    power.push({
      key: "suspend",
      kind: "button",
      label:
        props.pending === "suspend" ? cloudWords("cloud.suspending") : cloudWords("cloud.suspend"),
      detail: cloudWords("cloud.suspend.detail"),
      disabled: busy,
      onPress: () => props.onSuspend(computer),
    });
  if (computer.canResume)
    power.push({
      key: "resume",
      kind: "button",
      label: props.pending === "resume" ? cloudWords("cloud.resuming") : cloudWords("cloud.resume"),
      disabled: busy,
      onPress: () => props.onResume(computer),
    });
  power.push({
    key: "delete",
    kind: "button",
    label: props.pending === "delete" ? cloudWords("cloud.deleting") : cloudWords("cloud.delete"),
    destructive: true,
    disabled: busy,
    onPress: () => props.onDelete(computer),
  });
  sections.push({
    key: "power",
    title: "",
    rows: power,
    ...(props.actionFailure
      ? { footer: { text: props.actionFailure, tone: "danger" as const } }
      : {}),
  });
  return sections;
}
