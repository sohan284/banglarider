/**
 * In-browser routing: builds a directed road graph from roads.geojson,
 * snaps taps to the nearest usable road, runs A* (ngraph.path) and turns
 * the result into turn-by-turn steps. No network calls.
 */

import createGraph, { type Graph, type Link, type Node } from "ngraph.graph";
import { aStar } from "ngraph.path";
import type { FeatureCollection, LineString } from "geojson";
import type { LngLat } from "@/config/areas";

// ---------------------------------------------------------------------------
// Vehicles
// ---------------------------------------------------------------------------

export type Vehicle = "motorcycle" | "bicycle";

export const VEHICLES: Record<Vehicle, { avgKmh: number; minKmh: number; maxKmh: number }> = {
  // avgKmh drives the time estimate (typical Dhaka traffic); min/max bound the ride-mode speed slider.
  motorcycle: { avgKmh: 18, minKmh: 10, maxKmh: 60 },
  bicycle: { avgKmh: 12, minKmh: 5, maxKmh: 25 },
};

// ---------------------------------------------------------------------------
// Road data (shape written by scripts/prepare-area.ts)
// ---------------------------------------------------------------------------

export interface RoadProps {
  id: number;
  name?: string;
  name_bn?: string;
  highway: string;
  oneway: 1 | -1 | 0;
  bike_contraflow?: true;
  motor: boolean;
  bike: boolean;
}
export type Roads = FeatureCollection<LineString, RoadProps>;

interface NodeData {
  lng: number;
  lat: number;
}
interface LinkData {
  len: number;
  road: number; // index into roads.features, -1 for virtual links
  motor: boolean;
  bike: boolean;
}

export interface RoadGraph {
  graph: Graph<NodeData, LinkData>;
  roads: Roads;
  /** Flat segment list for nearest-road snapping. */
  segments: { a: number; b: number; road: number; ab: Mode; ba: Mode }[];
}
type Mode = { motor: boolean; bike: boolean };

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

const R = 6371008.8;
const RAD = Math.PI / 180;

export function distanceM(a: LngLat, b: LngLat): number {
  const dLat = (b[1] - a[1]) * RAD;
  const dLng = (b[0] - a[0]) * RAD;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Compass bearing a→b in degrees (0 = north, clockwise). */
export function bearing(a: LngLat, b: LngLat): number {
  const y = Math.sin((b[0] - a[0]) * RAD) * Math.cos(b[1] * RAD);
  const x = Math.cos(a[1] * RAD) * Math.sin(b[1] * RAD) - Math.sin(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.cos((b[0] - a[0]) * RAD);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

/** Projects p onto segment a-b (local equirectangular approximation). t in [0,1]. */
function project(p: LngLat, a: LngLat, b: LngLat): { t: number; point: LngLat; dist: number } {
  const k = Math.cos(p[1] * RAD);
  const ax = a[0] * k, ay = a[1], bx = b[0] * k, by = b[1], px = p[0] * k, py = p[1];
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  const point: LngLat = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  return { t, point, dist: distanceM(p, point) };
}

// ---------------------------------------------------------------------------
// Graph construction
// ---------------------------------------------------------------------------

export function buildGraph(roads: Roads): RoadGraph {
  const graph = createGraph<NodeData, LinkData>();
  const ids = new Map<string, number>();
  const segments: RoadGraph["segments"] = [];

  const nodeId = (c: number[]): number => {
    const key = `${c[0]},${c[1]}`;
    let id = ids.get(key);
    if (id === undefined) {
      id = ids.size;
      ids.set(key, id);
      graph.addNode(id, { lng: c[0], lat: c[1] });
    }
    return id;
  };

  const addDirected = (from: number, to: number, len: number, road: number, mode: Mode) => {
    if (!mode.motor && !mode.bike) return;
    const existing = graph.getLink(from, to);
    if (existing) {
      // Two ways share this segment (rare). Merge so no permission is lost.
      const d = existing.data;
      existing.data = { len: Math.min(d.len, len), road: d.motor ? d.road : road, motor: d.motor || mode.motor, bike: d.bike || mode.bike };
      return;
    }
    graph.addLink(from, to, { len, road, ...mode });
  };

  roads.features.forEach((f, roadIdx) => {
    const p = f.properties;
    const fwd: Mode = { motor: p.motor && p.oneway !== -1, bike: p.bike && (p.oneway !== -1 || !!p.bike_contraflow) };
    const rev: Mode = { motor: p.motor && p.oneway !== 1, bike: p.bike && (p.oneway !== 1 || !!p.bike_contraflow) };
    const cs = f.geometry.coordinates;
    for (let i = 1; i < cs.length; i++) {
      const a = nodeId(cs[i - 1]);
      const b = nodeId(cs[i]);
      if (a === b) continue;
      const len = distanceM(cs[i - 1] as LngLat, cs[i] as LngLat);
      addDirected(a, b, len, roadIdx, fwd);
      addDirected(b, a, len, roadIdx, rev);
      segments.push({ a, b, road: roadIdx, ab: fwd, ba: rev });
    }
  });

  return { graph, roads, segments };
}

const allowed = (m: Mode, v: Vehicle) => (v === "motorcycle" ? m.motor : m.bike);
const lngLatOf = (n: Node<NodeData>): LngLat => [n.data.lng, n.data.lat];

// ---------------------------------------------------------------------------
// Snapping
// ---------------------------------------------------------------------------

export interface Snap {
  point: LngLat;
  /** Distance from the tapped point to the road, metres. */
  dist: number;
  segment: RoadGraph["segments"][number];
  t: number;
  roadName: { en?: string; bn?: string };
}

/**
 * Nearest usable road segments to p, closest first, at most one per road.
 * Several candidates let routing recover when the closest road is a dead end
 * (e.g. a one-way street leaving the area).
 */
export function snapCandidates(rg: RoadGraph, p: LngLat, vehicle: Vehicle, max = 4, within = MAX_SNAP_M): Snap[] {
  const bestPerRoad = new Map<number, Snap>();
  const latSlack = (within + 50) / 111_000;
  for (const s of rg.segments) {
    if (!allowed(s.ab, vehicle) && !allowed(s.ba, vehicle)) continue;
    const a = rg.graph.getNode(s.a)!.data;
    const b = rg.graph.getNode(s.b)!.data;
    if (Math.min(a.lat, b.lat) - latSlack > p[1] || Math.max(a.lat, b.lat) + latSlack < p[1]) continue;
    const pr = project(p, [a.lng, a.lat], [b.lng, b.lat]);
    if (pr.dist > within) continue;
    const prev = bestPerRoad.get(s.road);
    if (!prev || pr.dist < prev.dist) {
      const props = rg.roads.features[s.road].properties;
      bestPerRoad.set(s.road, { point: pr.point, dist: pr.dist, segment: s, t: pr.t, roadName: { en: props.name, bn: props.name_bn } });
    }
  }
  return [...bestPerRoad.values()].sort((x, y) => x.dist - y.dist).slice(0, max);
}

export function snapToRoad(rg: RoadGraph, p: LngLat, vehicle: Vehicle): Snap | null {
  return snapCandidates(rg, p, vehicle, 1)[0] ?? null;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

export type Maneuver =
  | "depart"
  | "arrive"
  | "continue"
  | "slight-left"
  | "slight-right"
  | "left"
  | "right"
  | "sharp-left"
  | "sharp-right"
  | "uturn";

export interface Step {
  maneuver: Maneuver;
  road: { en?: string; bn?: string };
  /** Metres from this step to the next one. */
  distance: number;
  location: LngLat;
  /** Heading after the maneuver (for "head north" on depart). */
  bearingAfter: number;
  /** Index into Route.coords where this step starts. */
  coordIndex: number;
}

export interface Route {
  coords: LngLat[];
  /** Cumulative distance (m) at each coordinate. */
  cumDist: number[];
  distance: number;
  /** Seconds, at the vehicle's average speed. */
  duration: number;
  steps: Step[];
}

export type RouteErrorCode = "too-far" | "no-route" | "same-point";
export class RouteError extends Error {
  constructor(public code: RouteErrorCode, public which?: "start" | "end") {
    super(code);
  }
}

/** Max distance (m) between a tap and the road it snaps to. */
export const MAX_SNAP_M = 150;

const START = "__start";
const END = "__end";

export function findRoute(rg: RoadGraph, from: LngLat, to: LngLat, vehicle: Vehicle): Route {
  const starts = snapCandidates(rg, from, vehicle);
  if (!starts.length) throw new RouteError("too-far", "start");
  const ends = snapCandidates(rg, to, vehicle);
  if (!ends.length) throw new RouteError("too-far", "end");
  if (distanceM(starts[0].point, ends[0].point) < 5) throw new RouteError("same-point");

  // Try the nearest roads first; fall back to the next-nearest ones if they are dead ends.
  const attempts: [Snap, Snap][] = [];
  for (let sum = 0; sum < starts.length + ends.length - 1; sum++)
    for (let i = 0; i <= sum; i++) if (starts[i] && ends[sum - i]) attempts.push([starts[i], ends[sum - i]]);
  for (const [s, e] of attempts.slice(0, 10)) {
    const route = routeBetween(rg, s, e, vehicle);
    if (route) return route;
  }
  throw new RouteError("no-route");
}

function routeBetween(rg: RoadGraph, s: Snap, e: Snap, vehicle: Vehicle): Route | null {
  const g = rg.graph;
  const virtual = (id: string, p: LngLat) => g.addNode(id as unknown as number, { lng: p[0], lat: p[1] });
  const startId = START as unknown as number;
  const endId = END as unknown as number;
  const link = (a: number, b: number, len: number, road: number, mode: Mode) => g.addLink(a, b, { len, road, ...mode });

  try {
    virtual(START, s.point);
    virtual(END, e.point);
    const sa = lngLatOf(g.getNode(s.segment.a)!);
    const sb = lngLatOf(g.getNode(s.segment.b)!);
    const ea = lngLatOf(g.getNode(e.segment.a)!);
    const eb = lngLatOf(g.getNode(e.segment.b)!);

    // From the snapped start, we may leave toward whichever segment end the road direction allows.
    link(startId, s.segment.b, distanceM(s.point, sb), s.segment.road, s.segment.ab);
    link(startId, s.segment.a, distanceM(s.point, sa), s.segment.road, s.segment.ba);
    // We may arrive at the snapped end from whichever end the road direction allows.
    link(e.segment.a, endId, distanceM(ea, e.point), e.segment.road, e.segment.ab);
    link(e.segment.b, endId, distanceM(eb, e.point), e.segment.road, e.segment.ba);
    // Both points on the same segment: direct link if the direction allows it.
    if (s.segment === e.segment) {
      const mode = e.t > s.t ? s.segment.ab : s.segment.ba;
      link(startId, endId, distanceM(s.point, e.point), s.segment.road, mode);
    }

    const finder = aStar<NodeData, LinkData>(g, {
      oriented: true,
      distance: (_a, _b, l) => l.data.len,
      heuristic: (a, b) => distanceM(lngLatOf(a), lngLatOf(b)),
      blocked: (_a, _b, l) => !allowed(l.data, vehicle),
    });
    const path = finder.find(startId, endId).reverse(); // ngraph returns end → start
    if (path.length < 2) return null;

    // Resolve which link was used between consecutive nodes (to know the road).
    const coords: LngLat[] = [];
    const roadOfEdge: number[] = [];
    for (let i = 0; i < path.length; i++) {
      coords.push(lngLatOf(path[i]));
      if (i > 0) {
        const l = g.getLink(path[i - 1].id, path[i].id) as Link<LinkData> | undefined;
        roadOfEdge.push(l ? l.data.road : -1);
      }
    }
    return buildRoute(rg, coords, roadOfEdge, vehicle);
  } finally {
    if (g.getNode(startId)) g.removeNode(startId);
    if (g.getNode(endId)) g.removeNode(endId);
  }
}

// ---------------------------------------------------------------------------
// Turn-by-turn
// ---------------------------------------------------------------------------

function classify(delta: number): Maneuver {
  // delta: signed turn angle in degrees, positive = right.
  const a = Math.abs(delta);
  const side = delta > 0 ? "right" : "left";
  if (a < 25) return "continue";
  if (a < 55) return `slight-${side}` as Maneuver;
  if (a < 125) return side as Maneuver;
  if (a < 165) return `sharp-${side}` as Maneuver;
  return "uturn";
}

/** Bearing over ~20 m around index i, looking back (dir=-1) or ahead (dir=1). */
function localBearing(coords: LngLat[], cum: number[], i: number, dir: 1 | -1): number {
  let j = i;
  while (j + dir >= 0 && j + dir < coords.length && Math.abs(cum[j + dir] - cum[i]) < 20) j += dir;
  if (j + dir >= 0 && j + dir < coords.length && j === i) j += dir;
  return dir === 1 ? bearing(coords[i], coords[j]) : bearing(coords[j], coords[i]);
}

function buildRoute(rg: RoadGraph, coords: LngLat[], roadOfEdge: number[], vehicle: Vehicle): Route {
  const cumDist = [0];
  for (let i = 1; i < coords.length; i++) cumDist.push(cumDist[i - 1] + distanceM(coords[i - 1], coords[i]));
  const distance = cumDist[cumDist.length - 1];

  // Group consecutive edges by road name ("" = unnamed).
  const nameOf = (road: number) => (road >= 0 ? rg.roads.features[road].properties : undefined);
  interface Group { start: number; end: number; name: { en?: string; bn?: string } }
  const groups: Group[] = [];
  roadOfEdge.forEach((road, edge) => {
    const p = nameOf(road);
    const name = { en: p?.name, bn: p?.name_bn };
    const last = groups[groups.length - 1];
    if (last && (last.name.en ?? "") === (name.en ?? "")) last.end = edge + 1;
    else groups.push({ start: edge, end: edge + 1, name });
  });

  // Fold very short groups (driveways, junction slivers) into the previous one,
  // unless the turn there is significant.
  const merged: Group[] = [];
  for (const g of groups) {
    const len = cumDist[g.end] - cumDist[g.start];
    const prev = merged[merged.length - 1];
    if (prev && len < 25) {
      prev.end = g.end;
      continue;
    }
    if (prev && (prev.name.en ?? "") === (g.name.en ?? "")) {
      prev.end = g.end;
      continue;
    }
    merged.push({ ...g });
  }

  const steps: Step[] = merged.map((g, i) => {
    const at = g.start;
    const out = localBearing(coords, cumDist, at, 1);
    let maneuver: Maneuver = "depart";
    if (i > 0) {
      const inb = localBearing(coords, cumDist, at, -1);
      const delta = ((out - inb + 540) % 360) - 180;
      maneuver = classify(delta);
    }
    return {
      maneuver,
      road: g.name,
      distance: cumDist[g.end] - cumDist[g.start],
      location: coords[at],
      bearingAfter: out,
      coordIndex: at,
    };
  });
  steps.push({
    maneuver: "arrive",
    road: merged[merged.length - 1]?.name ?? {},
    distance: 0,
    location: coords[coords.length - 1],
    bearingAfter: 0,
    coordIndex: coords.length - 1,
  });

  const duration = distance / ((VEHICLES[vehicle].avgKmh * 1000) / 3600);
  return { coords, cumDist, distance, duration, steps };
}
