import type { ComponentProps, ReactNode } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { addressWords, isAddress } from "./address-words.js";
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
 * A host where there is one line, as a browser's address bar has it: drawn plain, never wrapped (a
 * host wrapped at a dot reads as two hosts). The line is for the host, so the host is cut alone,
 * at its start, keeping the end that says whose it is. The words around it (`before`, `after`)
 * are texts of their own, cut at their own end, and give way first. A scheme the host is shown
 * with (one that is not https, a warning) is drawn on its own and never gives way. A screen reader
 * hears the line once, whole.
 */
export function HostLine(
  props: Omit<
    AppTextProps,
    "children" | "selectable" | "numberOfLines" | "ellipsizeMode" | "style"
  > & {
    readonly host: string;
    readonly before?: string;
    readonly after?: string;
    /** Where the line stands among its neighbours. */
    readonly style?: StyleProp<ViewStyle>;
  },
): ReactNode {
  const { accessibilityLabel, after = "", before = "", host, style, ...text } = props;
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//iu.exec(host)?.[0] ?? "";
  return (
    <View
      accessibilityLabel={accessibilityLabel ?? `${before}${host}${after}`}
      accessibilityRole="text"
      accessible
      style={[styles.hostLine, style]}
    >
      {before === "" ? null : (
        <AppText {...text} ellipsizeMode="tail" numberOfLines={1} style={styles.givesWay}>
          {before}
        </AppText>
      )}
      {scheme === "" ? null : (
        <AppText {...text} numberOfLines={1} style={styles.kept}>
          {scheme}
        </AppText>
      )}
      <AppText {...text} ellipsizeMode="head" numberOfLines={1} style={styles.host}>
        {host.slice(scheme.length)}
      </AppText>
      {after === "" ? null : (
        <AppText {...text} ellipsizeMode="tail" numberOfLines={1} style={styles.givesWay}>
          {after}
        </AppText>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // The words around the host give way so much faster than it that they are gone before it is cut.
  givesWay: { flexShrink: 10_000 },
  host: { flexShrink: 1 },
  hostLine: { flexDirection: "row", flexShrink: 1, minWidth: 0 },
  kept: { flexShrink: 0 },
});
