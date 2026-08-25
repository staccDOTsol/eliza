/**
 * Node entrypoint. The plugin lives in src/ so the agent's workspace-source
 * loader (which probes plugins/<name>/src/index.ts) can hot-load it without
 * a build; this file exists for the built dist/ layout.
 *
 * The default export is re-exported via an explicit local binding, not
 * `export { default } from` — Bun.build emitted `default2 as default`
 * without ever declaring `default2` for the pass-through form, and the
 * agent refused the whole plugin with "default2 is not declared in this
 * file" (observed live: no model provider loaded, bot answered nothing).
 */
import openzooPlugin from "./src/index";

export * from "./src/index";
export default openzooPlugin;
