#!/usr/bin/env bun
/**
 * Build script for @elizaos/plugin-openzoo (Node only — it signs Solana
 * transactions and crawls the local filesystem; there is no browser story).
 */
import { buildPlugin } from "../plugin-build";

const reexport = (from: string) => `export * from "${from}";\nexport { default } from "${from}";\n`;

await buildPlugin({
  name: "@elizaos/plugin-openzoo",
  clean: true,
  targets: [
    { label: "Node", entry: "index.node.ts", outSubdir: "node", target: "node", format: "esm" },
  ],
  dtsProject: "tsconfig.build.json",
  dtsShims: [
    { path: "index.d.ts", content: reexport("./node/index") },
    { path: "node/index.d.ts", content: reexport("./index.node") },
  ],
});
