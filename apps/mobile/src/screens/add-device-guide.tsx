import { iphoneSetupNeeds, iphoneSetupOnMacSteps } from "@opensteer/client/integrations";
import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { space } from "../theme.js";
import { AppText, SecondaryButton, SectionLabel } from "../ui/primitives.js";
import type { NativeSettingsRow, NativeSettingsSection } from "./native-settings-page.types.js";

/**
 * What Add a device says, by the thing being added. It is drawn inside the sheet's own scroll
 * view, as the sheet's other content is, so its first title sits under the sheet's header and
 * its last row scrolls into reach at every text size.
 */
export function addDeviceGuideSections(input: {
  readonly onConnectSomethingElse: () => void;
}): readonly NativeSettingsSection[] {
  return [
    {
      key: "mac",
      title: "A Mac",
      rows: [
        {
          key: "instructions",
          kind: "text",
          label:
            "Install Opensteer on the Mac and sign in with the same Opensteer account. It shows up here, and you choose what your agent can use.",
        },
      ],
    },
    {
      key: "add-phone",
      title: "A phone",
      rows: [
        {
          key: "instructions",
          kind: "text",
          label: "Get the Opensteer app on the phone and sign in with the same Opensteer account.",
        },
      ],
    },
    {
      key: "chrome",
      title: "Chrome",
      rows: [
        {
          key: "instructions",
          kind: "text",
          label:
            "Share tabs from your Chrome: connect it in Opensteer on your Mac, in Settings › Chrome.",
        },
      ],
    },
    {
      key: "iphone-screen",
      title: "iPhone screen control",
      rows: [
        {
          key: "instructions",
          kind: "text",
          label:
            "Your agent sees and controls an iPhone’s screen through one of your Macs, plugged in or on the same Wi‑Fi. Setup happens in Opensteer on that Mac.",
        },
      ],
    },
    {
      key: "iphone-screen-needs",
      title: "You’ll need",
      rows: iphoneSetupNeeds.map((need) => ({
        key: need.id,
        kind: "text" as const,
        label: need.title,
        detail: need.detail,
      })),
    },
    {
      key: "iphone-screen-steps",
      title: "On your Mac",
      rows: iphoneSetupOnMacSteps.map((step, index) => ({
        key: `step-${index}`,
        kind: "text" as const,
        label: `${index + 1}. ${step}`,
      })),
    },
    {
      key: "agent-phone",
      title: "Android Agent Phone",
      rows: [
        {
          key: "instructions",
          kind: "text",
          label:
            "Connect your Android phone by USB to one of your Macs. Open Devices there and choose Set up Agent Phone.",
        },
      ],
    },
    {
      key: "server",
      title: "Linux server",
      rows: [
        {
          key: "instructions",
          kind: "text",
          label: "Create a command above, then run it on the server you want to add.",
        },
      ],
    },
    {
      key: "other",
      title: "Something else",
      rows: [
        {
          key: "instructions",
          kind: "text",
          label:
            "A TV, speaker, light or anything else on your network. An agent sets it up in a new task.",
        },
        {
          key: "connect",
          kind: "button",
          label: "Connect something else",
          onPress: input.onConnectSomethingElse,
        },
      ],
    },
  ];
}

export function AddDeviceGuide(props: {
  readonly sections: readonly NativeSettingsSection[];
}): ReactNode {
  return (
    <View style={styles.guide}>
      {props.sections.map((section) => (
        <View key={section.key} style={styles.section}>
          {section.title ? <SectionLabel>{section.title}</SectionLabel> : null}
          {section.rows.map((row) => (
            <GuideRow key={row.key} row={row} />
          ))}
        </View>
      ))}
    </View>
  );
}

function GuideRow(props: { readonly row: NativeSettingsRow }): ReactNode {
  const { row } = props;
  if (row.kind === "button") return <SecondaryButton label={row.label} onPress={row.onPress} />;
  return (
    <View style={styles.row}>
      <AppText role="body">{row.label}</AppText>
      {"detail" in row && row.detail ? (
        <AppText role="secondary" tone="muted">
          {row.detail}
        </AppText>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  guide: { gap: space[24] },
  row: { gap: space[4] },
  section: { gap: space[8] },
});
