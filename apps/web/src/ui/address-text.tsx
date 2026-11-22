import { addressParts, type SentencePart } from "@opensteer/client/host";

/**
 * A value known to be an address (an email address, a host or a URL), drawn so it wraps only at
 * its own joints (`addressParts`, the one rule in packages/client): each part is a box of its own,
 * so a line breaks only between parts, never after a hyphen the address has, and never with a
 * hyphen added. A part breaks inside itself only when it alone is wider than the line. It is
 * never cut with an ellipsis: an origin is drawn whole wherever a person grants, adds or links.
 * What is selected and copied is the address exactly.
 */
export function Address({ value }: { readonly value: string }) {
  return (
    <span className="address">
      {addressParts(value).map((part, index) => (
        <span className="address__part" key={index}>
          {part}
        </span>
      ))}
    </span>
  );
}

/** A sentence given as parts: its words as words, and each address part as an `Address`. */
export function SentenceText({ parts }: { readonly parts: readonly SentencePart[] }) {
  return (
    <>
      {parts.map((part, index) =>
        typeof part === "string" ? part : <Address key={index} value={part.address} />,
      )}
    </>
  );
}
