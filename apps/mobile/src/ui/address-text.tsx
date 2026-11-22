import { useMemo, useState, type ComponentProps, type ReactNode } from "react";
import {
  StyleSheet,
  useWindowDimensions,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { addressWords, isAddress } from "./address-words.js";
import { hostLineParts, planHostLine } from "./host-line-parts.js";
import { AppText } from "./primitives.js";
import { plainSentence, type SentencePart } from "./sentence-parts.js";

/**
 * How the phone draws an email address, a host or a URL: whole, never with a hyphen the address
 * does not have, wrapping only at its own joints.
 *
 * At an accessibility text size iOS hyphenates a word that does not fit its line, and to its text
 * engine an address is one word: "person@fix-" / "ture.invalid" reads as a different address. React
 * Native has no iOS setting for it, so the rule lives in the characters both platforms measure and
 * draw alike (`address-words.ts`):
 *
 * - inside a part, a word joiner (U+2060) between every two characters a person sees: no break, so
 *   no hyphen;
 * - between parts, a zero-width space (U+200B): the one place a line may break. A part ends after
 *   `@`, after `.`, after the `//` of a scheme, after `&` and `=`, and before a single `/`, `?`
 *   and `#`. An address's own hyphen is not a joint.
 *
 * Those characters never leave the component that draws them. `AddressText` and `AddressSentence`
 * here, and the native rows (`settings-form-primitives.ios.tsx`, `.android.tsx` and the native
 * settings pages), take the plain value and decorate it as they draw; a screen reader, a copy, an
 * alert or an announcement gets the value exactly. Nothing drawn this way is selectable: where a
 * value could be copied, `CopyableAddressText` (`copyable-address-text.tsx`) offers Copy of the
 * plain value in the platform's own menu.
 *
 * A one-line place that names a host (the address bar, a floating title) is not drawn this way: it
 * never wraps, so it draws the host plain and gives up the host's start, keeping the end that says
 * whose it is, as a browser does (`HostLine`).
 */

type AppTextProps = ComponentProps<typeof AppText>;

/** An email address, a host or a URL on its own: see the rules above. */
export function AddressText(
  props: Omit<AppTextProps, "children" | "selectable" | "noHyphens"> & {
    readonly value: string;
  },
): ReactNode {
  const { value, ...text } = props;
  return (
    <AppText {...text} accessibilityLabel={props.accessibilityLabel ?? value} noHyphens>
      {addressWords(value)}
    </AppText>
  );
}

/**
 * A sentence that holds an address (`sentence-parts.ts`): its words drawn as words, the address as
 * an address, inline. A screen reader hears the sentence exactly as written.
 */
export function AddressSentence(
  props: Omit<AppTextProps, "children" | "selectable" | "noHyphens"> & {
    readonly parts: readonly SentencePart[];
  },
): ReactNode {
  const { parts, ...text } = props;
  return (
    <AppText {...text} accessibilityLabel={props.accessibilityLabel ?? plainSentence(parts)}>
      {parts.map((part, index) =>
        typeof part === "string" ? (
          part
        ) : isAddress(part.address) ? (
          // Inline, in the sentence's own style; its characters are this text's alone.
          <AppText inline key={index} noHyphens>
            {addressWords(part.address)}
          </AppText>
        ) : (
          part.address
        ),
      )}
    </AppText>
  );
}

/**
 * A host where there is one line, as a browser's address bar has it: drawn plain, never wrapped
 * while it fits (a host wrapped at a dot reads as two hosts). It never cuts inside its registrable
 * domain (`host-line-parts.ts`): the words before and after it go first, entirely, then whole
 * labels from its left behind an ellipsis, and when even its registrable domain does not fit it
 * takes another line, wrapping at its joints, never cut. A scheme it is shown with (one that is
 * not https, a warning) never goes. A screen reader hears the line once, whole.
 *
 * Not for a decision about a site, where a person must see the whole origin: there the address is
 * drawn whole (`AddressSentence`). `tests/mobile-address-text.test.ts` lists where it may be used.
 *
 * Its pieces are measured unseen and unheard, and the line it may fill by an unseen copy of
 * itself whole, so it takes the room a plain line of its words would and nothing more.
 */
type HostLineProps = Omit<
  AppTextProps,
  "children" | "selectable" | "numberOfLines" | "ellipsizeMode" | "style"
> & {
  readonly host: string;
  readonly before?: string;
  readonly after?: string;
  /** Where the line stands among its neighbours. */
  readonly style?: StyleProp<ViewStyle>;
};

export function HostLine(props: HostLineProps): ReactNode {
  // What it measured holds for these words at this text size and style only: other ones are a
  // line of their own, measured afresh as it mounts, never planned by widths that were not theirs.
  const { fontScale } = useWindowDimensions();
  const drawing = [
    props.before ?? "",
    props.host,
    props.after ?? "",
    fontScale,
    props.role ?? "",
    props.maxFontSizeMultiplier ?? "",
  ].join("\u0000");
  return <MeasuredHostLine key={drawing} {...props} />;
}

function MeasuredHostLine(props: HostLineProps): ReactNode {
  const { accessibilityLabel, after = "", before = "", host, style, ...text } = props;
  const parts = useMemo(() => hostLineParts(host), [host]);
  const pieces = useMemo(
    () =>
      [
        ["before", before],
        ["after", after],
        ["scheme", parts.scheme],
        ["ellipsis", "…"],
        ["kept", parts.kept],
        ...parts.labels.map((label, index) => [`label:${index}`, label] as const),
      ].filter(([, words]) => words !== "") as [string, string][],
    [after, before, parts],
  );
  const [room, setRoom] = useState<number | null>(null);
  const [widths, setWidths] = useState<Readonly<Record<string, number>>>({});
  const measured = pieces.every(([key]) => widths[key] !== undefined);
  const plan =
    room === null || !measured
      ? null
      : planHostLine({ parts, room, width: (piece) => widths[piece] ?? 0 });
  const whole = `${parts.scheme}${parts.labels.join("")}${parts.kept}`;
  const unseen = {
    accessibilityElementsHidden: true,
    importantForAccessibility: "no-hide-descendants",
    pointerEvents: "none",
  } as const;
  return (
    <View
      accessibilityLabel={accessibilityLabel ?? `${before}${host}${after}`}
      accessibilityRole="text"
      accessible
      onLayout={(event) => {
        const width = event.nativeEvent.layout.width;
        setRoom((current) => (current === width ? current : width));
      }}
      style={[styles.hostLine, style]}
    >
      <View {...unseen} style={styles.measure} testID="host-line-measure">
        {pieces.map(([key, words]) => (
          <View
            key={key}
            onLayout={(event) => {
              const width = event.nativeEvent.layout.width;
              setWidths((current) =>
                current[key] === width ? current : { ...current, [key]: width },
              );
            }}
            style={styles.measured}
          >
            <AppText {...text} numberOfLines={1}>
              {words}
            </AppText>
          </View>
        ))}
      </View>
      {plan?.kind === "wrap" ? (
        // Its registrable domain does not fit one line: it wraps at its joints, never cut.
        <AppText {...text} noHyphens style={styles.wrapped}>
          {isAddress(whole) ? addressWords(whole) : whole}
        </AppText>
      ) : (
        <>
          <View {...unseen} style={styles.room} testID="host-line-room">
            <AppText {...text} numberOfLines={1}>
              {`${before}${host}${after}`}
            </AppText>
          </View>
          {plan === null ? null : (
            <View {...unseen} style={styles.drawn}>
              {plan.before && before !== "" ? (
                <AppText {...text} numberOfLines={1} style={styles.kept}>
                  {before}
                </AppText>
              ) : null}
              {parts.scheme === "" ? null : (
                <AppText {...text} numberOfLines={1} style={styles.kept}>
                  {parts.scheme}
                </AppText>
              )}
              <AppText {...text} numberOfLines={1} style={styles.kept}>
                {`${plan.dropped > 0 ? "…" : ""}${parts.labels.slice(plan.dropped).join("")}${parts.kept}`}
              </AppText>
              {after === "" || plan.after === "none" ? null : (
                <AppText
                  {...text}
                  ellipsizeMode="tail"
                  numberOfLines={1}
                  style={plan.after === "whole" ? styles.kept : styles.stump}
                >
                  {after}
                </AppText>
              )}
            </View>
          )}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // Drawn over the unseen copy of the line, which gives it its room.
  drawn: { flexDirection: "row", left: 0, position: "absolute", right: 0, top: 0 },
  hostLine: { flexShrink: 1, minWidth: 0 },
  kept: { flexShrink: 0 },
  // Each piece at its own width, wherever the line stands.
  measure: { left: 0, opacity: 0, position: "absolute", top: 0, width: 100_000 },
  measured: { alignSelf: "flex-start" },
  room: { opacity: 0 },
  stump: { flexShrink: 1, minWidth: 0 },
  wrapped: { flexShrink: 1 },
});
