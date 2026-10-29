import type { ChannelBinding, ChannelRouteSelector, RouteCandidate } from "./models.js";

const selectorKeys = ["scopeId", "conversationId", "threadId", "conversationType"] as const;

export function routeSpecificity(selector: ChannelRouteSelector): number {
  return selectorKeys.reduce((score, key) => score + (selector[key] === null ? 0 : 1), 0);
}

export function selectorMatches(
  selector: ChannelRouteSelector,
  candidate: RouteCandidate,
): boolean {
  return selectorKeys.every((key) => selector[key] === null || selector[key] === candidate[key]);
}

function selectorsCanOverlap(left: ChannelRouteSelector, right: ChannelRouteSelector): boolean {
  return selectorKeys.every(
    (key) => left[key] === null || right[key] === null || left[key] === right[key],
  );
}

export function resolveChannelBinding(
  bindings: readonly ChannelBinding[],
  candidate: RouteCandidate,
): ChannelBinding | null {
  const matches = bindings
    .filter(
      (binding) => binding.status === "active" && selectorMatches(binding.selector, candidate),
    )
    .map((binding) => ({ binding, specificity: routeSpecificity(binding.selector) }))
    // `map` already produced a fresh array. `sort` rather than `toSorted`
    // because this package is client-reachable and Hermes has no
    // change-by-copy array methods.
    .sort((left, right) => right.specificity - left.specificity);
  const first = matches[0];
  if (!first) return null;
  if (matches[1]?.specificity === first.specificity) {
    throw new Error("Channel route is ambiguous at equal specificity");
  }
  return first.binding;
}

export function assertUnambiguousBinding(
  candidate: Pick<ChannelBinding, "id" | "selector" | "status">,
  existing: readonly Pick<ChannelBinding, "id" | "selector" | "status">[],
): void {
  if (candidate.status !== "active") return;
  const score = routeSpecificity(candidate.selector);
  const conflict = existing.find(
    (binding) =>
      binding.id !== candidate.id &&
      binding.status === "active" &&
      routeSpecificity(binding.selector) === score &&
      selectorsCanOverlap(binding.selector, candidate.selector),
  );
  if (conflict) {
    throw new Error(`Channel route conflicts with ${conflict.id} at equal specificity`);
  }
}
