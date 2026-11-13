import type { ReactNode } from "react";

/**
 * A control of ours that a screen puts in its native navigation bar.
 *
 * Only iOS needs anything here (see `bar-control.ios.tsx`); elsewhere the bar
 * has no gesture of its own to compete with the control's tap.
 */
export function BarControl(props: { readonly children: ReactNode }): ReactNode {
  return props.children;
}
