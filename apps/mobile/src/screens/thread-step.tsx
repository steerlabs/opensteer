import {
  activityStepHead,
  toolBody,
  toolStatusLabel,
  type HostClient,
  type ReasoningEntry,
  type ToolEntry,
} from "@opensteer/client/host";
import { useHostSnapshot } from "@opensteer/client/react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Markdown } from "../markdown/markdown.js";
import { color, radius, space, touchTarget, type } from "../theme.js";
import { useMobileState } from "../ui/mobile-client-context.js";
import { AppText, Notice, monoFontFamily } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";
import { useContentInsets } from "../ui/pane.js";
import { useGutter } from "../ui/screen.js";

export type ThreadStepScreenProps = StaticScreenProps<{
  readonly deploymentId: string;
  readonly entryId: string;
  readonly threadId: string;
}>;

/**
 * One step of an agent's work, in full: what it ran and what came back.
 *
 * It reads the step from the live transcript rather than taking it as a route
 * parameter, so a command still running keeps printing here, and a step that
 * finishes while the sheet is open says so.
 */
export function ThreadStepScreen(props: ThreadStepScreenProps): ReactNode {
  const { deploymentId, entryId, threadId } = props.route.params;
  const { selection } = useMobileState();
  if (selection.deploymentId !== deploymentId || selection.hostClient === null) {
    return <Missing detail="This deployment is no longer open." />;
  }
  return <SubscribedStep entryId={entryId} hostClient={selection.hostClient} threadId={threadId} />;
}

function SubscribedStep(props: {
  readonly entryId: string;
  readonly hostClient: HostClient;
  readonly threadId: string;
}): ReactNode {
  const { snapshot } = useHostSnapshot(props.hostClient);
  const entry = snapshot.transcripts[props.threadId]?.find(({ id }) => id === props.entryId);
  if (entry?.kind === "tool") return <ToolDetail tool={entry} />;
  if (entry?.kind === "reasoning") return <ThoughtDetail reasoning={entry} />;
  return <Missing detail="This step is no longer loaded. Open the thread again to see it." />;
}

function ToolDetail(props: { readonly tool: ToolEntry }): ReactNode {
  const { tool } = props;
  const head = activityStepHead(tool);
  const body = toolBody(tool);
  const status = [toolStatusLabel(tool), head.duration].filter(Boolean).join(" · ");
  return (
    <Frame label={head.label} status={status} tone={head.tone === "error" ? "amber" : "muted"}>
      {body.summary ? (
        <AppText role="body" selectable tone="soft">
          {body.summary}
        </AppText>
      ) : null}
      {body.command !== null ? <Verbatim label="Command" text={body.command} /> : null}
      {body.argumentsText ? (
        <Verbatim collapsed={body.collapsed} label="Input" text={body.argumentsText} />
      ) : null}
      {body.output ? (
        <Verbatim collapsed={body.collapsed} label={body.outputLabel} text={body.output} />
      ) : tool.state === "running" || body.summary ? null : (
        <AppText role="secondary" tone="muted">
          No output
        </AppText>
      )}
    </Frame>
  );
}

function ThoughtDetail(props: { readonly reasoning: ReasoningEntry }): ReactNode {
  return (
    <Frame label="Thinking" status={activityStepHead(props.reasoning).label} tone="muted">
      <Markdown text={props.reasoning.text} />
    </Frame>
  );
}

function Frame(props: {
  readonly children: ReactNode;
  readonly label: string;
  readonly status: string;
  readonly tone: "amber" | "muted";
}): ReactNode {
  const insets = useContentInsets();
  const gutter = useGutter();
  return (
    <ScrollView
      contentContainerStyle={[
        styles.content,
        {
          paddingBottom: insets.bottom + space[24],
          paddingLeft: gutter + insets.left,
          paddingRight: gutter + insets.right,
        },
      ]}
      style={styles.sheet}
    >
      <View style={styles.head}>
        <AppText role="title" selectable>
          {props.label}
        </AppText>
        <AppText
          role="caption"
          style={props.tone === "amber" ? styles.amber : undefined}
          tone="muted"
        >
          {props.status}
        </AppText>
      </View>
      {props.children}
    </ScrollView>
  );
}

/**
 * Verbatim text a person reads here and runs or pastes somewhere else. It
 * wraps rather than scrolling sideways: in a sheet the page itself scrolls,
 * and a second scroller inside it is one a thumb keeps catching by mistake.
 * A `collapsed` section — a whole accessibility tree — stays closed under its
 * name until the reader asks for it.
 */
function Verbatim(props: {
  readonly collapsed?: boolean;
  readonly label: string;
  readonly text: string;
}): ReactNode {
  const [open, setOpen] = useState(props.collapsed !== true);
  const [copied, setCopied] = useState(false);
  const reset = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (reset.current !== null) clearTimeout(reset.current);
    },
    [],
  );
  const copy = (): void => {
    void Clipboard.setStringAsync(props.text).then(
      () => {
        void Haptics.selectionAsync();
        setCopied(true);
        if (reset.current !== null) clearTimeout(reset.current);
        reset.current = setTimeout(() => setCopied(false), 1_500);
      },
      () => Alert.alert("Copy unavailable", "Please try again."),
    );
  };
  return (
    <View style={styles.section}>
      <View style={styles.sectionHead}>
        {props.collapsed === true ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: open }}
            hitSlop={space[8]}
            onPress={() => setOpen(!open)}
            style={styles.sectionToggle}
          >
            <Symbol name={open ? "chevron.down" : "chevron.right"} size={11} tint={color.muted} />
            <AppText role="caption" tone="muted">
              {props.label}
            </AppText>
          </Pressable>
        ) : (
          <AppText role="caption" style={styles.sectionLabel} tone="muted">
            {props.label}
          </AppText>
        )}
        <Pressable
          accessibilityLabel={copied ? "Copied" : `Copy ${props.label.toLocaleLowerCase()}`}
          accessibilityRole="button"
          hitSlop={space[12]}
          onPress={copy}
          style={styles.copy}
        >
          <AppText role="caption" tone={copied ? "ember" : "muted"}>
            {copied ? "Copied" : "Copy"}
          </AppText>
        </Pressable>
      </View>
      {open ? (
        <View style={styles.verbatim}>
          <Text selectable style={[type.caption, styles.verbatimText]}>
            {props.text}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

function Missing(props: { readonly detail: string }): ReactNode {
  const navigation = useNavigation();
  return (
    <View style={[styles.sheet, styles.missing]}>
      <Notice
        action={{ label: "Close", onPress: () => navigation.goBack() }}
        detail={props.detail}
        title="This step can't be shown"
        tone="neutral"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  amber: { color: color.amber },
  content: { gap: space[16], paddingTop: space[24] },
  copy: { justifyContent: "center", minHeight: touchTarget / 2 },
  head: { gap: space[4] },
  missing: { justifyContent: "center", padding: space[24] },
  section: { gap: space[6] },
  sectionHead: { alignItems: "center", flexDirection: "row" },
  sectionLabel: { flex: 1 },
  sectionToggle: {
    alignItems: "center",
    flex: 1,
    flexDirection: "row",
    gap: space[6],
    minHeight: touchTarget / 2,
  },
  sheet: { backgroundColor: color.surfaceElevated, flex: 1 },
  verbatim: {
    backgroundColor: color.surfaceCode,
    borderColor: color.line,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: space[12],
    paddingVertical: space[10],
  },
  verbatimText: { color: color.textSoft, fontFamily: monoFontFamily },
});
