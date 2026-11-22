import {
  BottomSheet,
  Button,
  Capsule,
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
  accessibilityAddTraits,
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
  onSubmit,
  searchable,
  navigationTitle,
  opacity,
  shapes,
  tag,
  textSelection,
  tint,
  pickerStyle,
} from "@expo/ui/swift-ui/modifiers";
import { useNavigation } from "@react-navigation/native";
import { setStringAsync } from "expo-clipboard";
import { useEffect, type ReactNode } from "react";
import { color } from "../theme.js";
import { addressWords } from "../ui/address-words.js";
import { RowMarkIcon } from "../ui/integration-icon.js";
import type {
  NativeSettingsPageProps,
  NativeSettingsRow,
  NativeSettingsStep,
  NativeSettingsTone,
} from "./native-settings-page.types.js";
import {
  Chevron,
  IdentityMark,
  LineFooter,
  Lines,
  linesAddress,
  PlaceholderRow,
  Tile,
} from "./settings-form-primitives.ios.js";

const toneColor: Record<NativeSettingsTone, string> = {
  neutral: color.muted,
  good: color.green,
  attention: color.amber,
  bad: color.red,
};
export function NativeSettingsPage(props: NativeSettingsPageProps) {
  const query = useNativeState("");
  const navigation = useNavigation();
  const content = (
    <List
      modifiers={[
        listStyle("insetGrouped"),
        ...(props.search
          ? [
              searchable(query, {
                prompt: props.search.prompt ?? "Search plugins",
                onChange: props.search.onChange,
              }),
            ]
          : []),
      ]}
    >
      <NativeSettingsSections sections={props.sections} />
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
          <Toolbar modifiers={[navigationTitle(props.search.title ?? "Plugins")]}>
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
/** The sections of a page, for a form that draws its own header above them. */
export function NativeSettingsSections(props: {
  readonly sections: NativeSettingsPageProps["sections"];
}): ReactNode {
  return props.sections.map((section) => (
    <Section
      key={section.key}
      title={section.collapsed ? "" : section.title}
      {...(section.footer ? { footer: <LineFooter footer={section.footer} /> } : {})}
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
  ));
}

function Row({ row }: { readonly row: NativeSettingsRow }) {
  if (row.kind === "chips")
    return (
      <Picker
        label={row.label}
        selection={row.value}
        onSelectionChange={row.onChange}
        // A few choices sit side by side; more than fit a row open as a menu.
        modifiers={[
          pickerStyle(row.menu === true || row.choices.length > 3 ? "menu" : "segmented"),
        ]}
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
      <Lines detail={row.detail ?? null} title={row.label} {...linesAddress(row.addressIn)} />
    ) : (
      <HStack alignment="center" spacing={12}>
        <IdentityMark circular initial={row.initial} />
        <Lines detail={row.detail ?? null} title={row.label} {...linesAddress(row.addressIn)} />
      </HStack>
    );
  if (row.kind === "status") return <StatusRow row={row} />;
  if (row.kind === "choice") return <ChoiceRow row={row} />;
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
          modifiers={[
            disabled(row.disabled ?? false),
            ...(row.destructive ? [] : [tint(color.ember)]),
          ]}
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
            {row.symbol === undefined ? null : <Tile symbol={row.symbol} />}
            <Lines
              detail={row.detail ?? null}
              title={row.label}
              {...linesAddress(row.addressIn)}
              {...(row.tone === "attention" ? { detailColor: color.amber } : {})}
            />
            <Spacer />
            {row.opens === true ? <Chevron /> : null}
          </HStack>
        </Button>
      );
    const lead = row.mark ? <RowMarkIcon mark={row.mark} size={28} /> : (row.lead ?? null);
    const button =
      lead === null ? (
        plain
      ) : (
        <HStack spacing={12}>
          <RNHostView matchContents>{lead}</RNHostView>
          {plain}
        </HStack>
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
  if (row.kind === "placeholder") return <PlaceholderRow label={row.label} />;
  if (row.kind === "toggle") {
    const value = row.value;
    if (value === null) return <UnknownToggleRow row={row} />;
    return row.detail === undefined ? (
      <Toggle
        label={row.label}
        isOn={value}
        modifiers={[disabled(row.disabled ?? false)]}
        onIsOnChange={row.onChange}
      />
    ) : (
      <Toggle
        isOn={value}
        modifiers={[disabled(row.disabled ?? false)]}
        onIsOnChange={row.onChange}
      >
        <Lines detail={row.detail} title={row.label} />
      </Toggle>
    );
  }
  return <Input row={row} />;
}

/** One choice among several, each with its own line; the chosen ones carry a checkmark. */
function ChoiceRow({ row }: { readonly row: Extract<NativeSettingsRow, { kind: "choice" }> }) {
  return (
    <Button
      modifiers={[
        accessibilityLabel(row.detail === undefined ? row.label : `${row.label}, ${row.detail}`),
        accessibilityAddTraits(row.selected ? ["isSelected"] : []),
        disabled(row.disabled ?? false),
      ]}
      onPress={row.onPress}
    >
      <HStack alignment="center" modifiers={[contentShape(shapes.rectangle())]} spacing={12}>
        <Lines detail={row.detail ?? null} title={row.label} />
        <Spacer />
        {row.selected ? (
          <Image
            color={color.ember}
            modifiers={[frame({ width: 20 })]}
            size={15}
            systemName="checkmark"
          />
        ) : null}
      </HStack>
    </Button>
  );
}

/** A switch whose state never arrived: its track with no knob, never drawn as off. */
function UnknownToggleRow({
  row,
}: {
  readonly row: Extract<NativeSettingsRow, { kind: "toggle" }>;
}) {
  return (
    <HStack
      alignment="center"
      spacing={12}
      modifiers={[accessibilityLabel(`${row.label}, not loaded yet`)]}
    >
      <Lines detail={row.detail ?? null} title={row.label} />
      <Spacer />
      <Capsule
        modifiers={[
          foregroundStyle(color.surfaceRaised),
          frame({ width: 51, height: 31 }),
          opacity(0.4),
        ]}
      />
    </HStack>
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
      {row.detail === undefined ? null : row.addressIn === "detail" ? (
        // An address is drawn with characters that are not the address, so it is never selected:
        // Copy in the system's menu gives the address exactly.
        <ContextMenu>
          <ContextMenu.Trigger>
            <Text
              modifiers={[
                font({ textStyle: "footnote", design: "monospaced" }),
                foregroundStyle(color.textSoft),
                accessibilityLabel(row.detail),
              ]}
            >
              {addressWords(row.detail)}
            </Text>
          </ContextMenu.Trigger>
          <ContextMenu.Items>
            <Button
              label="Copy"
              onPress={() => {
                if (row.detail !== undefined) void setStringAsync(row.detail);
              }}
              systemImage="doc.on.doc"
            />
          </ContextMenu.Items>
        </ContextMenu>
      ) : (
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
    <TextField
      text={text}
      placeholder={row.label}
      onTextChange={row.onChange}
      modifiers={row.onSubmit === undefined ? [] : [onSubmit(row.onSubmit)]}
    />
  );
}
