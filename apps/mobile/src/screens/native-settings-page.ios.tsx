import {
  BottomSheet,
  Button,
  Circle,
  ContextMenu,
  SwipeActions,
  Picker,
  DisclosureGroup,
  Host,
  HStack,
  Image,
  ProgressView,
  RNHostView,
  Section,
  SecureField,
  Spacer,
  Text,
  TextField,
  Toggle,
  useNativeState,
  List,
  NavigationStack,
  Toolbar,
  ToolbarItem,
  VStack,
} from "@expo/ui/swift-ui";
import {
  accessibilityHidden,
  accessibilityLabel,
  buttonBorderShape,
  buttonStyle,
  contentShape,
  controlSize,
  disabled,
  font,
  foregroundStyle,
  frame,
  listStyle,
  searchable,
  navigationTitle,
  shapes,
  tag,
  textSelection,
  tint,
  pickerStyle,
} from "@expo/ui/swift-ui/modifiers";
import { useNavigation } from "@react-navigation/native";
import { useEffect, type ReactNode } from "react";
import { color } from "../theme.js";
import { IntegrationIcon } from "../ui/integration-icon.js";
import type {
  NativeSettingsPageProps,
  NativeSettingsRow,
  NativeSettingsSection,
  NativeSettingsStep,
  NativeSettingsTone,
} from "./native-settings-page.types.js";
import { Chevron, IdentityMark, Lines } from "./settings-form-primitives.ios.js";

const toneColor: Record<NativeSettingsTone, string> = {
  neutral: color.muted,
  good: color.green,
  attention: color.amber,
  bad: color.red,
};
const footnote = font({ textStyle: "footnote" });
export function NativeSettingsPage(props: NativeSettingsPageProps) {
  const query = useNativeState("");
  const navigation = useNavigation();
  const content = (
    <List
      modifiers={[
        listStyle("insetGrouped"),
        ...(props.search
          ? [searchable(query, { prompt: "Search plugins", onChange: props.search.onChange })]
          : []),
      ]}
    >
      {props.sections.map((section) => (
        <Section
          key={section.key}
          title={section.collapsed ? "" : section.title}
          {...(section.footer ? { footer: <Footer footer={section.footer} /> } : {})}
        >
          {section.collapsed ? (
            <DisclosureGroup label={section.title}>
              {section.rows.map((row) => (
                <Row key={row.key} row={row} />
              ))}
            </DisclosureGroup>
          ) : (
            section.rows.map((row) => <Row key={row.key} row={row} />)
          )}
        </Section>
      ))}
    </List>
  );
  return (
    <Host style={{ flex: 1 }} useViewportSizeMeasurement>
      {props.sheet ? (
        <BottomSheet
          isPresented
          onIsPresentedChange={(open) => {
            if (!open) props.sheet?.onClose();
          }}
        >
          <NavigationStack>
            <Toolbar modifiers={[navigationTitle(props.sheet.title)]}>
              {content}
              <Toolbar.Content>
                <ToolbarItem placement="topBarTrailing">
                  <Button label="Close" onPress={props.sheet.onClose} />
                </ToolbarItem>
              </Toolbar.Content>
            </Toolbar>
          </NavigationStack>
        </BottomSheet>
      ) : props.search ? (
        <NavigationStack>
          <Toolbar modifiers={[navigationTitle("Plugins")]}>
            {content}
            <Toolbar.Content>
              <ToolbarItem placement="topBarLeading">
                <Button label="Settings" onPress={() => navigation.goBack()} />
              </ToolbarItem>
            </Toolbar.Content>
          </Toolbar>
        </NavigationStack>
      ) : (
        content
      )}
    </Host>
  );
}
function Row({ row }: { readonly row: NativeSettingsRow }) {
  if (row.kind === "chips")
    return (
      <Picker
        label={row.label}
        selection={row.value}
        onSelectionChange={row.onChange}
        // A few choices sit side by side; more than fit a row open as a menu.
        modifiers={[pickerStyle(row.choices.length > 3 ? "menu" : "segmented")]}
      >
        {row.choices.map((choice) => (
          <Text key={choice.value} modifiers={[tag(choice.value)]}>
            {choice.label}
          </Text>
        ))}
      </Picker>
    );
  if (row.kind === "text")
    return row.initial === undefined ? (
      <Lines detail={row.detail ?? null} title={row.label} />
    ) : (
      <HStack alignment="center" spacing={12}>
        <IdentityMark circular initial={row.initial} />
        <Lines detail={row.detail ?? null} title={row.label} />
      </HStack>
    );
  if (row.kind === "status") return <StatusRow row={row} />;
  if (row.kind === "primary")
    return (
      <Button
        modifiers={[
          buttonStyle("borderedProminent"),
          buttonBorderShape("capsule"),
          controlSize("large"),
          tint(color.ember),
          disabled(row.disabled ?? false),
        ]}
        onPress={row.onPress}
      >
        <Text
          modifiers={[
            font({ textStyle: "headline" }),
            foregroundStyle(color.inkOnEmber),
            frame({ maxWidth: Infinity }),
          ]}
        >
          {row.label}
        </Text>
      </Button>
    );
  if (row.kind === "button") {
    const plain =
      row.detail === undefined && row.opens !== true ? (
        <Button
          label={row.label}
          role={row.destructive ? "destructive" : "default"}
          modifiers={[disabled(row.disabled ?? false), frame({ minHeight: 44 })]}
          onPress={row.onPress}
        />
      ) : (
        <Button
          modifiers={[
            disabled(row.disabled ?? false),
            accessibilityLabel(row.detail ? `${row.label}, ${row.detail}` : row.label),
          ]}
          onPress={row.onPress}
        >
          <HStack alignment="center" modifiers={[contentShape(shapes.rectangle())]} spacing={12}>
            <Lines detail={row.detail ?? null} title={row.label} />
            <Spacer />
            {row.opens === true ? <Chevron /> : null}
          </HStack>
        </Button>
      );
    const button = row.mark ? (
      <HStack spacing={12}>
        <RNHostView matchContents>
          <IntegrationIcon definitionId={row.mark.definitionId} name={row.mark.name} size={28} />
        </RNHostView>
        {plain}
      </HStack>
    ) : (
      plain
    );
    if (!row.actions?.length) return button;
    const actions = row.actions.map((action) => (
      <Button
        key={action.label}
        label={action.label}
        role={action.destructive ? "destructive" : "default"}
        modifiers={[disabled(row.disabled ?? false)]}
        onPress={action.onPress}
      />
    ));
    return (
      <SwipeActions>
        <ContextMenu>
          <ContextMenu.Trigger>{button}</ContextMenu.Trigger>
          <ContextMenu.Items>{actions}</ContextMenu.Items>
        </ContextMenu>
        <SwipeActions.Actions allowsFullSwipe={false}>{actions}</SwipeActions.Actions>
      </SwipeActions>
    );
  }
  if (row.kind === "toggle")
    return row.detail === undefined ? (
      <Toggle
        label={row.label}
        isOn={row.value}
        modifiers={[disabled(row.disabled ?? false)]}
        onIsOnChange={row.onChange}
      />
    ) : (
      <Toggle
        isOn={row.value}
        modifiers={[disabled(row.disabled ?? false)]}
        onIsOnChange={row.onChange}
      >
        <Lines detail={row.detail} title={row.label} />
      </Toggle>
    );
  return <Input row={row} />;
}

function Footer({ footer }: { readonly footer: NonNullable<NativeSettingsSection["footer"]> }) {
  return (
    <Text
      modifiers={[
        footnote,
        footer.tone === "danger"
          ? foregroundStyle(color.red)
          : foregroundStyle({ type: "hierarchical", style: "secondary" }),
      ]}
    >
      {footer.text}
    </Text>
  );
}

/** A coloured dot, one short state, and while something is under way its steps. */
function StatusRow({ row }: { readonly row: Extract<NativeSettingsRow, { kind: "status" }> }) {
  return (
    <VStack alignment="leading" spacing={8}>
      <HStack alignment="center" spacing={8}>
        <Circle
          modifiers={[
            foregroundStyle(toneColor[row.tone]),
            frame({ width: 9, height: 9 }),
            accessibilityHidden(true),
          ]}
        />
        <Text modifiers={[font({ textStyle: "body", weight: "semibold" })]}>{row.label}</Text>
      </HStack>
      {row.detail === undefined ? null : (
        <Text
          modifiers={[
            font({ textStyle: "footnote", design: "monospaced" }),
            foregroundStyle(color.textSoft),
            textSelection(true),
          ]}
        >
          {row.detail}
        </Text>
      )}
      {row.steps?.map((step) => (
        <Step key={step.label} step={step} />
      ))}
    </VStack>
  );
}

function Step({ step }: { readonly step: NativeSettingsStep }): ReactNode {
  const mark =
    step.state === "current" ? (
      <ProgressView modifiers={[controlSize("small"), frame({ width: 18, height: 18 })]} />
    ) : (
      <Image
        color={
          step.state === "done" ? color.green : step.state === "failed" ? color.red : color.mutedDim
        }
        modifiers={[accessibilityHidden(true), frame({ width: 18, height: 18 })]}
        size={15}
        systemName={
          step.state === "done"
            ? "checkmark.circle.fill"
            : step.state === "failed"
              ? "xmark.circle.fill"
              : "circle"
        }
      />
    );
  return (
    <HStack alignment="center" spacing={10}>
      {mark}
      <Text
        modifiers={[
          font({ textStyle: "subheadline" }),
          foregroundStyle(step.state === "pending" ? color.muted : color.text),
        ]}
      >
        {step.label}
      </Text>
    </HStack>
  );
}

function Input({ row }: { readonly row: Extract<NativeSettingsRow, { kind: "input" }> }) {
  const text = useNativeState(row.value);
  useEffect(() => {
    text.set(row.value);
  }, [text, row.value]);
  return row.secure ? (
    <SecureField text={text} placeholder={row.label} onTextChange={row.onChange} />
  ) : (
    <TextField text={text} placeholder={row.label} onTextChange={row.onChange} />
  );
}
