/**
 * Geometry for ride mode: converts lng/lat into a local metre grid around the
 * route and builds a few merged meshes (roads, route, buildings) so the whole
 * scene costs only a handful of draw calls on phones. Street furniture lives
 * in streetDetail.ts.
 *
 * Axes: +x = east, -z = north, +y = up. Models face -z.
 */

import * as THREE from "three";
import type { Feature, FeatureCollection, MultiPolygon, Polygon, Position } from "geojson";
import type { LngLat } from "@/config/areas";
import type { Roads, Route, Vehicle } from "@/lib/routing";
import { buildStreetDetail, type StreetDetail } from "@/ride/streetDetail";
import { TrafficSim } from "@/ride/traffic";

/** Bangladesh drives on the left: the rider keeps this far left of the road centre (m). */
export const HOME_LANE = -1.5;

export type Quality = "low" | "high";

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

export interface Projector {
  toLocal: (p: LngLat | Position) => [x: number, z: number];
}

export function makeProjector(origin: LngLat): Projector {
  const kx = Math.cos((origin[1] * Math.PI) / 180) * 111_320;
  const kz = 110_574;
  return { toLocal: (p) => [(p[0] - origin[0]) * kx, -(p[1] - origin[1]) * kz] };
}

const TAU = Math.PI * 2;
export const angleDiff = (a: number, b: number) => ((((a - b) % TAU) + TAU + Math.PI) % TAU) - Math.PI;

// ---------------------------------------------------------------------------
// Route path: position, heading and a realistic speed limit along the route
// ---------------------------------------------------------------------------

export interface PathSample {
  x: number;
  z: number;
  /** Yaw (radians, around +y) that makes a -z-facing model point along the route. */
  yaw: number;
}

const VEHICLE_DYNAMICS: Record<Vehicle, { lateral: number; brake: number; accel: number; breaker: number; minCorner: number }> = {
  // lateral: comfortable cornering acceleration (m/s²); brake/accel: m/s²; breaker: speed over humps (m/s)
  motorcycle: { lateral: 2.6, brake: 2.8, accel: 2.6, breaker: 3.6, minCorner: 3.2 },
  bicycle: { lateral: 1.8, brake: 1.6, accel: 1.0, breaker: 2.6, minCorner: 2.4 },
};

export class RoutePath {
  readonly xs: Float64Array;
  readonly zs: Float64Array;
  readonly cum: number[];
  readonly length: number;
  /** Max comfortable speed (m/s) at each metre of the route. */
  private limit: Float32Array = new Float32Array(0);
  /** Speed-breaker positions (metres along the route). */
  breakers: number[] = [];
  readonly accel: number;

  /** Road width (m) at each route vertex, used to keep speed humps off main roads. */
  private widths: Float32Array;

  constructor(route: Route, proj: Projector, private vehicle: Vehicle, widths?: Float32Array) {
    this.widths = widths ?? new Float32Array(route.coords.length).fill(6);
    const n = route.coords.length;
    this.xs = new Float64Array(n);
    this.zs = new Float64Array(n);
    route.coords.forEach((c, i) => {
      const [x, z] = proj.toLocal(c);
      this.xs[i] = x;
      this.zs[i] = z;
    });
    // Same distances as the route summary, so HUD numbers agree with the panel.
    this.cum = route.cumDist;
    this.length = route.distance;
    this.accel = VEHICLE_DYNAMICS[vehicle].accel;
    this.buildSpeedProfile();
  }

  private index(s: number): number {
    let lo = 0;
    let hi = this.cum.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.cum[mid] <= s) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  point(s: number): [number, number] {
    const d = Math.min(Math.max(s, 0), this.length);
    const i = this.index(d);
    const seg = this.cum[i + 1] - this.cum[i] || 1;
    const t = Math.min(1, Math.max(0, (d - this.cum[i]) / seg));
    const j = Math.min(i + 1, this.xs.length - 1);
    return [this.xs[i] + (this.xs[j] - this.xs[i]) * t, this.zs[i] + (this.zs[j] - this.zs[i]) * t];
  }

  heading(s: number, span = 4): number {
    const [x1, z1] = this.point(s - span);
    const [x2, z2] = this.point(s + span);
    return Math.atan2(-(x2 - x1), -(z2 - z1));
  }

  sample(s: number, lookAhead = 5): PathSample {
    const [x, z] = this.point(s);
    let [ax, az] = this.point(s + lookAhead);
    if (Math.hypot(ax - x, az - z) < 0.5) {
      const [bx, bz] = this.point(s - lookAhead);
      [ax, az] = [x + (x - bx), z + (z - bz)];
    }
    return { x, z, yaw: Math.atan2(-(ax - x), -(az - z)) };
  }

  /** Distance along the route of the closest point to (x, z). */
  nearestS(x: number, z: number): number {
    let best = Infinity;
    let bestS = 0;
    for (let i = 0; i < this.xs.length - 1; i++) {
      const x1 = this.xs[i], z1 = this.zs[i], x2 = this.xs[i + 1], z2 = this.zs[i + 1];
      const dx = x2 - x1, dz = z2 - z1;
      const len2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - x1) * dx + (z - z1) * dz) / len2));
      const d = Math.hypot(x1 + dx * t - x, z1 + dz * t - z);
      if (d < best) {
        best = d;
        bestS = this.cum[i] + (this.cum[i + 1] - this.cum[i]) * t;
      }
    }
    return bestS;
  }

  /** Speed limit (m/s) at s, from corners, speed breakers and the stop at the end. */
  limitAt(s: number): number {
    const i = Math.max(0, Math.min(this.limit.length - 1, Math.round(s)));
    return this.limit[i];
  }

  /**
   * Builds the per-metre speed limit:
   *  1. corner speed from curvature (v = sqrt(a_lat * r)),
   *  2. speed breakers on straight stretches,
   *  3. a stop at the destination,
   *  4. a backward pass so the rider brakes *before* each slow point.
   */
  private buildSpeedProfile() {
    const dyn = VEHICLE_DYNAMICS[this.vehicle];
    const n = Math.max(2, Math.ceil(this.length) + 1);
    const lim = new Float32Array(n).fill(60);
    const window = 9;
    const turnAt = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const theta = Math.abs(angleDiff(this.heading(i + window, 4), this.heading(i - window, 4)));
      turnAt[i] = theta;
      if (theta > 0.12) {
        const radius = (2 * window) / theta;
        lim[i] = Math.min(lim[i], Math.max(dyn.minCorner, Math.sqrt(dyn.lateral * radius)));
      }
    }

    // Speed breakers: on side streets only (Gulshan's main avenues have few), every ~300-400 m
    // on straight-ish stretches, away from the ends.
    const breakers: number[] = [];
    let next = 160;
    for (let s = 0; s < n; s++) {
      if (s < next || s > this.length - 70) continue;
      if (this.widths[this.index(s)] >= 10) continue;
      let straight = true;
      for (let k = Math.max(0, s - 25); k < Math.min(n, s + 25); k++) if (turnAt[k] > 0.2) straight = false;
      if (!straight) continue;
      breakers.push(s);
      next = s + 300 + ((s * 7919) % 100);
    }
    for (const b of breakers) for (let k = Math.max(0, b - 2); k < Math.min(n, b + 3); k++) lim[k] = Math.min(lim[k], dyn.breaker);
    this.breakers = breakers;

    lim[n - 1] = 0;
    // Backward pass: v(i)^2 <= v(i+1)^2 + 2*a*ds
    for (let i = n - 2; i >= 0; i--) lim[i] = Math.min(lim[i], Math.sqrt(lim[i + 1] ** 2 + 2 * dyn.brake));
    lim[n - 1] = 0.5; // let the rider actually reach the end
    this.limit = lim;
  }
}

// ---------------------------------------------------------------------------
// Proximity: "is this point within R metres of the route?"
// ---------------------------------------------------------------------------

export function makeNearRoute(path: RoutePath, radius: number) {
  const cell = radius;
  const grid = new Set<string>();
  for (let s = 0; s <= path.length; s += cell / 3) {
    const [x, z] = path.point(s);
    const cx = Math.floor(x / cell), cz = Math.floor(z / cell);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) grid.add(`${cx + i},${cz + j}`);
  }
  return (x: number, z: number) => grid.has(`${Math.floor(x / cell)},${Math.floor(z / cell)}`);
}

// ---------------------------------------------------------------------------
// Geometry writer (non-indexed, flat-shaded, vertex colours, optional UVs)
// ---------------------------------------------------------------------------

export type Vert = { p: number[]; c: THREE.Color; uv?: [number, number] };

export class GeometryWriter {
  pos: number[] = [];
  nor: number[] = [];
  col: number[] = [];
  uv: number[] = [];
  constructor(readonly withUV = false) {}

  /** Adds a triangle, flipping its winding if needed so its front face points along n. */
  triV(a: Vert, b: Vert, c: Vert, n: number[]) {
    const ux = b.p[0] - a.p[0], uy = b.p[1] - a.p[1], uz = b.p[2] - a.p[2];
    const vx = c.p[0] - a.p[0], vy = c.p[1] - a.p[1], vz = c.p[2] - a.p[2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    if (cx * n[0] + cy * n[1] + cz * n[2] < 0) [b, c] = [c, b];
    for (const v of [a, b, c]) {
      this.pos.push(v.p[0], v.p[1], v.p[2]);
      this.nor.push(n[0], n[1], n[2]);
      this.col.push(v.c.r, v.c.g, v.c.b);
      if (this.withUV) this.uv.push(v.uv?.[0] ?? 0, v.uv?.[1] ?? 0);
    }
  }
  tri(a: number[], b: number[], c: number[], n: number[], color: THREE.Color) {
    this.triV({ p: a, c: color }, { p: b, c: color }, { p: c, c: color }, n);
  }
  quad(a: number[], b: number[], c: number[], d: number[], n: number[], color: THREE.Color) {
    this.tri(a, b, c, n, color);
    this.tri(a, c, d, n, color);
  }
  quadV(a: Vert, b: Vert, c: Vert, d: Vert, n: number[]) {
    this.triV(a, b, c, n);
    this.triV(a, c, d, n);
  }
  /** Axis-aligned-in-yaw box (for water tanks, kerb blocks, humps). */
  box(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, yaw: number, color: THREE.Color, sideShade = 0.85) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const P = (lx: number, ly: number, lz: number) => [cx + lx * c + lz * s, cy + ly, cz - lx * s + lz * c];
    const hx = sx / 2, hz = sz / 2;
    const side = color.clone().multiplyScalar(sideShade);
    this.quad(P(-hx, sy, -hz), P(hx, sy, -hz), P(hx, sy, hz), P(-hx, sy, hz), [0, 1, 0], color);
    const faces: [number, number, number, number][] = [
      [-hx, -hz, hx, -hz],
      [hx, -hz, hx, hz],
      [hx, hz, -hx, hz],
      [-hx, hz, -hx, -hz],
    ];
    for (const [x1, z1, x2, z2] of faces) {
      const nx = (z2 - z1), nz = -(x2 - x1);
      const len = Math.hypot(nx, nz) || 1;
      const n = [(nx * c + nz * s) / len, 0, (-nx * s + nz * c) / len];
      this.quad(P(x1, 0, z1), P(x2, 0, z2), P(x2, sy, z2), P(x1, sy, z1), n, side);
    }
  }
  get empty() {
    return this.pos.length === 0;
  }
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(this.col, 3));
    if (this.withUV) g.setAttribute("uv", new THREE.Float32BufferAttribute(this.uv, 2));
    g.computeBoundingSphere();
    return g;
  }
}

/** Flat ribbon along a polyline of local points, with round joints. */
export function ribbon(w: GeometryWriter, pts: [number, number][], width: number, y: number, color: THREE.Color) {
  const up = [0, 1, 0];
  const h = width / 2;
  for (let i = 0; i < pts.length - 1; i++) {
    const [x1, z1] = pts[i];
    const [x2, z2] = pts[i + 1];
    const len = Math.hypot(x2 - x1, z2 - z1);
    if (len < 0.01) continue;
    const nx = (-(z2 - z1) / len) * h;
    const nz = ((x2 - x1) / len) * h;
    w.quad([x1 + nx, y, z1 + nz], [x2 + nx, y, z2 + nz], [x2 - nx, y, z2 - nz], [x1 - nx, y, z1 - nz], up, color);
    if (i < pts.length - 2) {
      for (let k = 0; k < 8; k++) {
        const a1 = (k / 8) * TAU;
        const a2 = ((k + 1) / 8) * TAU;
        w.tri([x2, y, z2], [x2 + Math.cos(a1) * h, y, z2 + Math.sin(a1) * h], [x2 + Math.cos(a2) * h, y, z2 + Math.sin(a2) * h], up, color);
      }
    }
  }
}

export const ROAD_WIDTH: Record<string, number> = {
  trunk: 14, primary: 12, secondary: 10, tertiary: 8, motorway: 14,
  trunk_link: 7, primary_link: 7, secondary_link: 6, tertiary_link: 6, motorway_link: 7,
  residential: 6, unclassified: 6, living_street: 5, road: 6, service: 4, track: 3, cycleway: 2.5, path: 2,
};

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------

export interface RideWorld {
  path: RoutePath;
  proj: Projector;
  roads: THREE.BufferGeometry;
  route: THREE.BufferGeometry;
  /** Building walls with UVs for the window texture. */
  walls: THREE.BufferGeometry;
  /** Roofs and rooftop water tanks (vertex colours only). */
  roofs: THREE.BufferGeometry;
  buildingCount: number;
  detail: StreetDetail;
  traffic: TrafficSim;
  /** Extent of the scene (for the ground plane). */
  radius: number;
}

export type BuildingsFC = FeatureCollection<Polygon | MultiPolygon, { h: number; mh?: number }>;

/** Window texture atlas covers 4 bays × 4 floors. */
export const BAY_M = 3.4;
export const FLOOR_M = 3.0;

const PALETTE = ["#f1ece2", "#ebe0ca", "#f3e6d6", "#e9d7bb", "#efe9e4", "#ecdad3", "#e1e6e9", "#f5f1e8", "#ddcdb2", "#e7e3d9", "#e8d3c3", "#dde4da"];
const TOWER = new THREE.Color("#a9bccb");

export function buildRideWorld(
  route: Route,
  roads: Roads,
  buildings: BuildingsFC,
  opts: { vehicle: Vehicle; quality: Quality; markets?: LngLat[] },
  radius = 320,
): RideWorld {
  const { vehicle, quality } = opts;
  const mid = route.coords[Math.floor(route.coords.length / 2)];
  const proj = makeProjector(mid);
  const widthAt = new Map<string, number>();
  for (const f of roads.features) {
    const w = ROAD_WIDTH[f.properties.highway] ?? 5;
    for (const c of f.geometry.coordinates) {
      const k = `${c[0]},${c[1]}`;
      widthAt.set(k, Math.max(widthAt.get(k) ?? 0, w));
    }
  }
  const widths = Float32Array.from(route.coords, (c) => widthAt.get(`${c[0]},${c[1]}`) ?? 6);
  const path = new RoutePath(route, proj, vehicle, widths);
  const near = makeNearRoute(path, radius);

  // Roads
  const rw = new GeometryWriter();
  const major = new THREE.Color("#4f5357");
  const minor = new THREE.Color("#63676b");
  for (const f of roads.features) {
    const pts = f.geometry.coordinates.map((c) => proj.toLocal(c));
    if (!pts.some(([x, z]) => near(x, z))) continue;
    const width = ROAD_WIDTH[f.properties.highway] ?? 5;
    ribbon(rw, pts, width, 0.03, width >= 10 ? major : minor);
  }

  // Route highlight: a slim guide line in the rider's (left) lane.
  const routeW = new GeometryWriter();
  const routePts: [number, number][] = Array.from(path.xs, (x, i) => {
    const prev = Math.max(0, i - 1), next = Math.min(path.xs.length - 1, i + 1);
    const dx = path.xs[next] - path.xs[prev], dz = path.zs[next] - path.zs[prev];
    const len = Math.hypot(dx, dz) || 1;
    // left of travel (dx, dz) is (dz, -dx)
    return [x + (dz / len) * -HOME_LANE, path.zs[i] + (-dx / len) * -HOME_LANE];
  });
  ribbon(routeW, routePts, 1.1, 0.07, new THREE.Color("#22c48a"));

  // Buildings
  const walls = new GeometryWriter(true);
  const roofs = new GeometryWriter();
  const color = new THREE.Color();
  const tank = new THREE.Color("#3d4a57");
  const tankAlt = new THREE.Color("#2b6cb0");
  let count = 0;

  const addPolygon = (rings: Position[][], h: number, base: number, seed: number) => {
    const outer = rings[0].map((c) => proj.toLocal(c));
    if (outer.length < 4) return;
    if (!outer.some(([x, z]) => near(x, z))) return;
    count++;
    color.set(PALETTE[seed % PALETTE.length]);
    if (h > 40) color.lerp(TOWER, Math.min(0.7, (h - 40) / 80));
    const ring = outer.slice(0, -1);
    let area = 0;
    for (let i = 0; i < ring.length; i++) {
      const [x1, z1] = ring[i];
      const [x2, z2] = ring[(i + 1) % ring.length];
      area += x1 * z2 - x2 * z1;
    }
    if (area < 0) ring.reverse();

    // Random atlas offset per building so lit-window patterns differ.
    const offU = ((seed * 7) % 4) / 4;
    const offV = ((seed * 13) % 4) / 4;
    let perim = 0;
    for (let i = 0; i < ring.length; i++) {
      const [x1, z1] = ring[i];
      const [x2, z2] = ring[(i + 1) % ring.length];
      const len = Math.hypot(x2 - x1, z2 - z1) || 1;
      const n = [(z2 - z1) / len, 0, -(x2 - x1) / len];
      const shade = 0.86 + 0.14 * Math.abs(n[0]);
      const top = color.clone().multiplyScalar(shade);
      const bottom = top.clone().multiplyScalar(base > 0 ? 0.92 : 0.66);
      // Snap bays to whole windows along each wall so windows don't get sliced at corners.
      const bays = Math.max(1, Math.round(len / BAY_M));
      const u1 = offU + perim / 4;
      const u2 = u1 + bays / 4;
      const v1 = offV + base / FLOOR_M / 4;
      const v2 = offV + h / FLOOR_M / 4;
      walls.quadV(
        { p: [x1, base, z1], c: bottom, uv: [u1, v1] },
        { p: [x2, base, z2], c: bottom, uv: [u2, v1] },
        { p: [x2, h, z2], c: top, uv: [u2, v2] },
        { p: [x1, h, z1], c: top, uv: [u1, v2] },
        n,
      );
      perim += bays;
    }

    // Roof + parapet colour
    const shape = ring.map(([x, z]) => new THREE.Vector2(x, z));
    const tris = THREE.ShapeUtils.triangulateShape(shape, []);
    const roof = color.clone().multiplyScalar(0.9);
    for (const [a, b, c] of tris) roofs.tri([ring[a][0], h, ring[a][1]], [ring[b][0], h, ring[b][1]], [ring[c][0], h, ring[c][1]], [0, 1, 0], roof);

    // Rooftop water tank on many mid-rise buildings (a very Dhaka skyline detail).
    if (h >= 9 && seed % 5 < 3) {
      let cx = 0, cz = 0;
      for (const [x, z] of ring) {
        cx += x;
        cz += z;
      }
      cx /= ring.length;
      cz /= ring.length;
      const yaw = Math.atan2(ring[1][0] - ring[0][0], ring[1][1] - ring[0][1]);
      roofs.box(cx, h, cz, 1.6, 1.3, 1.6, yaw, seed % 3 === 0 ? tankAlt : tank);
      if (quality === "high") roofs.box(cx + 1.4, h, cz + 1.2, 1.2, 2.4, 1.2, yaw, color.clone().multiplyScalar(0.8)); // stair room
    }
  };

  buildings.features.forEach((f: Feature<Polygon | MultiPolygon, { h: number; mh?: number }>, i) => {
    const h = f.properties.h;
    const base = f.properties.mh ?? 0;
    if (f.geometry.type === "Polygon") addPolygon(f.geometry.coordinates, h, base, i);
    else for (const poly of f.geometry.coordinates) addPolygon(poly, h, base, i);
  });

  let maxR = 0;
  for (let i = 0; i < path.xs.length; i++) maxR = Math.max(maxR, Math.hypot(path.xs[i], path.zs[i]));

  const detail = buildStreetDetail(roads, proj, path, quality, opts.markets);

  return {
    path,
    proj,
    roads: rw.build(),
    route: routeW.build(),
    walls: walls.build(),
    roofs: roofs.build(),
    buildingCount: count,
    detail,
    traffic: new TrafficSim(roads, proj, path, quality),
    radius: maxR + radius + 200,
  };
}

// ---------------------------------------------------------------------------
// Time of day
// ---------------------------------------------------------------------------

export type TimeOfDay = "morning" | "noon" | "evening" | "night";
export const TIMES: TimeOfDay[] = ["morning", "noon", "evening", "night"];

export function timeOfDayNow(date = new Date()): TimeOfDay {
  const h = date.getHours();
  if (h >= 5 && h < 9) return "morning";
  if (h >= 9 && h < 16) return "noon";
  if (h >= 16 && h < 19) return "evening";
  return "night";
}

export interface Lighting {
  /** Sky colour overhead and at the horizon (horizon = haze). */
  zenith: string;
  horizon: string;
  fog: string;
  fogNear: number;
  fogFar: number;
  ground: string;
  sun: string;
  sunIntensity: number;
  sunDir: [number, number, number];
  hemiSky: string;
  hemiGround: string;
  hemiIntensity: number;
  headlight: boolean;
  /** 0..1: lit windows, street lamps, signs glowing. */
  nightGlow: number;
  /** Sun / moon disc colour. */
  disc: string;
}

// Dhaka air is rarely crystal clear: warm haze near the horizon at every time of day.
export const LIGHTING: Record<TimeOfDay, Lighting> = {
  morning: { zenith: "#8fb4d8", horizon: "#f2d6b3", fog: "#e9d3b8", fogNear: 90, fogFar: 520, ground: "#a3a088", sun: "#ffd6a0", sunIntensity: 1.8, sunDir: [80, 40, -30], hemiSky: "#ffe6c8", hemiGround: "#6b6656", hemiIntensity: 1.15, headlight: false, nightGlow: 0, disc: "#ffe2b0" },
  noon: { zenith: "#7fb2e0", horizon: "#dcdccf", fog: "#d6d6c8", fogNear: 110, fogFar: 600, ground: "#9da98a", sun: "#fffaf0", sunIntensity: 2.3, sunDir: [25, 100, 15], hemiSky: "#e3f0ff", hemiGround: "#707a62", hemiIntensity: 1.2, headlight: false, nightGlow: 0, disc: "#fffbe8" },
  evening: { zenith: "#5d6fa3", horizon: "#f1a46d", fog: "#d99a74", fogNear: 80, fogFar: 480, ground: "#8e8470", sun: "#ff9a58", sunIntensity: 1.5, sunDir: [-85, 22, 20], hemiSky: "#ffc59e", hemiGround: "#5e5045", hemiIntensity: 0.95, headlight: true, nightGlow: 0.55, disc: "#ffb070" },
  night: { zenith: "#070d22", horizon: "#24304f", fog: "#1a2340", fogNear: 60, fogFar: 420, ground: "#353d33", sun: "#9fb2ff", sunIntensity: 0.55, sunDir: [-30, 80, -40], hemiSky: "#7d90cc", hemiGround: "#2a2f24", hemiIntensity: 1.5, headlight: true, nightGlow: 1, disc: "#e8eeff" },
};
