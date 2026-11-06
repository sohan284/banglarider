/**
 * Procedural street furniture along the roads near the route, cut back at
 * intersections:
 *   footpaths + kerbs, lane markings, zebra crossings, speed breakers,
 *   boundary walls with gates, trees, street lamps, electric poles with
 *   (tangled) overhead wires, shop signs near markets and roadside billboards.
 *
 * Everything is either merged into a few geometries or returned as instance
 * transforms, so it adds only ~10 draw calls.
 */

import * as THREE from "three";
import type { LngLat } from "@/config/areas";
import type { Roads } from "@/lib/routing";
import { GeometryWriter, makeNearRoute, ROAD_WIDTH, type Projector, type Quality, type RoutePath } from "@/ride/rideWorld";

export interface Instance {
  x: number;
  z: number;
  /** Rotation around +y. */
  yaw: number;
  scale: number;
  /** 0..1, used to vary colour. */
  tint: number;
}

export interface StreetDetail {
  /** Lane lines, zebra crossings, speed breakers (flat, vertex colours). */
  marks: THREE.BufferGeometry;
  /** Raised footpaths + kerb faces. */
  footpaths: THREE.BufferGeometry;
  /** Plot boundary walls and gates (render double-sided). */
  walls: THREE.BufferGeometry;
  /** Overhead electric wires (line segments). */
  wires: THREE.BufferGeometry;
  /** Shop signs and billboards (UVs into the sign atlas). */
  signs: THREE.BufferGeometry;
  /** Billboard posts (vertex colours). */
  posts: THREE.BufferGeometry;
  trees: Instance[];
  lamps: Instance[];
  poles: Instance[];
}

/** Sign atlas layout: 2 columns × 6 rows. Cells 0-7 shop signs, 8-11 billboards. */
export const SIGN_COLS = 2;
export const SIGN_ROWS = 6;
export const SHOP_SIGNS = 8;
export const BILLBOARDS = 4;

const DETAIL_RADIUS = 170;
const FOOTPATH_W = 1.8;
const NO_DETAIL = new Set(["service", "track", "path", "cycleway"]);
const WALLED = new Set(["residential", "living_street", "unclassified", "tertiary", "road"]);
const WIRED = new Set(["residential", "living_street", "unclassified", "tertiary", "road"]);

/** Deterministic pseudo-random in [0,1). */
function rnd(x: number, z: number, k = 0): number {
  const s = Math.sin(x * 12.9898 + z * 78.233 + k * 37.719) * 43758.5453;
  return s - Math.floor(s);
}

interface Junction {
  x: number;
  z: number;
  r: number;
}

export function buildStreetDetail(roads: Roads, proj: Projector, path: RoutePath, quality: Quality, markets: LngLat[] = []): StreetDetail {
  const high = quality === "high";
  const near = makeNearRoute(path, high ? DETAIL_RADIUS : 110);
  const up = [0, 1, 0];

  // ---- junctions: coordinates where 3+ road arms meet ----
  const arms = new Map<string, { x: number; z: number; n: number; w: number }>();
  for (const f of roads.features) {
    const cs = f.geometry.coordinates;
    const w = ROAD_WIDTH[f.properties.highway] ?? 5;
    cs.forEach((c, i) => {
      const key = `${c[0]},${c[1]}`;
      const end = i === 0 || i === cs.length - 1;
      const e = arms.get(key);
      if (e) {
        e.n += end ? 1 : 2;
        e.w = Math.max(e.w, w);
      } else {
        const [x, z] = proj.toLocal(c);
        arms.set(key, { x, z, n: end ? 1 : 2, w });
      }
    });
  }
  const JCELL = 40;
  const jgrid = new Map<string, Junction[]>();
  const junctionKeys = new Set<string>();
  for (const [key, a] of arms) {
    if (a.n < 3 || !near(a.x, a.z)) continue;
    junctionKeys.add(key);
    const j = { x: a.x, z: a.z, r: a.w / 2 + 2.5 };
    const k = `${Math.floor(a.x / JCELL)},${Math.floor(a.z / JCELL)}`;
    (jgrid.get(k) ?? jgrid.set(k, []).get(k)!).push(j);
  }
  const junctionsNear = (x: number, z: number) => {
    const out: Junction[] = [];
    const cx = Math.floor(x / JCELL), cz = Math.floor(z / JCELL);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) out.push(...(jgrid.get(`${cx + i},${cz + j}`) ?? []));
    return out;
  };

  /** Parts [t0,t1] of segment a→b (in 0..1) that stay clear of junctions by `extra` metres. */
  const clearParts = (x1: number, z1: number, x2: number, z2: number, extra: number): [number, number][] => {
    let parts: [number, number][] = [[0, 1]];
    const dx = x2 - x1, dz = z2 - z1;
    const len2 = dx * dx + dz * dz;
    if (len2 < 1e-6) return [];
    const js = [...junctionsNear(x1, z1), ...junctionsNear(x2, z2)];
    for (const j of js) {
      const r = j.r + extra;
      // Solve |a + t d - j| = r
      const fx = x1 - j.x, fz = z1 - j.z;
      const b = 2 * (fx * dx + fz * dz);
      const c = fx * fx + fz * fz - r * r;
      const disc = b * b - 4 * len2 * c;
      if (disc <= 0) continue;
      const sq = Math.sqrt(disc);
      const t0 = (-b - sq) / (2 * len2);
      const t1 = (-b + sq) / (2 * len2);
      parts = parts.flatMap(([p0, p1]): [number, number][] => {
        if (t1 <= p0 || t0 >= p1) return [[p0, p1]];
        const out: [number, number][] = [];
        if (t0 > p0) out.push([p0, t0]);
        if (t1 < p1) out.push([t1, p1]);
        return out;
      });
    }
    return parts.filter(([a, b]) => (b - a) * Math.sqrt(len2) > 0.3);
  };

  const marks = new GeometryWriter();
  const foot = new GeometryWriter();
  const walls = new GeometryWriter();
  const signs = new GeometryWriter(true);
  const posts = new GeometryWriter();
  const wirePos: number[] = [];
  const trees: Instance[] = [];
  const lamps: Instance[] = [];
  const poles: Instance[] = [];

  const white = new THREE.Color("#e9e7df");
  const yellow = new THREE.Color("#e8b923");
  const black = new THREE.Color("#22201c");
  const footColor = new THREE.Color("#a8a397");
  const kerbColor = new THREE.Color("#cfcabd");
  const wallColors = ["#efe7d6", "#e6dccb", "#f2e9e1", "#dcd4c4", "#e9dfd0", "#d8d0c8"].map((c) => new THREE.Color(c));
  const gateColors = ["#4f6b5a", "#7a6048", "#55627a", "#8a7a62", "#6b6f73"].map((c) => new THREE.Color(c));
  const postColor = new THREE.Color("#6b6f73");

  const marketPts = markets.map((m) => proj.toLocal(m));
  const nearMarket = (x: number, z: number) => marketPts.some(([mx, mz]) => Math.hypot(mx - x, mz - z) < 90);

  /** UVs for a sign atlas cell. */
  const cellUV = (cell: number) => {
    const col = cell % SIGN_COLS;
    const row = Math.floor(cell / SIGN_COLS);
    return { u0: col / SIGN_COLS, u1: (col + 1) / SIGN_COLS, v0: 1 - (row + 1) / SIGN_ROWS, v1: 1 - row / SIGN_ROWS };
  };
  const addSign = (cx: number, cy: number, cz: number, tx: number, tz: number, nx: number, nz: number, w: number, h: number, cell: number) => {
    const { u0, u1, v0, v1 } = cellUV(cell);
    const c = new THREE.Color("#ffffff");
    // Text must read left-to-right when facing the sign (looking along -n).
    const L = [cx + tx * w / 2, cz + tz * w / 2];
    const Rr = [cx - tx * w / 2, cz - tz * w / 2];
    const n = [nx, 0, nz];
    // Decide which end is on the left for a viewer facing the sign (looking along -n, left = (-nz, nx)).
    const leftIsL = -tx * nz + tz * nx > 0;
    const [A, B] = leftIsL ? [L, Rr] : [Rr, L];
    signs.quadV(
      { p: [A[0], cy - h / 2, A[1]], c, uv: [u0, v0] },
      { p: [B[0], cy - h / 2, B[1]], c, uv: [u1, v0] },
      { p: [B[0], cy + h / 2, B[1]], c, uv: [u1, v1] },
      { p: [A[0], cy + h / 2, A[1]], c, uv: [u0, v1] },
      n,
    );
  };

  for (const f of roads.features) {
    const hw = f.properties.highway;
    if (NO_DETAIL.has(hw)) continue;
    const pts = f.geometry.coordinates.map((c) => proj.toLocal(c));
    if (!pts.some(([x, z]) => near(x, z))) continue;
    const w = ROAD_WIDTH[hw] ?? 5;
    const half = w / 2;
    const major = w >= 10;
    const walled = WALLED.has(hw);
    const wired = WIRED.has(hw) && w < 10;
    const wireSide = rnd(f.properties.id, 1) > 0.5 ? 1 : -1;
    const roadPoles: { x: number; z: number; along: number }[] = [];
    let along = 0;
    const nextTree = [rnd(f.properties.id, 2) * 10, rnd(f.properties.id, 3) * 10];
    let nextLamp = rnd(f.properties.id, 4) * 20;
    let nextPole = rnd(f.properties.id, 5) * 15;
    const nextSign = [4, 8];
    let nextBillboard = 60 + rnd(f.properties.id, 6) * 200;
    let lampSide = 1;
    const gateRun = [10 + rnd(f.properties.id, 7) * 15, 10 + rnd(f.properties.id, 8) * 15];

    for (let i = 0; i < pts.length - 1; i++) {
      const [x1, z1] = pts[i];
      const [x2, z2] = pts[i + 1];
      const len = Math.hypot(x2 - x1, z2 - z1);
      if (len < 0.05) continue;
      const tx = (x2 - x1) / len, tz = (z2 - z1) / len; // tangent
      const lx = -tz, lz = tx; // left normal
      const segNear = near(x1, z1) || near(x2, z2);
      if (!segNear) {
        along += len;
        continue;
      }
      const at = (t: number, off: number): [number, number] => [x1 + tx * len * t + lx * off, z1 + tz * len * t + lz * off];

      // ---- lane markings ----
      if (w >= 8) {
        for (const [p0, p1] of clearParts(x1, z1, x2, z2, 1.5)) {
          // centre dashes: 3 m on, 6 m off, phased by distance along the road
          for (let d = Math.ceil((along + p0 * len) / 9) * 9; d < along + p1 * len; d += 9) {
            const a = (d - along) / len;
            const b = Math.min(p1, a + 3 / len);
            if (b <= a) continue;
            const [ax, az] = at(a, 0.08), [bx, bz] = at(b, 0.08), [cx, cz] = at(b, -0.08), [ex, ez] = at(a, -0.08);
            marks.quad([ax, 0.045, az], [bx, 0.045, bz], [cx, 0.045, cz], [ex, 0.045, ez], up, white);
          }
          if (major) {
            for (const s of [1, -1]) {
              const o1 = s * (half - 0.45), o2 = s * (half - 0.3);
              const [ax, az] = at(p0, o1), [bx, bz] = at(p1, o1), [cx, cz] = at(p1, o2), [ex, ez] = at(p0, o2);
              marks.quad([ax, 0.045, az], [bx, 0.045, bz], [cx, 0.045, cz], [ex, 0.045, ez], up, white);
            }
          }
        }
      }

      for (const side of [1, -1]) {
        const sideIdx = side > 0 ? 0 : 1;
        const parts = clearParts(x1, z1, x2, z2, 0.5);
        for (const [p0, p1] of parts) {
          // ---- footpath top + kerb face ----
          const [ax, az] = at(p0, side * half), [bx, bz] = at(p1, side * half);
          const [cx, cz] = at(p1, side * (half + FOOTPATH_W)), [ex, ez] = at(p0, side * (half + FOOTPATH_W));
          foot.quad([ax, 0.16, az], [bx, 0.16, bz], [cx, 0.16, cz], [ex, 0.16, ez], up, footColor);
          const kn = [-lx * side, 0, -lz * side]; // faces the road
          if (major && high) {
            // Painted black/yellow kerb stones, as on Dhaka's main roads.
            const segLen = (p1 - p0) * len;
            const pieces = Math.max(1, Math.round(segLen / 1.2));
            for (let k = 0; k < pieces; k++) {
              const q0 = p0 + ((p1 - p0) * k) / pieces, q1 = p0 + ((p1 - p0) * (k + 1)) / pieces;
              const [kx1, kz1] = at(q0, side * half), [kx2, kz2] = at(q1, side * half);
              foot.quad([kx1, 0.02, kz1], [kx2, 0.02, kz2], [kx2, 0.16, kz2], [kx1, 0.16, kz1], kn, k % 2 ? black : yellow);
            }
          } else {
            foot.quad([ax, 0.02, az], [bx, 0.02, bz], [bx, 0.16, bz], [ax, 0.16, az], kn, kerbColor);
          }

          // ---- boundary walls with gates ----
          if (walled) {
            const off = side * (half + FOOTPATH_W + 0.3);
            const wallH = 2.2;
            const wc = wallColors[Math.floor(rnd(f.properties.id, side, 9) * wallColors.length)];
            const wcTop = wc.clone().multiplyScalar(0.8);
            const wcBottom = wc.clone().multiplyScalar(0.7);
            const segStart = p0 * len, segEnd = p1 * len;
            let d = segStart;
            while (d < segEnd) {
              const run = gateRun[sideIdx];
              const isGate = run < 0;
              const piece = Math.min(segEnd - d, isGate ? -run : run);
              const a = d / len, b = (d + piece) / len;
              const [wx1, wz1] = at(a, off), [wx2, wz2] = at(b, off);
              if (isGate) {
                const g = gateColors[Math.floor(rnd(wx1, wz1, 3) * gateColors.length)];
                walls.quad([wx1, 0, wz1], [wx2, 0, wz2], [wx2, 2.4, wz2], [wx1, 2.4, wz1], kn, g);
              } else {
                walls.quadV(
                  { p: [wx1, 0, wz1], c: wcBottom },
                  { p: [wx2, 0, wz2], c: wcBottom },
                  { p: [wx2, wallH, wz2], c: wc },
                  { p: [wx1, wallH, wz1], c: wc },
                  kn,
                );
                // coping on top
                const [ox1, oz1] = at(a, off + side * 0.25), [ox2, oz2] = at(b, off + side * 0.25);
                walls.quad([wx1, wallH, wz1], [wx2, wallH, wz2], [ox2, wallH, oz2], [ox1, wallH, oz1], up, wcTop);
              }
              d += piece;
              const left = (isGate ? -run : run) - piece;
              if (left > 0.01) gateRun[sideIdx] = isGate ? -left : left;
              else gateRun[sideIdx] = isGate ? 14 + rnd(wx2, wz2, 1) * 16 : -(3.2 + rnd(wx2, wz2, 2) * 1.5);
            }
          }

          // ---- trees ----
          const treeGap = major || hw === "tertiary" ? (high ? 12 : 24) : high ? 30 : 70;
          for (let d = nextTree[sideIdx]; d < along + p1 * len; d = nextTree[sideIdx]) {
            if (d >= along + p0 * len) {
              const t = (d - along) / len;
              const [px, pz] = at(t, side * (half + 1.0));
              trees.push({ x: px, z: pz, yaw: rnd(px, pz) * 6.28, scale: 0.75 + rnd(px, pz, 1) * 0.6, tint: rnd(px, pz, 2) });
            }
            nextTree[sideIdx] = d + treeGap * (0.7 + rnd(d, side, 4) * 0.6);
          }

          // ---- shop signs near markets ----
          if (nearMarket(...at((p0 + p1) / 2, 0))) {
            for (let d = nextSign[sideIdx]; d < along + p1 * len; d = nextSign[sideIdx]) {
              if (d >= along + p0 * len) {
                const t = (d - along) / len;
                const [sx, sz] = at(t, side * (half + FOOTPATH_W + 0.45));
                const cell = Math.floor(rnd(sx, sz, 5) * SHOP_SIGNS);
                addSign(sx, 2.9 + rnd(sx, sz, 6) * 0.8, sz, tx, tz, -lx * side, -lz * side, 3.4, 1.13, cell);
              }
              nextSign[sideIdx] = d + 9 + rnd(d, side, 7) * 9;
            }
          }
        }
      }

      // ---- street lamps (alternating sides on wide roads) ----
      if (w >= 8) {
        const lampGap = high ? 30 : 45;
        for (let d = nextLamp; d < along + len; d = nextLamp) {
          const t = (d - along) / len;
          const [px, pz] = at(t, lampSide * (half + 0.4));
          const clear = clearParts(px - tx, pz - tz, px + tx, pz + tz, 0).length > 0;
          if (clear) lamps.push({ x: px, z: pz, yaw: Math.atan2(-lx * lampSide, -lz * lampSide), scale: 1, tint: 0 });
          lampSide = -lampSide;
          nextLamp = d + lampGap;
        }
      }

      // ---- electric poles ----
      if (wired) {
        for (let d = nextPole; d < along + len; d = nextPole) {
          const t = (d - along) / len;
          const [px, pz] = at(t, wireSide * (half + 0.7));
          const clear = clearParts(px - tx, pz - tz, px + tx, pz + tz, 0).length > 0;
          if (clear) {
            poles.push({ x: px, z: pz, yaw: Math.atan2(tx, tz), scale: 0.95 + rnd(px, pz) * 0.12, tint: rnd(px, pz, 1) });
            roadPoles.push({ x: px, z: pz, along: d });
          }
          nextPole = d + 30 + rnd(d, 3) * 7;
        }
      }

      // ---- billboards on main roads ----
      if (major && high) {
        for (let d = nextBillboard; d < along + len; d = nextBillboard) {
          const t = (d - along) / len;
          const side = rnd(d, 9) > 0.5 ? 1 : -1;
          const [bx, bz] = at(t, side * (half + 3.2));
          // Angle the board ~35° toward oncoming traffic so it reads from the road.
          const ang = Math.atan2(-lx * side, -lz * side) + side * 0.6;
          const nx = Math.sin(ang), nz = Math.cos(ang);
          const ttx = nz, ttz = -nx;
          addSign(bx, 6.2, bz, ttx, ttz, nx, nz, 7.2, 2.4, SHOP_SIGNS + Math.floor(rnd(bx, bz) * BILLBOARDS));
          for (const o of [-2.4, 2.4]) posts.box(bx + ttx * o - nx * 0.1, 0, bz + ttz * o - nz * 0.1, 0.22, 5.0, 0.22, ang, postColor);
          nextBillboard = d + 220 + rnd(d, 8) * 120;
        }
      }

      along += len;
    }

    // ---- wires between consecutive poles on this road ----
    for (let k = 0; k < roadPoles.length - 1; k++) {
      const a = roadPoles[k], b = roadPoles[k + 1];
      const span = Math.hypot(b.x - a.x, b.z - a.z);
      if (span > 48 || span < 5) continue;
      const nWires = high ? 5 : 3;
      for (let wI = 0; wI < nWires; wI++) {
        const h = 7.6 + wI * 0.28;
        const sag = 0.5 + rnd(a.x, a.z, wI) * 0.9 + (wI === nWires - 1 && rnd(a.x, b.z) > 0.6 ? 1.6 : 0);
        const off = (wI - nWires / 2) * 0.18;
        const ox = (-(b.z - a.z) / span) * off, oz = ((b.x - a.x) / span) * off;
        const steps = 8;
        for (let s = 0; s < steps; s++) {
          const t0 = s / steps, t1 = (s + 1) / steps;
          const y0 = h - sag * 4 * t0 * (1 - t0), y1 = h - sag * 4 * t1 * (1 - t1);
          wirePos.push(a.x + (b.x - a.x) * t0 + ox, y0, a.z + (b.z - a.z) * t0 + oz, a.x + (b.x - a.x) * t1 + ox, y1, a.z + (b.z - a.z) * t1 + oz);
        }
      }
      // A tangle of loose cable coils at some poles.
      if (high && rnd(a.x, a.z, 9) > 0.55) {
        for (let loop = 0; loop < 3; loop++) {
          const r = 0.25 + loop * 0.12;
          const y = 6.8 - loop * 0.25;
          for (let s = 0; s < 10; s++) {
            const t0 = (s / 10) * Math.PI * 2, t1 = ((s + 1) / 10) * Math.PI * 2;
            wirePos.push(a.x + Math.cos(t0) * r, y - Math.sin(t0) * 0.35, a.z + Math.sin(t0) * r, a.x + Math.cos(t1) * r, y - Math.sin(t1) * 0.35, a.z + Math.sin(t1) * r);
          }
        }
      }
    }

    // ---- zebra crossings where a wide road meets a junction ----
    if (w >= 8) {
      const cs = f.geometry.coordinates;
      for (const [endIdx, nextIdx] of [
        [0, 1],
        [cs.length - 1, cs.length - 2],
      ]) {
        if (!junctionKeys.has(`${cs[endIdx][0]},${cs[endIdx][1]}`)) continue;
        const [jx, jz] = pts[endIdx];
        const [nx2, nz2] = pts[nextIdx];
        const L = Math.hypot(nx2 - jx, nz2 - jz);
        if (L < 12) continue;
        const dx = (nx2 - jx) / L, dz = (nz2 - jz) / L;
        const lx2 = -dz, lz2 = dx;
        const dist = half + 4;
        const stripes = Math.floor(w / 1.0);
        for (let k = 0; k < stripes; k++) {
          const o = -half + 0.5 + k * 1.0;
          const c0 = [jx + dx * dist + lx2 * o, jz + dz * dist + lz2 * o];
          const p = (along2: number, lat: number): number[] => [c0[0] + dx * along2 + lx2 * lat, 0.05, c0[1] + dz * along2 + lz2 * lat];
          marks.quad(p(0, 0), p(3, 0), p(3, 0.5), p(0, 0.5), up, white);
        }
      }
    }
  }

  // ---- speed breakers on the route ----
  for (const s of path.breakers) {
    const [x, z] = path.point(s);
    const yaw = path.heading(s);
    const stripes = 8;
    const width = 6.4;
    for (let k = 0; k < stripes; k++) {
      const o = -width / 2 + (k + 0.5) * (width / stripes);
      // across the road: offset along the bike's right vector
      const rx = Math.cos(yaw), rz = -Math.sin(yaw);
      marks.box(x + rx * o, 0.02, z + rz * o, width / stripes, 0.09, 0.9, yaw, k % 2 ? black : yellow, 0.75);
    }
  }

  const wires = new THREE.BufferGeometry();
  wires.setAttribute("position", new THREE.Float32BufferAttribute(wirePos, 3));
  wires.computeBoundingSphere();

  return {
    marks: marks.build(),
    footpaths: foot.build(),
    walls: walls.build(),
    wires,
    signs: signs.build(),
    posts: posts.build(),
    trees,
    lamps,
    poles,
  };
}
