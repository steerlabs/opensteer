import { memo, useMemo, useState, type ReactNode } from "react";
import {
  Linking,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
  type TextStyle,
} from "react-native";
import {
  parseMarkdownBlock,
  splitMarkdownBlocks,
  type MarkdownBlock,
  type MarkdownSpan,
} from "./markdown-blocks.js";
import { color, radius, space, type } from "../theme.js";
import { CodeBlock, monoFontFamily } from "../ui/primitives.js";

/**
 * Assistant prose.
 *
 * The renderer is this repository's own, over `markdown-blocks.ts`: the
 * maintained React Native Markdown packages are either unmaintained or bring a
 * native module (an SVG or WebView dependency), and neither is something to
 * put in the path of every message the product shows. A bounded subset that
 * this tree owns is drawn correctly on both platforms and degrades to the
 * literal text the agent wrote.
 *
 * Each block is memoised on the exact source string it came from, so a
 * streaming message re-parses and re-draws only its trailing block.
 */
export const Markdown = memo(function Markdown(props: { readonly text: string }): ReactNode {
  const blocks = useMemo(() => splitMarkdownBlocks(props.text), [props.text]);
  if (blocks.length === 0) return null;
  return (
    <View style={styles.prose}>
      {blocks.map((source, index) => (
        <Block key={index} source={source} />
      ))}
    </View>
  );
});

const Block = memo(function Block(props: { readonly source: string }): ReactNode {
  const block = useMemo(() => parseMarkdownBlock(props.source), [props.source]);
  return renderBlock(block);
});

function renderBlock(block: MarkdownBlock): ReactNode {
  switch (block.kind) {
    case "code":
      return (
        <CodeBlock
          text={block.text}
          {...(block.language === null ? {} : { label: block.language })}
        />
      );
    case "heading":
      return (
        <Text
          accessibilityRole="header"
          selectable
          style={
            block.level === 1
              ? styles.heading1
              : block.level === 2
                ? styles.heading2
                : styles.heading3
          }
        >
          <Spans spans={block.spans} />
        </Text>
      );
    case "list":
      return (
        <View style={styles.list}>
          {block.items.map((item, index) => (
            // A nested item steps in by one marker column per level, so the
            // indentation the author wrote is the indentation the reader sees.
            <View
              key={`${index}:${item.marker}`}
              style={[styles.listItem, { paddingLeft: item.depth * listIndent }]}
            >
              <Text style={styles.listMarker}>{item.marker}</Text>
              <Text selectable style={[styles.paragraph, styles.listItemText]}>
                <Spans spans={item.spans} />
              </Text>
            </View>
          ))}
        </View>
      );
    case "paragraph":
      return (
        <Text selectable style={styles.paragraph}>
          <Spans spans={block.spans} />
        </Text>
      );
    case "quote":
      return (
        <View style={styles.quote}>
          <Text selectable style={styles.quoteText}>
            <Spans spans={block.spans} />
          </Text>
        </View>
      );
    case "rule":
      return <View style={styles.rule} />;
    case "table":
      return <Table align={block.align} header={block.header} rows={block.rows} />;
  }
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
function Table(props: {
  readonly align: readonly ("left" | "center" | "right" | null)[];
  readonly header: readonly (readonly MarkdownSpan[])[];
  readonly rows: readonly (readonly MarkdownSpan[])[][];
}): ReactNode {
  const [width, setWidth] = useState<number | null>(null);
  const columns = props.header.length;
  const columnWidth =
    width === null ? tableMinimumColumnWidth : Math.max(tableMinimumColumnWidth, width / columns);
  const onLayout = (event: LayoutChangeEvent): void => {
    setWidth(event.nativeEvent.layout.width);
  };
  const cellStyle = (index: number): TextStyle[] => [
    styles.cell,
    { width: columnWidth },
    ...(props.align[index] === "center" ? [styles.cellCenter] : []),
    ...(props.align[index] === "right" ? [styles.cellRight] : []),
  ];
  return (
    <View onLayout={onLayout} style={styles.table}>
      <ScrollView directionalLockEnabled horizontal showsHorizontalScrollIndicator>
        <View>
          <View style={[styles.tableRow, styles.tableHead]}>
            {props.header.map((spans, index) => (
              <Text key={index} selectable style={[...cellStyle(index), styles.headCell]}>
                <Spans spans={spans} />
              </Text>
            ))}
          </View>
          {props.rows.map((row, rowIndex) => (
            <View key={rowIndex} style={styles.tableRow}>
              {row.map((spans, index) => (
                <Text key={index} selectable style={cellStyle(index)}>
                  <Spans spans={spans} />
                </Text>
              ))}
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

function Spans(props: { readonly spans: readonly MarkdownSpan[] }): ReactNode {
  return (
    <>
      {props.spans.map((span, index) => (
        <Span key={`${index}:${span.kind}`} span={span} />
      ))}
    </>
  );
}

function Span(props: { readonly span: MarkdownSpan }): ReactNode {
  const { span } = props;
  switch (span.kind) {
    case "code":
      return <Text style={styles.inlineCode}>{span.text}</Text>;
    case "emphasis":
      return <Text style={span.strong ? styles.strong : styles.emphasis}>{span.text}</Text>;
    case "link":
      return (
        <Text
          accessibilityRole="link"
          onPress={() => {
            // A link the agent wrote goes to the system, which is the only
            // thing that can decide what opens it.
            void Linking.openURL(span.href).catch(() =>
              Alert.alert("Link could not be opened", span.href),
            );
          }}
          style={styles.link}
        >
          {span.text}
        </Text>
      );
    case "text":
      return <Text>{span.text}</Text>;
  }
}

/**
 * Prose with no Markdown in it at all, drawn in the same type as a paragraph.
 * Inside a filled bubble it takes the fill's own ink instead of the page's,
 * because the accent's ink is the only thing legible on the accent.
 */
export function PlainProse(props: {
  readonly text: string;
  readonly tone?: "bubble" | "default";
}): ReactNode {
  return (
    <Text selectable style={[styles.paragraph, props.tone === "bubble" && styles.bubbleInk]}>
      {props.text}
    </Text>
  );
}

/** One marker column: the marker's minimum width and the gap after it. */
const listIndent = 18 + space[8];

/** The narrowest a column may be and still hold a short answer on one line. */
const tableMinimumColumnWidth = 112;

const styles = StyleSheet.create({
  cell: {
    ...type.secondary,
    color: color.textSoft,
    paddingHorizontal: space[10],
    paddingVertical: space[8],
  },
  cellCenter: { textAlign: "center" },
  cellRight: { textAlign: "right" },
  emphasis: { fontStyle: "italic" },
  headCell: { ...type.secondaryMedium, color: color.text },
  heading1: { ...type.title, color: color.text, fontSize: 20, lineHeight: 26 },
  heading2: { ...type.title, color: color.text },
  heading3: { ...type.secondaryMedium, color: color.text },
  inlineCode: {
    backgroundColor: color.surfaceRaised,
    color: color.textSoft,
    fontFamily: monoFontFamily,
    fontSize: 14,
  },
  bubbleInk: { color: color.bubbleInk },
  link: { color: color.ember, textDecorationLine: "underline" },
  list: { gap: space[4] },
  listItem: { flexDirection: "row", gap: space[8] },
  listMarker: { ...type.body, color: color.muted, minWidth: 18 },
  listItemText: { flex: 1 },
  // An agent's turn is this app's reading surface, so it takes the full text
  // colour rather than the softened one a caption or a label uses.
  paragraph: { ...type.body, color: color.text },
  prose: { gap: space[10] },
  quote: {
    borderLeftColor: color.lineStrong,
    borderLeftWidth: 2,
    borderRadius: radius.xs,
    paddingLeft: space[10],
  },
  quoteText: { ...type.body, color: color.muted },
  rule: { backgroundColor: color.line, height: StyleSheet.hairlineWidth },
  strong: { fontWeight: "600" },
  // The same ground and frame as a code block: a table is verbatim structure,
  // read in the same register as verbatim text.
  table: {
    backgroundColor: color.surfaceCode,
    borderColor: color.line,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  tableHead: { backgroundColor: color.surface },
  tableRow: {
    borderTopColor: color.line,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
  },
});
