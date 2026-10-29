import { Icon } from "../icon.js";

/**
 * The one mark that says which computer the reader is sitting at, like a
 * map's "you are here". It replaces "This Mac", which named a different
 * computer on every screen it appeared on.
 */
export function HerePin() {
  return (
    <span className="here-pin">
      <Icon name="pin" />
      You’re here
    </span>
  );
}
