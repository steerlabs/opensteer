/** Which side of the sidebar's switch shows: the person's own tasks, or one team by its id. */
export type SidebarSide = "tasks" | (string & {});

/**
 * The side that shows, and the team last shown. That team keeps its name in
 * the switch while the person is on Tasks, so coming back finds it where it was.
 */
export interface SidebarSides {
  readonly side: SidebarSide;
  readonly recent: string | null;
}

export function chooseSide(sides: SidebarSides, side: SidebarSide): SidebarSides {
  return { side, recent: side === "tasks" ? sides.recent : side };
}

/**
 * The team that owns the named segment: the one showing, else the one last
 * shown, else the first. Null only when the person is in no team.
 */
export function recentTeam(sides: SidebarSides, teamIds: readonly string[]): string | null {
  for (const candidate of [sides.side, sides.recent])
    if (candidate !== null && candidate !== "tasks" && teamIds.includes(candidate))
      return candidate;
  return teamIds[0] ?? null;
}

/** One client's measures for the switch, in its own units. */
export interface SideSwitchMetrics {
  /** Inside the track's edge, on each side. */
  readonly padding: number;
  readonly gap: number;
  /** A team drawn as its mark alone, and the segment that folds the rest. */
  readonly mark: number;
  /** The least the recent team needs to say part of its name as well. */
  readonly named: number;
}

export interface SideSwitchSegment {
  /** A side, or `moreTeamsKey` for the segment holding the folded teams. */
  readonly key: SidebarSide;
  readonly x: number;
  readonly width: number;
}

export interface SideSwitchLayout {
  /** Tasks, the teams drawn in their joined order, then `moreTeamsKey` when any folded. */
  readonly segments: readonly SideSwitchSegment[];
  readonly folded: readonly string[];
  /** The recent team says its name; otherwise it is its mark and the name is said beneath. */
  readonly named: boolean;
}

/** The folded teams' segment; no team id takes this form. */
export const moreTeamsKey = ":more";

/**
 * Tasks keeps its own width, and every other team is its mark. The recent team
 * takes what is left, saying its name when that is enough, so moving between
 * Tasks and a team moves no segment. When even the marks don't fit, the teams
 * after what fits fold into one last segment; Tasks and the recent team stay
 * drawn, and every team keeps its joined order. Narrower than Tasks, the
 * recent team and that segment, every team folds into it, so none is ever out
 * of reach. Unmeasured (a width of 0), nothing folds and the recent team is named.
 */
export function sideSwitchLayout(
  input: {
    readonly teamIds: readonly string[];
    readonly recent: string | null;
    /** The track's whole width. */
    readonly width: number;
    /** What Tasks takes: its label and its count. */
    readonly tasks: number;
  },
  metrics: SideSwitchMetrics,
): SideSwitchLayout {
  const { teamIds, width, tasks } = input;
  const recent = input.recent !== null && teamIds.includes(input.recent) ? input.recent : null;
  const { gap, mark, padding } = metrics;
  const inner = width - padding * 2;
  const others = teamIds.filter((id) => id !== recent);
  // Room left for the recent team once Tasks and `marks` other segments are drawn.
  const left = (marks: number) =>
    inner - tasks - (marks + (recent === null ? 0 : 1)) * gap - marks * mark;
  let shown = others;
  let drawsRecent = recent !== null;
  if (width > 0 && recent !== null && left(others.length) < mark) {
    // One mark's place goes to the folded teams' segment.
    let fit = 0;
    while (fit < others.length - 1 && left(fit + 2) >= mark) fit += 1;
    shown = others.slice(0, fit);
    drawsRecent = left(1) >= mark;
  }
  const kept = new Set<string>([...shown, ...(drawsRecent && recent !== null ? [recent] : [])]);
  const folded = teamIds.filter((id) => !kept.has(id));
  const recentWidth = Math.max(mark, left(shown.length + (folded.length > 0 ? 1 : 0)));
  const named = width <= 0 || (drawsRecent && recentWidth >= metrics.named);
  const segments: SideSwitchSegment[] = [];
  let x = padding;
  const place = (key: SidebarSide, span: number) => {
    segments.push({ key, x, width: span });
    x += span + gap;
  };
  place("tasks", tasks);
  for (const id of teamIds) if (kept.has(id)) place(id, id === recent ? recentWidth : mark);
  if (folded.length > 0) place(moreTeamsKey, mark);
  return { segments, folded, named };
}
