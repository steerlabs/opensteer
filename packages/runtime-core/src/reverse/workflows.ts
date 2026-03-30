import type {
  OpensteerExecutableResolver,
  OpensteerReverseAdvisoryTemplate,
  OpensteerReverseCandidateRecord,
  OpensteerReverseConstraintKind,
  OpensteerReverseGuardRecord,
  OpensteerReverseManualCalibrationMode,
  OpensteerReverseObservationRecord,
  OpensteerReversePackageKind,
  OpensteerReversePackageReadiness,
  OpensteerReversePackageRequirements,
  OpensteerReverseRequirement,
  OpensteerReverseSuggestedEdit,
  OpensteerReverseWorkflowStep,
  OpensteerStateSourceKind,
  OpensteerValueReference,
  OpensteerValueTemplate,
  OpensteerValidationRule,
} from "@opensteer/protocol";

export function buildReversePackageWorkflow(input: {
  readonly candidate: OpensteerReverseCandidateRecord;
  readonly template?: OpensteerReverseAdvisoryTemplate;
  readonly observation?: OpensteerReverseObservationRecord;
  readonly guards: readonly OpensteerReverseGuardRecord[];
  readonly validators: readonly OpensteerValidationRule[];
  readonly executeStepInput?: OpensteerValueTemplate;
}): readonly OpensteerReverseWorkflowStep[] {
  if (input.template === undefined && input.executeStepInput === undefined) {
    return [];
  }

  const steps: OpensteerReverseWorkflowStep[] = [];
  if (input.template?.execution === "page-observation" && input.observation?.url !== undefined) {
    steps.push({
      id: `workflow:goto:${input.candidate.id}`,
      kind: "operation",
      label: `Open ${input.observation.url}`,
      operation: "page.goto",
      input: { url: input.observation.url },
    });
  }

  for (const guardId of input.template?.guardIds ?? input.candidate.guardIds) {
    const guard = input.guards.find((entry) => entry.id === guardId);
    if (guard?.interactionTraceId === undefined) {
      continue;
    }
    steps.push({
      id: `workflow:guard:${guard.id}`,
      kind: "operation",
      label: guard.label,
      operation: "interaction.replay",
      input: {
        traceId: guard.interactionTraceId,
        pageRef: runtimeValueRef("pageRef"),
      },
      bindAs: `trace:${guard.id}`,
    });
  }

  if (input.template?.execution === "page-observation") {
    steps.push({
      id: `workflow:await:${input.candidate.id}`,
      kind: "await-record",
      label: `Wait for ${input.candidate.channel.url}`,
      channel: input.candidate.channel,
      recordId: input.candidate.recordId,
      validationRuleIds: input.validators.map((validator) => validator.id),
      bindAs: "observed-record",
    });
  } else if (input.executeStepInput !== undefined) {
    steps.push({
      id: `workflow:execute:${input.candidate.id}`,
      kind: "operation",
      label: `Execute ${input.candidate.channel.kind} replay`,
      operation: "request.raw",
      input: input.executeStepInput,
      bindAs: "channel-response",
    });
  }

  steps.push({
    id: `workflow:assert:${input.candidate.id}`,
    kind: "assert",
    label: "Validate replay result against captured success",
    validationRuleIds: input.validators.map((validator) => validator.id),
    binding:
      input.template?.execution === "page-observation" ? "observed-record" : "channel-response",
  });

  return steps;
}

export function buildReversePackageRequirements(input: {
  readonly stateSource: OpensteerStateSourceKind;
  readonly template?: OpensteerReverseAdvisoryTemplate;
  readonly candidate?: OpensteerReverseCandidateRecord;
  readonly manualCalibration?: OpensteerReverseManualCalibrationMode;
}): OpensteerReversePackageRequirements {
  const stateSources = dedupeStateSources([
    input.stateSource,
    ...(input.template === undefined ? [] : [input.template.stateSource]),
  ]);
  return {
    requiresBrowser:
      input.template?.requiresBrowser ??
      (input.candidate?.guardIds.length !== 0 ||
        input.candidate?.resolvers.some((resolver) => resolver.requiresBrowser) === true),
    requiresLiveState:
      input.template?.requiresLiveState ??
      input.candidate?.resolvers.some((resolver) => resolver.requiresLiveState) === true,
    manualCalibration: classifyManualCalibrationRequirement(
      input.candidate,
      input.manualCalibration,
    ),
    stateSources,
  };
}

export function deriveReversePackageKind(input: {
  readonly candidate?: OpensteerReverseCandidateRecord;
  readonly template?: OpensteerReverseAdvisoryTemplate;
  readonly workflow?: readonly OpensteerReverseWorkflowStep[];
  readonly resolvers?: readonly OpensteerExecutableResolver[];
  readonly stateSnapshots?: readonly { readonly id: string }[];
}): OpensteerReversePackageKind {
  if (input.template?.execution === "page-observation") {
    return "browser-workflow";
  }
  if (workflowUsesBrowser(input.workflow ?? [])) {
    return "browser-workflow";
  }
  if ((input.resolvers ?? []).some((resolver) => resolver.requiresBrowser)) {
    return "browser-workflow";
  }
  if (
    (input.stateSnapshots?.length ?? 0) > 0 &&
    input.candidate !== undefined &&
    !isPortableCandidate(input.candidate)
  ) {
    return "browser-workflow";
  }
  return input.candidate !== undefined && isPortableCandidate(input.candidate)
    ? "portable-http"
    : "browser-workflow";
}

export function deriveReversePackageUnresolvedRequirements(input: {
  readonly candidate?: OpensteerReverseCandidateRecord;
  readonly template?: OpensteerReverseAdvisoryTemplate;
  readonly workflow: readonly OpensteerReverseWorkflowStep[];
  readonly resolvers: readonly OpensteerExecutableResolver[];
  readonly guards: readonly OpensteerReverseGuardRecord[];
  readonly stateSource: OpensteerStateSourceKind;
}): readonly OpensteerReverseRequirement[] {
  const requirements: OpensteerReverseRequirement[] = [];
  if (input.candidate === undefined) {
    requirements.push({
      id: "requirement:no-candidate",
      kind: "unsupported",
      status: "required",
      label: "No replay candidate was selected",
      description: "Pick a captured candidate request before replay can be edited or executed.",
      blocking: true,
    });
    return requirements;
  }

  if (input.candidate.constraints.includes("unsupported")) {
    requirements.push({
      id: `requirement:unsupported:${input.candidate.id}`,
      kind: "unsupported",
      status: "required",
      label: "Candidate is outside the supported reverse-engineering scope",
      description:
        "This candidate was classified as blocked or opaque and cannot be replayed directly.",
      blocking: true,
      recordId: input.candidate.recordId,
    });
  }

  if (input.template !== undefined) {
    if (input.template.viability === "unsupported") {
      requirements.push({
        id: `requirement:template:${input.template.id}`,
        kind: "unsupported",
        status: "required",
        label: input.template.notes ?? "Template is unsupported as generated",
        ...(input.template.notes === undefined ? {} : { description: input.template.notes }),
        blocking: true,
        recordId: input.candidate.recordId,
      });
    } else if (input.template.viability === "draft") {
      requirements.push({
        id: `requirement:template:${input.template.id}`,
        kind: "workflow-step",
        status: "recommended",
        label: input.template.notes ?? "Template needs agent edits before replay",
        ...(input.template.notes === undefined ? {} : { description: input.template.notes }),
        blocking: false,
        recordId: input.candidate.recordId,
      });
    }
  }

  if (input.workflow.length === 0) {
    requirements.push({
      id: `requirement:workflow:${input.candidate.id}`,
      kind: "workflow-step",
      status: "required",
      label: "Package workflow is empty",
      description: "Add package steps before replay can run.",
      blocking: true,
      recordId: input.candidate.recordId,
    });
  }

  const referencedResolverIds = collectReferencedResolverIds(input.workflow);
  const requiredResolverIds =
    input.template === undefined
      ? new Set(referencedResolverIds)
      : new Set(input.template.resolverIds);
  for (const resolver of input.resolvers) {
    if (input.template !== undefined && !requiredResolverIds.has(resolver.id)) {
      continue;
    }
    if (
      input.template === undefined &&
      requiredResolverIds.size > 0 &&
      !requiredResolverIds.has(resolver.id)
    ) {
      continue;
    }
    if (resolver.status === "ready") {
      continue;
    }
    const artifactId = extractResolverArtifactId(resolver);
    const recordId = extractResolverRecordId(resolver);
    requirements.push({
      id: `requirement:resolver:${resolver.id}`,
      kind: "resolver",
      status: "required",
      label: resolver.label,
      description:
        resolver.description ?? "Provide a resolver value or binding before replay can run.",
      blocking: true,
      resolverId: resolver.id,
      ...(resolver.inputNames === undefined ? {} : { inputNames: resolver.inputNames }),
      ...(resolver.traceId === undefined ? {} : { traceId: resolver.traceId }),
      ...(artifactId === undefined ? {} : { artifactId }),
      ...(recordId === undefined ? {} : { recordId }),
    });
  }

  const requiredGuardIds = new Set(input.template?.guardIds ?? input.candidate.guardIds);
  for (const guardId of requiredGuardIds) {
    const guard = input.guards.find((entry) => entry.id === guardId);
    if (guard?.status === "satisfied") {
      continue;
    }
    requirements.push({
      id: `requirement:guard:${guardId}`,
      kind: "guard",
      status: "required",
      label: guard?.label ?? `Unresolved guard ${guardId}`,
      description:
        guard?.notes ??
        "Attach a successful unlock trace or author package steps that satisfy this guard.",
      blocking: true,
      guardId,
      ...(guard?.interactionTraceId === undefined ? {} : { traceId: guard.interactionTraceId }),
    });
  }

  if (input.template?.requiresLiveState === true && input.stateSource !== "attach") {
    requirements.push({
      id: `requirement:state:${input.candidate.id}`,
      kind: "state",
      status: "recommended",
      label: "Live browser state may still be required",
      description:
        "Template expects live state. Consider using attach mode or patching the package to reacquire the state.",
      blocking: false,
      recordId: input.candidate.recordId,
    });
  }

  return dedupeRequirements(requirements);
}

export function deriveReversePackageReadiness(input: {
  readonly kind: OpensteerReversePackageKind;
  readonly unresolvedRequirements: readonly OpensteerReverseRequirement[];
}): OpensteerReversePackageReadiness {
  if (input.unresolvedRequirements.some((requirement) => requirement.kind === "unsupported")) {
    return "unsupported";
  }
  if (input.unresolvedRequirements.some((requirement) => requirement.blocking)) {
    return "draft";
  }
  return "runnable";
}

export function buildReversePackageSuggestedEdits(
  unresolvedRequirements: readonly OpensteerReverseRequirement[],
): readonly OpensteerReverseSuggestedEdit[] {
  const suggestions = unresolvedRequirements.map((requirement) => {
    switch (requirement.kind) {
      case "resolver":
        return {
          id: `suggestion:${requirement.id}`,
          kind: "set-resolver",
          label: `Patch resolver ${requirement.resolverId ?? requirement.label}`,
          ...(requirement.description === undefined
            ? {}
            : { description: requirement.description }),
          ...(requirement.resolverId === undefined ? {} : { resolverId: requirement.resolverId }),
          ...(requirement.traceId === undefined ? {} : { traceId: requirement.traceId }),
          ...(requirement.artifactId === undefined ? {} : { artifactId: requirement.artifactId }),
          ...(requirement.recordId === undefined ? {} : { recordId: requirement.recordId }),
        } satisfies OpensteerReverseSuggestedEdit;
      case "guard":
        return {
          id: `suggestion:${requirement.id}`,
          kind: "attach-trace",
          label: `Attach a trace for ${requirement.guardId ?? requirement.label}`,
          ...(requirement.description === undefined
            ? {}
            : { description: requirement.description }),
          ...(requirement.guardId === undefined ? {} : { guardId: requirement.guardId }),
          ...(requirement.traceId === undefined ? {} : { traceId: requirement.traceId }),
        } satisfies OpensteerReverseSuggestedEdit;
      case "workflow-step":
        return {
          id: `suggestion:${requirement.id}`,
          kind: "replace-workflow",
          label: "Patch the package workflow",
          ...(requirement.description === undefined
            ? {}
            : { description: requirement.description }),
          ...(requirement.stepId === undefined ? {} : { stepId: requirement.stepId }),
        } satisfies OpensteerReverseSuggestedEdit;
      case "state":
        return {
          id: `suggestion:${requirement.id}`,
          kind: "switch-state-source",
          label: "Switch replay to live state or add reacquisition steps",
          ...(requirement.description === undefined
            ? {}
            : { description: requirement.description }),
          ...(requirement.recordId === undefined ? {} : { recordId: requirement.recordId }),
        } satisfies OpensteerReverseSuggestedEdit;
      case "unsupported":
        return {
          id: `suggestion:${requirement.id}`,
          kind: "mark-unsupported",
          label: "Mark this package unsupported or choose another candidate",
          ...(requirement.description === undefined
            ? {}
            : { description: requirement.description }),
          ...(requirement.recordId === undefined ? {} : { recordId: requirement.recordId }),
        } satisfies OpensteerReverseSuggestedEdit;
      default:
        return {
          id: `suggestion:${requirement.id}`,
          kind: "inspect-evidence",
          label: "Inspect linked reverse-engineering evidence",
          ...(requirement.description === undefined
            ? {}
            : { description: requirement.description }),
          ...(requirement.traceId === undefined ? {} : { traceId: requirement.traceId }),
          ...(requirement.artifactId === undefined ? {} : { artifactId: requirement.artifactId }),
          ...(requirement.recordId === undefined ? {} : { recordId: requirement.recordId }),
        } satisfies OpensteerReverseSuggestedEdit;
    }
  });
  return dedupeSuggestedEdits(suggestions);
}

export function cloneReversePackageResolvers(
  resolvers: readonly OpensteerExecutableResolver[],
): readonly OpensteerExecutableResolver[] {
  return resolvers.map((resolver) => ({
    ...resolver,
    ...(resolver.inputNames === undefined ? {} : { inputNames: [...resolver.inputNames] }),
    ...(resolver.valueRef === undefined
      ? {}
      : { valueRef: cloneValueReference(resolver.valueRef) }),
  }));
}

function classifyManualCalibrationRequirement(
  candidate: OpensteerReverseCandidateRecord | undefined,
  manualCalibration: OpensteerReverseManualCalibrationMode | undefined,
): OpensteerReversePackageRequirements["manualCalibration"] {
  if (manualCalibration === "require") {
    return "required";
  }
  if (candidate?.constraints.includes("requires-guard")) {
    return manualCalibration === "avoid" ? "recommended" : "required";
  }
  if (
    candidate?.constraints.includes("requires-live-state") ||
    candidate?.constraints.includes("requires-script")
  ) {
    return "recommended";
  }
  return "not-needed";
}

function dedupeStateSources(
  stateSources: readonly OpensteerStateSourceKind[],
): readonly OpensteerStateSourceKind[] {
  return [...new Set(stateSources)];
}

function collectReferencedResolverIds(
  workflow: readonly OpensteerReverseWorkflowStep[],
): ReadonlySet<string> {
  const resolverIds = new Set<string>();
  for (const step of workflow) {
    if (step.kind !== "operation") {
      continue;
    }
    visitResolverReferences(step.input, resolverIds);
  }
  return resolverIds;
}

function visitResolverReferences(value: unknown, resolverIds: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      visitResolverReferences(entry, resolverIds);
    }
    return;
  }
  if (value === null || typeof value !== "object") {
    return;
  }
  const ref =
    "$ref" in (value as Record<string, unknown>) &&
    (value as { readonly $ref?: unknown }).$ref !== undefined &&
    (value as { readonly $ref?: unknown }).$ref !== null &&
    typeof (value as { readonly $ref?: unknown }).$ref === "object"
      ? ((value as { readonly $ref: unknown }).$ref as Record<string, unknown>)
      : undefined;
  const referencedResolverId =
    ref?.kind === "resolver" && typeof ref.resolverId === "string" ? ref.resolverId : undefined;
  if (referencedResolverId !== undefined) {
    resolverIds.add(referencedResolverId);
  }
  for (const entry of Object.values(value as Record<string, unknown>)) {
    visitResolverReferences(entry, resolverIds);
  }
}

function runtimeValueRef(
  runtimeKey: NonNullable<OpensteerValueReference["runtimeKey"]>,
): OpensteerValueTemplate {
  return {
    $ref: {
      kind: "runtime",
      runtimeKey,
    },
  };
}

function workflowUsesBrowser(workflow: readonly OpensteerReverseWorkflowStep[]): boolean {
  return workflow.some((step) => {
    if (step.kind === "await-record") {
      return true;
    }
    if (step.kind !== "operation") {
      return false;
    }
    return (
      step.operation.startsWith("page.") ||
      step.operation.startsWith("dom.") ||
      step.operation.startsWith("interaction.") ||
      step.operation === "computer.execute" ||
      step.operation === "captcha.solve"
    );
  });
}

function isPortableCandidate(candidate: OpensteerReverseCandidateRecord): boolean {
  return (
    !candidate.constraints.includes("requires-browser") &&
    !candidate.constraints.includes("requires-cookie") &&
    !candidate.constraints.includes("requires-storage") &&
    !candidate.constraints.includes("requires-script") &&
    !candidate.constraints.includes("requires-guard") &&
    !candidate.constraints.includes("requires-live-state") &&
    !candidate.constraints.includes("unsupported")
  );
}

function extractResolverArtifactId(resolver: OpensteerExecutableResolver): string | undefined {
  return resolver.valueRef?.kind === "artifact" ? resolver.valueRef.artifactId : undefined;
}

function extractResolverRecordId(resolver: OpensteerExecutableResolver): string | undefined {
  return resolver.valueRef?.kind === "record" ? resolver.valueRef.recordId : undefined;
}

function cloneValueReference(valueRef: OpensteerValueReference): OpensteerValueReference {
  return {
    ...valueRef,
    ...(valueRef.value === undefined ? {} : { value: valueRef.value }),
  };
}

function dedupeRequirements(
  requirements: readonly OpensteerReverseRequirement[],
): readonly OpensteerReverseRequirement[] {
  return [...new Map(requirements.map((requirement) => [requirement.id, requirement])).values()];
}

function dedupeSuggestedEdits(
  suggestions: readonly OpensteerReverseSuggestedEdit[],
): readonly OpensteerReverseSuggestedEdit[] {
  return [...new Map(suggestions.map((suggestion) => [suggestion.id, suggestion])).values()];
}
