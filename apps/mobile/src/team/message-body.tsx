import { splitMarkdownBlocks } from "@opensteer/shared/markdown";
import type { PhrasingContent, RootContent } from "mdast";
import { memo, useMemo, type ReactNode } from "react";
import { Linking, StyleSheet, Text, View } from "react-native";
import { Markdown } from "../markdown/markdown.js";
import { markdownTree } from "../markdown/markdown-tree.js";
import { color, radius, space, type } from "../theme.js";
import { monoFontFamily } from "../ui/primitives.js";
import { mentionFinder, mentionRuns, type MentionFinder } from "./mentions.js";
import type { MentionView } from "./team-models.js";

/**
 * A team message's words: its Markdown, with each structured mention drawn as
 * a chip in the reader's own words ("@My agent" to its owner, "@Tim's agent"
 * to everyone else).
 *
 * A block that holds no mention is the app's own Markdown. A block that holds
 * one is drawn here from the same parser, so a chip can sit inside a
 * paragraph, a list item or a quote; anything rarer that holds one (a table
 * cell, a heading) falls back to the plain Markdown with the handle as text.
 */
export const MessageBody = memo(function MessageBody(props: {
  readonly mentions: readonly MentionView[];
  readonly text: string;
}): ReactNode {
  const finder = useMemo(() => mentionFinder(props.mentions), [props.mentions]);
  const blocks = useMemo(() => splitMarkdownBlocks(props.text), [props.text]);
  if (finder === null) return <Markdown text={props.text} />;
  return (
    <View style={styles.prose}>
      {blocks.map((source, index) =>
        finder.pattern.test(source) ? (
          <MentionBlock finder={finder} key={index} source={source} />
        ) : (
          <Markdown key={index} text={source} />
        ),
      )}
    </View>
  );
});

function MentionBlock(props: {
  readonly finder: MentionFinder;
  readonly source: string;
}): ReactNode {
  const tree = markdownTree(props.source, false);
  // A block holding something this renderer leaves to Markdown is Markdown whole.
  if (!tree.children.every(drawable)) return <Markdown text={props.source} />;
  return (
    <View style={styles.prose}>
      {tree.children.map((node, index) => (
        <BlockNode finder={props.finder} key={index} node={node} />
      ))}
    </View>
  );
}

function drawable(node: RootContent): boolean {
  switch (node.type) {
    case "paragraph":
      return true;
    case "blockquote":
      return node.children.every(drawable);
    case "list":
      return node.children.every((item) => item.children.every(drawable));
    default:
      return false;
  }
}

function BlockNode(props: {
  readonly finder: MentionFinder;
  readonly node: RootContent;
}): ReactNode {
  const { finder, node } = props;
  switch (node.type) {
    case "paragraph":
      return (
        <Text selectable style={styles.text}>
          <Spans finder={finder} nodes={node.children} />
        </Text>
      );
    case "blockquote":
      return (
        <View style={styles.quote}>
          {node.children.map((child, index) => (
            <BlockNode finder={finder} key={index} node={child} />
          ))}
        </View>
      );
    case "list":
      return (
        <View style={styles.list}>
          {node.children.map((item, index) => (
            <View key={index} style={styles.listItem}>
              <Text style={[styles.text, styles.marker]}>
                {node.ordered === true ? `${(node.start ?? 1) + index}.` : "•"}
              </Text>
              <View style={styles.listBody}>
                {item.children.map((child, childIndex) => (
                  <BlockNode finder={finder} key={childIndex} node={child} />
                ))}
              </View>
            </View>
          ))}
        </View>
      );
    default:
      return null;
  }
}

function Spans(props: {
  readonly finder: MentionFinder;
  readonly nodes: readonly PhrasingContent[];
}): ReactNode {
  return props.nodes.map((node, index) => <Span finder={props.finder} key={index} node={node} />);
}

function Span(props: {
  readonly finder: MentionFinder;
  readonly node: PhrasingContent;
}): ReactNode {
  const { finder, node } = props;
  switch (node.type) {
    case "text":
      return <MentionText finder={finder} text={node.value} />;
    case "strong":
      return (
        <Text style={styles.strong}>
          <Spans finder={finder} nodes={node.children} />
        </Text>
      );
    case "emphasis":
      return (
        <Text style={styles.emphasis}>
          <Spans finder={finder} nodes={node.children} />
        </Text>
      );
    case "delete":
      return (
        <Text style={styles.struck}>
          <Spans finder={finder} nodes={node.children} />
        </Text>
      );
    case "inlineCode":
      return <Text style={styles.code}>{node.value}</Text>;
    case "break":
      return "\n";
    case "link":
      return (
        <Text
          accessibilityRole="link"
          onPress={() => void Linking.openURL(node.url).catch(() => undefined)}
          style={styles.link}
        >
          <Spans finder={finder} nodes={node.children} />
        </Text>
      );
    default:
      return "value" in node && typeof node.value === "string" ? node.value : null;
  }
}

function MentionText(props: { readonly finder: MentionFinder; readonly text: string }): ReactNode {
  return mentionRuns(props.text, props.finder).map((run, index) =>
    typeof run === "string" ? run : <MentionChip key={index} mention={run} />,
  );
}

/**
 * A mention, inline in its sentence. The colour is the meaning: ember woke an
 * agent, grey asks for owner approval, amber is the reader.
 */
export function MentionChip(props: { readonly mention: MentionView }): ReactNode {
  const tone = chipTone[props.mention.kind];
  return (
    <Text
      accessibilityLabel={
        props.mention.kind === "agent-inert"
          ? `${props.mention.label}, owner approval required`
          : props.mention.label
      }
      style={[styles.chip, tone]}
    >
      {/* Thin spaces stand in for padding, which nested text can't take on iOS. */}
      {` ${props.mention.label} `}
    </Text>
  );
}

const chipTone = StyleSheet.create({
  "agent-inert": { backgroundColor: "rgba(255, 255, 255, 0.04)", color: color.muted },
  "agent-live": { backgroundColor: color.emberWash, color: color.ember },
  me: { backgroundColor: color.amberWash, color: color.amber },
  person: { backgroundColor: "rgba(255, 255, 255, 0.07)", color: color.text },
});

const styles = StyleSheet.create({
  chip: { borderRadius: radius.xs, fontWeight: "600" },
  code: {
    backgroundColor: "rgba(255, 255, 255, 0.08)",
    color: color.textSoft,
    fontFamily: monoFontFamily,
    fontSize: 15,
  },
  emphasis: { fontStyle: "italic" },
  link: { color: color.ember, textDecorationLine: "underline" },
  list: { gap: space[4] },
  listBody: { flexShrink: 1, gap: space[4] },
  listItem: { flexDirection: "row", gap: space[8] },
  marker: { color: color.muted, minWidth: 18 },
  prose: { gap: space[12] },
  quote: {
    borderLeftColor: color.lineStrong,
    borderLeftWidth: 2,
    borderRadius: radius.xs,
    gap: space[4],
    paddingLeft: space[10],
  },
  strong: { fontWeight: "600" },
  struck: { textDecorationLine: "line-through" },
  text: { ...type.reading, color: color.text },
});
