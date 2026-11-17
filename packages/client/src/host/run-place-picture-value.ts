export interface RunPlacePicture {
  readonly placeKey: string | null;
  readonly usable: boolean;
  readonly fresh: boolean;
  readonly aspect: number | null;
}

export type RunPlacePictureReport =
  | { readonly kind: "drawn"; readonly width: number; readonly height: number }
  | { readonly kind: "cleared" };

export const emptyRunPlacePicture: RunPlacePicture = {
  placeKey: null,
  usable: false,
  fresh: false,
  aspect: null,
};
