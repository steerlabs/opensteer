import { appFailureSource } from "./browser-scripts.gen.ts";

/** Inline host script: no app dependencies, credentials, or authored HTML enter its source. */
export const appFailureBootstrap = `<script>${appFailureSource}</script>`;
