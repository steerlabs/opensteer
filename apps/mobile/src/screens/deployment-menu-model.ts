export type DeploymentMenuActionId = "details" | "remove" | "sign-out";

export interface DeploymentMenuItem {
  readonly destructive: boolean;
  readonly id: DeploymentMenuActionId;
  readonly systemImage: "info.circle" | "rectangle.portrait.and.arrow.right" | "trash";
  readonly title: string;
}

export interface DeploymentMenuProps {
  readonly canRemove: boolean;
  readonly canSignOut: boolean;
  readonly name: string;
  readonly onDetails: () => void;
  readonly onRemove: () => void;
  readonly onSignOut: () => void;
}

export function deploymentMenuItems(props: DeploymentMenuProps): readonly DeploymentMenuItem[] {
  return [
    { destructive: false, id: "details", systemImage: "info.circle", title: "Details" },
    ...(props.canSignOut
      ? [
          {
            destructive: true,
            id: "sign-out" as const,
            systemImage: "rectangle.portrait.and.arrow.right" as const,
            title: "Sign out",
          },
        ]
      : []),
    ...(props.canRemove
      ? [
          {
            destructive: true,
            id: "remove" as const,
            systemImage: "trash" as const,
            title: "Remove from this phone",
          },
        ]
      : []),
  ];
}

export function runDeploymentMenuAction(action: string, props: DeploymentMenuProps): void {
  switch (action) {
    case "details":
      props.onDetails();
      break;
    case "remove":
      props.onRemove();
      break;
    case "sign-out":
      props.onSignOut();
      break;
    default:
      throw new Error(`Unknown deployment menu action: ${action}`);
  }
}
