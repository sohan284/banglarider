// Copies MapLibre's web-worker module into public/ so it can be served as a
// static file (MapLibre 6 loads its worker by URL; bundlers don't emit it).
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const pkgDir = path.dirname(require.resolve("maplibre-gl/package.json"));
const outDir = path.resolve(import.meta.dirname, "..", "public", "vendor");
mkdirSync(outDir, { recursive: true });
copyFileSync(path.join(pkgDir, "dist", "maplibre-gl-worker.mjs"), path.join(outDir, "maplibre-gl-worker.mjs"));
console.log("copied maplibre-gl-worker.mjs → public/vendor/");
