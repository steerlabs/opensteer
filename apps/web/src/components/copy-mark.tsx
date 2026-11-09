import { useEffect, useState } from "react";
import { Icon } from "./icon.js";
import { useToast } from "./toast.js";
import { copyText } from "@opensteer/shared/clipboard";

/**
 * The one copy control beside a message or inside a block: a bare mark that
 * answers with a check, because the clipboard gives no sign of its own.
 * `text` may be a function when the words only exist once drawn.
 */
export function CopyMark({
  className,
  label,
  text,
}: {
  className?: string;
  label: string;
  text: string | (() => string);
}) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1_500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <>
      <button
        aria-label={label}
        className={["mark", className].filter(Boolean).join(" ")}
        data-done={copied || undefined}
        onClick={() => {
          void copyText(typeof text === "string" ? text : text()).then((success) =>
            success
              ? setCopied(true)
              : toast.error("Copy was blocked. Select the text to copy it."),
          );
        }}
        title={label}
        type="button"
      >
        <Icon name={copied ? "check" : "copy"} />
      </button>
      {copied ? (
        <span className="visually-hidden" role="status">
          Copied
        </span>
      ) : null}
    </>
  );
}
