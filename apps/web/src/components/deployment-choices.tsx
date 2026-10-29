import type { ReactNode } from "react";
import { Icon, type IconName } from "./icon.js";
import { OptionRow } from "./option-row.js";

export type DeploymentChoice = "cloud" | "computer" | "local" | "server";

interface DeploymentChoiceDefinition {
  readonly detail: string;
  readonly icon: IconName;
  readonly title: string;
}

const choices: Readonly<Record<DeploymentChoice, DeploymentChoiceDefinition>> = {
  cloud: {
    detail: "Always on, so agents keep working while your computer sleeps. We run it for you.",
    icon: "cloud",
    title: "Opensteer Cloud",
  },
  computer: {
    detail: "Turn on Remote access there, or pair it with a code.",
    icon: "laptop",
    title: "Another computer of yours",
  },
  local: {
    detail: "Keep your work and files on this computer. No account needed.",
    icon: "laptop",
    title: "Use this computer",
  },
  server: {
    detail: "Use the address your team gave you.",
    icon: "server",
    title: "A server",
  },
};

interface DeploymentChoicesProps {
  readonly busy?: boolean;
  readonly expanded?: DeploymentChoice | null;
  readonly onChoose: (choice: DeploymentChoice) => void;
  readonly options: readonly DeploymentChoice[];
  readonly renderExpanded?: (choice: DeploymentChoice) => ReactNode;
}

/** The ways to add a place: this computer, another computer, a server, or Opensteer Cloud. */
export function DeploymentChoices({
  busy = false,
  expanded = null,
  onChoose,
  options,
  renderExpanded,
}: DeploymentChoicesProps) {
  return (
    <div className="add-deployment">
      {options.map((choice) => {
        const definition = choices[choice];
        const open = expanded === choice;
        return (
          <div className="add-deployment__option" key={choice}>
            <OptionRow
              {...(renderExpanded ? { ariaExpanded: open } : {})}
              as="button"
              detail={definition.detail}
              disabled={busy}
              framed
              leading={
                <span className="option-row__glyph option-row__glyph--outline">
                  <Icon name={definition.icon} />
                </span>
              }
              onClick={() => onChoose(choice)}
              title={definition.title}
              trailing={<Icon name={open ? "chevron-down" : "chevron-right"} />}
            />
            {open && renderExpanded ? renderExpanded(choice) : null}
          </div>
        );
      })}
    </div>
  );
}

export function deploymentChoiceOrder({
  canCreateCloud,
  canCreateLocal,
  canConnect,
}: {
  readonly canCreateCloud: boolean;
  readonly canCreateLocal: boolean;
  readonly canConnect: boolean;
}): readonly DeploymentChoice[] {
  const ordered: DeploymentChoice[] = [];
  if (canCreateLocal) ordered.push("local");
  if (canConnect) ordered.push("computer", "server");
  if (canCreateCloud) ordered.push("cloud");
  return ordered;
}
