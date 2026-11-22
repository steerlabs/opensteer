import {
  Box,
  Button,
  Checkbox,
  CircularProgressIndicator,
  Column,
  DropdownMenu,
  DropdownMenuItem,
  FilterChip,
  FlowRow,
  Host,
  IconButton,
  LazyColumn,
  ListItem,
  OutlinedTextField,
  RadioButton,
  Row,
  Switch,
  Text,
  TextButton,
  useNativeState,
} from "@expo/ui/jetpack-compose";
import {
  alpha,
  background,
  clickable,
  clip,
  fillMaxSize,
  fillMaxWidth,
  imePadding,
  padding,
  selectable,
  semantics,
  selectableGroup,
  Shapes,
  size,
  toggleable,
  weight,
} from "@expo/ui/jetpack-compose/modifiers";
import { useEffect, useState, type ReactNode } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { color } from "../theme.js";
import type { NativeSettingsStep, NativeSettingsTone } from "./native-settings-page.types.js";
import type { SettingsActionModel } from "./settings-model.js";

/**
 * Material 3 building blocks for Settings on Android. Rows are list items in
 * plain groups under a coloured section header, as Android's own Settings
 * draws them; the one main action on a page is a filled button.
 */

const toneColor: Record<NativeSettingsTone, string> = {
  neutral: color.muted,
  good: color.green,
  attention: color.amber,
  bad: color.red,
};
const transparent = "#00000000";
const rowColors = { containerColor: transparent };
const gutter = 16;

/** One Material theme for every Settings surface: the app's dark ground and ember accent. */
export function SettingsHost(props: { readonly children: ReactNode }): ReactNode {
  return (
    <Host
      colorScheme="dark"
      colorOverrides={{
        primary: color.ember,
        onPrimary: color.inkOnEmber,
        // Material takes #RRGGBBAA only: the theme's ember wash, ember line and control lines.
        primaryContainer: "#E6BEB01C",
        onPrimaryContainer: color.emberBright,
        secondaryContainer: "#E6BEB038",
        onSecondaryContainer: color.text,
        background: color.background,
        onBackground: color.text,
        surface: color.background,
        onSurface: color.text,
        surfaceVariant: color.surfaceRaised,
        onSurfaceVariant: color.muted,
        surfaceContainer: color.surfaceElevated,
        surfaceContainerLow: color.surface,
        surfaceContainerHigh: color.surfaceRaised,
        surfaceContainerHighest: color.surfacePressed,
        error: color.red,
        outline: "#FFFFFF57",
        outlineVariant: "#FFFFFF1F",
      }}
      style={{ flex: 1 }}
    >
      {props.children}
    </Host>
  );
}

/** The scrolling page every Settings screen is: lazy, so long lists stay smooth. */
export function SettingsList(props: {
  readonly children: ReactNode;
  readonly footer?: ReactNode;
}): ReactNode {
  if (!props.footer)
    return (
      <LazyColumn
        contentPadding={{ top: 8, bottom: 40 }}
        modifiers={[fillMaxWidth(), imePadding()]}
      >
        {props.children}
      </LazyColumn>
    );
  // Move the viewport and footer together so Compose can scroll the focused
  // field into the visible list when the keyboard resizes it.
  return (
    <Column modifiers={[fillMaxSize(), imePadding()]}>
      <LazyColumn contentPadding={{ top: 8, bottom: 16 }} modifiers={[fillMaxWidth(), weight(1)]}>
        {props.children}
      </LazyColumn>
      <SettingsListFooter>{props.footer}</SettingsListFooter>
    </Column>
  );
}

function SettingsListFooter(props: { readonly children: ReactNode }): ReactNode {
  const { bottom } = useSafeAreaInsets();
  return <Box modifiers={[padding(0, 0, 0, bottom)]}>{props.children}</Box>;
}

export function Section(props: {
  readonly children: ReactNode;
  readonly footer?: string | undefined;
  readonly footerTone?: "danger" | undefined;
  readonly title?: string | undefined;
}): ReactNode {
  return (
    <>
      {props.title ? <SectionHeader title={props.title} /> : <Box modifiers={[size(1, 12)]} />}
      {props.children}
      {props.footer ? <Footer text={props.footer} tone={props.footerTone} /> : null}
    </>
  );
}

export function SectionHeader(props: {
  readonly title: string;
  readonly onPress?: () => void;
  readonly expanded?: boolean;
}): ReactNode {
  return (
    <Row
      verticalAlignment="center"
      modifiers={[
        fillMaxWidth(),
        ...(props.onPress ? [clickable(props.onPress)] : []),
        padding(gutter, 20, gutter, 6),
        semantics({
          contentDescription:
            props.expanded === undefined
              ? props.title
              : `${props.title}, ${props.expanded ? "shown" : "hidden"}`,
        }),
      ]}
    >
      <Text color={color.ember} style={{ typography: "titleSmall" }}>
        {props.title}
      </Text>
      {props.expanded === undefined ? null : (
        <Text color={color.muted} style={{ typography: "titleSmall" }}>
          {props.expanded ? "  ▴" : "  ▾"}
        </Text>
      )}
    </Row>
  );
}

export function Footer(props: {
  readonly text: string;
  readonly tone?: "danger" | undefined;
  readonly link?: { readonly label: string; readonly onPress: () => void } | null;
}): ReactNode {
  const text = (
    <Text
      color={props.tone === "danger" ? color.red : color.muted}
      modifiers={props.link ? [] : [padding(gutter, 4, gutter, 8)]}
      style={{ typography: "bodySmall" }}
    >
      {props.text}
    </Text>
  );
  if (!props.link) return text;
  const link = props.link;
  // The sentence above its link: at the largest text size it wraps, and the link stays on screen.
  return (
    <Column modifiers={[padding(gutter, 4, gutter, 8)]}>
      {text}
      <TextButton onClick={link.onPress}>
        <Text color={color.ember} style={{ typography: "labelMedium" }}>
          {link.label}
        </Text>
      </TextButton>
    </Column>
  );
}

/** A row whose content never arrived: two still bars, never a shimmer. */
export function PlaceholderRow(props: { readonly label: string }): ReactNode {
  return (
    <ListItem colors={rowColors}>
      <ListItem.HeadlineContent>
        <Column modifiers={[semantics({ contentDescription: props.label })]}>
          <Box modifiers={[size(160, 10), clip(Shapes.Circle), background(color.surfaceRaised)]} />
          <Box modifiers={[size(1, 8)]} />
          <Box modifiers={[size(96, 10), clip(Shapes.Circle), background(color.surfaceRaised)]} />
        </Column>
      </ListItem.HeadlineContent>
    </ListItem>
  );
}

/** A switch whose state never arrived: its track with no knob, never drawn as off. */
export function UnknownToggleRow(props: {
  readonly detail?: string | null | undefined;
  readonly title: string;
}): ReactNode {
  return (
    <ListItem colors={rowColors}>
      <ListItem.HeadlineContent>
        <Text color={color.text}>{props.title}</Text>
      </ListItem.HeadlineContent>
      {props.detail ? (
        <ListItem.SupportingContent>
          <Text color={color.muted}>{props.detail}</Text>
        </ListItem.SupportingContent>
      ) : null}
      <ListItem.TrailingContent>
        <Box
          modifiers={[
            semantics({ contentDescription: "Not loaded yet" }),
            size(52, 32),
            clip(Shapes.Circle),
            alpha(0.4),
            background(color.surfaceRaised),
          ]}
        />
      </ListItem.TrailingContent>
    </ListItem>
  );
}

/** A name and the line under it, optionally opening or doing something. */
export function LinkRow(props: {
  readonly detail?: string | null | undefined;
  /** Amber for a thing that needs the person. */
  readonly detailTone?: "attention" | undefined;
  readonly destructive?: boolean | undefined;
  readonly disabled?: boolean | undefined;
  readonly lead?: ReactNode;
  readonly onPress?: (() => void) | null | undefined;
  readonly title: string;
  /** A short word on the right, such as the current choice or an action. */
  readonly trailing?: ReactNode;
}): ReactNode {
  const enabled = props.onPress && props.disabled !== true;
  return (
    <ListItem colors={rowColors} modifiers={enabled ? [clickable(props.onPress!)] : []}>
      <ListItem.HeadlineContent>
        <Text
          color={
            props.disabled === true
              ? color.mutedDim
              : props.destructive === true
                ? color.red
                : color.text
          }
        >
          {props.title}
        </Text>
      </ListItem.HeadlineContent>
      {props.detail ? (
        <ListItem.SupportingContent>
          <Text color={props.detailTone === "attention" ? color.amber : color.muted}>
            {props.detail}
          </Text>
        </ListItem.SupportingContent>
      ) : null}
      {props.lead ? <ListItem.LeadingContent>{props.lead}</ListItem.LeadingContent> : null}
      {props.trailing === undefined || props.trailing === null ? null : (
        <ListItem.TrailingContent>
          {typeof props.trailing === "string" ? (
            <Text color={color.muted} style={{ typography: "bodyMedium" }}>
              {props.trailing}
            </Text>
          ) : (
            props.trailing
          )}
        </ListItem.TrailingContent>
      )}
    </ListItem>
  );
}

/** A plain fact: a name and its value, nothing to press. */
export function ValueRow(props: { readonly title: string; readonly value: string }): ReactNode {
  return <LinkRow title={props.title} trailing={props.value} />;
}

/** A sentence inside a group, such as why something can't be used yet. */
export function NoteRow(props: { readonly text: string }): ReactNode {
  return (
    <Text
      color={color.textSoft}
      modifiers={[padding(gutter, 8, gutter, 8)]}
      style={{ typography: "bodyMedium" }}
    >
      {props.text}
    </Text>
  );
}

/** A whole-row Material switch: the row and the switch toggle together. */
export function ToggleRow(props: {
  readonly detail?: string | null | undefined;
  readonly disabled?: boolean | undefined;
  readonly onChange: (value: boolean) => void;
  readonly title: string;
  readonly value: boolean;
}): ReactNode {
  const enabled = props.disabled !== true;
  return (
    <ListItem
      colors={rowColors}
      modifiers={[
        toggleable(props.value, () => props.onChange(!props.value), { role: "switch", enabled }),
      ]}
    >
      <ListItem.HeadlineContent>
        <Text color={enabled ? color.text : color.mutedDim}>{props.title}</Text>
      </ListItem.HeadlineContent>
      {props.detail ? (
        <ListItem.SupportingContent>
          <Text color={color.muted}>{props.detail}</Text>
        </ListItem.SupportingContent>
      ) : null}
      <ListItem.TrailingContent>
        {/* Without its own handler the switch leaves the tap to the row, as Material asks. */}
        <Switch
          enabled={enabled}
          value={props.value}
          colors={{ checkedTrackColor: color.ember, checkedThumbColor: color.inkOnEmber }}
        />
      </ListItem.TrailingContent>
    </ListItem>
  );
}

/**
 * One of a few choices. Up to three fit to their labels and flow onto another
 * line if needed. More open as a menu from the row naming the current choice.
 */
export function ChoiceRow(props: {
  readonly choices: readonly { readonly value: string; readonly label: string }[];
  /** Always a menu from the row naming the choice. */
  readonly menu?: boolean | undefined;
  readonly onChange: (value: string) => void;
  readonly title: string;
  readonly value: string;
}): ReactNode {
  const [open, setOpen] = useState(false);
  if (props.choices.length <= 3 && props.menu !== true)
    return (
      <Column modifiers={[padding(gutter, 8, gutter, 8)]}>
        <Text color={color.text} modifiers={[padding(0, 0, 0, 8)]}>
          {props.title}
        </Text>
        <FlowRow
          horizontalArrangement={{ spacedBy: 8 }}
          modifiers={[fillMaxWidth(), selectableGroup()]}
        >
          {props.choices.map((choice) => (
            <FilterChip
              key={choice.value}
              selected={choice.value === props.value}
              onClick={() => props.onChange(choice.value)}
            >
              {choice.value === props.value ? (
                <FilterChip.LeadingIcon>
                  <Text style={{ typography: "labelMedium" }}>✓</Text>
                </FilterChip.LeadingIcon>
              ) : null}
              <FilterChip.Label>
                <Text style={{ typography: "labelLarge" }}>{choice.label}</Text>
              </FilterChip.Label>
            </FilterChip>
          ))}
        </FlowRow>
      </Column>
    );
  const current = props.choices.find((choice) => choice.value === props.value)?.label ?? "";
  return (
    <DropdownMenu expanded={open} onDismissRequest={() => setOpen(false)}>
      <DropdownMenu.Trigger>
        <LinkRow detail={current} onPress={() => setOpen(true)} title={props.title} trailing="▾" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Items>
        {props.choices.map((choice) => (
          <DropdownMenuItem
            key={choice.value}
            onClick={() => {
              setOpen(false);
              props.onChange(choice.value);
            }}
          >
            <DropdownMenuItem.Text>
              <Text color={choice.value === props.value ? color.ember : color.text}>
                {choice.label}
              </Text>
            </DropdownMenuItem.Text>
          </DropdownMenuItem>
        ))}
      </DropdownMenu.Items>
    </DropdownMenu>
  );
}

/**
 * One choice among several, each with its own line: a radio button, or a checkbox
 * where several may be chosen. The whole row selects.
 */
export function SelectRow(props: {
  readonly detail?: string | undefined;
  readonly disabled?: boolean | undefined;
  readonly multiple?: boolean | undefined;
  readonly onPress: () => void;
  readonly selected: boolean;
  readonly title: string;
}): ReactNode {
  const enabled = props.disabled !== true;
  return (
    <ListItem
      colors={rowColors}
      modifiers={
        enabled
          ? [
              selectable(
                props.selected,
                props.onPress,
                props.multiple === true ? "checkbox" : "radioButton",
              ),
            ]
          : []
      }
    >
      <ListItem.LeadingContent>
        {props.multiple === true ? (
          <Checkbox
            colors={{ checkedColor: color.ember, checkmarkColor: color.inkOnEmber }}
            enabled={enabled}
            value={props.selected}
          />
        ) : (
          <RadioButton enabled={enabled} selected={props.selected} />
        )}
      </ListItem.LeadingContent>
      <ListItem.HeadlineContent>
        <Text color={enabled ? color.text : color.mutedDim}>{props.title}</Text>
      </ListItem.HeadlineContent>
      {props.detail ? (
        <ListItem.SupportingContent>
          <Text color={color.muted}>{props.detail}</Text>
        </ListItem.SupportingContent>
      ) : null}
    </ListItem>
  );
}

/** A row with secondary actions behind Android's overflow button. */
export function MenuRow(props: {
  readonly actions: readonly {
    readonly label: string;
    readonly destructive?: boolean | undefined;
    readonly onPress: () => void;
  }[];
  readonly detail?: string | undefined;
  readonly disabled?: boolean | undefined;
  readonly destructive?: boolean | undefined;
  readonly lead?: ReactNode;
  /** The overflow button's spoken name, when the title alone isn't unique. */
  readonly menuLabel?: string | undefined;
  /** Without one, tapping the row opens its menu. */
  readonly onPress?: (() => void) | undefined;
  readonly title: string;
}): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <LinkRow
      detail={props.detail}
      destructive={props.destructive}
      disabled={props.disabled}
      lead={props.lead}
      onPress={props.onPress ?? (() => setOpen(true))}
      title={props.title}
      trailing={
        <DropdownMenu expanded={open} onDismissRequest={() => setOpen(false)}>
          <DropdownMenu.Trigger>
            <IconButton
              enabled={props.disabled !== true}
              onClick={() => setOpen(true)}
              modifiers={[
                semantics({
                  contentDescription: props.menuLabel ?? `More actions for ${props.title}`,
                }),
              ]}
            >
              <Text color={color.textSoft} style={{ typography: "titleLarge" }}>
                ⋮
              </Text>
            </IconButton>
          </DropdownMenu.Trigger>
          <DropdownMenu.Items>
            {props.actions.map((action) => (
              <DropdownMenuItem
                key={action.label}
                onClick={() => {
                  setOpen(false);
                  action.onPress();
                }}
              >
                <DropdownMenuItem.Text>
                  <Text color={action.destructive === true ? color.red : color.text}>
                    {action.label}
                  </Text>
                </DropdownMenuItem.Text>
              </DropdownMenuItem>
            ))}
          </DropdownMenu.Items>
        </DropdownMenu>
      }
    />
  );
}

/** A Settings action that is not the page's main one: a row in the accent colour. */
export function ActionRow(props: {
  readonly destructive?: boolean | undefined;
  readonly disabled?: boolean | undefined;
  readonly label: string;
  readonly onPress: () => void;
}): ReactNode {
  const enabled = props.disabled !== true;
  return (
    <ListItem colors={rowColors} modifiers={enabled ? [clickable(props.onPress)] : []}>
      <ListItem.HeadlineContent>
        <Text
          color={!enabled ? color.mutedDim : props.destructive === true ? color.red : color.ember}
          style={{ fontWeight: "500" }}
        >
          {props.label}
        </Text>
      </ListItem.HeadlineContent>
    </ListItem>
  );
}

export function ActionButton(props: {
  readonly action: SettingsActionModel | null;
  readonly onPress: () => void;
}): ReactNode {
  const action = props.action;
  return action === null ? null : (
    <ActionRow
      destructive={action.destructive}
      disabled={action.disabled}
      label={action.label}
      onPress={props.onPress}
    />
  );
}

/** The one main action on a page: a full-width filled button. */
export function PrimaryButton(props: {
  readonly disabled?: boolean | undefined;
  readonly label: string;
  readonly onPress: () => void;
}): ReactNode {
  return (
    <Box modifiers={[fillMaxWidth(), padding(gutter, 8, gutter, 8)]}>
      <Button
        enabled={props.disabled !== true}
        onClick={props.onPress}
        modifiers={[fillMaxWidth()]}
        contentPadding={{ top: 12, bottom: 12, start: 24, end: 24 }}
      >
        <Text style={{ typography: "labelLarge", fontWeight: "600" }}>{props.label}</Text>
      </Button>
    </Box>
  );
}

export function ErrorText(props: { readonly detail: string | null }): ReactNode {
  return props.detail === null ? null : (
    <Text
      color={color.red}
      modifiers={[
        padding(gutter, 4, gutter, 8),
        semantics({ contentDescription: `Error: ${props.detail}` }),
      ]}
      style={{ typography: "bodyMedium" }}
    >
      {props.detail}
    </Text>
  );
}

/** A person's round initial, leading their identity row. */
export function Avatar(props: { readonly initial: string }): ReactNode {
  return (
    <Box
      contentAlignment="center"
      modifiers={[size(40, 40), clip(Shapes.Circle), background(color.surfaceRaised)]}
    >
      <Text color={color.textSoft} style={{ typography: "titleMedium", fontWeight: "600" }}>
        {props.initial}
      </Text>
    </Box>
  );
}

/** A coloured dot, one short state, and while something is under way its steps. */
export function StatusRow(props: {
  readonly detail?: string | undefined;
  readonly label: string;
  readonly steps?: readonly NativeSettingsStep[] | undefined;
  readonly tone: NativeSettingsTone;
}): ReactNode {
  const hasSupport = props.detail !== undefined || (props.steps?.length ?? 0) > 0;
  return (
    <ListItem colors={rowColors}>
      <ListItem.LeadingContent>
        <Box modifiers={[size(10, 10), clip(Shapes.Circle), background(toneColor[props.tone])]} />
      </ListItem.LeadingContent>
      <ListItem.HeadlineContent>
        <Text color={color.text} style={{ fontWeight: "600" }}>
          {props.label}
        </Text>
      </ListItem.HeadlineContent>
      {hasSupport ? (
        <ListItem.SupportingContent>
          <Column verticalArrangement={{ spacedBy: 8 }} modifiers={[padding(0, 4, 0, 0)]}>
            {props.detail === undefined ? null : (
              <Text color={color.textSoft} style={{ fontFamily: "monospace", fontSize: 13 }}>
                {props.detail}
              </Text>
            )}
            {props.steps?.map((step) => (
              <Step key={step.label} step={step} />
            ))}
          </Column>
        </ListItem.SupportingContent>
      ) : null}
    </ListItem>
  );
}

function Step({ step }: { readonly step: NativeSettingsStep }): ReactNode {
  return (
    <Row verticalAlignment="center" horizontalArrangement={{ spacedBy: 10 }}>
      <Box contentAlignment="center" modifiers={[size(18, 18)]}>
        {step.state === "current" ? (
          <CircularProgressIndicator
            color={color.ember}
            strokeWidth={2}
            modifiers={[size(14, 14)]}
          />
        ) : (
          <Text
            color={
              step.state === "done"
                ? color.green
                : step.state === "failed"
                  ? color.red
                  : color.mutedDim
            }
            style={{ fontSize: 14, fontWeight: "700" }}
          >
            {step.state === "done" ? "✓" : step.state === "failed" ? "✕" : "○"}
          </Text>
        )}
      </Box>
      <Text
        color={step.state === "pending" ? color.muted : color.text}
        style={{ typography: "bodyMedium" }}
      >
        {step.label}
      </Text>
    </Row>
  );
}

/** A Material outlined text field that keeps the caller's value as the source of truth. */
export function InputRow(props: {
  readonly disabled?: boolean | undefined;
  readonly label: string;
  readonly maxLength?: number | undefined;
  readonly multiline?: boolean | undefined;
  readonly onChange: (value: string) => void;
  readonly secure?: boolean | undefined;
  readonly value: string;
}): ReactNode {
  const text = useNativeState(props.value);
  useEffect(() => {
    if (text.value !== props.value) text.set(props.value);
  }, [text, props.value]);
  return (
    <Box modifiers={[fillMaxWidth(), padding(gutter, 4, gutter, 8)]}>
      <OutlinedTextField
        value={text}
        onValueChange={props.onChange}
        enabled={props.disabled !== true}
        singleLine={props.multiline !== true}
        {...(props.multiline === true ? { minLines: 4, maxLines: 8 } : {})}
        {...(props.maxLength === undefined ? {} : { maxLength: props.maxLength })}
        visualTransformation={props.secure === true ? "password" : "none"}
        keyboardOptions={{
          autoCorrectEnabled: false,
          capitalization: "none",
          ...(props.secure === true ? { keyboardType: "password" as const } : {}),
        }}
        modifiers={[fillMaxWidth()]}
      >
        <OutlinedTextField.Label>
          <Text>{props.label}</Text>
        </OutlinedTextField.Label>
      </OutlinedTextField>
    </Box>
  );
}
