export { DictationController, dictationView } from "./controller.js";
export type {
  DictationControllerInput,
  DictationFinish,
  DictationNotice,
  DictationPhase,
  DictationSnapshot,
  DictationTarget,
  DictationView,
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
