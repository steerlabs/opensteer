export interface ComposerActionProps {
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly kind: "send" | "stop";
  readonly label: string;
  readonly onPress: () => void;
}
