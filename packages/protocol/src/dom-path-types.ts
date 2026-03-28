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

export interface ContextHop {
  readonly kind: "iframe" | "shadow";
  readonly host: readonly PathNode[];
}

interface ElementRouteBase {
  readonly context: readonly ContextHop[];
  readonly nodes: readonly PathNode[];
}

export interface StructuralElementAnchor extends ElementRouteBase {
  readonly resolution: "structural";
}

export interface ReplayElementPath extends ElementRouteBase {
  readonly resolution: "deterministic";
}
