export { DictationController } from "./controller.js";
export type {
  DictationControllerInput,
  DictationFinish,
  DictationPhase,
  DictationSnapshot,
  DictationTarget,
} from "./controller.js";
export { insertDictationText, joinDictationText } from "./text.js";
export type { DictationSelection } from "./text.js";
export {
  dictationLabels,
  dictationStartLabel,
  dictationDownloadStatus,
  dictationElapsed,
  dictationNoticeMessage,
} from "./presentation.js";
export type { DictationNoticeKind } from "./presentation.js";
