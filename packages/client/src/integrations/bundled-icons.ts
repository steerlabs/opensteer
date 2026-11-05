/** Local assets keep plugin browsing private and work offline on every client. */
export const bundledIntegrationIconIds = [
  "apple-messages",
  "apple-contacts",
  "apple-photos",
  "apple-notes",
  "apple-reminders",
  "apple-calendar",
  "google-docs",
  "google-drive",
  "google-gmail",
  "google-calendar",
  "google-sheets",
  "google-slides",
  "google-forms",
  "axiom",
  "browserbase",
  "context7",
  "exa",
  "firecrawl",
  "microsoft",
  "monday",
  "openai",
  "twilio",
  "val-town",
  "figma",
  "slack",
  "google-contacts",
  "gitlab",
  "posthog",
  "cloudflare",
  "neon",
  "asana",
  "microsoft-outlook",
  "microsoft-teams",
  "microsoft-todo",
  "microsoft-onedrive",
  "microsoft-onenote",
  "deepwiki",
] as const;

export type BundledIntegrationIconId = (typeof bundledIntegrationIconIds)[number];

export function bundledIntegrationIcon(definitionId: string): BundledIntegrationIconId | null {
  return Object.hasOwn(artworkOf, definitionId) ? (artworkOf[definitionId] ?? null) : null;
}

/** Full app tiles and inset logos share local assets; vector marks and generic capabilities stay small. */
export type IntegrationMark =
  | { readonly kind: "art"; readonly art: BundledIntegrationIconId }
  | { readonly kind: "logo"; readonly art: BundledIntegrationIconId }
  | { readonly kind: "brand"; readonly color: string; readonly d: string }
  | { readonly kind: "glyph"; readonly color: string; readonly d: string };

export function integrationMark(definitionId: string): IntegrationMark | null {
  const art = bundledIntegrationIcon(definitionId);
  if (art) return { kind: art.startsWith("apple-") ? "art" : "logo", art };
  const glyph = Object.hasOwn(deviceGlyphs, definitionId) ? deviceGlyphs[definitionId] : null;
  if (glyph) return { kind: "glyph", ...glyph };
  const brand = Object.hasOwn(brandOf, definitionId) ? brandOf[definitionId] : null;
  return brand ? { kind: "brand", ...brands[brand] } : null;
}

const artworkOf: Readonly<Record<string, BundledIntegrationIconId>> = {
  "apple-messages": "apple-messages",
  "apple-contacts": "apple-contacts",
  "apple-photos": "apple-photos",
  "apple-notes": "apple-notes",
  "apple-reminders": "apple-reminders",
  "apple-calendar": "apple-calendar",
  imessage: "apple-messages",
  "iphone-photos": "apple-photos",
  "google-docs": "google-docs",
  "google-drive": "google-drive",
  "google-gmail": "google-gmail",
  "google-calendar": "google-calendar",
  "google-sheets": "google-sheets",
  "google-slides": "google-slides",
  "google-forms": "google-forms",
  axiom: "axiom",
  browserbase: "browserbase",
  context7: "context7",
  exa: "exa",
  firecrawl: "firecrawl",
  microsoft: "microsoft",
  monday: "monday",
  openai: "openai",
  twilio: "twilio",
  "val-town": "val-town",
  "microsoft-outlook": "microsoft-outlook",
  "microsoft-teams": "microsoft-teams",
  "microsoft-todo": "microsoft-todo",
  "microsoft-onedrive": "microsoft-onedrive",
  "microsoft-onenote": "microsoft-onenote",
  deepwiki: "deepwiki",
  "axiom-mcp": "axiom",
  "browserbase-mcp": "browserbase",
  "context7-mcp": "context7",
  "deepwiki-mcp": "deepwiki",
  "exa-rest": "exa",
  "exa-websets-rest": "exa",
  "firecrawl-rest": "firecrawl",
  "microsoft-profile": "microsoft",
  "monday-graphql": "monday",
  "openai-rest": "openai",
  "twilio-rest": "twilio",
  "val-town-rest": "val-town",
  "microsoft-outlook-mail": "microsoft-outlook",
  "microsoft-outlook-calendar": "microsoft-outlook",
  "microsoft-contacts": "microsoft-outlook",
  "microsoft-teams-chat": "microsoft-teams",
  figma: "figma",
  slack: "slack",
  "google-contacts": "google-contacts",
  gitlab: "gitlab",
  posthog: "posthog",
  cloudflare: "cloudflare",
  neon: "neon",
  asana: "asana",
  "figma-rest": "figma",
  "google-people": "google-contacts",
  "gitlab-graphql": "gitlab",
  "posthog-rest": "posthog",
  "cloudflare-mcp": "cloudflare",
  "neon-mcp": "neon",
  "neon-rest": "neon",
  "asana-rest": "asana",
};

/** Stroked, round-capped glyphs for the apps on a person's own devices. */
const glyphs = {
  computer: {
    color: "#1C1C1E",
    d: "M3.5 6a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2ZM8.5 20.5h7M12 16.5v4",
  },
  location: {
    color: "#007AFF",
    d: "M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11ZM14.25 10a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Z",
  },
} as const satisfies Readonly<Record<string, { readonly color: string; readonly d: string }>>;

const deviceGlyphs: Readonly<Record<string, { readonly color: string; readonly d: string }>> = {
  "apple-location": glyphs.location,
  "computer-use": glyphs.computer,
  "iphone-location": glyphs.location,
  "macos-app": glyphs.computer,
};

/** Which brand each catalog definition wears; a product's variants share one. */
const brandOf: Readonly<Record<string, keyof typeof brands>> = {
  "android-phone": "android",
  "anilist-graphql": "anilist",
  "digitalocean-rest": "digitalocean",
  discord: "discord",
  github: "github",
  "github-graphql": "github",
  "google-tasks": "googletasks",
  linear: "linear",
  "linear-mcp": "linear",
  notion: "notion",
  "notion-mcp": "notion",
  resend: "resend",
  "sentry-mcp": "sentry",
  "sentry-rest": "sentry",
  "spotify-rest": "spotify",
  "stripe-mcp": "stripe",
  "stripe-rest": "stripe",
  "vercel-rest": "vercel",
};

/*
 * Brand marks from Simple Icons 16.36.0 (CC0; https://simpleicons.org), in
 * each brand's colour from that release. Android's robot is CC BY 3.0 by
 * Google. Bundled full-colour assets and their provenance live beside the client assets.
 */
const brands = {
  android: {
    color: "#3DDC84",
    d: "M18.4395 5.5586c-.675 1.1664-1.352 2.3318-2.0274 3.498-.0366-.0155-.0742-.0286-.1113-.043-1.8249-.6957-3.484-.8-4.42-.787-1.8551.0185-3.3544.4643-4.2597.8203-.084-.1494-1.7526-3.021-2.0215-3.4864a1.1451 1.1451 0 0 0-.1406-.1914c-.3312-.364-.9054-.4859-1.379-.203-.475.282-.7136.9361-.3886 1.5019 1.9466 3.3696-.0966-.2158 1.9473 3.3593.0172.031-.4946.2642-1.3926 1.0177C2.8987 12.176.452 14.772 0 18.9902h24c-.119-1.1108-.3686-2.099-.7461-3.0683-.7438-1.9118-1.8435-3.2928-2.7402-4.1836a12.1048 12.1048 0 0 0-2.1309-1.6875c.6594-1.122 1.312-2.2559 1.9649-3.3848.2077-.3615.1886-.7956-.0079-1.1191a1.1001 1.1001 0 0 0-.8515-.5332c-.5225-.0536-.9392.3128-1.0488.5449zm-.0391 8.461c.3944.5926.324 1.3306-.1563 1.6503-.4799.3197-1.188.0985-1.582-.4941-.3944-.5927-.324-1.3307.1563-1.6504.4727-.315 1.1812-.1086 1.582.4941zM7.207 13.5273c.4803.3197.5506 1.0577.1563 1.6504-.394.5926-1.1038.8138-1.584.4941-.48-.3197-.5503-1.0577-.1563-1.6504.4008-.6021 1.1087-.8106 1.584-.4941z",
  },
  anilist: {
    color: "#02A9FF",
    d: "M24 17.53v2.421c0 .71-.391 1.101-1.1 1.101h-5l-.057-.165L11.84 3.736c.106-.502.46-.788 1.053-.788h2.422c.71 0 1.1.391 1.1 1.1v12.38H22.9c.71 0 1.1.392 1.1 1.101zM11.034 2.947l6.337 18.104h-4.918l-1.052-3.131H6.019l-1.077 3.131H0L6.361 2.948h4.673zm-.66 10.96-1.69-5.014-1.541 5.015h3.23z",
  },
  digitalocean: {
    color: "#0080FF",
    d: "M12.04 0C5.408-.02.005 5.37.005 11.992h4.638c0-4.923 4.882-8.731 10.064-6.855a6.95 6.95 0 014.147 4.148c1.889 5.177-1.924 10.055-6.84 10.064v-4.61H7.391v4.623h4.61V24c7.86 0 13.967-7.588 11.397-15.83-1.115-3.59-3.985-6.446-7.575-7.575A12.8 12.8 0 0012.039 0zM7.39 19.362H3.828v3.564H7.39zm-3.563 0v-2.978H.85v2.978z",
  },
  discord: {
    color: "#5865F2",
    d: "M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z",
  },
  github: {
    color: "#181717",
    d: "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12",
  },
  googletasks: {
    color: "#2684FC",
    d: "M11.383.617C5.097.617 0 5.714 0 12c0 6.286 5.097 11.383 11.383 11.383 6.286 0 11.38-5.097 11.38-11.383a11.34 11.34 0 0 0-.878-4.389l-3.203 3.203c.062.387.1.782.1 1.186a7.398 7.398 0 1 1-7.4-7.398c1.499 0 2.889.448 4.054 1.214l2.857-2.857a11.325 11.325 0 0 0-6.91-2.342zm9.674.756c-.292 0-.583.112-.805.334-2.97 2.965-5.934 5.934-8.9 8.902L9.596 8.854a1.139 1.139 0 0 0-1.61 0l-1.775 1.773a1.139 1.139 0 0 0 0 1.61l4.166 4.163a1.421 1.421 0 0 0 2.012 0L23.666 5.121a1.136 1.136 0 0 0 0-1.61l-1.805-1.804a1.136 1.136 0 0 0-.804-.334z",
  },
  linear: {
    color: "#5E6AD2",
    d: "M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z",
  },
  notion: {
    color: "#000000",
    d: "M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z",
  },
  resend: {
    color: "#000000",
    d: "M14.679 0c4.648 0 7.413 2.765 7.413 6.434s-2.765 6.434-7.413 6.434H12.33L24 24h-8.245l-8.88-8.44c-.636-.588-.93-1.273-.93-1.86 0-.831.587-1.565 1.713-1.883l4.574-1.224c1.737-.465 2.936-1.81 2.936-3.572 0-2.153-1.761-3.4-3.939-3.4H0V0z",
  },
  sentry: {
    color: "#362D59",
    d: "M13.91 2.505c-.873-1.448-2.972-1.448-3.844 0L6.904 7.92a15.478 15.478 0 0 1 8.53 12.811h-2.221A13.301 13.301 0 0 0 5.784 9.814l-2.926 5.06a7.65 7.65 0 0 1 4.435 5.848H2.194a.365.365 0 0 1-.298-.534l1.413-2.402a5.16 5.16 0 0 0-1.614-.913L.296 19.275a2.182 2.182 0 0 0 .812 2.999 2.24 2.24 0 0 0 1.086.288h6.983a9.322 9.322 0 0 0-3.845-8.318l1.11-1.922a11.47 11.47 0 0 1 4.95 10.24h5.915a17.242 17.242 0 0 0-7.885-15.28l2.244-3.845a.37.37 0 0 1 .504-.13c.255.14 9.75 16.708 9.928 16.9a.365.365 0 0 1-.327.543h-2.287c.029.612.029 1.223 0 1.831h2.297a2.206 2.206 0 0 0 1.922-3.31z",
  },
  spotify: {
    color: "#1ED760",
    d: "M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z",
  },
  stripe: {
    color: "#635BFF",
    d: "M13.976 9.15c-2.172-.806-3.356-1.426-3.356-2.409 0-.831.683-1.305 1.901-1.305 2.227 0 4.515.858 6.09 1.631l.89-5.494C18.252.975 15.697 0 12.165 0 9.667 0 7.589.654 6.104 1.872 4.56 3.147 3.757 4.992 3.757 7.218c0 4.039 2.467 5.76 6.476 7.219 2.585.92 3.445 1.574 3.445 2.583 0 .98-.84 1.545-2.354 1.545-1.875 0-4.965-.921-6.99-2.109l-.9 5.555C5.175 22.99 8.385 24 11.714 24c2.641 0 4.843-.624 6.328-1.813 1.664-1.305 2.525-3.236 2.525-5.732 0-4.128-2.524-5.851-6.594-7.305h.003z",
  },
  vercel: { color: "#000000", d: "m12 1.608 12 20.784H0Z" },
} as const satisfies Readonly<Record<string, { readonly color: string; readonly d: string }>>;
