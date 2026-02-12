export type MatchOperator = 'exact' | 'startsWith' | 'contains'

export interface AttributeMatchClause {
    kind: 'attr'
    key: string
    op?: MatchOperator
    value?: string
}

export interface PositionMatchClause {
    kind: 'position'
    axis: 'nthOfType' | 'nthChild'
}

export type MatchClause = AttributeMatchClause | PositionMatchClause

export interface PathNodePosition {
    nthChild: number
    nthOfType: number
}

export interface PathNode {
    tag: string
    attrs: Record<string, string>
    position: PathNodePosition
    match: MatchClause[]
}

export type DomPath = PathNode[]

export interface ContextHop {
    kind: 'iframe' | 'shadow'
    host: DomPath
}

export interface ElementPath {
    context: ContextHop[]
    nodes: DomPath
}
