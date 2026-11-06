"use client";

/**
 * Ambient Dhaka traffic (simulated, not live data): cycle rickshaws, CNG
 * auto-rickshaws, cars, microbuses, buses and motorbikes driving on the left
 * along the real road network, respecting one-way streets, following each
 * other, stopping (and honking) when the rider is in the way, and respawning
 * around the rider. Plus parked vehicles along side streets.
 *
 * Each vehicle type is two instanced meshes (tinted body + fixed-colour trim),
 * so all traffic costs 12 draw calls.
 */

import { useFrame } from "@react-three/fiber";
import { useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { Roads } from "@/lib/routing";
import { angleDiff, makeNearRoute, ROAD_WIDTH, type Projector, type Quality, type RoutePath } from "@/ride/rideWorld";

export type TrafficKind = "rickshaw" | "cng" | "car" | "microbus" | "bus" | "motorbike";
export const TRAFFIC_KINDS: TrafficKind[] = ["rickshaw", "cng", "car", "microbus", "bus", "motorbike"];

interface KindSpec {
  len: number;
  width: number;
  /** Speed range, m/s. */
  v: [number, number];
  tints: string[];
  /** Spawn weights on main roads / side streets. */
  wMajor: number;
  wMinor: number;
}

export const KIND: Record<TrafficKind, KindSpec> = {
  rickshaw: { len: 2.7, width: 1.15, v: [2.8, 4.2], tints: ["#d62828", "#1d4ed8", "#f4c20d", "#16a34a", "#db2777", "#f97316"], wMajor: 0.08, wMinor: 0.4 },
  cng: { len: 2.8, width: 1.4, v: [6, 10], tints: ["#2e7d32", "#388e3c", "#1b5e20", "#43a047"], wMajor: 0.22, wMinor: 0.18 },
  car: { len: 4.4, width: 1.76, v: [7, 13], tints: ["#f4f4f2", "#f4f4f2", "#c9ccd0", "#1b1b1b", "#8b1e2b", "#1f4fa0", "#6b6f73"], wMajor: 0.3, wMinor: 0.22 },
  microbus: { len: 4.7, width: 1.75, v: [7, 12], tints: ["#f4f4f2", "#f4f4f2", "#c9ccd0", "#2b2b2b"], wMajor: 0.1, wMinor: 0.07 },
  bus: { len: 10.5, width: 2.5, v: [5, 9], tints: ["#c62828", "#2e7d32", "#1565c0", "#ef6c00", "#6a1b9a", "#00838f"], wMajor: 0.12, wMinor: 0 },
  motorbike: { len: 2.0, width: 0.8, v: [8, 14], tints: ["#c8102e", "#151515", "#1f4fa0", "#f2f2f2"], wMajor: 0.18, wMinor: 0.13 },
};

export interface Lane {
  pts: Float32Array;
  cum: Float32Array;
  len: number;
  startKey: string;
  endKey: string;
  road: number;
  dir: 1 | -1;
  major: boolean;
  bbox: [number, number, number, number];
}

export interface TrafficVehicle {
  kind: TrafficKind;
  lane: number;
  s: number;
  v: number;
  vMax: number;
  next: number;
  /** Simulated position and heading. */
  x: number;
  z: number;
  yaw: number;
  /** Smoothed display position (hides small jumps between lanes). */
  dx: number;
  dz: number;
  dyaw: number;
  parked: boolean;
  tint: THREE.Color;
  blockedT: number;
  honkT: number;
}

export type HonkHandler = (kind: TrafficKind, x: number, z: number) => void;

function rnd(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export class TrafficSim {
  lanes: Lane[] = [];
  vehicles: TrafficVehicle[] = [];
  private byStart = new Map<string, number[]>();
  private nearLanes: number[] = [];
  private nearT = 99;
  private random = rnd(20261106);

  constructor(roads: Roads, proj: Projector, path: RoutePath, quality: Quality) {
    const near = makeNearRoute(path, quality === "high" ? 260 : 190);
    roads.features.forEach((f, roadIdx) => {
      const p = f.properties;
      if (!p.motor || ["service", "track", "path", "cycleway"].includes(p.highway)) return;
      const pts = f.geometry.coordinates.map((c) => proj.toLocal(c));
      if (!pts.some(([x, z]) => near(x, z))) return;
      const w = ROAD_WIDTH[p.highway] ?? 5;
      const major = w >= 10;
      const keys = f.geometry.coordinates.map((c) => `${c[0]},${c[1]}`);
      const dirs: (1 | -1)[] = p.oneway === 1 ? [1] : p.oneway === -1 ? [-1] : [1, -1];
      const oneway = dirs.length === 1;
      const n = oneway ? (w >= 8 ? 2 : 1) : w >= 10 ? 2 : 1;
      const laneW = oneway ? Math.min(3.2, w / n) : Math.min(3.2, w / 2 / n);
      for (const dir of dirs) {
        const seq = dir === 1 ? pts : [...pts].reverse();
        const kseq = dir === 1 ? keys : [...keys].reverse();
        for (let k = 0; k < n; k++) {
          // Left-hand traffic: lanes sit to the LEFT of the direction of travel.
          const off = oneway ? (k - (n - 1) / 2) * laneW : laneW * (k + 0.5);
          this.addLane(offsetLine(seq, off), kseq[0], kseq[kseq.length - 1], roadIdx, dir, major);
        }
      }
    });

    // Vehicles
    const high = quality === "high";
    const moving = high ? 120 : 55;
    const start = path.point(0);
    this.refreshNear(start[0], start[1], true);
    let tries = 0;
    while (this.vehicles.length < moving && tries++ < moving * 20) {
      const v = this.spawn(start[0], start[1], 12, 320);
      if (v) this.vehicles.push(v);
    }
    // Parked rickshaws / cars / CNGs along side streets near the route
    const parked = high ? 60 : 25;
    let placed = 0;
    for (let i = 0; i < this.lanes.length && placed < parked; i++) {
      const lane = this.lanes[i];
      if (lane.major) continue;
      for (let s = 15 + this.random() * 40; s < lane.len - 10 && placed < parked; s += 45 + this.random() * 90) {
        const r = this.random();
        const kind: TrafficKind = r < 0.5 ? "rickshaw" : r < 0.8 ? "car" : "cng";
        const pos = this.at(i, s);
        // Pull over to the kerb: a bit further left than the lane centre.
        const lx = -Math.cos(pos.yaw), lz = Math.sin(pos.yaw);
        const kerb = kind === "rickshaw" ? 1.0 : 0.9;
        const x = pos.x + lx * kerb, z = pos.z + lz * kerb;
        if (!near(x, z)) continue;
        const spec = KIND[kind];
        this.vehicles.push({
          kind, lane: i, s, v: 0, vMax: 0, next: -1, x, z, yaw: pos.yaw + (this.random() - 0.5) * 0.15,
          dx: x, dz: z, dyaw: pos.yaw, parked: true, tint: new THREE.Color(spec.tints[Math.floor(this.random() * spec.tints.length)]), blockedT: 0, honkT: 0,
        });
        placed++;
      }
    }
  }

  private addLane(pts: [number, number][], startKey: string, endKey: string, road: number, dir: 1 | -1, major: boolean) {
    if (pts.length < 2) return;
    const arr = new Float32Array(pts.length * 2);
    const cum = new Float32Array(pts.length);
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    pts.forEach(([x, z], i) => {
      arr[i * 2] = x;
      arr[i * 2 + 1] = z;
      if (i) cum[i] = cum[i - 1] + Math.hypot(x - pts[i - 1][0], z - pts[i - 1][1]);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    });
    const len = cum[cum.length - 1];
    if (len < 8) return;
    const id = this.lanes.length;
    this.lanes.push({ pts: arr, cum, len, startKey, endKey, road, dir, major, bbox: [minX, minZ, maxX, maxZ] });
    (this.byStart.get(startKey) ?? this.byStart.set(startKey, []).get(startKey)!).push(id);
  }

  /** Position and heading at distance s along a lane. */
  at(laneId: number, s: number): { x: number; z: number; yaw: number } {
    const l = this.lanes[laneId];
    const d = Math.max(0, Math.min(s, l.len));
    let lo = 0, hi = l.cum.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (l.cum[mid] <= d) lo = mid;
      else hi = mid;
    }
    const seg = l.cum[hi] - l.cum[lo] || 1;
    const t = (d - l.cum[lo]) / seg;
    const x1 = l.pts[lo * 2], z1 = l.pts[lo * 2 + 1], x2 = l.pts[hi * 2], z2 = l.pts[hi * 2 + 1];
    return { x: x1 + (x2 - x1) * t, z: z1 + (z2 - z1) * t, yaw: Math.atan2(-(x2 - x1), -(z2 - z1)) };
  }

  private refreshNear(rx: number, rz: number, force = false) {
    if (!force && this.nearT < 1.5) return;
    this.nearT = 0;
    const R = 330;
    this.nearLanes = [];
    this.lanes.forEach((l, i) => {
      const [a, b, c, d] = l.bbox;
      if (rx > a - R && rx < c + R && rz > b - R && rz < d + R) this.nearLanes.push(i);
    });
  }

  private pickKind(major: boolean): TrafficKind {
    let r = this.random() * TRAFFIC_KINDS.reduce((s, k) => s + (major ? KIND[k].wMajor : KIND[k].wMinor), 0);
    for (const k of TRAFFIC_KINDS) {
      r -= major ? KIND[k].wMajor : KIND[k].wMinor;
      if (r <= 0) return k;
    }
    return "car";
  }

  /** A new vehicle (or a respawn spot) between minD and maxD from the rider. */
  private spawn(rx: number, rz: number, minD: number, maxD: number, kind?: TrafficKind): TrafficVehicle | null {
    if (!this.nearLanes.length) return null;
    for (let t = 0; t < 25; t++) {
      const lane = this.nearLanes[Math.floor(this.random() * this.nearLanes.length)];
      const L = this.lanes[lane];
      const k = kind ?? this.pickKind(L.major);
      if (k === "bus" && !L.major) continue;
      const s = this.random() * L.len;
      const p = this.at(lane, s);
      const d = Math.hypot(p.x - rx, p.z - rz);
      if (d < minD || d > maxD) continue;
      if (this.vehicles.some((o) => o.lane === lane && Math.abs(o.s - s) < 14)) continue;
      const spec = KIND[k];
      const vMax = spec.v[0] + this.random() * (spec.v[1] - spec.v[0]);
      return {
        kind: k, lane, s, v: vMax * 0.8, vMax, next: -1, x: p.x, z: p.z, yaw: p.yaw, dx: p.x, dz: p.z, dyaw: p.yaw,
        parked: false, tint: new THREE.Color(spec.tints[Math.floor(this.random() * spec.tints.length)]), blockedT: 0, honkT: 2 + this.random() * 4,
      };
    }
    return null;
  }

  private chooseNext(v: TrafficVehicle): number {
    const L = this.lanes[v.lane];
    const options = (this.byStart.get(L.endKey) ?? []).filter((id) => {
      const o = this.lanes[id];
      if (o.road === L.road && o.dir !== L.dir) return false; // no U-turns
      if (v.kind === "bus" && !o.major) return false;
      return true;
    });
    if (!options.length) return -2;
    const endYaw = this.at(v.lane, L.len).yaw;
    const weights = options.map((id) => 0.25 + Math.max(0, Math.cos(angleDiff(this.at(id, 1).yaw, endYaw))) ** 2);
    let r = this.random() * weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < options.length; i++) {
      r -= weights[i];
      if (r <= 0) return options[i];
    }
    return options[0];
  }

  update(dt: number, rider: { x: number; z: number }, onHonk?: HonkHandler) {
    this.nearT += dt;
    this.refreshNear(rider.x, rider.z);

    // Leaders per lane
    const byLane = new Map<number, TrafficVehicle[]>();
    for (const v of this.vehicles) {
      if (v.parked) continue;
      (byLane.get(v.lane) ?? byLane.set(v.lane, []).get(v.lane)!).push(v);
    }
    for (const list of byLane.values()) list.sort((a, b) => a.s - b.s);

    for (const v of this.vehicles) {
      if (v.parked) continue;
      const L = this.lanes[v.lane];
      const spec = KIND[v.kind];
      let desired = v.vMax;

      // Car following
      const list = byLane.get(v.lane)!;
      const idx = list.indexOf(v);
      let leader: TrafficVehicle | undefined = list[idx + 1];
      let gap = leader ? leader.s - v.s : Infinity;
      if (!leader && v.next >= 0) {
        const nl = byLane.get(v.next);
        if (nl?.length) {
          leader = nl[0];
          gap = L.len - v.s + leader.s;
        }
      }
      if (leader) {
        const clear = gap - (leader.kind === v.kind ? spec.len : (spec.len + KIND[leader.kind].len) / 2) - 2.5;
        const safe = 2 + v.v * 1.1;
        if (clear < safe) desired = Math.min(desired, Math.max(0, leader.v + (clear - 1) * 0.8));
      }

      // Slow down for turns at the end of the lane
      if (v.next === -1 && v.s > L.len - 20) v.next = this.chooseNext(v);
      if (v.next >= 0 && v.s > L.len - 14) {
        const turn = Math.abs(angleDiff(this.at(v.next, 2).yaw, v.yaw));
        if (turn > 0.6) desired = Math.min(desired, 3.5 + (1 - turn / Math.PI) * 3);
      }

      // Stop for the rider (and honk if kept waiting)
      const fx = -Math.sin(v.yaw), fz = -Math.cos(v.yaw);
      const rx = rider.x - v.x, rz = rider.z - v.z;
      const f = rx * fx + rz * fz;
      const lat = Math.abs(rx * fz - rz * fx);
      if (f > 0 && f < 14 + spec.len / 2 && lat < spec.width / 2 + 0.7) {
        desired = Math.min(desired, Math.max(0, (f - spec.len / 2 - 3) * 0.8));
        v.blockedT += dt;
      } else v.blockedT = 0;
      v.honkT -= dt;
      if (v.blockedT > 1.2 && v.honkT <= 0) {
        onHonk?.(v.kind, v.x, v.z);
        v.honkT = 4 + this.random() * 5;
      }

      // Integrate speed
      const dv = desired - v.v;
      v.v = Math.max(0, v.v + Math.max(-6 * dt, Math.min((v.kind === "bus" ? 1.2 : 2.2) * dt, dv)));
      v.s += v.v * dt;

      if (v.s >= L.len) {
        if (v.next >= 0) {
          v.s -= L.len;
          v.lane = v.next;
          v.next = -1;
        } else {
          this.respawn(v, rider);
          continue;
        }
      }
      const p = this.at(v.lane, v.s);
      v.x = p.x;
      v.z = p.z;
      v.yaw = p.yaw;
      const k = Math.min(1, dt * 8);
      v.dx += (v.x - v.dx) * k;
      v.dz += (v.z - v.dz) * k;
      v.dyaw += angleDiff(v.yaw, v.dyaw) * Math.min(1, dt * 6);

      if (Math.hypot(v.x - rider.x, v.z - rider.z) > 360) this.respawn(v, rider);
    }
  }

  private respawn(v: TrafficVehicle, rider: { x: number; z: number }) {
    const n = this.spawn(rider.x, rider.z, 130, 320, v.kind);
    if (!n) {
      v.v = 0;
      return;
    }
    Object.assign(v, { lane: n.lane, s: n.s, v: n.v, next: -1, x: n.x, z: n.z, yaw: n.yaw, dx: n.x, dz: n.z, dyaw: n.yaw, blockedT: 0 });
  }
}

/** Polyline offset to the left by `off` metres (averaged vertex normals). */
function offsetLine(pts: [number, number][], off: number): [number, number][] {
  if (off === 0) return pts.map((p) => [p[0], p[1]]);
  const n = pts.length;
  return pts.map(([x, z], i) => {
    const [ax, az] = pts[Math.max(0, i - 1)];
    const [bx, bz] = pts[Math.min(n - 1, i + 1)];
    let dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len;
    dz /= len;
    // left of travel direction (dx, dz) is (dz, -dx)
    return [x + dz * off, z - dx * off];
  });
}

// ---------------------------------------------------------------------------
// Vehicle geometry (local: forward = -z, ground at y = 0)
// ---------------------------------------------------------------------------

class Parts {
  tint: THREE.BufferGeometry[] = [];
  trim: THREE.BufferGeometry[] = [];
  private add(g: THREE.BufferGeometry, color: string | null, shade = 1) {
    const geo = g.index ? g.toNonIndexed() : g;
    geo.deleteAttribute("uv");
    const c = new THREE.Color(color ?? "#ffffff").multiplyScalar(color ? 1 : shade);
    const n = geo.getAttribute("position").count;
    const cols = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) cols.set([c.r, c.g, c.b], i * 3);
    geo.setAttribute("color", new THREE.BufferAttribute(cols, 3));
    (color ? this.trim : this.tint).push(geo);
  }
  /** color null = tinted per vehicle. */
  box(sx: number, sy: number, sz: number, x: number, y: number, z: number, color: string | null, rx = 0, shade = 1) {
    const g = new THREE.BoxGeometry(sx, sy, sz);
    if (rx) g.rotateX(rx);
    g.translate(x, y, z);
    this.add(g, color, shade);
  }
  wheel(r: number, w: number, x: number, z: number) {
    const g = new THREE.CylinderGeometry(r, r, w, 10);
    g.rotateZ(Math.PI / 2);
    g.translate(x, r, z);
    this.add(g, "#161616");
  }
  cyl(r: number, l: number, x: number, y: number, z: number, color: string | null, axis: "x" | "y" | "z" = "y") {
    const g = new THREE.CylinderGeometry(r, r, l, 8);
    if (axis === "x") g.rotateZ(Math.PI / 2);
    if (axis === "z") g.rotateX(Math.PI / 2);
    g.translate(x, y, z);
    this.add(g, color);
  }
  /** Half-cylinder hood (rickshaw canopy), open at front. */
  hood(r: number, l: number, y: number, z: number) {
    const g = new THREE.CylinderGeometry(r, r, l, 12, 1, true, -Math.PI / 2, Math.PI);
    g.rotateZ(Math.PI / 2);
    g.translate(0, y, z);
    this.add(g, null);
  }
  build() {
    const merge = (list: THREE.BufferGeometry[]) => (list.length ? mergeGeometries(list) : new THREE.BufferGeometry());
    return { tint: merge(this.tint), trim: merge(this.trim) };
  }
}

const GLASS = "#25313b";
const DARK = "#222";
const LIGHT = "#fff2c4";
const RED = "#b3121a";

function buildKind(kind: TrafficKind) {
  const p = new Parts();
  switch (kind) {
    case "rickshaw": {
      p.wheel(0.34, 0.05, 0, -1.05);
      p.wheel(0.34, 0.05, -0.55, 0.55);
      p.wheel(0.34, 0.05, 0.55, 0.55);
      p.box(0.06, 0.06, 1.4, 0, 0.55, -0.35, "#3a3a3a"); // frame
      p.box(1.1, 0.06, 0.06, 0, 0.36, 0.55, "#3a3a3a"); // rear axle
      p.box(0.98, 0.14, 0.55, 0, 0.82, 0.45, "#7b1d1d"); // passenger seat
      p.box(0.98, 0.5, 0.08, 0, 1.06, 0.74, null); // back panel (rickshaw art)
      p.box(0.98, 0.3, 0.5, 0, 0.6, 0.45, null, 0, 0.85); // body box
      p.hood(0.55, 1.05, 1.32, 0.55); // folding hood
      p.box(0.2, 0.06, 0.3, 0, 0.98, -0.55, "#222"); // puller seat
      p.box(0.5, 0.03, 0.03, 0, 1.06, -1.0, "#3a3a3a"); // handlebar
      // puller: torso, head, lungi
      p.box(0.32, 0.5, 0.2, 0, 1.3, -0.62, "#d9d2c3", -0.25);
      p.cyl(0.11, 0.2, 0, 1.68, -0.7, "#5a3b2a");
      p.box(0.34, 0.32, 0.26, 0, 0.88, -0.6, "#1e5aa8");
      break;
    }
    case "cng": {
      p.wheel(0.24, 0.12, 0, -1.0);
      p.wheel(0.24, 0.12, -0.58, 0.68);
      p.wheel(0.24, 0.12, 0.58, 0.68);
      p.box(1.3, 0.7, 2.0, 0, 0.62, 0.3, null); // body
      p.box(0.9, 0.6, 0.7, 0, 0.6, -0.95, null, 0.25); // nose
      p.box(1.36, 0.06, 2.2, 0, 1.72, 0.15, DARK); // roof canopy
      p.box(1.32, 0.75, 0.06, 0, 1.33, 1.2, DARK); // back canvas
      p.box(1.0, 0.45, 0.04, 0, 1.33, -0.62, GLASS, 0.15); // windshield
      p.box(0.06, 0.75, 1.0, -0.64, 1.33, 0.55, "#4b5560"); // side mesh doors
      p.box(0.06, 0.75, 1.0, 0.64, 1.33, 0.55, "#4b5560");
      p.box(0.14, 0.1, 0.04, 0, 0.82, -1.32, LIGHT);
      p.box(0.25, 0.08, 0.03, 0, 0.75, 1.32, RED);
      break;
    }
    case "car": {
      for (const [x, z] of [[-0.78, -1.35], [0.78, -1.35], [-0.78, 1.35], [0.78, 1.35]]) p.wheel(0.32, 0.22, x, z);
      p.box(1.76, 0.62, 4.4, 0, 0.6, 0, null); // lower body
      p.box(1.56, 0.5, 2.3, 0, 1.15, 0.15, null, 0, 0.95); // cabin
      p.box(1.6, 0.38, 2.15, 0, 1.15, 0.15, GLASS); // window band
      p.box(1.5, 0.42, 0.05, 0, 1.12, -1.0, GLASS, 0.55); // windshield
      p.box(1.84, 0.12, 0.2, 0, 0.42, -2.18, "#2b2b2b"); // bumpers
      p.box(1.84, 0.12, 0.2, 0, 0.42, 2.18, "#2b2b2b");
      for (const x of [-0.6, 0.6]) {
        p.box(0.32, 0.12, 0.04, x, 0.72, -2.21, LIGHT);
        p.box(0.32, 0.12, 0.04, x, 0.75, 2.21, RED);
      }
      break;
    }
    case "microbus": {
      for (const [x, z] of [[-0.78, -1.5], [0.78, -1.5], [-0.78, 1.45], [0.78, 1.45]]) p.wheel(0.31, 0.22, x, z);
      p.box(1.72, 1.55, 4.7, 0, 1.1, 0, null);
      p.box(1.76, 0.5, 3.6, 0, 1.45, 0.4, GLASS); // side windows
      p.box(1.55, 0.6, 0.05, 0, 1.4, -2.36, GLASS, 0.3); // windshield
      p.box(1.8, 0.14, 0.2, 0, 0.4, -2.38, "#2b2b2b");
      for (const x of [-0.6, 0.6]) {
        p.box(0.3, 0.12, 0.04, x, 0.75, -2.39, LIGHT);
        p.box(0.2, 0.3, 0.04, x * 1.3, 1.0, 2.36, RED);
      }
      break;
    }
    case "bus": {
      for (const [x, z] of [[-1.1, -3.2], [1.1, -3.2], [-1.1, 3.1], [1.1, 3.1], [-0.95, 3.1], [0.95, 3.1]]) p.wheel(0.5, 0.3, x, z);
      p.box(2.5, 2.7, 10.5, 0, 1.75, 0, null); // body
      p.box(2.54, 0.9, 9.2, 0, 2.2, 0.3, GLASS); // window band
      p.box(2.3, 1.1, 0.06, 0, 2.15, -5.26, GLASS, 0.08); // windshield
      p.box(2.54, 0.16, 10.2, 0, 1.6, 0, "#f2f2ec"); // stripe
      p.box(1.6, 0.3, 0.05, 0, 2.95, -5.27, "#1a1a1a"); // route board
      p.box(1.4, 0.18, 0.02, 0, 2.95, -5.3, "#ffb000");
      p.box(2.55, 0.25, 0.25, 0, 0.5, -5.2, "#2b2b2b");
      for (const x of [-0.9, 0.9]) {
        p.box(0.35, 0.18, 0.04, x, 0.85, -5.27, LIGHT);
        p.box(0.25, 0.4, 0.04, x, 1.0, 5.26, RED);
      }
      break;
    }
    case "motorbike": {
      p.wheel(0.3, 0.1, 0, -0.65);
      p.wheel(0.3, 0.1, 0, 0.65);
      p.box(0.3, 0.32, 1.0, 0, 0.62, 0, null);
      p.box(0.3, 0.08, 0.55, 0, 0.84, 0.3, "#151515");
      p.box(0.6, 0.03, 0.03, 0, 1.02, -0.48, "#222");
      p.box(0.36, 0.55, 0.22, 0, 1.18, 0.18, "#3b4a5a", -0.3); // rider
      p.cyl(0.14, 0.26, 0, 1.58, 0.05, "#e6e6e6");
      p.box(0.1, 0.06, 0.03, 0, 0.92, -0.62, LIGHT);
      break;
    }
  }
  return p.build();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function TrafficLayer({ sim, rider, onHonk }: { sim: TrafficSim; rider: React.RefObject<{ x: number; z: number }>; onHonk?: HonkHandler }) {
  const geos = useMemo(() => Object.fromEntries(TRAFFIC_KINDS.map((k) => [k, buildKind(k)])) as Record<TrafficKind, { tint: THREE.BufferGeometry; trim: THREE.BufferGeometry }>, []);
  const groups = useMemo(() => {
    const g = Object.fromEntries(TRAFFIC_KINDS.map((k) => [k, [] as TrafficVehicle[]])) as Record<TrafficKind, TrafficVehicle[]>;
    for (const v of sim.vehicles) g[v.kind].push(v);
    return g;
  }, [sim]);
  const meshes = useRef<Partial<Record<TrafficKind, { tint: THREE.InstancedMesh | null; trim: THREE.InstancedMesh | null }>>>({});
  const m = useMemo(() => new THREE.Matrix4(), []);
  const q = useMemo(() => new THREE.Quaternion(), []);
  const pos = useMemo(() => new THREE.Vector3(), []);
  const one = useMemo(() => new THREE.Vector3(1, 1, 1), []);
  const up = useMemo(() => new THREE.Vector3(0, 1, 0), []);

  useLayoutEffect(() => {
    for (const k of TRAFFIC_KINDS) {
      const mm = meshes.current[k];
      groups[k].forEach((v, i) => mm?.tint?.setColorAt(i, v.tint));
      if (mm?.tint?.instanceColor) mm.tint.instanceColor.needsUpdate = true;
    }
  }, [groups]);

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.1);
    sim.update(dt, rider.current, onHonk);
    for (const k of TRAFFIC_KINDS) {
      const mm = meshes.current[k];
      if (!mm) continue;
      groups[k].forEach((v, i) => {
        q.setFromAxisAngle(up, v.dyaw);
        m.compose(pos.set(v.dx, 0, v.dz), q, one);
        mm.tint?.setMatrixAt(i, m);
        mm.trim?.setMatrixAt(i, m);
      });
      if (mm.tint) mm.tint.instanceMatrix.needsUpdate = true;
      if (mm.trim) mm.trim.instanceMatrix.needsUpdate = true;
    }
  });

  return (
    <>
      {TRAFFIC_KINDS.map((k) =>
        groups[k].length ? (
          <group key={k}>
            <instancedMesh
              ref={(r) => void ((meshes.current[k] ??= { tint: null, trim: null }).tint = r)}
              args={[geos[k].tint, undefined, groups[k].length]}
              frustumCulled={false}
              castShadow
            >
              <meshLambertMaterial vertexColors />
            </instancedMesh>
            <instancedMesh
              ref={(r) => void ((meshes.current[k] ??= { tint: null, trim: null }).trim = r)}
              args={[geos[k].trim, undefined, groups[k].length]}
              frustumCulled={false}
            >
              <meshLambertMaterial vertexColors />
            </instancedMesh>
          </group>
        ) : null,
      )}
    </>
  );
}
