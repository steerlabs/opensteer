import { addressParts, addressText, outsideText, type SentencePart } from "@opensteer/client/host";

/**
 * A value known to be an address (an origin, a provider's handle), drawn so it wraps only at its
 * own joints (`addressParts`, the one rule in packages/client): each part is a box of its own, so
 * a line breaks only between parts, never after a hyphen the address has, and never with a
 * hyphen added. A part breaks inside itself only when it alone is wider than the line. It is
 * never cut with an ellipsis: an origin is drawn whole wherever a person grants, adds or links.
 * It is cleaned first (`addressText`) and isolated from the direction of the text around it.
 * What is selected and copied is the address exactly.
 */
export function Address({ value }: { readonly value: string }) {
  return (
    <bdi className="address">
      {addressParts(addressText(value)).map((part, index) => (
        <span className="address__part" key={index}>
          {part}
        </span>
      ))}
    </bdi>
  );
}

/**
 * A name someone else chose, drawn as a name: the Home cleaned it where it entered; here it is
 * isolated from the direction of the text around it, and in its own weight, the same everywhere, so a person can tell where it ends and
 * Opensteer's words begin. Never drawn as an address, whatever it looks like.
 */
export function OutsideName({ value }: { readonly value: string }) {
  return <bdi className="outside-name">{outsideText(value)}</bdi>;
}

/** A sentence given as parts: its words as words, each name an `OutsideName`, each address an `Address`. */
export function SentenceText({ parts }: { readonly parts: readonly SentencePart[] }) {
  return (
    <>
      {parts.map((part, index) =>
        typeof part === "string" ? (
          part
        ) : "address" in part ? (
          <Address key={index} value={part.address} />
        ) : (
          <OutsideName key={index} value={part.name} />
        ),
      )}
    </>
  );
}
