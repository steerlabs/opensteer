import { Text } from "@expo/ui/jetpack-compose";
import { clickable, padding } from "@expo/ui/jetpack-compose/modifiers";
import type { ReactNode } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { color } from "../theme.js";
import {
  ErrorText,
  Footer,
  InputRow,
  PrimaryButton,
  Section,
  SettingsHost,
  SettingsList,
  ToggleRow,
  ValueRow,
} from "../screens/settings-form-primitives.android.js";
import {
  allowInSettings,
  photosFooter,
  readyFooter,
  type ReadyFormProps,
  type SetupFormProps,
  type SetupSwitch,
} from "./setup-view.js";

/**
 * Set up this phone in Material 3: a large title, list items with trailing
 * switches, and one filled button held at the bottom.
 */
export function SetupStep(props: {
  readonly setup: SetupFormProps;
  readonly ready: ReadyFormProps | null;
}): ReactNode {
  return props.ready === null ? <SetupForm {...props.setup} /> : <ReadyForm {...props.ready} />;
}

function SetupForm(props: SetupFormProps): ReactNode {
  return (
    <Page
      action={
        <PrimaryButton
          disabled={props.busy}
          label={props.busy ? "Setting up…" : props.continueLabel}
          onPress={props.onContinue}
        />
      }
      title={props.title}
    >
      <InputRow
        disabled={props.busy}
        label="Name"
        maxLength={120}
        onChange={props.onName}
        value={props.name}
      />
      <Section title="Your agent can use">
        {props.agent.map((row) => (
          <Switch key={row.key} onToggle={props.onToggle} row={row} />
        ))}
        {props.photos === null ? null : <Switch onToggle={props.onToggle} row={props.photos} />}
        {props.photos === null ? null : <Footer text={photosFooter} />}
        <Denied rows={props.agent} onOpenSettings={props.onOpenSettings} />
        <Footer text={props.disclosure} />
      </Section>
      <Section title={`On this ${props.noun}`}>
        <Switch onToggle={props.onToggle} row={props.notifications} />
        <Denied rows={[props.notifications]} onOpenSettings={props.onOpenSettings} />
      </Section>
      <ErrorText detail={props.failure} />
      {props.onNotNow === null ? null : (
        <Text
          color={color.ember}
          modifiers={[clickable(props.onNotNow), padding(16, 12, 16, 12)]}
          style={{ typography: "labelLarge" }}
        >
          Not now
        </Text>
      )}
    </Page>
  );
}

function ReadyForm(props: ReadyFormProps): ReactNode {
  return (
    <Page
      action={<PrimaryButton label="Start using Opensteer" onPress={props.onDone} />}
      title={props.title}
    >
      <Text
        color={color.textSoft}
        modifiers={[padding(16, 0, 16, 8)]}
        style={{ typography: "bodyLarge" }}
      >
        {props.body}
      </Text>
      <Section title="Your agent can use">
        {props.agent.map((row) => (
          <ValueRow key={row.key} title={row.title} value={row.value} />
        ))}
      </Section>
      <Section footer={readyFooter(props.noun)} title={`On this ${props.noun}`}>
        {props.here.map((row) => (
          <ValueRow key={row.key} title={row.title} value={row.value} />
        ))}
      </Section>
    </Page>
  );
}

function Page(props: {
  readonly title: string;
  readonly action: ReactNode;
  readonly children: ReactNode;
}): ReactNode {
  const insets = useSafeAreaInsets();
  return (
    <View style={{ flex: 1, backgroundColor: color.background, paddingTop: insets.top }}>
      <SettingsHost>
        <SettingsList>
          {/* Material's large top app bar title, at headline size. */}
          <Text
            color={color.text}
            modifiers={[padding(16, 24, 16, 16)]}
            style={{ typography: "headlineMedium" }}
          >
            {props.title}
          </Text>
          {props.children}
        </SettingsList>
      </SettingsHost>
      <View style={{ paddingBottom: insets.bottom, height: 72 + insets.bottom }}>
        <SettingsHost>{props.action}</SettingsHost>
      </View>
    </View>
  );
}

function Switch(props: {
  readonly row: SetupSwitch;
  readonly onToggle: SetupFormProps["onToggle"];
}): ReactNode {
  return (
    <ToggleRow
      detail={props.row.detail}
      disabled={props.row.disabled}
      onChange={(value) => props.onToggle(props.row.key, value)}
      title={props.row.title}
      value={props.row.value}
    />
  );
}

function Denied(props: {
  readonly rows: readonly SetupSwitch[];
  readonly onOpenSettings: () => void;
}): ReactNode {
  const denied = props.rows.filter((row) => row.denied).map((row) => row.title);
  if (denied.length === 0) return null;
  return (
    <Text
      color={color.ember}
      modifiers={[clickable(props.onOpenSettings), padding(16, 4, 16, 8)]}
      style={{ typography: "bodySmall" }}
    >
      {`${denied.join(", ")} ${denied.length === 1 ? "isn't" : "aren't"} allowed. ${allowInSettings}`}
    </Text>
  );
}
