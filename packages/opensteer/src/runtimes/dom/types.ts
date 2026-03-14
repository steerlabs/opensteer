import type {
  BrowserCoreEngine,
  DocumentEpoch,
  DocumentRef,
  FrameRef,
  KeyModifier,
  MouseButton,
  NodeLocator,
  NodeRef,
  PageRef,
  Point,
  DomSnapshot,
  DomSnapshotNode,
} from "@opensteer/browser-core";

import type { TimeoutExecutionContext } from "../../policy/index.js";

export type MatchOperator = "exact" | "startsWith" | "contains";

export interface AttributeMatchClause {
  readonly kind: "attr";
  readonly key: string;
  readonly op?: MatchOperator;
  readonly value?: string;
}

export interface PositionMatchClause {
  readonly kind: "position";
  readonly axis: "nthOfType" | "nthChild";
}

export type MatchClause = AttributeMatchClause | PositionMatchClause;

export interface PathNodePosition {
  readonly nthChild: number;
  readonly nthOfType: number;
}

export interface PathNode {
  readonly tag: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly position: PathNodePosition;
  readonly match: readonly MatchClause[];
}

export type DomPath = readonly PathNode[];

export interface ContextHop {
  readonly kind: "iframe" | "shadow";
  readonly host: DomPath;
}

export interface ElementPath {
  readonly context: readonly ContextHop[];
  readonly nodes: DomPath;
}

export interface DomDescriptorPayload {
  readonly kind: "dom-target";
  readonly method: string;
  readonly description: string;
  readonly path: ElementPath;
  readonly sourceUrl?: string;
}

export interface DomDescriptorRecord {
  readonly id: string;
  readonly key: string;
  readonly version: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly payload: DomDescriptorPayload;
}

export interface DescriptorTargetRef {
  readonly kind: "descriptor";
  readonly description: string;
}

export interface LiveTargetRef {
  readonly kind: "live";
  readonly locator: NodeLocator;
  readonly description?: string;
}

export interface PathTargetRef {
  readonly kind: "path";
  readonly path: ElementPath;
  readonly description?: string;
}

export interface SelectorTargetRef {
  readonly kind: "selector";
  readonly selector: string;
  readonly description?: string;
  readonly frameRef?: FrameRef;
  readonly documentRef?: DocumentRef;
}

export type DomTargetRef = DescriptorTargetRef | LiveTargetRef | PathTargetRef | SelectorTargetRef;

export interface ResolvedDomTarget {
  readonly source: "descriptor" | "live" | "path" | "selector";
  readonly pageRef: PageRef;
  readonly frameRef: FrameRef;
  readonly documentRef: DocumentRef;
  readonly documentEpoch: DocumentEpoch;
  readonly nodeRef: NodeRef;
  readonly locator: NodeLocator;
  readonly snapshot: DomSnapshot;
  readonly node: DomSnapshotNode;
  readonly path: ElementPath;
  readonly description?: string;
  readonly selectorUsed?: string;
  readonly descriptor?: DomDescriptorRecord;
}

export interface DomBuildPathInput {
  readonly locator: NodeLocator;
}

export interface DomResolveTargetInput {
  readonly pageRef: PageRef;
  readonly method: string;
  readonly target: DomTargetRef;
}

export interface DomWriteDescriptorInput {
  readonly method: string;
  readonly description: string;
  readonly path: ElementPath;
  readonly sourceUrl?: string;
  readonly createdAt?: number;
  readonly updatedAt?: number;
}

export interface DomReadDescriptorInput {
  readonly description: string;
}

export interface DomActionOutcome {
  readonly resolved: ResolvedDomTarget;
  readonly point: Point;
}

export interface DomClickInput {
  readonly pageRef: PageRef;
  readonly target: DomTargetRef;
  readonly button?: MouseButton;
  readonly clickCount?: number;
  readonly modifiers?: readonly KeyModifier[];
  readonly position?: Point;
  readonly timeout?: TimeoutExecutionContext;
}

export interface DomHoverInput {
  readonly pageRef: PageRef;
  readonly target: DomTargetRef;
  readonly position?: Point;
  readonly timeout?: TimeoutExecutionContext;
}

export interface DomInputInput {
  readonly pageRef: PageRef;
  readonly target: DomTargetRef;
  readonly text: string;
  readonly pressEnter?: boolean;
  readonly timeout?: TimeoutExecutionContext;
}

export interface DomScrollInput {
  readonly pageRef: PageRef;
  readonly target: DomTargetRef;
  readonly delta: Point;
  readonly position?: Point;
  readonly timeout?: TimeoutExecutionContext;
}

export interface DomExtractFieldSelector {
  readonly key: string;
  readonly target?: DomTargetRef;
  readonly attribute?: string;
  readonly source?: "current_url";
}

export interface DomExtractFieldsInput {
  readonly pageRef: PageRef;
  readonly fields: readonly DomExtractFieldSelector[];
}

export interface DomArrayFieldSelector {
  readonly key: string;
  readonly path?: ElementPath;
  readonly attribute?: string;
  readonly source?: "current_url";
}

export interface DomArraySelector {
  readonly itemParentPath: ElementPath;
  readonly fields: readonly DomArrayFieldSelector[];
}

export interface DomExtractArrayRowsInput {
  readonly pageRef: PageRef;
  readonly array: DomArraySelector;
}

export interface DomArrayRowMetadata {
  readonly key: string;
  readonly order: number;
}

export interface DomExtractedArrayRow {
  readonly values: Readonly<Record<string, string | null>>;
  readonly meta: DomArrayRowMetadata;
}

export interface DomRuntime {
  readonly engine: BrowserCoreEngine;

  buildPath(input: DomBuildPathInput): Promise<ElementPath>;
  resolveTarget(input: DomResolveTargetInput): Promise<ResolvedDomTarget>;
  writeDescriptor(input: DomWriteDescriptorInput): Promise<DomDescriptorRecord>;
  readDescriptor(input: DomReadDescriptorInput): Promise<DomDescriptorRecord | undefined>;
  click(input: DomClickInput): Promise<DomActionOutcome>;
  hover(input: DomHoverInput): Promise<DomActionOutcome>;
  input(input: DomInputInput): Promise<ResolvedDomTarget>;
  scroll(input: DomScrollInput): Promise<DomActionOutcome>;
  extractFields(input: DomExtractFieldsInput): Promise<Readonly<Record<string, string | null>>>;
  extractArrayRows(input: DomExtractArrayRowsInput): Promise<readonly DomExtractedArrayRow[]>;
}
