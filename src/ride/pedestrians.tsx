"use client";

/**
 * Pedestrians on the footpaths: men in shirts and lungis/trousers, women in
 * sarees, walking with swinging arms and legs; some standing near shops at
 * markets. They follow footpath segments, continue onto connected ones, and
 * respawn around the rider like traffic does. Rendered with 5 instanced meshes.
 */

import { useFrame } from "@react-three/fiber";
import { useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { Quality } from "@/ride/rideWorld";

export interface Walkway {
  x1: number;
  z1: number;
  x2: number;
  z2: number;
}

export interface Stand {
  x: number;
  z: number;
  yaw: number;
}

interface Ped {
  seg: number;
  /** Metres along the segment. */
  t: number;
  dir: 1 | -1;
  speed: number;
  lateral: number;
  phase: number;
  woman: boolean;
  standing: boolean;
  scale: number;
  x: number;
  z: number;
  yaw: number;
  top: THREE.Color;
  bottom: THREE.Color;
}

const SHIRTS = ["#f2f2ee", "#3b6ea8", "#c4473a", "#e0b04a", "#5a8f5a", "#2e2e2e", "#8a5aa8", "#d9d2c3", "#6f8796"];
const LOWER_MEN = ["#2b3440", "#3a3a3a", "#1f4f7a", "#4d6b3b", "#6b4a2b"]; // trousers / lungi
const SAREES = ["#c2185b", "#f57c00", "#00897b", "#6a1b9a", "#d32f2f", "#1565c0", "#f9a825", "#2e7d32"];

function rnd(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export class PedestrianSim {
  peds: Ped[] = [];
  private lens: Float32Array;
  private ends = new Map<string, number[]>();
  private random = rnd(4242);

  constructor(
    private ways: Walkway[],
    stands: Stand[],
    start: [number, number],
    quality: Quality,
  ) {
    this.lens = Float32Array.from(ways, (w) => Math.hypot(w.x2 - w.x1, w.z2 - w.z1));
    const cell = (x: number, z: number) => `${Math.round(x / 4)},${Math.round(z / 4)}`;
    ways.forEach((w, i) => {
      for (const k of [cell(w.x1, w.z1), cell(w.x2, w.z2)]) (this.ends.get(k) ?? this.ends.set(k, []).get(k)!).push(i);
    });

    const walkers = quality === "high" ? 130 : 55;
    for (let n = 0, tries = 0; n < walkers && tries < walkers * 30 && ways.length; tries++) {
      const p = this.make(start[0], start[1], 6, 220);
      if (p) {
        this.peds.push(p);
        n++;
      }
    }
    // A few people standing by shops near markets.
    const standing = quality === "high" ? Math.min(40, stands.length) : Math.min(15, stands.length);
    for (let i = 0; i < standing; i++) {
      const s = stands[Math.floor(this.random() * stands.length)];
      const woman = this.random() < 0.35;
      this.peds.push({
        seg: -1, t: 0, dir: 1, speed: 0, lateral: 0, phase: this.random() * 6, woman, standing: true,
        scale: 0.92 + this.random() * 0.12, x: s.x + (this.random() - 0.5) * 2, z: s.z + (this.random() - 0.5) * 2, yaw: s.yaw + (this.random() - 0.5) * 1.5,
        ...this.clothes(woman),
      });
    }
  }

  private clothes(woman: boolean) {
    const pick = (a: string[]) => new THREE.Color(a[Math.floor(this.random() * a.length)]);
    return woman ? { top: pick(SAREES), bottom: pick(SAREES) } : { top: pick(SHIRTS), bottom: pick(LOWER_MEN) };
  }

  private make(rx: number, rz: number, minD: number, maxD: number): Ped | null {
    for (let k = 0; k < 20; k++) {
      const seg = Math.floor(this.random() * this.ways.length);
      const w = this.ways[seg];
      const t = this.random() * this.lens[seg];
      const f = t / (this.lens[seg] || 1);
      const x = w.x1 + (w.x2 - w.x1) * f, z = w.z1 + (w.z2 - w.z1) * f;
      const d = Math.hypot(x - rx, z - rz);
      if (d < minD || d > maxD) continue;
      const woman = this.random() < 0.38;
      return {
        seg, t, dir: this.random() < 0.5 ? 1 : -1, speed: 1.0 + this.random() * 0.6, lateral: (this.random() - 0.5) * 0.9,
        phase: this.random() * 6.28, woman, standing: false, scale: 0.9 + this.random() * 0.15, x, z, yaw: 0, ...this.clothes(woman),
      };
    }
    return null;
  }

  update(dt: number, rider: { x: number; z: number }) {
    for (const p of this.peds) {
      if (p.standing) {
        p.phase += dt;
        continue;
      }
      p.t += p.dir * p.speed * dt;
      p.phase += p.speed * dt * 3.4;
      const len = this.lens[p.seg];
      if (p.t < 0 || p.t > len) {
        // Continue onto a footpath that starts where this one ends, else turn back.
        const w = this.ways[p.seg];
        const ex = p.t > len ? w.x2 : w.x1, ez = p.t > len ? w.z2 : w.z1;
        const opts = (this.ends.get(`${Math.round(ex / 4)},${Math.round(ez / 4)}`) ?? []).filter((i) => i !== p.seg);
        if (opts.length && this.random() < 0.85) {
          const n = opts[Math.floor(this.random() * opts.length)];
          const nw = this.ways[n];
          const fromStart = Math.hypot(nw.x1 - ex, nw.z1 - ez) < Math.hypot(nw.x2 - ex, nw.z2 - ez);
          p.seg = n;
          p.dir = fromStart ? 1 : -1;
          p.t = fromStart ? 0 : this.lens[n];
        } else {
          p.dir = p.dir === 1 ? -1 : 1;
          p.t = Math.max(0, Math.min(len, p.t));
        }
      }
      const w = this.ways[p.seg];
      const L = this.lens[p.seg] || 1;
      const dx = (w.x2 - w.x1) / L, dz = (w.z2 - w.z1) / L;
      const f = p.t;
      p.x = w.x1 + dx * f + -dz * p.lateral;
      p.z = w.z1 + dz * f + dx * p.lateral;
      p.yaw = Math.atan2(-dx * p.dir, -dz * p.dir);

      if (Math.hypot(p.x - rider.x, p.z - rider.z) > 240) {
        const n = this.make(rider.x, rider.z, 70, 200);
        if (n) Object.assign(p, { seg: n.seg, t: n.t, dir: n.dir, x: n.x, z: n.z });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function PedestriansLayer({ sim, rider }: { sim: PedestrianSim; rider: React.RefObject<{ x: number; z: number }> }) {
  const n = sim.peds.length;
  const torso = useRef<THREE.InstancedMesh>(null);
  const head = useRef<THREE.InstancedMesh>(null);
  const legs = useRef<THREE.InstancedMesh>(null);
  const arms = useRef<THREE.InstancedMesh>(null);
  const skirt = useRef<THREE.InstancedMesh>(null);
  const geo = useMemo(
    () => ({
      torso: new THREE.BoxGeometry(0.38, 0.56, 0.22),
      head: new THREE.SphereGeometry(0.115, 10, 8),
      leg: new THREE.BoxGeometry(0.13, 0.82, 0.13).translate(0, -0.41, 0),
      arm: new THREE.BoxGeometry(0.085, 0.6, 0.085).translate(0, -0.3, 0),
      // Saree: a flared skirt from waist to ankle.
      skirt: new THREE.CylinderGeometry(0.2, 0.3, 0.88, 10).translate(0, -0.44, 0),
    }),
    [],
  );
  const t = useMemo(
    () => ({ base: new THREE.Matrix4(), local: new THREE.Matrix4(), out: new THREE.Matrix4(), q: new THREE.Quaternion(), e: new THREE.Euler(), p: new THREE.Vector3(), s: new THREE.Vector3(), zero: new THREE.Matrix4().makeScale(0, 0, 0) }),
    [],
  );

  // Static colours: clothes and skin.
  useLayoutEffect(() => {
    const skinTones = ["#8d5a3b", "#a0694a", "#7a4a30", "#b07a55"].map((c) => new THREE.Color(c));
    sim.peds.forEach((p, i) => {
      torso.current?.setColorAt(i, p.top);
      head.current?.setColorAt(i, skinTones[i % skinTones.length]);
      skirt.current?.setColorAt(i, p.bottom);
      legs.current?.setColorAt(i * 2, p.woman ? skinTones[i % 4] : p.bottom);
      legs.current?.setColorAt(i * 2 + 1, p.woman ? skinTones[i % 4] : p.bottom);
      arms.current?.setColorAt(i * 2, p.woman ? skinTones[i % 4] : p.top);
      arms.current?.setColorAt(i * 2 + 1, p.woman ? skinTones[i % 4] : p.top);
    });
    for (const m of [torso, head, legs, arms, skirt]) if (m.current?.instanceColor) m.current.instanceColor.needsUpdate = true;
  }, [sim]);

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.1);
    sim.update(dt, rider.current);
    const { base, local, out, q, e, p, s, zero } = t;
    const set = (mesh: THREE.InstancedMesh | null, i: number, x: number, y: number, z: number, rx: number, sx = 1, sy = 1, sz = 1) => {
      if (!mesh) return;
      local.compose(p.set(x, y, z), q.setFromEuler(e.set(rx, 0, 0)), s.set(sx, sy, sz));
      mesh.setMatrixAt(i, out.multiplyMatrices(base, local));
    };
    sim.peds.forEach((ped, i) => {
      // y = 0.16: standing on the raised footpath
      base.compose(p.set(ped.x, 0.16, ped.z), q.setFromEuler(e.set(0, ped.yaw, 0)), s.setScalar(ped.scale));
      const swing = ped.standing ? Math.sin(ped.phase * 0.7) * 0.04 : Math.sin(ped.phase) * 0.5;
      const bob = ped.standing ? 0 : Math.abs(Math.sin(ped.phase)) * 0.035;
      set(torso.current, i, 0, 1.17 + bob, 0, 0);
      set(head.current, i, 0, 1.6 + bob, -0.01, 0);
      set(legs.current, i * 2, -0.1, 0.86 + bob, 0, swing);
      set(legs.current, i * 2 + 1, 0.1, 0.86 + bob, 0, -swing);
      set(arms.current, i * 2, -0.235, 1.42 + bob, 0, -swing * 0.8);
      set(arms.current, i * 2 + 1, 0.235, 1.42 + bob, 0, swing * 0.8);
      if (ped.woman) set(skirt.current, i, 0, 0.9 + bob, 0, 0);
      else skirt.current?.setMatrixAt(i, zero);
    });
    for (const m of [torso, head, legs, arms, skirt]) if (m.current) m.current.instanceMatrix.needsUpdate = true;
  });

  if (!n) return null;
  return (
    <>
      <instancedMesh ref={torso} args={[geo.torso, undefined, n]} frustumCulled={false} castShadow>
        <meshLambertMaterial />
      </instancedMesh>
      <instancedMesh ref={head} args={[geo.head, undefined, n]} frustumCulled={false}>
        <meshLambertMaterial />
      </instancedMesh>
      <instancedMesh ref={legs} args={[geo.leg, undefined, n * 2]} frustumCulled={false}>
        <meshLambertMaterial />
      </instancedMesh>
      <instancedMesh ref={arms} args={[geo.arm, undefined, n * 2]} frustumCulled={false}>
        <meshLambertMaterial />
      </instancedMesh>
      <instancedMesh ref={skirt} args={[geo.skirt, undefined, n]} frustumCulled={false} castShadow>
        <meshLambertMaterial />
      </instancedMesh>
    </>
  );
}
