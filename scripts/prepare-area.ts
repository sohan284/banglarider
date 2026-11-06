/**
 * Downloads OpenStreetMap data for one area (via the Overpass API) and writes
 * compact files the app loads at runtime:
 *
 *   public/data/<area>/roads.geojson      routable road centrelines
 *   public/data/<area>/buildings.geojson  footprints with heights (metres)
 *   public/data/<area>/landmarks.json     ~25 notable places, English + Bangla
 *   public/data/<area>/meta.json          source timestamp, counts, sizes
 *
 * Usage:
 *   npm run prepare-area -- <areaId> [--force] [--endpoint <url>] [--only roads,buildings,landmarks]
 *
 *   --force      ignore the local download cache in .cache/overpass/
 *   --endpoint   use this Overpass endpoint first (others are tried after it)
 *   --only       regenerate only some outputs (still needs the others' cache for meta.json)
 *
 * Data © OpenStreetMap contributors, ODbL 1.0.
 */

import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Feature, FeatureCollection, LineString, Polygon, MultiPolygon, Position } from "geojson";
import { AREAS, type AreaConfig, type LngLat } from "../src/config/areas";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const areaId = args.find((a) => !a.startsWith("--") && !isFlagValue(a));
const force = args.includes("--force");
const endpointArg = flagValue("--endpoint");
const only = new Set((flagValue("--only") ?? "roads,buildings,landmarks").split(","));

function flagValue(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
function isFlagValue(a: string): boolean {
  const i = args.indexOf(a);
  return i > 0 && ["--endpoint", "--only"].includes(args[i - 1]);
}

if (!areaId || !AREAS[areaId]) {
  console.error(`Usage: npm run prepare-area -- <areaId>\nKnown areas: ${Object.keys(AREAS).join(", ")}`);
  process.exit(1);
}
const area: AreaConfig = AREAS[areaId];
const ROOT = path.resolve(import.meta.dirname, "..");
const OUT_DIR = path.join(ROOT, "public", "data", area.id);
const CACHE_DIR = path.join(ROOT, ".cache", "overpass");

// ---------------------------------------------------------------------------
// Overpass access with retry + mirrors
// ---------------------------------------------------------------------------

const ENDPOINTS = [
  ...(endpointArg ? [endpointArg] : []),
  "https://overpass-api.de/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

interface OverpassElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
  nodes?: number[];
  geometry?: ({ lat: number; lon: number } | null)[];
  members?: { type: string; ref: number; role: string; geometry?: { lat: number; lon: number }[] }[];
}
interface OverpassResponse {
  osm3s?: { timestamp_osm_base?: string };
  elements: OverpassElement[];
}

/** Overpass bbox order is south,west,north,east. */
const BB = `${area.bbox[1]},${area.bbox[0]},${area.bbox[3]},${area.bbox[2]}`;

async function overpass(kind: string, query: string): Promise<OverpassResponse> {
  const cacheFile = path.join(CACHE_DIR, `${area.id}-${kind}.json`);
  if (!force && existsSync(cacheFile)) {
    console.log(`  [${kind}] using cache ${path.relative(ROOT, cacheFile)}`);
    return JSON.parse(await readFile(cacheFile, "utf8"));
  }
  const maxAttempts = 8;
  let wait = 5_000;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const endpoint = ENDPOINTS[attempt % ENDPOINTS.length];
    try {
      console.log(`  [${kind}] attempt ${attempt + 1}/${maxAttempts} → ${new URL(endpoint).host}`);
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "bangla-rider-prepare-area/1.0",
        },
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.timeout(240_000),
      });
      const text = await res.text();
      if (!res.ok || !text.trimStart().startsWith("{")) {
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 120).replace(/\s+/g, " ")}`);
      }
      const json = JSON.parse(text) as OverpassResponse & { remark?: string };
      if (json.remark && /runtime error|timed out/i.test(json.remark)) throw new Error(json.remark);
      await mkdir(CACHE_DIR, { recursive: true });
      await writeFile(cacheFile, text);
      console.log(`  [${kind}] ${json.elements.length} elements`);
      return json;
    } catch (err) {
      console.warn(`  [${kind}] failed: ${(err as Error).message}`);
      if (attempt < maxAttempts - 1) {
        console.warn(`  [${kind}] retrying in ${wait / 1000}s`);
        await new Promise((r) => setTimeout(r, wait));
        wait = Math.min(wait * 2, 60_000);
      }
    }
  }
  throw new Error(`[${kind}] all Overpass attempts failed. Try again later or pass --endpoint <url>.`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;
const pos = (p: { lat: number; lon: number }, d: number): Position => [round(p.lon, d), round(p.lat, d)];

function dedupe(coords: Position[]): Position[] {
  return coords.filter((c, i) => i === 0 || c[0] !== coords[i - 1][0] || c[1] !== coords[i - 1][1]);
}

function haversine(a: Position, b: Position): number {
  const R = 6371008.8;
  const toRad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * toRad;
  const dLng = (b[0] - a[0]) * toRad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * toRad) * Math.cos(b[1] * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function inBBox(p: Position): boolean {
  const [w, s, e, n] = area.bbox;
  return p[0] >= w && p[0] <= e && p[1] >= s && p[1] <= n;
}

function parseMeters(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const m = v.replace(",", ".").match(/-?\d+(\.\d+)?/);
  if (!m) return undefined;
  let n = parseFloat(m[0]);
  if (/ft|'/.test(v)) n *= 0.3048;
  return Number.isFinite(n) ? n : undefined;
}

async function writeJson(file: string, data: unknown): Promise<number> {
  const full = path.join(OUT_DIR, file);
  await writeFile(full, JSON.stringify(data));
  return (await stat(full)).size;
}

// ---------------------------------------------------------------------------
// Roads
// ---------------------------------------------------------------------------

const ROUTABLE =
  "motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|" +
  "tertiary|tertiary_link|unclassified|residential|living_street|service|road|track|cycleway|path";

export interface RoadProps {
  id: number;
  name?: string;
  name_bn?: string;
  highway: string;
  /** 1 = forward only, -1 = reverse only, 0 = both ways. */
  oneway: 1 | -1 | 0;
  /** Bicycles may ride against oneway (oneway:bicycle=no). */
  bike_contraflow?: true;
  motor: boolean;
  bike: boolean;
}

function roadProps(el: OverpassElement): RoadProps | null {
  const t = el.tags ?? {};
  const hw = t.highway;
  if (t.area === "yes") return null;
  if (["private", "no"].includes(t.access ?? "") && !["yes", "designated", "permissive"].includes(t.bicycle ?? "")) return null;

  let oneway: 1 | -1 | 0 = 0;
  if (["yes", "true", "1"].includes(t.oneway)) oneway = 1;
  else if (["-1", "reverse"].includes(t.oneway)) oneway = -1;
  else if (t.oneway !== "no" && (["roundabout", "circular"].includes(t.junction) || hw === "motorway" || hw === "motorway_link")) oneway = 1;

  const motorBlocked =
    ["cycleway", "path"].includes(hw) ||
    ["no", "private"].includes(t.motor_vehicle ?? "") ||
    ["no", "private"].includes(t.motorcycle ?? "") ||
    (["no", "private"].includes(t.access ?? "") && !["yes", "designated", "permissive"].includes(t.motorcycle ?? ""));
  const bikeBlocked =
    ["motorway", "motorway_link"].includes(hw) ||
    ["no", "private", "dismount"].includes(t.bicycle ?? "") ||
    (hw === "path" && !["yes", "designated", "permissive"].includes(t.bicycle ?? ""));

  if (motorBlocked && bikeBlocked) return null;

  const p: RoadProps = { id: el.id, highway: hw, oneway, motor: !motorBlocked, bike: !bikeBlocked };
  const name = t["name:en"] || t.name;
  if (name) p.name = name;
  if (t["name:bn"]) p.name_bn = t["name:bn"];
  else if (t.name && /[ঀ-৿]/.test(t.name)) p.name_bn = t.name;
  if (oneway !== 0 && t["oneway:bicycle"] === "no") p.bike_contraflow = true;
  return p;
}

async function buildRoads() {
  const data = await overpass(
    "roads",
    `[out:json][timeout:180];
way["highway"~"^(${ROUTABLE})$"]["service"!~"^(parking_aisle|drive-through)$"](${BB});
out tags geom;`,
  );
  const features: Feature<LineString, RoadProps>[] = [];
  for (const el of data.elements) {
    if (el.type !== "way" || !el.geometry) continue;
    const props = roadProps(el);
    if (!props) continue;
    const coords = dedupe(el.geometry.filter((g): g is { lat: number; lon: number } => !!g).map((g) => pos(g, 6)));
    if (coords.length < 2) continue;
    features.push({ type: "Feature", properties: props, geometry: { type: "LineString", coordinates: coords } });
  }
  const fc: FeatureCollection<LineString, RoadProps> = { type: "FeatureCollection", features };
  const bytes = await writeJson("roads.geojson", fc);
  console.log(`  roads.geojson: ${features.length} ways, ${(bytes / 1024).toFixed(0)} KB`);
  return { fc, bytes, timestamp: data.osm3s?.timestamp_osm_base };
}

// ---------------------------------------------------------------------------
// Buildings
// ---------------------------------------------------------------------------

const DEFAULT_LEVELS = 3;
const METERS_PER_LEVEL = 3;

function buildingHeight(t: Record<string, string>): { h: number; mh?: number } {
  let h = parseMeters(t.height) ?? parseMeters(t["building:height"]);
  if (h === undefined) {
    const levels = parseMeters(t["building:levels"]);
    const roof = parseMeters(t["roof:levels"]) ?? 0;
    h = ((levels ?? DEFAULT_LEVELS) + roof) * METERS_PER_LEVEL;
  }
  let mh = parseMeters(t.min_height);
  if (mh === undefined && t["building:min_level"]) mh = (parseMeters(t["building:min_level"]) ?? 0) * METERS_PER_LEVEL;
  h = Math.min(Math.max(h, 3), 350);
  return mh && mh > 0 && mh < h ? { h: round(h, 1), mh: round(mh, 1) } : { h: round(h, 1) };
}

/** Joins open member ways into closed rings (for multipolygon relations). */
function assembleRings(parts: Position[][]): Position[][] {
  const rings: Position[][] = [];
  const pool = parts.filter((p) => p.length >= 2).map((p) => [...p]);
  const same = (a: Position, b: Position) => a[0] === b[0] && a[1] === b[1];
  while (pool.length) {
    let ring = pool.shift()!;
    let progressed = true;
    while (!same(ring[0], ring[ring.length - 1]) && progressed) {
      progressed = false;
      for (let i = 0; i < pool.length; i++) {
        const p = pool[i];
        const end = ring[ring.length - 1];
        if (same(end, p[0])) ring = ring.concat(p.slice(1));
        else if (same(end, p[p.length - 1])) ring = ring.concat([...p].reverse().slice(1));
        else continue;
        pool.splice(i, 1);
        progressed = true;
        break;
      }
    }
    if (same(ring[0], ring[ring.length - 1]) && ring.length >= 4) rings.push(ring);
  }
  return rings;
}

async function buildBuildings() {
  const data = await overpass(
    "buildings",
    `[out:json][timeout:240];
(way["building"](${BB}); relation["building"]["type"="multipolygon"](${BB}););
out tags geom;`,
  );
  const features: Feature<Polygon | MultiPolygon, { h: number; mh?: number }>[] = [];
  let defaulted = 0;
  for (const el of data.elements) {
    const t = el.tags ?? {};
    if (!t.height && !t["building:height"] && !t["building:levels"]) defaulted++;
    const props = buildingHeight(t);
    if (el.type === "way" && el.geometry) {
      const ring = dedupe(el.geometry.filter((g): g is { lat: number; lon: number } => !!g).map((g) => pos(g, 5)));
      if (ring.length < 4) continue;
      features.push({ type: "Feature", properties: props, geometry: { type: "Polygon", coordinates: [ring] } });
    } else if (el.type === "relation" && el.members) {
      const toCoords = (role: string) =>
        el.members!.filter((m) => m.type === "way" && m.role === role && m.geometry).map((m) => dedupe(m.geometry!.map((g) => pos(g, 5))));
      const outers = assembleRings(toCoords("outer"));
      const inners = assembleRings(toCoords("inner"));
      if (!outers.length) continue;
      // Holes are attached to the first outer ring; good enough for building courtyards.
      const polys: Position[][][] = outers.map((o, i) => (i === 0 ? [o, ...inners] : [o]));
      features.push({
        type: "Feature",
        properties: props,
        geometry: polys.length === 1 ? { type: "Polygon", coordinates: polys[0] } : { type: "MultiPolygon", coordinates: polys },
      });
    }
  }
  const fc = { type: "FeatureCollection", features };
  const bytes = await writeJson("buildings.geojson", fc);
  console.log(
    `  buildings.geojson: ${features.length} footprints (${defaulted} used the ${DEFAULT_LEVELS}-floor default), ${(bytes / 1024 / 1024).toFixed(2)} MB`,
  );
  return { count: features.length, defaulted, bytes };
}

// ---------------------------------------------------------------------------
// Landmarks
// ---------------------------------------------------------------------------

export type LandmarkCategory =
  | "circle"
  | "park"
  | "lake"
  | "market"
  | "mosque"
  | "hospital"
  | "road"
  | "education"
  | "embassy"
  | "transport"
  | "other";

export interface LandmarkSeed {
  id: string;
  category: LandmarkCategory;
  en: string;
  /** Used when OSM has no name:bn. Marked bnSource "manual" in the output. */
  bn: string;
  /** Matched against name, name:en, alt_name, old_name, official_name. Omit to use `fallback` only. */
  name?: RegExp;
  /** "road" = matched against roads.geojson; "feature" (default) = amenity/leisure/etc. */
  source?: "road" | "feature";
  /** Optional tag filters the OSM element must satisfy. */
  tags?: Record<string, RegExp>;
  /** Only used when nothing in OSM matches. Always flagged for verification. */
  fallback?: LngLat;
  /** Free-text caveat copied into the output's `verify` list. */
  note?: string;
}

export interface Landmark {
  id: string;
  category: LandmarkCategory;
  name: { en: string; bn: string };
  lngLat: LngLat;
  osm: string | null;
  bnSource: "osm" | "manual";
  /** Non-empty when a human should double-check this entry. */
  verify: string[];
}

const NAME_KEYS = ["name", "name:en", "alt_name", "old_name", "official_name", "short_name"];

async function buildLandmarks(roads: FeatureCollection<LineString, RoadProps>) {
  const seedsFile = path.join(ROOT, "scripts", "landmark-seeds", `${area.id}.ts`);
  if (!existsSync(seedsFile)) throw new Error(`Missing ${path.relative(ROOT, seedsFile)}`);
  const seeds: LandmarkSeed[] = (await import(seedsFile)).default;

  const data = await overpass(
    "landmark-candidates",
    `[out:json][timeout:180];
(
  nwr["name"]["amenity"](${BB});
  nwr["name"]["leisure"](${BB});
  nwr["name"]["shop"~"^(mall|department_store|supermarket)$"](${BB});
  nwr["name"]["natural"="water"](${BB});
  nwr["name"]["water"](${BB});
  nwr["name"]["place"](${BB});
  nwr["name"]["junction"](${BB});
  nwr["name"]["highway"~"^(traffic_signals|bus_stop|crossing)$"](${BB});
  nwr["name"]["office"="diplomatic"](${BB});
  nwr["name"]["tourism"](${BB});
  nwr["name"]["landuse"~"^(retail|commercial)$"](${BB});
  nwr["name"]["building"~"^(mosque|hospital|retail|commercial|school)$"](${BB});
);
out tags center;`,
  );

  // Dump all candidate names so seeds can be written/adjusted by hand.
  const listing = data.elements
    .map((e) => {
      const t = e.tags ?? {};
      const kind = ["amenity", "leisure", "shop", "natural", "place", "junction", "highway", "office", "tourism", "landuse", "building"]
        .filter((k) => t[k])
        .map((k) => `${k}=${t[k]}`)
        .join(" ");
      const c = e.center ?? (e.lat !== undefined ? { lat: e.lat, lon: e.lon! } : undefined);
      return `${e.type}/${e.id}\t${t.name}\t${t["name:bn"] ?? ""}\t${kind}\t${c ? `${c.lat.toFixed(5)},${c.lon.toFixed(5)}` : ""}`;
    })
    .sort((a, b) => a.split("\t")[1].localeCompare(b.split("\t")[1]));
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(path.join(CACHE_DIR, `${area.id}-landmark-candidates.tsv`), listing.join("\n"));

  const landmarks: Landmark[] = [];
  for (const seed of seeds) {
    const verify: string[] = [];
    let lngLat: LngLat | null = null;
    let osm: string | null = null;
    let osmBn: string | undefined;

    if (!seed.name) {
      // Fallback-only seed.
    } else if (seed.source === "road") {
      const matches = roads.features.filter((f) => f.properties.name && seed.name!.test(f.properties.name));
      if (matches.length) {
        const inside = (f: Feature<LineString>) => f.geometry.coordinates.filter(inBBox);
        if (seed.category === "circle") {
          // A circle is drawn as several short ways; use the centre of all their vertices.
          const pts = matches.flatMap(inside);
          if (pts.length) lngLat = [round(pts.reduce((s, c) => s + c[0], 0) / pts.length, 6), round(pts.reduce((s, c) => s + c[1], 0) / pts.length, 6)];
        } else {
          // A road: the middle in-area vertex of the longest matching way.
          const len = (f: Feature<LineString>) => inside(f).reduce((s, c, i, a) => (i ? s + haversine(a[i - 1], c) : 0), 0);
          const best = matches.reduce((a, b) => (len(b) > len(a) ? b : a));
          const cs = inside(best);
          if (cs.length) lngLat = [cs[Math.floor(cs.length / 2)][0], cs[Math.floor(cs.length / 2)][1]];
        }
        if (lngLat) osm = `way/${matches[0].properties.id}`;
        osmBn = matches.find((m) => m.properties.name_bn)?.properties.name_bn;
      }
    } else {
      const matches = data.elements.filter((e) => {
        const t = e.tags ?? {};
        if (!NAME_KEYS.some((k) => t[k] && seed.name!.test(t[k]))) return false;
        return !seed.tags || Object.entries(seed.tags).every(([k, re]) => t[k] !== undefined && re.test(t[k]));
      });
      const located = matches
        .map((e) => ({ e, c: e.center ?? (e.lat !== undefined ? { lat: e.lat, lon: e.lon! } : undefined) }))
        .filter((m): m is { e: OverpassElement; c: { lat: number; lon: number } } => !!m.c);
      if (located.length) {
        // Prefer ways/relations (areas) over nodes; they are usually the main feature.
        located.sort((a, b) => (a.e.type === "node" ? 1 : 0) - (b.e.type === "node" ? 1 : 0));
        const first = located[0];
        lngLat = [round(first.c.lon, 6), round(first.c.lat, 6)];
        osm = `${first.e.type}/${first.e.id}`;
        const bnOf = (t: Record<string, string> = {}) => t["name:bn"] ?? (/[\u0980-\u09FF]/.test(t.name ?? "") ? t.name : undefined);
        osmBn = bnOf(first.e.tags) ?? located.map((m) => bnOf(m.e.tags)).find(Boolean);
        const far = located.filter((m) => haversine(pos(m.c, 6), lngLat!) > 150);
        if (far.length) verify.push(`${far.length + 1} OSM matches more than 150 m apart; picked ${osm}`);
      }
    }

    if (!lngLat) {
      if (!seed.fallback) {
        console.warn(`  ! landmark "${seed.en}" not found in OSM and has no fallback; skipped`);
        continue;
      }
      lngLat = seed.fallback;
      verify.push("not found in OSM; using hand-entered fallback coordinate");
    }
    if (seed.note) verify.push(seed.note);
    if (!inBBox(lngLat)) verify.push("outside the area bounding box");
    if (!osmBn) verify.push("Bangla name is a manual translation, not from OSM");

    landmarks.push({
      id: seed.id,
      category: seed.category,
      name: { en: seed.en, bn: osmBn ?? seed.bn },
      lngLat,
      osm,
      bnSource: osmBn ? "osm" : "manual",
      verify,
    });
  }

  const bytes = await writeJson("landmarks.json", landmarks);
  console.log(`  landmarks.json: ${landmarks.length} landmarks, ${(bytes / 1024).toFixed(1)} KB`);
  const flagged = landmarks.filter((l) => l.verify.length);
  if (flagged.length) {
    console.log(`\n  Landmarks to double-check (${flagged.length}):`);
    for (const l of flagged) console.log(`   - ${l.id.padEnd(24)} ${l.verify.join("; ")}`);
  }
  console.log(`\n  All candidate names: ${path.relative(ROOT, path.join(CACHE_DIR, `${area.id}-landmark-candidates.tsv`))}`);
  return { count: landmarks.length, flagged: flagged.length, bytes };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`Preparing "${area.id}" bbox=${area.bbox.join(",")}`);
  await mkdir(OUT_DIR, { recursive: true });

  const metaPath = path.join(OUT_DIR, "meta.json");
  const prevMeta = existsSync(metaPath) ? JSON.parse(await readFile(metaPath, "utf8")) : {};

  console.log("Roads…");
  // Landmarks need roads, so roads are always (re)built from cache when landmarks are requested.
  const roads = only.has("roads") || only.has("landmarks") ? await buildRoads() : null;
  console.log("Buildings…");
  const buildings = only.has("buildings") ? await buildBuildings() : null;
  console.log("Landmarks…");
  const landmarks = only.has("landmarks") && roads ? await buildLandmarks(roads.fc) : null;

  const meta = {
    ...prevMeta,
    area: area.id,
    bbox: area.bbox,
    generatedAt: new Date().toISOString(),
    osmTimestamp: roads?.timestamp ?? prevMeta.osmTimestamp ?? null,
    attribution: "© OpenStreetMap contributors (ODbL 1.0)",
    ...(roads && { roads: { features: roads.fc.features.length, bytes: roads.bytes } }),
    ...(buildings && { buildings }),
    ...(landmarks && { landmarks }),
  };
  await writeJson("meta.json", meta);
  console.log(`\nDone → ${path.relative(ROOT, OUT_DIR)}/`);
}

main().catch((err) => {
  console.error(`\n${(err as Error).message}`);
  process.exit(1);
});
