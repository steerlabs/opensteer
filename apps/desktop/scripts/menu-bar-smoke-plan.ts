/** The menu bar smoke's trials: what each needs and how the driver moves it along. */
export const menuBarSmokeTrials = [
  "popover-phases",
  "home-stop",
  "quit-logout",
  "quit-sigterm",
  "early-quit",
  "dock",
] as const;
export type MenuBarSmokeTrial = (typeof menuBarSmokeTrials)[number];

/** `unverified`: the guest lacked what the trial needs; never counted as a pass. */
export type MenuBarTrialOutcome = "pass" | "fail" | "unverified";

export interface MenuBarTrialPlan {
  readonly trial: MenuBarSmokeTrial;
  /** Starts this Mac's own Home from the Personal runtime resources. */
  readonly needsHome: boolean;
  /**
   * `self`: the trial checks itself and exits. `quit-during-startup`: the
   * driver presses Cmd+Q once it is starting. `quit-question`: the driver
   * opens Quit Completely's question, then logs out or sends SIGTERM.
   */
  readonly drive: "self" | "quit-during-startup" | "quit-question";
}

const plans: Readonly<Record<MenuBarSmokeTrial, Omit<MenuBarTrialPlan, "trial">>> = {
  "popover-phases": { needsHome: false, drive: "self" },
  "home-stop": { needsHome: true, drive: "self" },
  "quit-logout": { needsHome: false, drive: "quit-question" },
  "quit-sigterm": { needsHome: false, drive: "quit-question" },
  "early-quit": { needsHome: false, drive: "quit-during-startup" },
  dock: { needsHome: false, drive: "self" },
};

/** Every trial in order, or the named ones; an unknown name is refused. */
export function menuBarSmokeTrialPlan(names: readonly string[]): MenuBarTrialPlan[] {
  for (const name of names)
    if (!menuBarSmokeTrials.some((trial) => trial === name))
      throw new Error(`Unknown menu bar smoke trial: ${name}`);
  return menuBarSmokeTrials
    .filter((trial) => names.length === 0 || names.includes(trial))
    .map((trial) => ({ trial, ...plans[trial] }));
}

/**
 * The electron journey's acceptance: every trial passed, except that the real
 * helper trial may be unverified in a guest without its grants, and says so.
 */
export function menuBarSmokeAccepted(
  results: readonly { readonly trial: string; readonly outcome: MenuBarTrialOutcome }[],
): boolean {
  return (
    menuBarSmokeTrials.every((trial) => results.some((row) => row.trial === trial)) &&
    results.every((row) => row.outcome === "pass")
  );
}
