export type RecordedActionKind =
  | "navigate"
  | "click"
  | "dblclick"
  | "type"
  | "keypress"
  | "scroll"
  | "select-option"
  | "new-tab"
  | "close-tab"
  | "switch-tab"
  | "go-back"
  | "go-forward"
  | "reload";

export interface NavigateRecordedActionDetail {
  readonly kind: "navigate";
  readonly url: string;
  readonly source:
    | "poll"
    | "push-state"
    | "replace-state"
    | "hashchange"
    | "history-traversal"
    | "full-navigation";
}

export interface ClickRecordedActionDetail {
  readonly kind: "click";
  readonly button: number;
  readonly modifiers: readonly string[];
}

export interface DblclickRecordedActionDetail {
  readonly kind: "dblclick";
}

export interface TypeRecordedActionDetail {
  readonly kind: "type";
  readonly text: string;
}

export interface KeypressRecordedActionDetail {
  readonly kind: "keypress";
  readonly key: string;
  readonly modifiers: readonly string[];
}

export interface ScrollRecordedActionDetail {
  readonly kind: "scroll";
  readonly deltaX: number;
  readonly deltaY: number;
}

export interface SelectOptionRecordedActionDetail {
  readonly kind: "select-option";
  readonly value: string;
  readonly label?: string;
}

export interface NewTabRecordedActionDetail {
  readonly kind: "new-tab";
  readonly openerPageId?: string;
  readonly initialUrl: string;
}

export interface CloseTabRecordedActionDetail {
  readonly kind: "close-tab";
}

export interface SwitchTabRecordedActionDetail {
  readonly kind: "switch-tab";
  readonly fromPageId?: string;
  readonly toPageId: string;
}

export interface GoBackRecordedActionDetail {
  readonly kind: "go-back";
  readonly url: string;
}

export interface GoForwardRecordedActionDetail {
  readonly kind: "go-forward";
  readonly url: string;
}

export interface ReloadRecordedActionDetail {
  readonly kind: "reload";
  readonly url: string;
}

export type RecordedActionDetail =
  | NavigateRecordedActionDetail
  | ClickRecordedActionDetail
  | DblclickRecordedActionDetail
  | TypeRecordedActionDetail
  | KeypressRecordedActionDetail
  | ScrollRecordedActionDetail
  | SelectOptionRecordedActionDetail
  | NewTabRecordedActionDetail
  | CloseTabRecordedActionDetail
  | SwitchTabRecordedActionDetail
  | GoBackRecordedActionDetail
  | GoForwardRecordedActionDetail
  | ReloadRecordedActionDetail;

interface RecordedActionBase<
  TKind extends RecordedActionKind,
  TDetail extends RecordedActionDetail,
> {
  readonly kind: TKind;
  readonly timestamp: number;
  readonly pageId: string;
  readonly pageUrl: string;
  readonly selector?: string;
  readonly detail: TDetail;
}

export type NavigateRecordedAction = RecordedActionBase<"navigate", NavigateRecordedActionDetail>;
export type ClickRecordedAction = RecordedActionBase<"click", ClickRecordedActionDetail>;
export type DblclickRecordedAction = RecordedActionBase<"dblclick", DblclickRecordedActionDetail>;
export type TypeRecordedAction = RecordedActionBase<"type", TypeRecordedActionDetail>;
export type KeypressRecordedAction = RecordedActionBase<"keypress", KeypressRecordedActionDetail>;
export type ScrollRecordedAction = RecordedActionBase<"scroll", ScrollRecordedActionDetail>;
export type SelectOptionRecordedAction = RecordedActionBase<
  "select-option",
  SelectOptionRecordedActionDetail
>;
export type NewTabRecordedAction = RecordedActionBase<"new-tab", NewTabRecordedActionDetail>;
export type CloseTabRecordedAction = RecordedActionBase<"close-tab", CloseTabRecordedActionDetail>;
export type SwitchTabRecordedAction = RecordedActionBase<"switch-tab", SwitchTabRecordedActionDetail>;
export type GoBackRecordedAction = RecordedActionBase<"go-back", GoBackRecordedActionDetail>;
export type GoForwardRecordedAction = RecordedActionBase<
  "go-forward",
  GoForwardRecordedActionDetail
>;
export type ReloadRecordedAction = RecordedActionBase<"reload", ReloadRecordedActionDetail>;

export type RecordedAction =
  | NavigateRecordedAction
  | ClickRecordedAction
  | DblclickRecordedAction
  | TypeRecordedAction
  | KeypressRecordedAction
  | ScrollRecordedAction
  | SelectOptionRecordedAction
  | NewTabRecordedAction
  | CloseTabRecordedAction
  | SwitchTabRecordedAction
  | GoBackRecordedAction
  | GoForwardRecordedAction
  | ReloadRecordedAction;

export interface RecordingOptions {
  readonly workspace: string;
  readonly outputPath?: string;
  readonly url: string;
  readonly pollIntervalMs?: number;
}

export interface CodegenOptions {
  readonly actions: readonly RecordedAction[];
  readonly workspace: string;
  readonly startUrl: string;
}

export interface RecorderPageState {
  readonly pageId: string;
  readonly pageRef: string;
  readonly openerPageRef?: string;
  readonly openerPageId?: string;
  readonly currentUrl: string;
}

export interface FlowRecorderSnapshot {
  readonly url: string;
  readonly focused: boolean;
  readonly visibilityState: "hidden" | "visible" | "prerender";
  readonly events: readonly RawFlowRecorderEvent[];
}

export interface RawFlowRecorderBaseEvent {
  readonly timestamp: number;
  readonly selector?: string;
}

export interface RawFlowRecorderNavigateEvent extends RawFlowRecorderBaseEvent {
  readonly kind: "navigate";
  readonly url: string;
  readonly source:
    | "push-state"
    | "replace-state"
    | "hashchange"
    | "history-traversal"
    | "full-navigation";
}

export interface RawFlowRecorderClickEvent extends RawFlowRecorderBaseEvent {
  readonly kind: "click";
  readonly selector: string;
  readonly button: number;
  readonly modifiers: readonly string[];
}

export interface RawFlowRecorderDblclickEvent extends RawFlowRecorderBaseEvent {
  readonly kind: "dblclick";
  readonly selector: string;
}

export interface RawFlowRecorderTypeEvent extends RawFlowRecorderBaseEvent {
  readonly kind: "type";
  readonly selector: string;
  readonly text: string;
}

export interface RawFlowRecorderKeypressEvent extends RawFlowRecorderBaseEvent {
  readonly kind: "keypress";
  readonly key: string;
  readonly modifiers: readonly string[];
  readonly selector?: string;
}

export interface RawFlowRecorderScrollEvent extends RawFlowRecorderBaseEvent {
  readonly kind: "scroll";
  readonly deltaX: number;
  readonly deltaY: number;
  readonly selector?: string;
}

export interface RawFlowRecorderSelectOptionEvent extends RawFlowRecorderBaseEvent {
  readonly kind: "select-option";
  readonly selector: string;
  readonly value: string;
  readonly label?: string;
}

export interface RawFlowRecorderReloadEvent extends RawFlowRecorderBaseEvent {
  readonly kind: "reload";
  readonly url: string;
}

export interface RawFlowRecorderGoBackEvent extends RawFlowRecorderBaseEvent {
  readonly kind: "go-back";
  readonly url: string;
}

export interface RawFlowRecorderGoForwardEvent extends RawFlowRecorderBaseEvent {
  readonly kind: "go-forward";
  readonly url: string;
}

export type RawFlowRecorderEvent =
  | RawFlowRecorderNavigateEvent
  | RawFlowRecorderClickEvent
  | RawFlowRecorderDblclickEvent
  | RawFlowRecorderTypeEvent
  | RawFlowRecorderKeypressEvent
  | RawFlowRecorderScrollEvent
  | RawFlowRecorderSelectOptionEvent
  | RawFlowRecorderReloadEvent
  | RawFlowRecorderGoBackEvent
  | RawFlowRecorderGoForwardEvent;
