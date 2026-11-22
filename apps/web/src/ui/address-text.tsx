import { Fragment, type ReactNode } from "react";

/**
 * An address, host or URL wraps only at its own joints: after "@", before each dot, after each
 * "/". It is never hyphenated, and only a part longer than the whole line breaks inside itself
 * (`.address` in `styles/address.css`). Any web screen that draws an address uses this.
 */
export function Address({ value }: { readonly value: string }) {
  const parts = addressParts(value);
  return (
    <span className="address">
      {parts.map((part, index) => (
        <Fragment key={index}>
          {index > 0 ? <wbr /> : null}
          {part}
        </Fragment>
      ))}
    </span>
  );
}

/** A sentence whose addresses, hosts and URLs wrap only at their joints; the rest as written. */
export function AddressText({ text }: { readonly text: string }) {
  const nodes: ReactNode[] = [];
  let at = 0;
  for (const match of text.matchAll(addressPattern)) {
    const start = match.index;
    // A sentence's own full stop or comma after an address is not part of it.
    const value = match[0].replace(/[.,;:!?)]+$/u, "");
    if (start > at) nodes.push(text.slice(at, start));
    nodes.push(<Address key={start} value={value} />);
    at = start + value.length;
  }
  if (at < text.length) nodes.push(text.slice(at));
  return <>{nodes}</>;
}

/** An e-mail address, a URL, or a host of two or more labels. */
const addressPattern =
  /[\w.+-]+@[\w-]+(?:\.[\w-]+)+|https?:\/\/[^\s]+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b/gu;

/** The parts of an address between which a line may break. */
export function addressParts(value: string): readonly string[] {
  const parts: string[] = [];
  let current = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    // Before a dot that follows something, so ".com" moves to the next line whole.
    if (character === "." && current !== "" && !current.endsWith("/")) {
      parts.push(current);
      current = "";
    }
    current += character;
    // After "@", and after a "/" that ends a run of them ("https://" stays whole).
    if (character === "@" || (character === "/" && value[index + 1] !== "/")) {
      parts.push(current);
      current = "";
    }
  }
  if (current !== "") parts.push(current);
  return parts;
}
