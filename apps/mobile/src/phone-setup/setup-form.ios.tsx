import {
  Button,
  Form,
  HStack,
  Host,
  LabeledContent,
  NavigationStack,
  Section,
  Text,
  TextField,
  Toggle,
  Toolbar,
  ToolbarItem,
  useNativeState,
} from "@expo/ui/swift-ui";
import {
  autocorrectionDisabled,
  disabled,
  font,
  foregroundStyle,
  multilineTextAlignment,
  navigationBarTitleDisplayMode,
  navigationTitle,
} from "@expo/ui/swift-ui/modifiers";
import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { PrimaryButton } from "../ui/primitives.js";
import { color } from "../theme.js";
import { ErrorText, Footer, Lines } from "../screens/settings-form-primitives.ios.js";
import {
  allowInSettings,
  photosFooter,
  readyFooter,
  type ReadyFormProps,
  type ReadyRow,
  type SetupFormProps,
  type SetupSwitch,
} from "./setup-view.js";

const secondary = foregroundStyle({ type: "hierarchical", style: "secondary" });

export function SetupStep(props: {
  readonly setup: SetupFormProps;
  readonly ready: ReadyFormProps | null;
}): ReactNode {
  // One Host for both phases: Ready replaces the content and the action in place.
  const ready = props.ready;
  return (
    <Page
      action={
        ready === null ? (
          <Pinned
            busy={props.setup.busy}
            label={props.setup.continueLabel}
            onPress={props.setup.onContinue}
          />
        ) : (
          <Pinned busy={false} label="Start using Opensteer" onPress={ready.onDone} />
        )
      }
    >
      {ready === null ? <SetupForm {...props.setup} /> : <ReadyForm {...ready} />}
    </Page>
  );
}

function SetupForm(props: SetupFormProps): ReactNode {
  return (
    <NavigationStack>
      <Toolbar modifiers={[navigationTitle(props.title), navigationBarTitleDisplayMode("large")]}>
        <Form>
          <Section>
            <Name busy={props.busy} name={props.name} onName={props.onName} />
          </Section>
          <Section
            footer={
              props.agent.some((row) => row.denied) ? (
                <DeniedFooter rows={props.agent} onOpenSettings={props.onOpenSettings} />
              ) : (
                <Footer text={props.disclosure} />
              )
            }
            title="Your agent can use"
          >
            {props.agent.map((row) => (
              <Switch key={row.key} onToggle={props.onToggle} row={row} />
            ))}
          </Section>
          {props.photos === null ? null : (
            <Section
              footer={
                props.photos.denied ? (
                  <DeniedFooter rows={[props.photos]} onOpenSettings={props.onOpenSettings} />
                ) : (
                  <Footer text={photosFooter} />
                )
              }
            >
              <Switch onToggle={props.onToggle} row={props.photos} />
            </Section>
          )}
          <Section
            footer={
              <DeniedFooter rows={[props.notifications]} onOpenSettings={props.onOpenSettings} />
            }
            title={`On this ${props.noun}`}
          >
            <Switch onToggle={props.onToggle} row={props.notifications} />
          </Section>
          {props.failure === null ? null : (
            <Section>
              <ErrorText detail={props.failure} />
            </Section>
          )}
        </Form>
        <Toolbar.Content>
          {props.onNotNow === null ? null : (
            <ToolbarItem placement="topBarLeading">
              <Button label="Not now" onPress={props.onNotNow} />
            </ToolbarItem>
          )}
        </Toolbar.Content>
      </Toolbar>
    </NavigationStack>
  );
}

function ReadyForm(props: ReadyFormProps): ReactNode {
  return (
    <NavigationStack>
      <Form modifiers={[navigationTitle(props.title), navigationBarTitleDisplayMode("large")]}>
        <Section>
          <Text modifiers={[font({ textStyle: "body" }), foregroundStyle(color.textSoft)]}>
            {props.body}
          </Text>
        </Section>
        <Section title="Your agent can use">
          {props.agent.map((row) => (
            <Value key={row.key} row={row} />
          ))}
        </Section>
        <Section footer={<Footer text={readyFooter(props.noun)} />} title={`On this ${props.noun}`}>
          {props.here.map((row) => (
            <Value key={row.key} row={row} />
          ))}
        </Section>
      </Form>
    </NavigationStack>
  );
}

function Name(props: {
  readonly busy: boolean;
  readonly name: string;
  readonly onName: (name: string) => void;
}): ReactNode {
  // Seeded once: the field owns its text, and edits flow back through onName.
  const text = useNativeState(props.name);
  return (
    <LabeledContent label="Name">
      <TextField
        maxLength={120}
        modifiers={[
          autocorrectionDisabled(),
          disabled(props.busy),
          multilineTextAlignment("trailing"),
        ]}
        placeholder="Name"
        text={text}
        onTextChange={props.onName}
      />
    </LabeledContent>
  );
}

function Switch(props: {
  readonly row: SetupSwitch;
  readonly onToggle: SetupFormProps["onToggle"];
}): ReactNode {
  return (
    <Toggle
      isOn={props.row.value}
      modifiers={[disabled(props.row.disabled)]}
      onIsOnChange={(value) => props.onToggle(props.row.key, value)}
    >
      <Lines detail={props.row.detail} title={props.row.title} />
    </Toggle>
  );
}

function DeniedFooter(props: {
  readonly rows: readonly SetupSwitch[];
  readonly onOpenSettings: () => void;
}): ReactNode {
  const denied = props.rows.filter((row) => row.denied).map((row) => row.title);
  if (denied.length === 0) return null;
  return (
    <HStack spacing={4}>
      <Text modifiers={[font({ textStyle: "footnote" }), secondary]}>
        {`${denied.join(", ")} ${denied.length === 1 ? "isn't" : "aren't"} allowed.`}
      </Text>
      <Button onPress={props.onOpenSettings}>
        <Text modifiers={[font({ textStyle: "footnote" }), foregroundStyle(color.ember)]}>
          {allowInSettings}
        </Text>
      </Button>
    </HStack>
  );
}

function Value(props: { readonly row: ReadyRow }): ReactNode {
  return (
    <LabeledContent label={props.row.title}>
      <Text modifiers={[props.row.attention ? foregroundStyle(color.amber) : secondary]}>
        {props.row.value}
      </Text>
    </LabeledContent>
  );
}

/** The action is the app's capsule: a SwiftUI button in a second phase stopped receiving taps. */
function Page(props: { readonly action: ReactNode; readonly children: ReactNode }): ReactNode {
  const insets = useSafeAreaInsets();
  return (
    <View style={styles.page}>
      <Host style={styles.form}>{props.children}</Host>
      <View style={[styles.action, { paddingBottom: Math.max(insets.bottom, 16) }]}>
        {props.action}
      </View>
    </View>
  );
}

function Pinned(props: {
  readonly busy: boolean;
  readonly label: string;
  readonly onPress: () => void;
}): ReactNode {
  return <PrimaryButton busy={props.busy} label={props.label} onPress={props.onPress} prominent />;
}

const styles = StyleSheet.create({
  action: { backgroundColor: color.background, paddingHorizontal: 20, paddingTop: 12 },
  form: { flex: 1 },
  page: { backgroundColor: color.background, flex: 1 },
});
