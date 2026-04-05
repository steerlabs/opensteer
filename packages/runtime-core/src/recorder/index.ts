export type {
  ClickRecordedActionDetail,
  CodegenOptions,
  CloseTabRecordedActionDetail,
  DblclickRecordedActionDetail,
  FlowRecorderSnapshot,
  GoBackRecordedActionDetail,
  GoForwardRecordedActionDetail,
  KeypressRecordedActionDetail,
  NavigateRecordedActionDetail,
  NewTabRecordedActionDetail,
  RawFlowRecorderClickEvent,
  RawFlowRecorderDblclickEvent,
  RawFlowRecorderEvent,
  RawFlowRecorderGoBackEvent,
  RawFlowRecorderGoForwardEvent,
  RawFlowRecorderKeypressEvent,
  RawFlowRecorderNavigateEvent,
  RawFlowRecorderReloadEvent,
  RawFlowRecorderScrollEvent,
  RawFlowRecorderSelectOptionEvent,
  RawFlowRecorderTypeEvent,
  RecordedAction,
  RecordedActionDetail,
  RecordedActionKind,
  RecorderPageState,
  RecordingOptions,
  ReloadRecordedActionDetail,
  ScrollRecordedActionDetail,
  SelectOptionRecordedActionDetail,
  SwitchTabRecordedActionDetail,
  TypeRecordedActionDetail,
} from "./types.js";
export {
  FLOW_RECORDER_DRAIN_SCRIPT,
  FLOW_RECORDER_INSTALL_SCRIPT,
} from "./browser-scripts.js";
export { FlowRecorderCollector } from "./event-collector.js";
export type {
  FlowRecorderCollectorOptions,
  RecorderRuntimeAdapter,
} from "./event-collector.js";
export { generateReplayScript } from "./codegen.js";
