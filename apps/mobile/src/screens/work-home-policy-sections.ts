import type { WorkHomeSeeView } from "@opensteer/client/host";
import type { NativeSettingsSection } from "./native-settings-page.types.js";

/**
 * "What {organization} can see", from inside a work Home, as Settings rows: what it decided
 * and its version, exactly the records this Home sends, and what never leaves it.
 */
export function workHomePolicySections(view: WorkHomeSeeView): readonly NativeSettingsSection[] {
  return [
    { key: "lead", title: "", rows: [], footer: { text: view.lead } },
    {
      key: "decides",
      title: view.decides.title,
      rows: view.decides.rows.map((row) => ({
        key: row.title,
        kind: "text",
        label: row.title,
        detail: row.value,
      })),
      footer: { text: view.decides.version },
    },
    {
      key: "sees",
      title: view.sees.title,
      rows: view.sees.items.map((item) => ({ key: item, kind: "text", label: item })),
    },
    {
      key: "records",
      title: view.sees.recordsTitle,
      rows: view.sees.records.map((record) => ({ key: record, kind: "text", label: record })),
    },
    {
      key: "never",
      title: view.never.title,
      rows: view.never.items.map((item) => ({ key: item, kind: "text", label: item })),
    },
  ];
}
