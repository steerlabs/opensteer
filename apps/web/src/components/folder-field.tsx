import type { TaskFolder } from "@opensteer/core";
import { FolderChip } from "./home/folder-picker.js";
import { useFolderPicker } from "./home/use-folder-picker.js";

/** A form's folder choice: where the tasks it starts work. Agent home until changed. */
export function FolderField({
  folder,
  hint,
  onChange,
}: {
  readonly folder: TaskFolder | null;
  readonly hint: string;
  readonly onChange: (folder: TaskFolder) => void;
}) {
  const picker = useFolderPicker(folder, onChange);
  return (
    <div className="field">
      <span className="field__label">Folder</span>
      {picker ? <FolderChip {...picker} /> : <span className="field__hint">Loading folders…</span>}
      <span className="field__hint">{hint}</span>
    </div>
  );
}
