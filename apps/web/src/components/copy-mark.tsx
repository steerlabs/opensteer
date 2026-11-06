import { useEffect, useState } from "react";
import { Icon } from "./icon.js";
import { useToast } from "./toast.js";

/** `execCommand` is what a Host reached over plain HTTP has left: there is no clipboard API there. */
function copyWithSelection(text: string): boolean {
  const focused = document.activeElement;
  const field = document.createElement("textarea");
  field.value = text;
  field.readOnly = true;
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.append(field);
  field.select();
  const copied = document.execCommand("copy");
  field.remove();
  if (focused instanceof HTMLElement) focused.focus({ preventScroll: true });
  return copied;
}

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    if (!copyWithSelection(text)) throw new Error("The browser refused to copy.");
  }
}

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
          copyText(typeof text === "string" ? text : text()).then(
            () => setCopied(true),
            () => toast.error("Copy was blocked. Select the text to copy it."),
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
