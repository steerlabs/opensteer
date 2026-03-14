export type {
  AnchorTargetRef,
  ContextHop,
  DomActionOutcome,
  DomArrayFieldSelector,
  DomArrayRowMetadata,
  DomArraySelector,
  DomBuildPathInput,
  DomClickInput,
  DomDescriptorPayload,
  DomDescriptorRecord,
  DomExtractArrayRowsInput,
  DomExtractFieldSelector,
  DomExtractFieldsInput,
  DomExtractedArrayRow,
  DomHoverInput,
  DomInputInput,
  DomPath,
  DomReadDescriptorInput,
  DomResolveTargetInput,
  DomRuntime,
  DomScrollInput,
  DomTargetRef,
  DomWriteDescriptorInput,
  ElementPath,
  MatchClause,
  PathNode,
  ReplayElementPath,
  ResolvedDomTarget,
  StructuralElementAnchor,
} from "./types.js";
export {
  buildArrayFieldPathCandidates,
  isCurrentUrlField,
  normalizeExtractedValue,
  resolveExtractedValueInContext,
} from "./extraction.js";
export { ElementPathError } from "./errors.js";
export {
  buildPathCandidates,
  buildSegmentSelector,
} from "./match-selectors.js";
export {
  DEFERRED_MATCH_ATTR_KEYS,
  MATCH_ATTRIBUTE_PRIORITY,
  STABLE_PRIMARY_ATTR_KEYS,
  buildLocalClausePool,
  isValidCssAttributeKey,
  shouldKeepAttributeForPath,
} from "./match-policy.js";
export {
  buildPathSelectorHint,
  cloneElementPath,
  cloneReplayElementPath,
  cloneStructuralElementAnchor,
  sanitizeElementPath,
  sanitizeReplayElementPath,
  sanitizeStructuralElementAnchor,
} from "./path.js";
export { createDomRuntime } from "./runtime.js";
