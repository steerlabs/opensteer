import {
  Button,
  Form,
  HStack,
  Host,
  LabeledContent,
  NavigationStack,
  ProgressView,
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
  buttonBorderShape,
  buttonStyle,
  controlSize,
  disabled,
  font,
  foregroundStyle,
  frame,
  multilineTextAlignment,
  navigationBarTitleDisplayMode,
  navigationTitle,
  tint,
} from "@expo/ui/swift-ui/modifiers";
import type { ReactNode } from "react";
import { color } from "../theme.js";
import { ErrorText, Footer, Lines } from "../screens/settings-form-primitives.ios.js";
import {
  allowInSettings,
  photosFooter,
  readyFooter,
  type ReadyRow,
  type SetupFormProps,
  type SetupSwitch,
} from "./setup-view.js";

const secondary = foregroundStyle({ type: "hierarchical", style: "secondary" });

/**
 * Set up this iPhone as iOS draws a setup step: its own navigation bar with a
 * large title and no Back, one inset grouped form, and Continue pinned to the
 * bottom bar.
 */
export function SetupForm(props: SetupFormProps): ReactNode {
  return (
    <Host style={{ flex: 1 }} useViewportSizeMeasurement>
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
            <ToolbarItem placement="bottomBar">
              <Pinned busy={props.busy} label={props.continueLabel} onPress={props.onContinue} />
            </ToolbarItem>
          </Toolbar.Content>
        </Toolbar>
      </NavigationStack>
    </Host>
  );
}

export function ReadyForm(props: {
  readonly title: string;
  readonly body: string;
  readonly agent: readonly ReadyRow[];
  readonly here: readonly ReadyRow[];
  readonly noun: string;
  readonly onDone: () => void;
}): ReactNode {
  return (
    <Host style={{ flex: 1 }} useViewportSizeMeasurement>
      <NavigationStack>
        <Toolbar modifiers={[navigationTitle(props.title), navigationBarTitleDisplayMode("large")]}>
          <Form>
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
            <Section
              footer={<Footer text={readyFooter(props.noun)} />}
              title={`On this ${props.noun}`}
            >
              {props.here.map((row) => (
                <Value key={row.key} row={row} />
              ))}
            </Section>
          </Form>
          <Toolbar.Content>
            <ToolbarItem placement="bottomBar">
              <Pinned busy={false} label="Start using Opensteer" onPress={props.onDone} />
            </ToolbarItem>
          </Toolbar.Content>
        </Toolbar>
      </NavigationStack>
    </Host>
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

function Pinned(props: {
  readonly busy: boolean;
  readonly label: string;
  readonly onPress: () => void;
}): ReactNode {
  return (
    <Button
      modifiers={[
        buttonStyle("borderedProminent"),
        buttonBorderShape("capsule"),
        controlSize("large"),
        tint(color.ember),
        disabled(props.busy),
        frame({ maxWidth: Infinity }),
      ]}
      onPress={props.onPress}
    >
      {props.busy ? (
        <ProgressView modifiers={[frame({ maxWidth: Infinity })]} />
      ) : (
        <Text
          modifiers={[
            font({ textStyle: "headline" }),
            foregroundStyle(color.inkOnEmber),
            frame({ maxWidth: Infinity }),
          ]}
        >
          {props.label}
        </Text>
      )}
    </Button>
  );
}
