"use client";

/**
 * Traffic signals at major junctions near the route (e.g. Gulshan 1 / 2
 * circles, avenue crossings). Two-phase cycle: approaches roughly along the
 * junction's main axis get green while crossing approaches wait, then swap.
 * Traffic and the auto-riding rider obey them; poles with lamps are drawn at
 * each approach (on the left, as in left-hand-traffic Bangladesh).
 */

import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import type { Roads } from "@/lib/routing";
import { angleDiff, ROAD_WIDTH, type Projector } from "@/ride/rideWorld";

export type SignalState = "green" | "yellow" | "red";

export interface Approach {
  /** Where the pole stands. */
  x: number;
  z: number;
  /** Heading of traffic arriving on this approach. */
  yaw: number;
  group: 0 | 1;
}

export interface SignalJunction {
  key: string;
  x: number;
  z: number;
  /** Stop-line distance from the junction centre (m). */
  r: number;
  /** Main axis (yaw) — approaches along it are group 0. */
  axis: number;
  /** Cycle offset (s) so neighbouring junctions don't switch together. */
  offset: number;
  approaches: Approach[];
}

/** Shared clock for all signals, advanced once per frame by the traffic layer. */
export interface SignalClock {
  t: number;
}

const GREEN = 16;
const YELLOW = 3;
const ALL_RED = 2;
const HALF = GREEN + YELLOW + ALL_RED;
export const CYCLE = HALF * 2;

export function groupFor(j: SignalJunction, yaw: number): 0 | 1 {
  return Math.abs(Math.cos(angleDiff(yaw, j.axis))) > Math.SQRT1_2 ? 0 : 1;
}

/** State of a junction's group at time t, and seconds until it changes. */
export function signalState(j: SignalJunction, group: 0 | 1, t: number): { state: SignalState; remaining: number } {
  const c = (((t + j.offset) % CYCLE) + CYCLE) % CYCLE;
  // Group 0 is green in the first half, group 1 in the second.
  const local = group === 0 ? c : (c + HALF) % CYCLE;
  if (local < GREEN) return { state: "green", remaining: GREEN - local };
  if (local < GREEN + YELLOW) return { state: "yellow", remaining: GREEN + YELLOW - local };
  return { state: "red", remaining: CYCLE - local };
}

/**
 * Junctions where main roads cross (two main-road arms plus a third wide arm),
 * within `near` of the route.
 */
export function findSignalJunctions(roads: Roads, proj: Projector, near: (x: number, z: number) => boolean): SignalJunction[] {
  interface Arm { yaw: number; w: number; incoming: boolean }
  const nodes = new Map<string, { x: number; z: number; arms: Arm[] }>();
  for (const f of roads.features) {
    const p = f.properties;
    if (!p.motor) continue;
    const w = ROAD_WIDTH[p.highway] ?? 5;
    const pts = f.geometry.coordinates;
    pts.forEach((c, i) => {
      const key = `${c[0]},${c[1]}`;
      let node = nodes.get(key);
      const [x, z] = proj.toLocal(c);
      if (!node) nodes.set(key, (node = { x, z, arms: [] }));
      const yawFrom = (a: number[]) => {
        const [ax, az] = proj.toLocal(a);
        return Math.atan2(-(x - ax), -(z - az)); // heading arriving from a
      };
      if (i > 0) node.arms.push({ yaw: yawFrom(pts[i - 1]), w, incoming: p.oneway !== -1 });
      if (i < pts.length - 1) node.arms.push({ yaw: yawFrom(pts[i + 1]), w, incoming: p.oneway !== 1 });
    });
  }

  const out: SignalJunction[] = [];
  let n = 0;
  for (const [key, node] of nodes) {
    if (node.arms.length < 3 || !near(node.x, node.z)) continue;
    // Only where main roads cross: at least two arms of a main road (≥ 10 m) and a third arm of any road ≥ 8 m.
    if (node.arms.filter((a) => a.w >= 10).length < 2 || node.arms.filter((a) => a.w >= 8).length < 3) continue;
    // Skip junction clusters: keep one signal per ~60 m (big circles have several nodes).
    if (out.some((j) => Math.hypot(j.x - node.x, j.z - node.z) < 60)) continue;
    const widest = node.arms.reduce((a, b) => (b.w > a.w ? b : a));
    const r = Math.max(...node.arms.map((a) => a.w)) / 2 + 3.5;
    const j: SignalJunction = { key, x: node.x, z: node.z, r, axis: widest.yaw, offset: (n++ * 13.7) % CYCLE, approaches: [] };
    for (const a of node.arms) {
      if (!a.incoming) continue;
      if (j.approaches.some((o) => Math.abs(angleDiff(o.yaw, a.yaw)) < 0.35)) continue;
      // Pole on the left kerb of the approach, just before the stop line.
      const fx = -Math.sin(a.yaw), fz = -Math.cos(a.yaw);
      const lx = -Math.cos(a.yaw), lz = Math.sin(a.yaw);
      j.approaches.push({
        x: node.x - fx * (r + 1) + lx * (a.w / 2 + 0.8),
        z: node.z - fz * (r + 1) + lz * (a.w / 2 + 0.8),
        yaw: a.yaw,
        group: 0,
      });
    }
    for (const ap of j.approaches) ap.group = groupFor(j, ap.yaw);
    out.push(j);
  }
  return out;
}

/** Same junction lookup, by the OSM node key of every node within the junction cluster radius. */
export function junctionIndex(roads: Roads, proj: Projector, junctions: SignalJunction[]): Map<string, SignalJunction> {
  const map = new Map<string, SignalJunction>();
  if (!junctions.length) return map;
  for (const f of roads.features) {
    for (const c of f.geometry.coordinates) {
      const key = `${c[0]},${c[1]}`;
      if (map.has(key)) continue;
      const [x, z] = proj.toLocal(c);
      const j = junctions.find((jj) => Math.hypot(jj.x - x, jj.z - z) < 6);
      if (j) map.set(key, j);
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Rendering: poles + 3-lamp heads, lamp colours follow the clock
// ---------------------------------------------------------------------------

const ON: Record<SignalState, THREE.Color> = { red: new THREE.Color("#ff2a1f"), yellow: new THREE.Color("#ffc21a"), green: new THREE.Color("#22e07a") };
const OFF = [new THREE.Color("#3a0d0b"), new THREE.Color("#3a2e08"), new THREE.Color("#08301a")];
const ORDER: SignalState[] = ["red", "yellow", "green"];

export function SignalsLayer({ junctions, clock }: { junctions: SignalJunction[]; clock: SignalClock }) {
  const approaches = useMemo(() => junctions.flatMap((j) => j.approaches.map((a) => ({ j, a }))), [junctions]);
  const poles = useRef<THREE.InstancedMesh>(null);
  const heads = useRef<THREE.InstancedMesh>(null);
  const lamps = useRef<THREE.InstancedMesh>(null);
  const poleGeo = useMemo(() => new THREE.CylinderGeometry(0.07, 0.09, 4.6, 6).translate(0, 2.3, 0), []);
  const headGeo = useMemo(() => new THREE.BoxGeometry(0.34, 1.0, 0.26).translate(0, 4.3, 0), []);
  const lampGeo = useMemo(() => new THREE.SphereGeometry(0.1, 10, 8), []);
  const tmp = useMemo(() => ({ m: new THREE.Matrix4(), q: new THREE.Quaternion(), p: new THREE.Vector3(), s: new THREE.Vector3(1, 1, 1), up: new THREE.Vector3(0, 1, 0) }), []);
  const placed = useRef(false);

  useFrame(() => {
    const { m, q, p, s, up } = tmp;
    if (!poles.current || !heads.current || !lamps.current) return;
    approaches.forEach(({ j, a }, i) => {
      // The lamp face looks back at approaching traffic.
      const face = a.yaw + Math.PI;
      if (!placed.current) {
        q.setFromAxisAngle(up, face);
        m.compose(p.set(a.x, 0, a.z), q, s);
        poles.current!.setMatrixAt(i, m);
        heads.current!.setMatrixAt(i, m);
      }
      const st = signalState(j, a.group, clock.t).state;
      ORDER.forEach((name, k) => {
        const lx = a.x - Math.sin(face) * 0.14;
        const lz = a.z - Math.cos(face) * 0.14;
        q.identity();
        m.compose(p.set(lx, 4.62 - k * 0.31, lz), q, s);
        lamps.current!.setMatrixAt(i * 3 + k, m);
        lamps.current!.setColorAt(i * 3 + k, st === name ? ON[name] : OFF[k]);
      });
    });
    if (!placed.current) {
      poles.current.instanceMatrix.needsUpdate = true;
      heads.current.instanceMatrix.needsUpdate = true;
      placed.current = true;
    }
    lamps.current.instanceMatrix.needsUpdate = true;
    if (lamps.current.instanceColor) lamps.current.instanceColor.needsUpdate = true;
  });

  if (!approaches.length) return null;
  return (
    <>
      <instancedMesh ref={poles} args={[poleGeo, undefined, approaches.length]} frustumCulled={false}>
        <meshLambertMaterial color="#3d4247" />
      </instancedMesh>
      <instancedMesh ref={heads} args={[headGeo, undefined, approaches.length]} frustumCulled={false}>
        <meshLambertMaterial color="#1b1d1f" />
      </instancedMesh>
      <instancedMesh ref={lamps} args={[lampGeo, undefined, approaches.length * 3]} frustumCulled={false}>
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>
    </>
  );
}
