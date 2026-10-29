/**
 * Opensteer's accent and reading surfaces, with platform system typography.
 * Native controls retain their own spacing and materials. Shared content uses
 * these roles so Dynamic Type and Android font scaling grow it coherently.
 */

/**
 * The accent and its ink, named before the palette, so the roles that *are*
 * the accent cannot drift from it when one of them is edited.
 */
const ember = "#e6beb0";
const inkOnEmber = "#1b120e";

export const color = {
  background: "#080808",
  surface: "#101010",
  surfaceElevated: "#171717",
  surfaceRaised: "#1d1d1d",
  surfacePressed: "#242424",
  surfaceCode: "#0d0d0d",
  /**
   * The ground an assistant turn's own furniture stands on — a collapsed
   * activity row, a step hanging off its hairline. A single step above the
   * page, so it reads as attached to the turn rather than drawn on the
   * screen. The assistant's prose itself takes no ground at all: it is the
   * reading surface, and a bubble around long markdown narrows it for nothing.
   */
  assistantSurface: "#151515",

  text: "#f5f4f2",
  textSoft: "#cecbc7",
  muted: "#8e8a86",
  mutedDim: "#898581",

  line: "rgba(255, 255, 255, 0.07)",
  lineStrong: "rgba(255, 255, 255, 0.12)",
  lineHover: "rgba(255, 255, 255, 0.18)",
  /**
   * The boundary of something that can be pressed or typed into. It resolves
   * to 3:1 against the ground — the floor a control's edge has to clear to be
   * seen at all in daylight or with low contrast sensitivity — and it is drawn
   * at a full point, because a third of a point of any tint is not an edge on a
   * near-black screen. Separators inside a group keep the hairline: they divide,
   * they do not need to be found.
   */
  lineControl: "rgba(255, 255, 255, 0.34)",

  ember,
  emberBright: "#f1cabe",
  /** The web's `--ember-dim`: the ember pulled back toward muted, for a label
   * that names an author rather than offering an action. */
  emberDim: "#c7aca1",
  emberWash: "rgba(230, 190, 176, 0.11)",
  emberLine: "rgba(230, 190, 176, 0.22)",
  inkOnEmber,

  /**
   * A person's own message in a transcript. It is the accent because the one
   * thing a person scanning a long thread looks for is what they asked, and a
   * filled capsule of the accent is the only mark on the screen that finds
   * itself. The ink is the accent's own, so the bubble needs no second colour.
   */
  bubble: ember,
  bubbleInk: inkOnEmber,

  green: "#71c6a5",
  amber: "#dfb36b",
  /** Words on an amber fill: the count of questions waiting on the reader. */
  inkOnAmber: "#1a1408",
  red: "#e77e76",
  blue: "#84b5e0",

  greenWash: "rgba(113, 198, 165, 0.09)",
  redWash: "rgba(231, 126, 118, 0.09)",
  redLine: "rgba(231, 126, 118, 0.34)",
  amberWash: "rgba(223, 179, 107, 0.07)",
  amberLine: "rgba(223, 179, 107, 0.32)",
} as const;

/** The web's even 2px rhythm through 24px, then 4px steps. */
export const space = {
  2: 2,
  4: 4,
  6: 6,
  8: 8,
  10: 10,
  12: 12,
  14: 14,
  16: 16,
  18: 18,
  20: 20,
  22: 22,
  24: 24,
  28: 28,
  32: 32,
  40: 40,
  48: 48,
  56: 56,
  64: 64,
} as const;

export const radius = {
  xs: 6,
  sm: 9,
  md: 12,
  lg: 16,
  /** A chat bubble: the largest radius that still reads as a rectangle. */
  xl: 20,
  /** A floating card or sheet header, where the corner carries the elevation. */
  xxl: 24,
  full: 999,
} as const;

/** Omitting fontFamily lets iOS and Android use their own system typefaces. */
export const type = {
  displayLarge: { fontWeight: "700", fontSize: 28, lineHeight: 34 },
  displaySmall: { fontWeight: "600", fontSize: 22, lineHeight: 28 },
  title: { fontWeight: "600", fontSize: 17, lineHeight: 23 },
  body: { fontWeight: "400", fontSize: 17, lineHeight: 24 },
  bodyMedium: { fontWeight: "500", fontSize: 17, lineHeight: 24 },
  secondary: { fontWeight: "400", fontSize: 15, lineHeight: 21 },
  secondaryMedium: { fontWeight: "500", fontSize: 15, lineHeight: 21 },
  caption: { fontWeight: "400", fontSize: 13, lineHeight: 18 },
  action: { fontWeight: "600", fontSize: 17, lineHeight: 24 },
} as const;

/** The smallest a control may be, in points, whatever it contains. */
export const touchTarget = 44;

/**
 * The height of a docked bar at rest — the composer's capsule, a floating
 * toolbar. It equals `touchTarget` because the bar *is* the control at that
 * moment, and it is named separately because it grows: the composer's field
 * takes more lines and its pills appear, and what must not change is the
 * height it returns to.
 */
export const barHeight = 44;

/**
 * A pill inside a bar: the model chip, the access chip, a workspace filter.
 * Below the touch target on purpose — a pill is a passenger in a bar that is
 * already 44 points tall, so the row gives it the hit area its own height does
 * not, through `hitSlop` rather than through padding that would swell the bar.
 */
export const pillHeight = 32;

/** The width of a control's edge: see `color.lineControl`. */
export const controlBorderWidth = 1;

/**
 * How far Dynamic Type may grow text inside a fixed-height control before the
 * control would clip it. Body text carries no cap at all.
 */
export const controlFontScaleLimit = 1.6;

/**
 * The same limit for the navigation bar, which is tighter still.
 *
 * The system's own bar does not grow its title at all, and its left and right
 * slots are a fixed width: past this, an action's label is cut rather than
 * wrapped. Native header items use the platform's own sizing instead.
 */
export const headerFontScaleLimit = 1.2;

/**
 * A Deployment's independent identity palette, kept apart from task and specialist marks.
 */
export const deploymentPaint = {
  violet: { fill: "#342d3e", ink: "#cfc4dd" },
  emerald: { fill: "#243831", ink: "#a7d6c3" },
  amber: { fill: "#453627", ink: "#e2c79c" },
  sky: { fill: "#2a3945", ink: "#b0cde3" },
  rose: { fill: "#412d32", ink: "#e0b3bd" },
  teal: { fill: "#233c3b", ink: "#a2d3d1" },
} as const;

export type DeploymentTone = keyof typeof deploymentPaint;
