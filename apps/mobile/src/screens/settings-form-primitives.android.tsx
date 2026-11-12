import {
  Box,
  Button,
  CircularProgressIndicator,
  Column,
  DropdownMenu,
  DropdownMenuItem,
  Host,
  IconButton,
  LazyColumn,
  ListItem,
  OutlinedTextField,
  Row,
  SegmentedButton,
  SingleChoiceSegmentedButtonRow,
  Switch,
  Text,
  useNativeState,
} from "@expo/ui/jetpack-compose";
import {
  background,
  clickable,
  clip,
  fillMaxWidth,
  padding,
  semantics,
  Shapes,
  size,
  toggleable,
} from "@expo/ui/jetpack-compose/modifiers";
import { useEffect, useState, type ReactNode } from "react";
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
export function SettingsList(props: { readonly children: ReactNode }): ReactNode {
  return (
    <LazyColumn contentPadding={{ top: 8, bottom: 40 }} modifiers={[fillMaxWidth()]}>
      {props.children}
    </LazyColumn>
  );
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
}): ReactNode {
  return (
    <Text
      color={props.tone === "danger" ? color.red : color.muted}
      modifiers={[padding(gutter, 4, gutter, 8)]}
      style={{ typography: "bodySmall" }}
    >
      {props.text}
    </Text>
  );
}

/** A name and the line under it, optionally opening or doing something. */
export function LinkRow(props: {
  readonly detail?: string | null | undefined;
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
          <Text color={color.muted}>{props.detail}</Text>
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
 * One of a few choices. Up to three sit side by side as segmented buttons; more
 * open as a menu from the row, which names the current choice.
 */
export function ChoiceRow(props: {
  readonly choices: readonly { readonly value: string; readonly label: string }[];
  readonly onChange: (value: string) => void;
  readonly title: string;
  readonly value: string;
}): ReactNode {
  const [open, setOpen] = useState(false);
  if (props.choices.length <= 3)
    return (
      <Column modifiers={[padding(gutter, 8, gutter, 8)]}>
        <Text color={color.text} modifiers={[padding(0, 0, 0, 8)]}>
          {props.title}
        </Text>
        <SingleChoiceSegmentedButtonRow modifiers={[fillMaxWidth()]}>
          {props.choices.map((choice) => (
            <SegmentedButton
              key={choice.value}
              selected={choice.value === props.value}
              onClick={() => props.onChange(choice.value)}
            >
              <SegmentedButton.Label>
                <Text>{choice.label}</Text>
              </SegmentedButton.Label>
            </SegmentedButton>
          ))}
        </SingleChoiceSegmentedButtonRow>
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
