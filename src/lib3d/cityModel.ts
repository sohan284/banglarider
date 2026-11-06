/**
 * Stylised whole-area city model (the "diorama" look): buildings with pastel
 * walls and flat roofs (water tanks, solar panels), roads with markings,
 * lakes with shorelines, parks, pitches and thousands of trees.
 *
 * Used by the 3D start screen (DioramaView) and as the distant scenery in ride
 * mode (so zooming out while riding shows the whole neighbourhood).
 * Everything is merged into a few geometries; trees are returned as instances.
 */

import * as THREE from "three";
import type { Feature, FeatureCollection, MultiPolygon, Polygon, Position } from "geojson";
import type { Roads } from "@/lib/routing";
import { GeometryWriter, ribbon, ROAD_WIDTH, type Projector, type Quality } from "@/ride/rideWorld";

export type LanduseKind = "water" | "park" | "pitch" | "grass";
export type LanduseFC = FeatureCollection<Polygon | MultiPolygon, { kind: LanduseKind }>;
export type BuildingsFC = FeatureCollection<Polygon | MultiPolygon, { h: number; mh?: number }>;

export interface TreeInstance {
  x: number;
  z: number;
  scale: number;
  yaw: number;
  /** 0..1 colour variation. */
  tint: number;
  conifer: boolean;
}

export interface CityModel {
  buildings: THREE.BufferGeometry;
  roofDetail: THREE.BufferGeometry;
  roads: THREE.BufferGeometry;
  markings: THREE.BufferGeometry;
  water: THREE.BufferGeometry;
  shore: THREE.BufferGeometry;
  green: THREE.BufferGeometry;
  trees: TreeInstance[];
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
}

interface Options {
  proj: Projector;
  roads: Roads;
  buildings: BuildingsFC;
  landuse: LanduseFC | null;
  quality: Quality;
  /** Skip buildings and trees at points for which this returns true (e.g. what ride mode already draws in detail). */
  excludeBuilding?: (x: number, z: number) => boolean;
  /** Road surface height. Ride mode draws its own detailed roads slightly above these. */
  roadY?: number;
  /** Centre-line dashes (off in ride mode, which has its own markings). */
  markings?: boolean;
}

function rand(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const WALLS = ["#f4f1ea", "#efe8dc", "#f2e7d8", "#e8edf0", "#f3ece6", "#e6e2d6", "#f6f3ee", "#ece4d4"].map((c) => new THREE.Color(c));
// Mostly concrete, with slate, terracotta and green (planted) roofs for a lively diorama.
const ROOFS = ["#c9c4b8", "#b9b3a6", "#5f6b78", "#b5654a", "#6f9a55", "#8d9aa6", "#d6d1c5", "#4f5b66"].map((c) => new THREE.Color(c));
const COLORS = {
  road: new THREE.Color("#4a4f55"),
  roadMajor: new THREE.Color("#3e4348"),
  mark: new THREE.Color("#f2f2ee"),
  water: new THREE.Color("#2f86d6"),
  shore: new THREE.Color("#d9cfae"),
  park: new THREE.Color("#82c85a"),
  grass: new THREE.Color("#95d067"),
  pitch: new THREE.Color("#5fb04c"),
  tank: new THREE.Color("#3f4d5c"),
  solar: new THREE.Color("#1e2f55"),
};

const up = [0, 1, 0];

function ringArea(r: [number, number][]) {
  let a = 0;
  for (let i = 0; i < r.length; i++) {
    const [x1, z1] = r[i];
    const [x2, z2] = r[(i + 1) % r.length];
    a += x1 * z2 - x2 * z1;
  }
  return a / 2;
}

function pointInRing(x: number, z: number, ring: [number, number][]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Flat polygon (with holes) at height y. */
function fillPolygon(w: GeometryWriter, rings: [number, number][][], y: number, color: THREE.Color) {
  const outer = rings[0].map(([x, z]) => new THREE.Vector2(x, z));
  const holes = rings.slice(1).map((r) => r.map(([x, z]) => new THREE.Vector2(x, z)));
  const all = [...outer, ...holes.flat()];
  for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(outer, holes)) {
    w.tri([all[a].x, y, all[a].y], [all[b].x, y, all[b].y], [all[c].x, y, all[c].y], up, color);
  }
}

export function buildCityModel(o: Options): CityModel {
  const { proj, quality } = o;
  const high = quality === "high";
  const r = rand(99);
  const toRing = (ring: Position[]) => {
    const pts = ring.map((c) => proj.toLocal(c));
    if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
    return pts;
  };
  const bounds = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };

  // ---- land use ----
  const water = new GeometryWriter();
  const shore = new GeometryWriter();
  const green = new GeometryWriter();
  const parkRings: [number, number][][] = [];
  const waterRings: [number, number][][] = [];
  for (const f of o.landuse?.features ?? []) {
    const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const poly of polys) {
      const rings = poly.map(toRing).filter((rr) => rr.length >= 3);
      if (!rings.length) continue;
      const kind = f.properties.kind;
      if (kind === "water") {
        fillPolygon(water, rings, 0.02, COLORS.water);
        // shoreline: a sandy band just outside the water edge
        const outer = [...rings[0], rings[0][0]];
        ribbon(shore, outer, 5, 0.015, COLORS.shore);
        waterRings.push(rings[0]);
      } else {
        fillPolygon(green, rings, kind === "pitch" ? 0.012 : 0.01, kind === "pitch" ? COLORS.pitch : kind === "park" ? COLORS.park : COLORS.grass);
        parkRings.push(rings[0]);
      }
    }
  }

  // ---- roads ----
  const roadsW = new GeometryWriter(true);
  const marks = new GeometryWriter();
  const treesAlong: TreeInstance[] = [];
  const roadY = o.roadY ?? 0.06;
  {
    for (const f of o.roads.features) {
      const pts = f.geometry.coordinates.map((c) => proj.toLocal(c));
      const hw = f.properties.highway;
      const w = ROAD_WIDTH[hw] ?? 5;
      ribbon(roadsW, pts, w, roadY, w >= 10 ? COLORS.roadMajor : COLORS.road);
      let along = 0;
      for (let i = 0; i < pts.length - 1; i++) {
        const [x1, z1] = pts[i], [x2, z2] = pts[i + 1];
        const len = Math.hypot(x2 - x1, z2 - z1);
        if (len < 0.1) continue;
        const tx = (x2 - x1) / len, tz = (z2 - z1) / len;
        const lx = -tz, lz = tx;
        if (w >= 8 && o.markings !== false) {
          // centre dashes
          for (let d = Math.ceil(along / 10) * 10; d < along + len; d += 10) {
            const a = d - along, b = Math.min(len, a + 4);
            const q = (t: number, off: number) => [x1 + tx * t + lx * off, 0.08, z1 + tz * t + lz * off];
            marks.quad(q(a, 0.12), q(b, 0.12), q(b, -0.12), q(a, -0.12), up, COLORS.mark);
          }
        }
        // street trees on both sides
        if (w >= 6 && hw !== "service") {
          const gap = high ? 16 : 30;
          for (let d = Math.ceil(along / gap) * gap; d < along + len; d += gap) {
            const t = d - along;
            for (const side of [1, -1]) {
              if (r() < 0.25) continue;
              treesAlong.push({ x: x1 + tx * t + lx * side * (w / 2 + 2.2), z: z1 + tz * t + lz * side * (w / 2 + 2.2), scale: 0.8 + r() * 0.5, yaw: r() * 6.28, tint: r(), conifer: r() < 0.12 });
            }
          }
        }
        along += len;
      }
      for (const [x, z] of pts) {
        bounds.minX = Math.min(bounds.minX, x); bounds.maxX = Math.max(bounds.maxX, x);
        bounds.minZ = Math.min(bounds.minZ, z); bounds.maxZ = Math.max(bounds.maxZ, z);
      }
    }
  }

  // ---- buildings ----
  const bw = new GeometryWriter();
  const roofDetail = new GeometryWriter();
  const buildingRings: [number, number][][] = [];
  o.buildings.features.forEach((f: Feature<Polygon | MultiPolygon, { h: number; mh?: number }>, idx) => {
    const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const poly of polys) {
      const ring = toRing(poly[0]);
      if (ring.length < 3) continue;
      if (o.excludeBuilding && ring.some(([x, z]) => o.excludeBuilding!(x, z))) continue;
      if (ringArea(ring) < 0) ring.reverse();
      buildingRings.push(ring);
      const h = f.properties.h;
      const base = f.properties.mh ?? 0;
      const wall = WALLS[idx % WALLS.length];
      const roof = ROOFS[(idx * 7) % ROOFS.length];
      const bottom = wall.clone().multiplyScalar(0.72);
      for (let i = 0; i < ring.length; i++) {
        const [x1, z1] = ring[i];
        const [x2, z2] = ring[(i + 1) % ring.length];
        const len = Math.hypot(x2 - x1, z2 - z1) || 1;
        const n = [(z2 - z1) / len, 0, -(x2 - x1) / len];
        const top = wall.clone().multiplyScalar(0.86 + 0.14 * Math.abs(n[0]));
        bw.quadV({ p: [x1, base, z1], c: bottom }, { p: [x2, base, z2], c: bottom }, { p: [x2, h, z2], c: top }, { p: [x1, h, z1], c: top }, n);
      }
      fillPolygon(bw, [ring], h, roof);
      // Rooftop clutter: water tanks and the odd solar array.
      if (h >= 8 && (idx % 5 < 3 || high)) {
        let cx = 0, cz = 0;
        for (const [x, z] of ring) {
          cx += x;
          cz += z;
        }
        cx /= ring.length;
        cz /= ring.length;
        const yaw = Math.atan2(ring[1][0] - ring[0][0], ring[1][1] - ring[0][1]);
        if (idx % 3 !== 2) roofDetail.box(cx, h, cz, 1.6, 1.3, 1.6, yaw, COLORS.tank);
        if (idx % 4 === 0) roofDetail.box(cx + 2, h + 0.15, cz - 1.5, 3.2, 0.12, 2, yaw, COLORS.solar, 0.6);
      }
    }
  });

  // ---- trees in parks and grass ----
  const trees: TreeInstance[] = [...treesAlong];
  const density = high ? 1 / 140 : 1 / 380;
  for (const ring of parkRings) {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of ring) {
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
    }
    const want = Math.min(900, Math.round(Math.abs(ringArea(ring)) * density));
    for (let k = 0, tries = 0; k < want && tries < want * 4; tries++) {
      const x = x0 + r() * (x1 - x0), z = z0 + r() * (z1 - z0);
      if (!pointInRing(x, z, ring)) continue;
      if (waterRings.some((wr) => pointInRing(x, z, wr))) continue;
      trees.push({ x, z, scale: 0.8 + r() * 0.7, yaw: r() * 6.28, tint: r(), conifer: r() < 0.3 });
      k++;
    }
  }
  // Drop street trees that ended up inside a building or the lake.
  const cell = 30;
  const grid = new Map<string, number[]>();
  buildingRings.forEach((ring, i) => {
    const [x, z] = ring[0];
    const k = `${Math.floor(x / cell)},${Math.floor(z / cell)}`;
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(i);
  });
  const blocked = (x: number, z: number) => {
    const cx = Math.floor(x / cell), cz = Math.floor(z / cell);
    for (let i = -1; i <= 1; i++)
      for (let j = -1; j <= 1; j++) for (const id of grid.get(`${cx + i},${cz + j}`) ?? []) if (pointInRing(x, z, buildingRings[id])) return true;
    return waterRings.some((wr) => pointInRing(x, z, wr));
  };
  const keptTrees = trees.filter((t) => !blocked(t.x, t.z) && !o.excludeBuilding?.(t.x, t.z)).slice(0, high ? 9000 : 3200);

  return {
    buildings: bw.build(),
    roofDetail: roofDetail.build(),
    roads: roadsW.build(),
    markings: marks.build(),
    water: water.build(),
    shore: shore.build(),
    green: green.build(),
    trees: keptTrees,
    bounds,
  };
}
