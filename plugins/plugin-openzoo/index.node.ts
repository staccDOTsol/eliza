/**
 * Node entrypoint. The plugin lives in src/ so the agent's workspace-source
 * loader (which probes plugins/<name>/src/index.ts) can hot-load it without
 * a build; this file exists for the built dist/ layout.
 */
export * from "./src/index";
export { default } from "./src/index";
