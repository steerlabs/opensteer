import { computerUsesPhrase, type ComputerUse } from "@opensteer/client/computers";
import { Icon } from "../icon.js";
import { IntegrationIcon } from "../integrations/integration-icon.js";

/** How many marks a row draws before it counts the rest. */
const shownMarks = 4;

/**
 * What agents can use on a computer, as the marks people already know: each
 * app's own icon, a folder, a terminal, a phone's screen. The sentence is the accessible name,
 * so a screen reader hears "Messages, Notes and 2 folders" rather than a row
 * of pictures.
 */
export function ComputerUseMarks({ uses }: { readonly uses: readonly ComputerUse[] }) {
  if (uses.length === 0) return null;
  const shown = uses.slice(0, shownMarks);
  const rest = uses.length - shown.length;
  return (
    <span aria-label={computerUsesPhrase(uses)} className="computer-uses" role="img">
      {shown.map((use, index) => (
        <UseMark key={`${useKey(use)}:${index}`} use={use} />
      ))}
      {rest > 0 ? <span className="computer-uses__more">+{rest}</span> : null}
    </span>
  );
}

function UseMark({ use }: { readonly use: ComputerUse }) {
  switch (use.kind) {
    case "app":
      return <IntegrationIcon id={use.definitionId} name={use.name} />;
    case "screen-app":
      return (
        <span className="computer-uses__glyph computer-uses__monogram">
          {use.name.trim().charAt(0).toUpperCase()}
        </span>
      );
    case "folders":
      return (
        <span className="computer-uses__glyph">
          <Icon name="folder" />
        </span>
      );
    case "commands":
      return (
        <span className="computer-uses__glyph">
          <Icon name="terminal" />
        </span>
      );
    case "screen":
      return (
        <span className="computer-uses__glyph">
          <Icon name="phone" />
        </span>
      );
  }
}

function useKey(use: ComputerUse): string {
  switch (use.kind) {
    case "app":
      return `app:${use.definitionId}`;
    case "screen-app":
      return `screen:${use.name}`;
    case "folders":
    case "commands":
    case "screen":
      return use.kind;
  }
}
