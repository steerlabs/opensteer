export interface Person {
  readonly skin: string;
  readonly hair: string;
  /** Hair silhouette: short, long, bun, crop (close cut) or wavy. */
  readonly cut: "short" | "long" | "bun" | "crop" | "wavy";
  readonly top: string;
  /** Soft studio backdrop, two colors from light to dark. */
  readonly bg: readonly [string, string];
  readonly beard?: boolean;
}

const HAIR_BACK: Record<Person["cut"], string> = {
  short: "",
  crop: "",
  bun: "M43 24a7 7 0 1 0 14 0 7 7 0 1 0-14 0Z",
  long: "M33 44c-3-17 4-28 17-28s20 11 17 28c-1 13 2 24 7 34-9 4-39 4-48 0 5-10 8-21 7-34Z",
  wavy: "M32 46c-4-19 4-30 18-30s22 11 18 30c2 9 6 16 4 24-8 4-14 3-18 0H46c-4 3-10 4-18 0-2-8 2-15 4-24Z",
};

const HAIR_FRONT: Record<Person["cut"], string> = {
  short: "M35 42c-2-14 4-22 15-22 12 0 18 8 15 22-2-6-5-9-10-10-6 3-13 5-20 10Z",
  crop: "M36 40c0-10 6-16 14-16s14 6 14 16c-3-4-8-6-14-6s-11 2-14 6Z",
  bun: "M35 43c-1-14 5-22 15-22s16 8 15 22c-4-8-9-11-15-11s-11 3-15 11Z",
  long: "M34 45c-1-15 6-24 16-24 11 0 17 9 16 24-4-9-10-13-18-12-6 1-10 5-14 12Z",
  wavy: "M33 45c-1-15 7-25 17-25s18 10 17 25c-3-6-7-9-11-10-2 3-5 4-9 4-6 0-10 2-14 6Z",
};

/** A small studio-style portrait of a fictional person: backdrop, shoulders, face and hair, softly lit. */
export function face(person: Person, className: string): string {
  const { skin, hair, cut, top, bg, beard } = person;
  return `<span class="${className}" style="position:relative;overflow:hidden;background:radial-gradient(110% 90% at 32% 22%, ${bg[0]}, ${bg[1]})"><svg viewBox="0 0 100 100" aria-hidden="true" style="display:block;width:100%;height:100%"><g transform="translate(-12 -17) scale(1.24)">
<path d="${HAIR_BACK[cut]}" fill="${hair}"/>
<path d="M2 104c1-14 10-22 26-25l10-3h24l10 3c16 3 25 11 26 25Z" fill="${top}"/>
<path d="M38 76 50 96 62 76c-3-1-8-1-12-1s-9 0-12 1Z" fill="#000" opacity=".22"/>
<path d="M2 104c1-14 10-22 26-25l10-3 2 4c-14 4-22 12-26 24Z" fill="#fff" opacity=".08"/>
<path d="M43 58h14v16c-3 5-11 5-14 0Z" fill="${skin}"/>
<path d="M43 62c4 4 10 4 14 0v7c-4 3-10 3-14 0Z" fill="#000" opacity=".18"/>
<ellipse cx="35.6" cy="45.5" rx="2.6" ry="4.2" fill="${skin}"/>
<ellipse cx="64.4" cy="45.5" rx="2.6" ry="4.2" fill="${skin}"/>
<ellipse cx="50" cy="43" rx="14.6" ry="18.5" fill="${skin}"/>
<path d="M56 26c7 4 9 12 8.5 19-.6 9-5 15-12 17 7.5-6 9-21 3.5-36Z" fill="#000" opacity=".12"/>
<ellipse cx="44" cy="38" rx="6" ry="8" fill="#fff" opacity=".07"/>
${beard ? `<path d="M36 46c1 10 7 16.5 14 16.5S63 56 64 46c-2 4-4 7-7 8-2-1.5-4.5-1.6-7-1.6s-5 .1-7 1.6c-3-1-5-4-7-8Z" fill="${hair}" opacity=".7"/>` : ""}
<path d="${HAIR_FRONT[cut]}" fill="${hair}"/>
<path d="M41 39.6c1.6-.8 3.8-.9 5.4-.2M53.6 39.4c1.6-.7 3.8-.6 5.4.2" fill="none" stroke="${hair}" stroke-width="1.2" stroke-linecap="round" opacity=".55"/>
<ellipse cx="44" cy="43.5" rx="1.5" ry="1" fill="#2a1d18" opacity=".7"/>
<ellipse cx="56" cy="43.5" rx="1.5" ry="1" fill="#2a1d18" opacity=".7"/>
<path d="M50.5 45c-.3 3-1 5-1.8 6.2 1 .6 2.4.6 3.4.1" fill="none" stroke="#000" stroke-width=".9" stroke-linecap="round" opacity=".14"/>
<path d="M46 55.2c2.6 1.2 5.4 1.2 8 0-1.2 1.6-2.6 2.2-4 2.2s-2.8-.6-4-2.2Z" fill="#8a4a3e" opacity=".45"/>
</g></svg><i style="position:absolute;inset:0;background:radial-gradient(80% 60% at 30% 20%, rgb(255 255 255 / 20%), transparent 65%), linear-gradient(transparent 55%, rgb(0 0 0 / 16%))"></i></span>`;
}

/** The fictional people who appear across the demo's apps. */
export const PEOPLE = {
  priya: {
    skin: "#b98262",
    hair: "#231713",
    cut: "long",
    top: "#2f4858",
    bg: ["#dfe7ec", "#8ea4b2"],
  },
  alex: {
    skin: "#d6a88a",
    hair: "#4a3328",
    cut: "short",
    top: "#3b4a5c",
    bg: ["#ece4da", "#a99886"],
    beard: true,
  },
  maya: {
    skin: "#e8bfa3",
    hair: "#1c1a1a",
    cut: "bun",
    top: "#7d5a8c",
    bg: ["#f1e6ef", "#b39ab0"],
  },
  sam: {
    skin: "#7a4e36",
    hair: "#151110",
    cut: "crop",
    top: "#2e6b55",
    bg: ["#e2ece5", "#86a596"],
  },
  marcus: {
    skin: "#a9714f",
    hair: "#1d1512",
    cut: "crop",
    top: "#e9e6e1",
    bg: ["#dde3e8", "#7f8f9c"],
    beard: true,
  },
  nadia: {
    skin: "#c99577",
    hair: "#3a2219",
    cut: "wavy",
    top: "#8d3f4f",
    bg: ["#f0e6dc", "#b49a84"],
  },
  tomas: {
    skin: "#d9a27f",
    hair: "#2b2019",
    cut: "short",
    top: "#25364d",
    bg: ["#e5e9ee", "#93a0b1"],
  },
  jordan: {
    skin: "#efc9ae",
    hair: "#a0683d",
    cut: "short",
    top: "#4f6d7a",
    bg: ["#e9eef0", "#9fb3bb"],
  },
} as const satisfies Record<string, Person>;
