import { useState } from "react";
import { mutationIdempotencyKey, threadMark, type HostClient } from "@opensteer/client/host";
import { useTaskSnapshot } from "./task-rows.js";
import { Popover } from "./popover.js";
import { WorkspaceIconPicker } from "./workspace-icon-picker.js";

export function TaskIconEditor({
  anchor,
  hostClient,
  onClose,
  threadId,
}: {
  readonly anchor: HTMLElement;
  readonly hostClient: HostClient;
  readonly onClose: () => void;
  readonly threadId: string;
}) {
  const mark = threadMark(threadId, useTaskSnapshot(hostClient));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  return (
    <Popover anchor={anchor} label="Task icon" role="dialog" onClose={onClose}>
      <div aria-busy={saving}>
        <WorkspaceIconPicker
          task
          name=""
          color={mark.color}
          value={mark.pending ? null : mark.icon}
          onChange={(icon) => {
            if (saving) return;
            setSaving(true);
            setError(null);
            void hostClient
              .dispatch({
                type: "thread.icon.set",
                idempotencyKey: mutationIdempotencyKey(`thread-icon:${threadId}`),
                threadId,
                icon,
              })
              .then(onClose)
              .catch((failure: unknown) => {
                setError(
                  failure instanceof Error ? failure.message : "The icon could not be changed.",
                );
                setSaving(false);
              });
          }}
        />
        {error ? (
          <p className="workspace-icon-picker__error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Popover>
  );
}
