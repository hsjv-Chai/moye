import { build } from "esbuild";
await build({
  entryPoints: ["server/index.ts", "server/admin.ts"],
  outdir: "dist-server",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  packages: "external",
});
