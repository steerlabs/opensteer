/*
 * The phones a frames test lays a screen out on. The smallest is the narrowest phone the app
 * supports, which no simulator in the walk's VM offers: a frames test is the only check it has.
 * iPhone Duo is the inner screen the walk measured, its vertical bar standing at the right.
 * Text sizes run from the default to the largest the walk's simulator reported (3.571).
 */
export interface LayoutPhone {
  readonly name: string;
  readonly window: { readonly height: number; readonly width: number };
  /** The navigation bar's height over the screen, as `useHeaderHeight` reports it. */
  readonly header: number;
  readonly insets: {
    readonly bottom: number;
    readonly left: number;
    readonly right: number;
    readonly top: number;
  };
}

export const layoutPhones: readonly LayoutPhone[] = [
  {
    name: "the smallest phone",
    window: { height: 568, width: 320 },
    header: 64,
    insets: { bottom: 0, left: 0, right: 0, top: 20 },
  },
  {
    name: "iPhone Duo beside its vertical bar",
    window: { height: 678, width: 466 },
    header: 72,
    insets: { bottom: 20, left: 0, right: 84, top: 0 },
  },
];

/** The default text size and the largest one the app is read at. */
export const layoutTextSizes = [1, 3.571] as const;
