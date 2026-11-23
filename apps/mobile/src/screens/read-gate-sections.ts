import { agentWords } from "@opensteer/client/host";
import type { NativeSettingsRow, NativeSettingsSection } from "./native-settings-page.types.js";

/**
 * A page drawn from a read whose last attempt failed changes nothing until it is read again: one
 * rule for every phone page that shows what a Home last said and lets a person act on it
 * (Messaging, a connected agent's page). Every row that acts is gone (a button that does not open
 * another page, a switch, a field, chips), except Try again; a status reads as not read just now;
 * a section that rule empties is not drawn; and the page draws no sheet over itself while it
 * lasts (`readFailed` is what its caller checks). `retry`, when the page has no Try again of its
 * own, is drawn first: what failed and the one control that reads it again.
 */
export function readGateSections(
  sections: readonly NativeSettingsSection[],
  input: {
    readonly failed: boolean;
    /** Sections drawn as they are (a page's own Refresh). */
    readonly keep?: (section: NativeSettingsSection) => boolean;
    readonly retry?: { readonly message: string; readonly onRetry: () => void };
  },
): readonly NativeSettingsSection[] {
  if (!input.failed) return sections;
  const tryAgain = agentWords("common.tryAgain");
  const gated = sections.map((section) =>
    input.keep?.(section)
      ? section
      : {
          ...section,
          rows: section.rows.flatMap((row): NativeSettingsRow[] =>
            row.kind === "status"
              ? [{ ...row, tone: "neutral", label: agentWords("messaging.status.stale") }]
              : (row.kind === "button" && !row.opens && row.label !== tryAgain) ||
                  row.kind === "toggle" ||
                  row.kind === "input" ||
                  row.kind === "chips" ||
                  row.kind === "choice"
                ? []
                : [row],
          ),
        },
  );
  const drawn = gated.filter(
    (section) => input.keep?.(section) || section.rows.length > 0 || section.footer,
  );
  return input.retry
    ? [
        {
          key: "read-failed",
          title: "",
          rows: [
            { key: "read-failed", kind: "text", label: input.retry.message },
            { key: "retry", kind: "button", label: tryAgain, onPress: input.retry.onRetry },
          ],
        },
        ...drawn,
      ]
    : drawn;
}
