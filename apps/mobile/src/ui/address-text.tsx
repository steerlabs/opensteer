import type { ComponentProps, ReactNode } from "react";
import { addressWords } from "./address-words.js";
import { AppText } from "./primitives.js";

/**
 * How the phone draws an email address, a host or a URL: whole, never with a hyphen the address
 * does not have, wrapping only at its own joints.
 *
 * At an accessibility text size iOS hyphenates a word that does not fit its line, and to its text
 * engine an address is one word: "person@fix-" / "ture.invalid" reads as a different address. React
 * Native has no iOS setting for it, so the rule lives in the characters both platforms measure and
 * draw alike:
 *
 * - inside a part, a word joiner (U+2060) between every two characters: no break, so no hyphen;
 * - between parts, a zero-width space (U+200B): the one place a line may break. A part ends after
 *   `@`, after `.`, after the `//` of a scheme, after `&` and `=`, and before a single `/`, `?`
 *   and `#`. An address's own hyphen is not a joint.
 *
 * A part longer than the line still breaks inside itself where the text engine must (a break
 * between characters, without a hyphen); only the phone shows where. Android draws without
 * hyphenation by default and `AddressText` says so as well.
 *
 * Every address, host and URL the app draws goes through `AddressText`, or `addressWords`
 * (`address-words.ts`) inside a sentence or a row's text; `tests/mobile-address-text.test.ts` holds
 * every screen to it. Neither is ever selectable: a copy must give the address exactly, so copying
 * goes through the raw value.
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
