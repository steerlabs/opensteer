export interface ComposerActionProps {
  readonly busy: boolean;
  readonly disabled: boolean;
  /** `next` points on, for a step that moves to the next question rather than sending. */
  readonly kind: "send" | "next" | "stop";
  readonly label: string;
  readonly onPress: () => void;
}
