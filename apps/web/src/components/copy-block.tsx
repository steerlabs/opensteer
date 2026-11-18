import { useState } from "react";
import { copyText } from "@opensteer/shared/clipboard";

/** A value to paste somewhere else, shown whole, with its own Copy button. */
export function CopyBlock({
  className,
  label,
  value,
}: {
  readonly className?: string;
  readonly label: string;
  readonly value: string;
}) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <div className={["computers-copy-block", className].filter(Boolean).join(" ")}>
      <div>
        <strong>{label}</strong>
        <button
          className="btn btn--ghost btn--small"
          onClick={() =>
            void copyText(value).then((success) => (success ? setCopied(true) : setFailed(true)))
          }
          type="button"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <code>{value}</code>
      {failed ? (
        <small className="field__hint">Copy was blocked. Select the text to copy it.</small>
      ) : null}
    </div>
  );
}
