/** How hard the model reasons, as a slider over the ladder's steps. */
export interface ReasoningSliderProps {
  readonly disabled: boolean;
  readonly label: string;
  /** The step shown, or null while the engine chooses and none is in force. */
  readonly step: number | null;
  /** The ladder's step names, least effort first. */
  readonly steps: readonly string[];
  /** What assistive technology reads for the step shown. */
  readonly valueText: string;
  /** A finger is on a step not yet applied; null once it lets go of none. */
  readonly onPreview: (step: number | null) => void;
  /** The slider came to rest on a step: apply it. */
  readonly onSettle: (step: number) => void;
}
