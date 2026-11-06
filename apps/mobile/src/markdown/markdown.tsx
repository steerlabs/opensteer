import { splitMarkdownBlocks } from "@opensteer/shared/markdown";
import { transcriptLinkUrl } from "@opensteer/shared/transcriptLinks";
import type { List, PhrasingContent, RootContent, Table as TableNode } from "mdast";
import { memo, useContext, useMemo, useState, type ReactNode } from "react";
import {
  Alert,
  Linking,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
  type TextStyle,
} from "react-native";
import { color, radius, space, type } from "../theme.js";
import { CopyMark } from "../ui/copy-mark.js";
import { monoFontFamily } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";
import { markdownTree } from "./markdown-tree.js";
import { TextLines } from "./text-lines.js";

/**
 * How an agent's words are set. A task's are read, at full width, so they can
 * be selected in place; a chat bubble's are held, so they can't be, and it
 * takes Messages' tighter measure.
 */
export type MarkdownLook = "bubble" | "reading";

/**
 * Assistant prose, drawn from the same parser web uses, so a reply reads the
 * same on every client. Each block is memoised on the exact source it came from,
 * so a streaming message re-parses and re-draws only its trailing block.
 */
export const Markdown = memo(function Markdown(props: {
  readonly look?: MarkdownLook;
  readonly streaming?: boolean;
  readonly text: string;
}): ReactNode {
  const look = props.look ?? "reading";
  const blocks = useMemo(() => splitMarkdownBlocks(props.text), [props.text]);
  return (
    <View style={look === "bubble" ? styles.bubbleProse : styles.prose}>
      {blocks.map((source, index) => (
        <Block
          key={index}
          look={look}
          source={source}
          streaming={props.streaming === true && index === blocks.length - 1}
        />
      ))}
    </View>
  );
});

const Block = memo(function Block(props: {
  readonly look: MarkdownLook;
  readonly source: string;
  readonly streaming: boolean;
}): ReactNode {
  const tree = useMemo(
    () => markdownTree(props.source, props.streaming),
    [props.source, props.streaming],
  );
  return <Nodes look={props.look} nodes={tree.children} />;
});

function Nodes(props: {
  readonly look: MarkdownLook;
  readonly nodes: readonly RootContent[];
}): ReactNode {
  return props.nodes.map((node, index) => <Node key={index} look={props.look} node={node} />);
}

function Node(props: { readonly look: MarkdownLook; readonly node: RootContent }): ReactNode {
  const { look, node } = props;
  switch (node.type) {
    case "paragraph":
      return (
        <Prose look={look}>
          <Spans nodes={node.children} />
        </Prose>
      );
    case "html":
      return <Prose look={look}>{node.value}</Prose>;
    case "heading":
      return (
        <Text
          accessibilityRole="header"
          selectable={look === "reading"}
          style={headingStyle(look, node.depth)}
        >
          <Spans nodes={node.children} />
        </Text>
      );
    case "list":
      return <ListView list={node} look={look} />;
    case "blockquote":
      return (
        <View style={styles.quote}>
          <Nodes look={look} nodes={node.children} />
        </View>
      );
    case "code":
      return <CodeBlock language={node.lang ?? null} text={node.value} />;
    case "thematicBreak":
      return <View style={styles.rule} />;
    case "table":
      return <Table look={look} table={node} />;
    default:
      return null;
  }
}

function headingStyle(look: MarkdownLook, depth: number): TextStyle {
  if (look === "bubble") return styles.bubbleHeading;
  // Three levels are all a phone column can distinguish; deeper headings are
  // drawn as the smallest one rather than as progressively invisible text.
  return depth === 1 ? styles.heading1 : depth === 2 ? styles.heading2 : styles.heading3;
}

function Prose(props: { readonly children: ReactNode; readonly look: MarkdownLook }): ReactNode {
  const lines = useContext(TextLines);
  return (
    <Text
      onTextLayout={lines ?? undefined}
      selectable={props.look === "reading"}
      style={props.look === "bubble" ? styles.bubbleText : styles.readingText}
    >
      {props.children}
    </Text>
  );
}

function ListView(props: { readonly list: List; readonly look: MarkdownLook }): ReactNode {
  const { list, look } = props;
  return (
    <View style={styles.list}>
      {list.children.map((item, index) => (
        <View key={index} style={styles.listItem}>
          {item.checked === null || item.checked === undefined ? (
            <Text
              style={[look === "bubble" ? styles.bubbleText : styles.readingText, styles.marker]}
            >
              {list.ordered === true ? `${(list.start ?? 1) + index}.` : "•"}
            </Text>
          ) : (
            <View style={styles.checkMarker}>
              <Symbol
                name={item.checked ? "checkmark.circle.fill" : "circle"}
                size={15}
                tint={item.checked ? color.ember : color.muted}
              />
            </View>
          )}
          {/* Shrinks rather than flexes: a bubble sizes itself by its words, so a
              flexed body would have no width to fill and draw its marker alone. */}
          <View style={styles.listBody}>
            <Nodes look={look} nodes={item.children} />
          </View>
        </View>
      ))}
    </View>
  );
}

/** Verbatim lines in their own sideways scroller, which must not take the vertical drag. */
export function CodeLines(props: {
  readonly selectable?: boolean;
  readonly text: string;
}): ReactNode {
  return (
    <ScrollView
      directionalLockEnabled
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.codeScroll}
    >
      <Text selectable={props.selectable !== false} style={styles.codeText}>
        {props.text}
      </Text>
    </ScrollView>
  );
}

/**
 * Code or a draft in a reading column, whose copy mark stands in the corner
 * because the column leaves no gutter. A draft is words a person will send as
 * their own, so it reads as words and wraps.
 */
function CodeBlock(props: { readonly language: string | null; readonly text: string }): ReactNode {
  const draft = props.language === "draft";
  return (
    <View style={styles.block}>
      {draft ? (
        <Text selectable style={styles.draftText}>
          {props.text}
        </Text>
      ) : (
        <CodeLines text={props.text} />
      )}
      <View style={styles.blockCopy}>
        <CopyMark accessibilityLabel={draft ? "Copy draft" : "Copy code"} text={props.text} />
      </View>
    </View>
  );
}

/**
 * A table, drawn as rows of equal columns inside its own sideways scroller.
 *
 * React Native has no table layout, so the columns are given one width each:
 * an even share of the space the table has, and never less than a readable
 * cell. Two columns fill the measure; five run past it and the table scrolls
 * within itself, which is how a phone reads a wide table anywhere. Text wraps
 * inside a cell rather than truncating, because the cell is the answer.
 */
function Table(props: { readonly look: MarkdownLook; readonly table: TableNode }): ReactNode {
  const { look, table } = props;
  const [width, setWidth] = useState<number | null>(null);
  const [head, ...rows] = table.children;
  const columns = head?.children.length ?? 0;
  const columnWidth =
    width === null ? tableMinimumColumnWidth : Math.max(tableMinimumColumnWidth, width / columns);
  const onLayout = (event: LayoutChangeEvent): void => {
    setWidth(event.nativeEvent.layout.width);
  };
  const cellStyle = (index: number): TextStyle[] => [
    styles.cell,
    { width: columnWidth },
    ...(table.align?.[index] === "center" ? [styles.cellCenter] : []),
    ...(table.align?.[index] === "right" ? [styles.cellRight] : []),
  ];
  return (
    <View onLayout={onLayout} style={styles.table}>
      <ScrollView directionalLockEnabled horizontal showsHorizontalScrollIndicator>
        <View>
          <View style={[styles.tableRow, styles.tableHead]}>
            {head?.children.map((cell, index) => (
              <Text
                key={index}
                selectable={look === "reading"}
                style={[...cellStyle(index), styles.headCell]}
              >
                <Spans nodes={cell.children} />
              </Text>
            ))}
          </View>
          {rows.map((row, rowIndex) => (
            <View key={rowIndex} style={styles.tableRow}>
              {Array.from({ length: columns }, (_, index) => (
                <Text key={index} selectable={look === "reading"} style={cellStyle(index)}>
                  <Spans nodes={row.children[index]?.children ?? []} />
                </Text>
              ))}
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

function Spans(props: { readonly nodes: readonly PhrasingContent[] }): ReactNode {
  return props.nodes.map((node, index) => <Span key={index} node={node} />);
}

function Span(props: { readonly node: PhrasingContent }): ReactNode {
  const { node } = props;
  switch (node.type) {
    case "text":
      // A line break in a paragraph's source is a space, as it is on web.
      return node.value.replaceAll("\n", " ");
    case "strong":
      return (
        <Text style={styles.strong}>
          <Spans nodes={node.children} />
        </Text>
      );
    case "emphasis":
      return (
        <Text style={styles.emphasis}>
          <Spans nodes={node.children} />
        </Text>
      );
    case "delete":
      return (
        <Text style={styles.struck}>
          <Spans nodes={node.children} />
        </Text>
      );
    case "inlineCode":
      return <Text style={styles.inlineCode}>{node.value}</Text>;
    case "break":
      return "\n";
    case "html":
      return node.value;
    case "image":
      // An agent's image is never fetched from the reader's device; its words stay.
      return node.alt ?? node.url;
    case "link": {
      const words = <Spans nodes={node.children} />;
      if (!transcriptLinkUrl(node.url)) return words;
      const { url } = node;
      return (
        <Text
          accessibilityRole="link"
          onPress={() => {
            // A link the agent wrote goes to the system, which is the only
            // thing that can decide what opens it.
            void Linking.openURL(url).catch(() => Alert.alert("Link could not be opened", url));
          }}
          style={styles.link}
        >
          {words}
        </Text>
      );
    }
    default:
      return null;
  }
}

/**
 * Prose with no Markdown in it at all, drawn in the same type as a paragraph.
 * Inside the reader's own bubble it takes the fill's ink instead of the page's,
 * because the accent's ink is the only thing legible on the accent; `reply` is
 * a bubble's words on Opensteer's side.
 */
export function PlainProse(props: {
  readonly text: string;
  readonly tone?: "bubble" | "default" | "reply";
}): ReactNode {
  const lines = useContext(TextLines);
  const { tone = "default" } = props;
  return (
    <Text
      onTextLayout={lines ?? undefined}
      selectable={tone === "default"}
      style={[
        tone === "default" ? styles.readingText : styles.bubbleText,
        tone === "bubble" && styles.bubbleInk,
      ]}
    >
      {props.text}
    </Text>
  );
}

/** The narrowest a column may be and still hold a short answer on one line. */
const tableMinimumColumnWidth = 112;

const styles = StyleSheet.create({
  block: {
    backgroundColor: color.surfaceElevated,
    borderRadius: radius.md,
    borderCurve: "continuous",
    overflow: "hidden",
  },
  blockCopy: {
    alignItems: "center",
    backgroundColor: color.surfaceElevated,
    height: 38,
    justifyContent: "center",
    position: "absolute",
    right: 0,
    top: 0,
    width: 38,
  },
  bubbleHeading: { ...type.bubble, color: color.text, fontWeight: "600" },
  bubbleInk: { color: color.bubbleInk },
  bubbleProse: { gap: space[8] },
  bubbleText: { ...type.bubble, color: color.text },
  cell: {
    ...type.secondary,
    color: color.textSoft,
    paddingHorizontal: space[10],
    paddingVertical: space[8],
  },
  cellCenter: { textAlign: "center" },
  cellRight: { textAlign: "right" },
  checkMarker: { alignItems: "center", height: 22, justifyContent: "center", width: 18 },
  codeScroll: { maxHeight: 320 },
  codeText: {
    color: color.textSoft,
    fontFamily: monoFontFamily,
    fontSize: 13,
    lineHeight: 18,
    paddingLeft: space[12],
    paddingRight: 42,
    paddingVertical: space[10],
  },
  draftText: {
    ...type.reading,
    color: color.text,
    paddingLeft: space[12],
    paddingRight: 42,
    paddingVertical: space[10],
  },
  emphasis: { fontStyle: "italic" },
  headCell: { ...type.secondaryMedium, color: color.text },
  heading1: { ...type.title, color: color.text, fontSize: 20, lineHeight: 26 },
  heading2: { ...type.title, color: color.text },
  heading3: { ...type.secondaryMedium, color: color.text },
  inlineCode: {
    backgroundColor: "rgba(255, 255, 255, 0.08)",
    color: color.textSoft,
    fontFamily: monoFontFamily,
    fontSize: 15,
  },
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
  // An agent's turn is this app's reading surface, so it takes the full text
  // colour rather than the softened one a caption or a label uses.
  readingText: { ...type.reading, color: color.text },
  rule: { backgroundColor: color.line, height: StyleSheet.hairlineWidth },
  strong: { fontWeight: "600" },
  struck: { textDecorationLine: "line-through" },
  // The same ground and frame as a code block: a table is verbatim structure,
  // read in the same register as verbatim text.
  table: {
    backgroundColor: color.surfaceElevated,
    borderRadius: radius.md,
    overflow: "hidden",
  },
  tableHead: { backgroundColor: color.surfaceRaised },
  tableRow: {
    borderTopColor: color.line,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
  },
});
