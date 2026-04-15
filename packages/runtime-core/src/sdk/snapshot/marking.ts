import type { BrowserCoreEngine, FrameRef, PageRef } from "@opensteer/browser-core";

import {
  INTERACTIVE_ROLE_TOKENS,
  INTERACTIVE_SELECTOR,
  NON_NEGATIVE_TAB_INDEX_MIN,
  OPENSTEER_HIDDEN_ATTR,
  OPENSTEER_INTERACTIVE_ATTR,
  OPENSTEER_SCROLLABLE_ATTR,
  OPENSTEER_SELF_HIDDEN_ATTR,
} from "./constants.js";

const MARK_SNAPSHOT_SEMANTICS_SCRIPT = `({
  hiddenAttr,
  selfHiddenAttr,
  interactiveAttr,
  scrollableAttr,
  interactiveSelector,
  interactiveRoles,
  nonNegativeTabIndexMin,
}) => {
  const interactiveRolesSet = new Set(interactiveRoles);

  function isSubtreeHidden(el, style) {
    if (el.hasAttribute("hidden")) {
      return true;
    }
    if (el.tagName === "INPUT" && String(el.getAttribute("type") || "").toLowerCase() === "hidden") {
      return true;
    }
    if (style.display === "none") {
      return true;
    }
    const opacity = Number.parseFloat(style.opacity);
    return Number.isFinite(opacity) && opacity <= 0;
  }

  function hasVisibleOutOfFlowChild(el) {
    const children = el.children;
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index];
      const childStyle = window.getComputedStyle(child);
      if (childStyle.position !== "fixed" && childStyle.position !== "absolute") {
        continue;
      }
      const childRect = child.getBoundingClientRect();
      if (childRect.width > 0 && childRect.height > 0) {
        return true;
      }
    }
    return false;
  }

  function isSelfHidden(el, style) {
    if (style.visibility === "hidden" || style.visibility === "collapse") {
      return true;
    }
    if (style.display === "contents") {
      return false;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      return false;
    }
    return !hasVisibleOutOfFlowChild(el);
  }

  function hasInteractiveTabIndex(el) {
    const value = el.getAttribute("tabindex");
    if (value == null) {
      return false;
    }
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed >= nonNegativeTabIndexMin;
  }

  const roots = [document];
  while (roots.length > 0) {
    const root = roots.pop();
    if (!root) {
      continue;
    }

    const elements = Array.from(root.querySelectorAll("*"));
    for (const el of elements) {
      el.removeAttribute(hiddenAttr);
      el.removeAttribute(selfHiddenAttr);
      el.removeAttribute(interactiveAttr);
      el.removeAttribute(scrollableAttr);

      const style = window.getComputedStyle(el);
      const subtreeHidden = isSubtreeHidden(el, style);
      const selfHidden = !subtreeHidden && isSelfHidden(el, style);
      if (subtreeHidden) {
        el.setAttribute(hiddenAttr, "1");
      } else if (selfHidden) {
        el.setAttribute(selfHiddenAttr, "1");
      } else {
        let interactive = false;
        if (el.matches(interactiveSelector)) {
          interactive = true;
        } else if (hasInteractiveTabIndex(el)) {
          interactive = true;
        } else {
          const role = (el.getAttribute("role") || "").toLowerCase();
          if (interactiveRolesSet.has(role)) {
            interactive = true;
          }
        }

        if (interactive) {
          el.setAttribute(interactiveAttr, "1");
        }

        const canScrollY =
          (style.overflowY === "auto" || style.overflowY === "scroll") &&
          el.scrollHeight > el.clientHeight + 1;
        const canScrollX =
          (style.overflowX === "auto" || style.overflowX === "scroll") &&
          el.scrollWidth > el.clientWidth + 1;

        let scrollDirection = null;
        if (canScrollX && canScrollY) {
          scrollDirection = "xy";
        } else if (canScrollX) {
          scrollDirection = "x";
        } else if (canScrollY) {
          scrollDirection = "y";
        } else {
          const inferredY = el.scrollHeight > el.clientHeight + 5;
          const inferredX = el.scrollWidth > el.clientWidth + 5;
          if (inferredX && inferredY) {
            scrollDirection = "xy";
          } else if (inferredX) {
            scrollDirection = "x";
          } else if (inferredY) {
            scrollDirection = "y";
          }
        }

        if (scrollDirection) {
          el.setAttribute(scrollableAttr, scrollDirection);
        } else {
          el.removeAttribute(scrollableAttr);
        }
      }

      if (el.shadowRoot) {
        roots.push(el.shadowRoot);
      }
    }
  }

  return true;
}`;

const CLEAR_SNAPSHOT_SEMANTICS_SCRIPT = `({
  hiddenAttr,
  selfHiddenAttr,
  interactiveAttr,
  scrollableAttr,
}) => {
  const roots = [document];
  while (roots.length > 0) {
    const root = roots.pop();
    if (!root) {
      continue;
    }

    const elements = Array.from(root.querySelectorAll("*"));
    for (const el of elements) {
      el.removeAttribute(hiddenAttr);
      el.removeAttribute(selfHiddenAttr);
      el.removeAttribute(interactiveAttr);
      el.removeAttribute(scrollableAttr);
      if (el.shadowRoot) {
        roots.push(el.shadowRoot);
      }
    }
  }

  return true;
}`;

const SNAPSHOT_SEMANTIC_ARGS = [
  {
    hiddenAttr: OPENSTEER_HIDDEN_ATTR,
    selfHiddenAttr: OPENSTEER_SELF_HIDDEN_ATTR,
    interactiveAttr: OPENSTEER_INTERACTIVE_ATTR,
    scrollableAttr: OPENSTEER_SCROLLABLE_ATTR,
    interactiveSelector: INTERACTIVE_SELECTOR,
    interactiveRoles: [...INTERACTIVE_ROLE_TOKENS],
    nonNegativeTabIndexMin: NON_NEGATIVE_TAB_INDEX_MIN,
  },
] as const;

const CLEAR_SNAPSHOT_SEMANTIC_ARGS = [
  {
    hiddenAttr: OPENSTEER_HIDDEN_ATTR,
    selfHiddenAttr: OPENSTEER_SELF_HIDDEN_ATTR,
    interactiveAttr: OPENSTEER_INTERACTIVE_ATTR,
    scrollableAttr: OPENSTEER_SCROLLABLE_ATTR,
  },
] as const;

async function evaluateFrameBestEffort(
  engine: BrowserCoreEngine,
  frameRef: FrameRef,
  script: string,
  args: readonly unknown[],
): Promise<void> {
  try {
    await engine.evaluateFrame({
      frameRef,
      script,
      args,
    });
  } catch {
    // Best effort: frames may detach or navigate while marking semantics.
  }
}

export async function markLiveSnapshotSemantics(options: {
  readonly engine: BrowserCoreEngine;
  readonly pageRef: PageRef;
}): Promise<() => Promise<void>> {
  const frames = await options.engine.listFrames({
    pageRef: options.pageRef,
  });

  await Promise.all(
    frames.map((frame) =>
      evaluateFrameBestEffort(
        options.engine,
        frame.frameRef,
        MARK_SNAPSHOT_SEMANTICS_SCRIPT,
        SNAPSHOT_SEMANTIC_ARGS,
      ),
    ),
  );

  return async () => {
    await Promise.all(
      frames.map((frame) =>
        evaluateFrameBestEffort(
          options.engine,
          frame.frameRef,
          CLEAR_SNAPSHOT_SEMANTICS_SCRIPT,
          CLEAR_SNAPSHOT_SEMANTIC_ARGS,
        ),
      ),
    );
  };
}
