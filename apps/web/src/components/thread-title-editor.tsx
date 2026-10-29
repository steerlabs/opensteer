import { useLayoutEffect, useRef, useState } from "react";
import type { HostClient } from "@opensteer/client/host";
import { threadTitleMaxLength } from "@opensteer/core";

export function ThreadTitleEditor(props: {
  readonly hostClient: HostClient;
  readonly onClose: () => void;
  readonly threadId: string;
  readonly title: string;
}) {
  const [value, setValue] = useState(props.title);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  useLayoutEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const save = async () => {
    if (saving) return;
    const title = value.trim();
    if (!title || title === props.title) {
      props.onClose();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await props.hostClient.renameThread(props.threadId, title);
      props.onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The task could not be renamed.");
      setSaving(false);
      input.current?.focus();
    }
  };
  return (
    <span className="thread-title-editor">
      <input
        aria-label="Task title"
        className="text-input"
        disabled={saving}
        maxLength={threadTitleMaxLength}
        onChange={(event) => setValue(event.target.value)}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
        onKeyDown={(event) => {
          if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            props.onClose();
          }
          if (event.key === "Enter") {
            event.preventDefault();
            void save();
          }
        }}
        ref={input}
        value={value}
      />
      {error ? (
        <span className="thread-title-editor__error" role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}
