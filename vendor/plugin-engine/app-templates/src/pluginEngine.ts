/** Source assets for the ordinary PluginEngine app; hosts choose file I/O or bundled text. */
export {
  pluginEngineSkillFiles,
  readPluginEngineSkillDocuments,
  readPluginEngineSkills,
} from "./implementation/pluginEngine-skills.ts";
export { pluginEngineIntro } from "./implementation/pluginEngine-intro.gen.ts";
export { publishedSkillRoutes } from "./implementation/skill-publishing.ts";
export { annotateSkillRead } from "./implementation/skill-telemetry.ts";
