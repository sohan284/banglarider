"use client";

/**
 * The player's bikes: a small catalogue (4 motorcycles, 3 bicycles) and
 * detailed procedural models with a rider. All geometry is original and built
 * from primitives; the number plate is drawn on a canvas.
 */

import { useFrame } from "@react-three/fiber";
import { useMemo, useRef, type RefObject } from "react";
import * as THREE from "three";
import type { Vehicle } from "@/lib/routing";

export type V3 = [number, number, number];
export type EngineSound = "commuter" | "sport" | "scooter" | "cruiser" | "bicycle";

export interface BikeSpec {
  id: string;
  vehicle: Vehicle;
  name: { en: string; bn: string };
  blurb: { en: string; bn: string };
  /** Top speed (km/h) and acceleration (m/s²). */
  maxKmh: number;
  accel: number;
  /** Rear wheel radius (for wheel spin). */
  wheelR: number;
  sound: EngineSound;
  /** Helmet-camera eye position in bike space. */
  eye: { y: number; z: number };
}

export const BIKES: BikeSpec[] = [
  { id: "commuter", vehicle: "motorcycle", name: { en: "City Commuter 150", bn: "সিটি কমিউটার ১৫০" }, blurb: { en: "Everyday Dhaka bike", bn: "রোজকার ঢাকার বাইক" }, maxKmh: 105, accel: 2.8, wheelR: 0.31, sound: "commuter", eye: { y: 1.6, z: 0.5 } },
  { id: "sport", vehicle: "motorcycle", name: { en: "Street Sport 300", bn: "স্ট্রিট স্পোর্ট ৩০০" }, blurb: { en: "Fast, low and loud", bn: "দ্রুত ও শক্তিশালী" }, maxKmh: 170, accel: 5.2, wheelR: 0.32, sound: "sport", eye: { y: 1.42, z: 0.38 } },
  { id: "scooter", vehicle: "motorcycle", name: { en: "Urban Scooter 125", bn: "আরবান স্কুটার ১২৫" }, blurb: { en: "Easy step-through", bn: "সহজ ও আরামদায়ক" }, maxKmh: 85, accel: 2.5, wheelR: 0.24, sound: "scooter", eye: { y: 1.62, z: 0.45 } },
  { id: "cruiser", vehicle: "motorcycle", name: { en: "Highway Cruiser 400", bn: "হাইওয়ে ক্রুজার ৪০০" }, blurb: { en: "Laid-back and torquey", bn: "আরামে লম্বা পথ" }, maxKmh: 140, accel: 3.6, wheelR: 0.33, sound: "cruiser", eye: { y: 1.52, z: 0.45 } },
  { id: "city", vehicle: "bicycle", name: { en: "City Roadster", bn: "সিটি রোডস্টার" }, blurb: { en: "Classic upright, with basket", bn: "ঝুড়িসহ ক্লাসিক সাইকেল" }, maxKmh: 28, accel: 1.0, wheelR: 0.34, sound: "bicycle", eye: { y: 1.72, z: 0.32 } },
  { id: "mountain", vehicle: "bicycle", name: { en: "Trail Mountain", bn: "ট্রেইল মাউন্টেন" }, blurb: { en: "Fat tyres, suspension fork", bn: "মোটা টায়ার, সাসপেনশন" }, maxKmh: 38, accel: 1.3, wheelR: 0.34, sound: "bicycle", eye: { y: 1.62, z: 0.3 } },
  { id: "road", vehicle: "bicycle", name: { en: "Aero Road", bn: "অ্যারো রোড" }, blurb: { en: "Light and quick", bn: "হালকা ও দ্রুত" }, maxKmh: 55, accel: 1.7, wheelR: 0.34, sound: "bicycle", eye: { y: 1.5, z: 0.24 } },
];

export const BIKE_COLORS = ["#c8102e", "#1f4fa0", "#161616", "#f2f2f2", "#0f8a5f", "#f2b705", "#ff6f00", "#7b1fa2"];

export function bikesFor(vehicle: Vehicle): BikeSpec[] {
  return BIKES.filter((b) => b.vehicle === vehicle);
}
export function getBike(id: string | null | undefined, vehicle: Vehicle): BikeSpec {
  return BIKES.find((b) => b.id === id && b.vehicle === vehicle) ?? bikesFor(vehicle)[0];
}

// ---------------------------------------------------------------------------
// Primitive helpers
// ---------------------------------------------------------------------------

function Box({ s, p, c, r, basic }: { s: V3; p: V3; c: string; r?: V3; basic?: boolean }) {
  return (
    <mesh position={p} rotation={r ?? [0, 0, 0]} castShadow>
      <boxGeometry args={s} />
      {basic ? <meshBasicMaterial color={c} /> : <meshLambertMaterial color={c} />}
    </mesh>
  );
}

/** Cylinder along an axis. */
function Cyl({ r, l, p, axis = "y", c, seg = 12, basic }: { r: number; l: number; p: V3; axis?: "x" | "y" | "z"; c: string; seg?: number; basic?: boolean }) {
  const rot: V3 = axis === "x" ? [0, 0, Math.PI / 2] : axis === "z" ? [Math.PI / 2, 0, 0] : [0, 0, 0];
  return (
    <mesh position={p} rotation={rot} castShadow>
      <cylinderGeometry args={[r, r, l, seg]} />
      {basic ? <meshBasicMaterial color={c} /> : <meshLambertMaterial color={c} />}
    </mesh>
  );
}

const UP = new THREE.Vector3(0, 1, 0);
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

/** Positions a unit-height cylinder mesh between two points. */
function setRod(m: THREE.Mesh | null, a: THREE.Vector3, b: THREE.Vector3) {
  if (!m) return;
  const dir = _b.copy(b).sub(a);
  const len = dir.length() || 1e-3;
  m.position.copy(_a.copy(a).add(b).multiplyScalar(0.5));
  m.quaternion.setFromUnitVectors(UP, dir.multiplyScalar(1 / len));
  m.scale.set(1, len, 1);
}

/** Static rod between two points. */
export function Rod({ from, to, r, c }: { from: V3; to: V3; r: number; c: string }) {
  const ref = useRef<THREE.Mesh>(null);
  const [fx, fy, fz] = from;
  const [tx, ty, tz] = to;
  const t = useMemo(() => {
    const a = new THREE.Vector3(fx, fy, fz);
    const b = new THREE.Vector3(tx, ty, tz);
    const dir = b.clone().sub(a);
    return { p: a.clone().add(b).multiplyScalar(0.5), q: new THREE.Quaternion().setFromUnitVectors(UP, dir.clone().normalize()), l: dir.length() };
  }, [fx, fy, fz, tx, ty, tz]);
  return (
    <mesh ref={ref} position={t.p} quaternion={t.q} castShadow>
      <cylinderGeometry args={[r, r, t.l, 8]} />
      <meshLambertMaterial color={c} />
    </mesh>
  );
}

type WheelStyle = "alloy" | "wire" | "mtb" | "scooter";

function Wheel({ z, r, tyre, style, disc, wheelRef }: { z: number; r: number; tyre: number; style: WheelStyle; disc?: boolean; wheelRef: (g: THREE.Group | null) => void }) {
  const spokes = style === "wire" ? 12 : style === "mtb" ? 10 : style === "alloy" ? 5 : 6;
  return (
    <group position={[0, r, z]}>
      <group ref={wheelRef}>
        <mesh rotation-y={Math.PI / 2} castShadow>
          <torusGeometry args={[r - tyre, tyre, 10, 28]} />
          <meshLambertMaterial color="#181818" />
        </mesh>
        <mesh rotation-y={Math.PI / 2}>
          <torusGeometry args={[r - tyre * 1.9, style === "wire" || style === "mtb" ? 0.012 : 0.025, 6, 28]} />
          <meshLambertMaterial color={style === "alloy" || style === "scooter" ? "#3a3d40" : "#b8bdc2"} />
        </mesh>
        <Cyl r={style === "wire" || style === "mtb" ? 0.03 : 0.06} l={0.1} p={[0, 0, 0]} axis="x" c="#8a8f94" />
        {Array.from({ length: spokes }, (_, i) => (
          <mesh key={i} rotation-x={(i * Math.PI) / spokes}>
            <boxGeometry args={[style === "wire" || style === "mtb" ? 0.006 : 0.03, (r - tyre * 1.9) * 2, style === "wire" || style === "mtb" ? 0.006 : 0.045]} />
            <meshLambertMaterial color={style === "wire" || style === "mtb" ? "#c9ced3" : "#3a3d40"} />
          </mesh>
        ))}
      </group>
      {disc && <Cyl r={r * 0.55} l={0.012} p={[0.07, 0, 0]} axis="x" c="#a5a9ad" seg={20} />}
    </group>
  );
}

// ---------------------------------------------------------------------------
// Number plate (Bangladeshi style: white, black Bangla text)
// ---------------------------------------------------------------------------

function usePlateTexture(): THREE.CanvasTexture {
  return useMemo(() => {
    const c = document.createElement("canvas");
    c.width = 256;
    c.height = 128;
    const g = c.getContext("2d")!;
    const fam = getComputedStyle(document.documentElement).getPropertyValue("--font-bengali").trim() || "sans-serif";
    g.fillStyle = "#fbfbf6";
    g.fillRect(0, 0, 256, 128);
    g.strokeStyle = "#111";
    g.lineWidth = 6;
    g.strokeRect(4, 4, 248, 120);
    g.fillStyle = "#111";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.font = `700 40px ${fam}`;
    g.fillText("ঢাকা মেট্রো-হ", 128, 40);
    g.font = `700 46px ${fam}`;
    g.fillText("২৪-৮১৫৭", 128, 92);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }, []);
}

function Plate({ p, r }: { p: V3; r?: V3 }) {
  const tex = usePlateTexture();
  return (
    <mesh position={p} rotation={r ?? [0, 0, 0]}>
      <planeGeometry args={[0.22, 0.11]} />
      <meshLambertMaterial map={tex} />
    </mesh>
  );
}

// ---------------------------------------------------------------------------
// Rider
// ---------------------------------------------------------------------------

interface RiderPose {
  seat: V3;
  /** Hand position (x is +/- per side). */
  hands: V3;
  /** Foot position on pegs (x is +/- per side), or pedalling. */
  feet: V3 | { crank: V3; radius: number };
  /** Forward lean of the torso (radians). */
  lean: number;
  helmet: string;
  shirt: string;
}

function RiderBody({ pose, crank }: { pose: RiderPose; crank?: RefObject<THREE.Group | null> }) {
  const [, sy, sz] = pose.seat;
  const torsoLen = 0.58;
  const shoulder: V3 = [0, sy + torsoLen * Math.cos(pose.lean), sz - torsoLen * Math.sin(pose.lean)];
  const head: V3 = [0, shoulder[1] + 0.22 * Math.cos(pose.lean * 0.6), shoulder[2] - 0.22 * Math.sin(pose.lean * 0.6) - 0.02];
  const pedal = !Array.isArray(pose.feet);
  const legs = useRef<(THREE.Mesh | null)[]>([]);
  const feetRefs = useRef<(THREE.Mesh | null)[]>([]);

  // Pedalling: two-bone IK from hip to the pedal on each side.
  useFrame(() => {
    if (!pedal || !crank?.current) return;
    const f = pose.feet as { crank: V3; radius: number };
    const th = crank.current.rotation.x;
    const L1 = 0.46, L2 = 0.46;
    [-1, 1].forEach((side, i) => {
      const ang = th + (side < 0 ? 0 : Math.PI);
      const foot = new THREE.Vector3(side * 0.12, f.crank[1] + f.radius * Math.cos(ang), f.crank[2] + f.radius * Math.sin(ang));
      const hip = new THREE.Vector3(side * 0.1, sy - 0.02, sz + 0.02);
      const d = Math.min(hip.distanceTo(foot), L1 + L2 - 0.01);
      const dir = foot.clone().sub(hip).normalize();
      const a = (L1 * L1 - L2 * L2 + d * d) / (2 * d);
      const h = Math.sqrt(Math.max(0, L1 * L1 - a * a));
      // knee bends forward (-z) in the y-z plane
      let py = -dir.z, pz = dir.y;
      if (pz > 0) {
        py = -py;
        pz = -pz;
      }
      const knee = hip.clone().addScaledVector(dir, a).add(new THREE.Vector3(0, py, pz).multiplyScalar(h));
      setRod(legs.current[i * 2], hip, knee);
      setRod(legs.current[i * 2 + 1], knee, foot);
      feetRefs.current[i]?.position.copy(foot).add(new THREE.Vector3(0, -0.02, -0.04));
    });
  });

  return (
    <group>
      {/* torso + hips */}
      <Rod from={[0, sy, sz]} to={shoulder} r={0.17} c={pose.shirt} />
      <mesh position={[0, sy + 0.02, sz]} castShadow>
        <boxGeometry args={[0.34, 0.16, 0.3]} />
        <meshLambertMaterial color="#2b3440" />
      </mesh>
      {/* helmet with visor */}
      <mesh position={head} castShadow>
        <sphereGeometry args={[0.155, 16, 12]} />
        <meshLambertMaterial color={pose.helmet} />
      </mesh>
      <mesh position={[0, head[1] - 0.01, head[2] - 0.12]} rotation-x={0.2}>
        <boxGeometry args={[0.2, 0.08, 0.06]} />
        <meshLambertMaterial color="#1c2630" />
      </mesh>
      {/* arms with a slight elbow bend */}
      {[-1, 1].map((side) => {
        const sh: V3 = [side * 0.19, shoulder[1] - 0.06, shoulder[2]];
        const hd: V3 = [side * Math.abs(pose.hands[0]), pose.hands[1], pose.hands[2]];
        const el: V3 = [(sh[0] + hd[0]) / 2 + side * 0.07, (sh[1] + hd[1]) / 2 - 0.06, (sh[2] + hd[2]) / 2 + 0.03];
        return (
          <group key={side}>
            <Rod from={sh} to={el} r={0.052} c={pose.shirt} />
            <Rod from={el} to={hd} r={0.045} c={pose.shirt} />
            <mesh position={hd}>
              <sphereGeometry args={[0.045, 8, 6]} />
              <meshLambertMaterial color="#1b1b1b" />
            </mesh>
          </group>
        );
      })}
      {/* legs */}
      {pedal
        ? [0, 1].map((i) => (
            <group key={i}>
              <mesh ref={(m) => void (legs.current[i * 2] = m)} castShadow>
                <cylinderGeometry args={[0.065, 0.06, 1, 8]} />
                <meshLambertMaterial color="#2b3440" />
              </mesh>
              <mesh ref={(m) => void (legs.current[i * 2 + 1] = m)} castShadow>
                <cylinderGeometry args={[0.055, 0.045, 1, 8]} />
                <meshLambertMaterial color="#2b3440" />
              </mesh>
              <mesh ref={(m) => void (feetRefs.current[i] = m)}>
                <boxGeometry args={[0.09, 0.07, 0.22]} />
                <meshLambertMaterial color="#141414" />
              </mesh>
            </group>
          ))
        : [-1, 1].map((side) => {
            const ft = pose.feet as V3;
            const hip: V3 = [side * 0.12, sy - 0.02, sz];
            const foot: V3 = [side * Math.abs(ft[0]), ft[1], ft[2]];
            const knee: V3 = [side * (Math.abs(ft[0]) + 0.04), Math.max(hip[1], foot[1]) + 0.08, Math.min(hip[2], foot[2]) - 0.22];
            return (
              <group key={side}>
                <Rod from={hip} to={knee} r={0.07} c="#2b3440" />
                <Rod from={knee} to={foot} r={0.058} c="#2b3440" />
                <Box s={[0.1, 0.08, 0.24]} p={[foot[0], foot[1] + 0.02, foot[2] - 0.04]} c="#141414" />
              </group>
            );
          })}
    </group>
  );
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

type WheelRef = (i: number) => (g: THREE.Group | null) => void;

interface ModelProps {
  color: string;
  wheelRef: WheelRef;
  crank: RefObject<THREE.Group | null>;
  showRider: boolean;
  headlightOn: boolean;
  braking: RefObject<boolean>;
}

function TailLight({ p, s, braking }: { p: V3; s: V3; braking: RefObject<boolean> }) {
  const mat = useRef<THREE.MeshBasicMaterial>(null);
  useFrame(() => mat.current?.color.set(braking.current ? "#ff2a2a" : "#8a1010"));
  return (
    <mesh position={p}>
      <boxGeometry args={s} />
      <meshBasicMaterial ref={mat} color="#8a1010" />
    </mesh>
  );
}

function Headlight({ p, r, on }: { p: V3; r: number; on: boolean }) {
  return (
    <mesh position={p} rotation-x={Math.PI / 2}>
      <cylinderGeometry args={[r, r * 0.9, 0.06, 16]} />
      <meshBasicMaterial color={on ? "#fff7d0" : "#d9dad2"} />
    </mesh>
  );
}

function Mirrors({ y, z, x }: { y: number; z: number; x: number }) {
  return (
    <>
      {[-1, 1].map((s) => (
        <group key={s}>
          <Rod from={[s * (x - 0.1), y - 0.22, z + 0.04]} to={[s * x, y, z]} r={0.01} c="#2a2a2a" />
          <mesh position={[s * x, y + 0.02, z]} rotation-y={s * 0.2}>
            <cylinderGeometry args={[0.055, 0.055, 0.015, 14]} />
            <meshLambertMaterial color="#9aa5ae" />
          </mesh>
        </group>
      ))}
    </>
  );
}

function Commuter(p: ModelProps) {
  const c = p.color;
  return (
    <group>
      <Wheel z={-0.66} r={0.31} tyre={0.07} style="alloy" disc wheelRef={p.wheelRef(0)} />
      <Wheel z={0.64} r={0.31} tyre={0.075} style="alloy" wheelRef={p.wheelRef(1)} />
      {[-1, 1].map((s) => (
        <Rod key={s} from={[s * 0.085, 0.31, -0.66]} to={[s * 0.09, 0.98, -0.5]} r={0.028} c="#9b9fa3" />
      ))}
      <Box s={[0.14, 0.04, 0.42]} p={[0, 0.64, -0.66]} c={c} r={[0.1, 0, 0]} />
      <Box s={[0.2, 0.16, 0.14]} p={[0, 0.98, -0.58]} c={c} />
      <Headlight p={[0, 0.98, -0.66]} r={0.075} on={p.headlightOn} />
      <Rod from={[-0.36, 1.06, -0.46]} to={[0.36, 1.06, -0.46]} r={0.016} c="#202020" />
      <Rod from={[-0.38, 1.06, -0.46]} to={[-0.26, 1.06, -0.46]} r={0.03} c="#111" />
      <Rod from={[0.26, 1.06, -0.46]} to={[0.38, 1.06, -0.46]} r={0.03} c="#111" />
      <Mirrors x={0.3} y={1.3} z={-0.5} />
      <Box s={[0.15, 0.08, 0.06]} p={[0, 1.1, -0.55]} c="#1e2328" r={[-0.5, 0, 0]} />
      <Box s={[0.11, 0.05, 0.01]} p={[0, 1.12, -0.575]} c="#9ff0d4" r={[-0.5, 0, 0]} basic />
      {/* tank + shrouds */}
      <Box s={[0.34, 0.22, 0.5]} p={[0, 0.88, -0.18]} c={c} r={[0.12, 0, 0]} />
      <Box s={[0.4, 0.16, 0.22]} p={[0, 0.78, -0.36]} c={c} />
      {/* seat, side panel, tail */}
      <Box s={[0.3, 0.1, 0.62]} p={[0, 0.86, 0.32]} c="#151515" />
      <Box s={[0.28, 0.2, 0.32]} p={[0, 0.64, 0.24]} c={c} />
      <Box s={[0.24, 0.12, 0.34]} p={[0, 0.78, 0.68]} c={c} r={[-0.15, 0, 0]} />
      <TailLight p={[0, 0.8, 0.86]} s={[0.14, 0.06, 0.03]} braking={p.braking} />
      <Plate p={[0, 0.64, 0.88]} />
      <Rod from={[-0.17, 0.86, 0.5]} to={[0.17, 0.86, 0.5]} r={0.015} c="#777" />
      {/* engine block + fins */}
      <Box s={[0.26, 0.3, 0.38]} p={[0, 0.44, -0.12]} c="#4a4d50" />
      {[0, 1, 2, 3].map((i) => (
        <Box key={i} s={[0.3, 0.015, 0.2]} p={[0, 0.5 + i * 0.05, -0.28]} c="#6a6e72" r={[0.4, 0, 0]} />
      ))}
      <Box s={[0.04, 0.09, 0.55]} p={[-0.15, 0.36, 0.36]} c="#151515" />
      {/* frame, swingarm, exhaust, pegs */}
      <Rod from={[0, 0.95, -0.48]} to={[0, 0.62, 0.15]} r={0.03} c="#2a2a2a" />
      {[-1, 1].map((s) => (
        <Rod key={s} from={[s * 0.1, 0.36, 0.0]} to={[s * 0.1, 0.31, 0.64]} r={0.025} c="#2a2a2a" />
      ))}
      <Rod from={[0.14, 0.4, -0.05]} to={[0.18, 0.4, 0.45]} r={0.035} c="#b0b4b8" />
      <Cyl r={0.055} l={0.38} p={[0.19, 0.44, 0.62]} axis="z" c="#c4c8cc" />
      <Rod from={[-0.25, 0.37, 0.05]} to={[0.25, 0.37, 0.05]} r={0.015} c="#333" />
      {p.showRider && <RiderBody pose={{ seat: [0, 0.9, 0.32], hands: [0.33, 1.06, -0.44], feet: [0.22, 0.38, 0.05], lean: 0.35, helmet: "#006a4e", shirt: "#2f4f6f" }} />}
    </group>
  );
}

function Sport(p: ModelProps) {
  const c = p.color;
  return (
    <group>
      <Wheel z={-0.7} r={0.31} tyre={0.07} style="alloy" disc wheelRef={p.wheelRef(0)} />
      <Wheel z={0.7} r={0.32} tyre={0.095} style="alloy" disc wheelRef={p.wheelRef(1)} />
      {[-1, 1].map((s) => (
        <Rod key={s} from={[s * 0.09, 0.31, -0.7]} to={[s * 0.09, 0.95, -0.48]} r={0.034} c="#d4a017" />
      ))}
      <Box s={[0.15, 0.04, 0.4]} p={[0, 0.66, -0.7]} c={c} r={[0.15, 0, 0]} />
      {/* fairing */}
      <Box s={[0.42, 0.34, 0.42]} p={[0, 0.95, -0.55]} c={c} r={[0.55, 0, 0]} />
      <Box s={[0.44, 0.42, 0.75]} p={[0, 0.66, -0.22]} c={c} />
      <Box s={[0.36, 0.14, 0.5]} p={[0, 0.38, -0.15]} c="#151515" />
      <Box s={[0.3, 0.2, 0.03]} p={[0, 1.16, -0.62]} c="#1d2a35" r={[-0.65, 0, 0]} />
      {[-0.09, 0.09].map((x) => (
        <Box key={x} s={[0.1, 0.05, 0.04]} p={[x, 0.98, -0.77]} c={p.headlightOn ? "#fff7d0" : "#e6e6dc"} r={[0.55, 0, 0]} basic />
      ))}
      {/* tank, seat, tail */}
      <Box s={[0.36, 0.24, 0.48]} p={[0, 0.98, -0.08]} c={c} r={[0.18, 0, 0]} />
      <Box s={[0.26, 0.08, 0.36]} p={[0, 0.95, 0.3]} c="#151515" />
      <Box s={[0.24, 0.16, 0.42]} p={[0, 1.02, 0.62]} c={c} r={[-0.35, 0, 0]} />
      <TailLight p={[0, 1.07, 0.84]} s={[0.12, 0.04, 0.03]} braking={p.braking} />
      <Plate p={[0, 0.72, 0.96]} r={[-0.3, 0, 0]} />
      {/* clip-ons, mirrors, dash */}
      {[-1, 1].map((s) => (
        <Rod key={s} from={[s * 0.1, 0.93, -0.44]} to={[s * 0.3, 0.92, -0.38]} r={0.02} c="#111" />
      ))}
      <Mirrors x={0.26} y={1.17} z={-0.6} />
      <Box s={[0.18, 0.1, 0.04]} p={[0, 1.06, -0.48]} c="#1e2328" r={[-0.8, 0, 0]} />
      <Box s={[0.14, 0.07, 0.01]} p={[0, 1.07, -0.5]} c="#ffb347" r={[-0.8, 0, 0]} basic />
      {/* swingarm + underbelly exhaust */}
      {[-1, 1].map((s) => (
        <Rod key={s} from={[s * 0.11, 0.42, 0.1]} to={[s * 0.11, 0.32, 0.7]} r={0.03} c="#3a3a3a" />
      ))}
      <Box s={[0.16, 0.14, 0.32]} p={[0.15, 0.38, 0.35]} c="#2b2b2b" r={[-0.2, 0, 0]} />
      {p.showRider && <RiderBody pose={{ seat: [0, 0.97, 0.28], hands: [0.3, 0.94, -0.4], feet: [0.18, 0.5, 0.26], lean: 0.95, helmet: "#111", shirt: "#1d1d1d" }} />}
    </group>
  );
}

function Scooter(p: ModelProps) {
  const c = p.color;
  return (
    <group>
      <Wheel z={-0.62} r={0.24} tyre={0.06} style="scooter" wheelRef={p.wheelRef(0)} />
      <Wheel z={0.55} r={0.24} tyre={0.065} style="scooter" wheelRef={p.wheelRef(1)} />
      <Rod from={[0, 0.24, -0.62]} to={[0, 0.98, -0.5]} r={0.04} c="#4a4a4a" />
      <Box s={[0.16, 0.05, 0.3]} p={[0, 0.5, -0.62]} c={c} />
      {/* apron + floorboard + rear body */}
      <Box s={[0.44, 0.72, 0.12]} p={[0, 0.66, -0.46]} c={c} r={[0.18, 0, 0]} />
      <Box s={[0.4, 0.06, 0.5]} p={[0, 0.32, -0.08]} c="#2d2d2d" />
      <Box s={[0.44, 0.42, 0.72]} p={[0, 0.58, 0.4]} c={c} />
      <Box s={[0.32, 0.1, 0.6]} p={[0, 0.84, 0.36]} c="#151515" />
      <Box s={[0.3, 0.16, 0.16]} p={[0, 1.04, -0.5]} c={c} />
      <Headlight p={[0, 1.04, -0.59]} r={0.06} on={p.headlightOn} />
      <Rod from={[-0.33, 1.06, -0.46]} to={[-0.2, 1.06, -0.46]} r={0.028} c="#111" />
      <Rod from={[0.2, 1.06, -0.46]} to={[0.33, 1.06, -0.46]} r={0.028} c="#111" />
      <Mirrors x={0.26} y={1.28} z={-0.48} />
      <Box s={[0.14, 0.06, 0.01]} p={[0, 1.13, -0.43]} c="#9ff0d4" r={[-0.6, 0, 0]} basic />
      <TailLight p={[0, 0.72, 0.77]} s={[0.2, 0.06, 0.03]} braking={p.braking} />
      <Plate p={[0, 0.52, 0.77]} />
      {p.showRider && <RiderBody pose={{ seat: [0, 0.9, 0.34], hands: [0.29, 1.06, -0.44], feet: [0.14, 0.38, -0.12], lean: 0.12, helmet: "#f2f2f2", shirt: "#7a3b2e" }} />}
    </group>
  );
}

function Cruiser(p: ModelProps) {
  const c = p.color;
  const chrome = "#cfd3d6";
  return (
    <group>
      <Wheel z={-0.86} r={0.33} tyre={0.08} style="wire" disc wheelRef={p.wheelRef(0)} />
      <Wheel z={0.7} r={0.33} tyre={0.09} style="wire" wheelRef={p.wheelRef(1)} />
      {[-1, 1].map((s) => (
        <Rod key={s} from={[s * 0.1, 0.33, -0.86]} to={[s * 0.1, 1.0, -0.56]} r={0.032} c={chrome} />
      ))}
      <Box s={[0.18, 0.05, 0.5]} p={[0, 0.68, -0.84]} c={c} r={[0.25, 0, 0]} />
      <Headlight p={[0, 0.98, -0.68]} r={0.11} on={p.headlightOn} />
      <Cyl r={0.12} l={0.1} p={[0, 0.98, -0.62]} axis="z" c={chrome} seg={18} />
      {/* wide pull-back bars */}
      <Rod from={[0, 1.04, -0.56]} to={[-0.32, 1.12, -0.5]} r={0.018} c={chrome} />
      <Rod from={[0, 1.04, -0.56]} to={[0.32, 1.12, -0.5]} r={0.018} c={chrome} />
      <Rod from={[-0.32, 1.12, -0.5]} to={[-0.42, 1.12, -0.38]} r={0.03} c="#111" />
      <Rod from={[0.32, 1.12, -0.5]} to={[0.42, 1.12, -0.38]} r={0.03} c="#111" />
      <Mirrors x={0.34} y={1.38} z={-0.52} />
      {/* teardrop tank */}
      <mesh position={[0, 0.84, -0.22]} scale={[0.2, 0.15, 0.36]} castShadow>
        <sphereGeometry args={[1, 18, 12]} />
        <meshLambertMaterial color={c} />
      </mesh>
      <Box s={[0.36, 0.1, 0.5]} p={[0, 0.7, 0.24]} c="#2a1a12" />
      <Box s={[0.3, 0.16, 0.3]} p={[0, 0.82, 0.52]} c="#2a1a12" r={[-0.4, 0, 0]} />
      <Box s={[0.26, 0.06, 0.62]} p={[0, 0.7, 0.66]} c={c} r={[-0.2, 0, 0]} />
      <TailLight p={[0, 0.72, 0.98]} s={[0.14, 0.05, 0.03]} braking={p.braking} />
      <Plate p={[0, 0.58, 0.98]} />
      {/* V-twin */}
      {[-1, 1].map((s) => (
        <Cyl key={s} r={0.08} l={0.3} p={[0, 0.5, -0.12 + s * 0.1]} axis="y" c={chrome} />
      ))}
      <Box s={[0.28, 0.2, 0.36]} p={[0, 0.34, -0.08]} c="#3a3a3a" />
      {[0.12, 0.2].map((y) => (
        <Rod key={y} from={[0.16, 0.3 + y * 0.3, -0.05]} to={[0.2, 0.3 + y * 0.4, 0.95]} r={0.035} c={chrome} />
      ))}
      <Rod from={[-0.28, 0.42, -0.45]} to={[0.28, 0.42, -0.45]} r={0.015} c={chrome} />
      {p.showRider && <RiderBody pose={{ seat: [0, 0.74, 0.24], hands: [0.42, 1.12, -0.38], feet: [0.24, 0.44, -0.45], lean: -0.05, helmet: "#3b2a1a", shirt: "#3a3a3a" }} />}
    </group>
  );
}

/** Shared bicycle frame. */
function BicycleFrame({ c, kind, wheelRef, crank, braking, showRider }: { c: string; kind: "city" | "mountain" | "road" } & ModelProps) {
  const tyre = kind === "mountain" ? 0.05 : kind === "road" ? 0.016 : 0.025;
  const style: WheelStyle = kind === "mountain" ? "mtb" : "wire";
  const seatTop: V3 = kind === "road" ? [0, 0.98, 0.24] : [0, 0.92, 0.2];
  const head: V3 = kind === "road" ? [0, 0.86, -0.42] : [0, 0.86, -0.42];
  const bb: V3 = [0, 0.33, 0];
  return (
    <group>
      <Wheel z={-0.56} r={0.34} tyre={tyre} style={style} wheelRef={wheelRef(0)} />
      <Wheel z={0.54} r={0.34} tyre={tyre} style={style} wheelRef={wheelRef(1)} />
      {/* main triangle + stays */}
      <Rod from={bb} to={[0, 0.84, 0.18]} r={0.022} c={c} />
      <Rod from={bb} to={head} r={0.026} c={c} />
      <Rod from={[0, 0.82, 0.16]} to={[0, kind === "city" ? 0.7 : 0.8, -0.4]} r={0.021} c={c} />
      <Rod from={bb} to={[0, 0.34, 0.54]} r={0.016} c={c} />
      <Rod from={[0, 0.82, 0.18]} to={[0, 0.34, 0.54]} r={0.015} c={c} />
      {/* fork */}
      <Rod from={[0, 0.34, -0.56]} to={head} r={kind === "mountain" ? 0.035 : 0.02} c={kind === "mountain" ? "#2b2b2b" : "#b0b4b8"} />
      {kind === "mountain" && <Cyl r={0.045} l={0.2} p={[0, 0.66, -0.5]} c="#d4a017" />}
      {/* seat post + saddle */}
      <Rod from={[0, 0.82, 0.18]} to={seatTop} r={0.014} c="#999" />
      <Box s={[0.13, 0.05, 0.26]} p={[seatTop[0], seatTop[1] + 0.02, seatTop[2]]} c="#141414" />
      {/* bars */}
      <Rod from={head} to={[0, head[1] + 0.14, head[2] - (kind === "road" ? 0.08 : 0.02)]} r={0.016} c="#999" />
      {kind === "road" ? (
        <>
          <Rod from={[-0.2, 1.0, -0.5]} to={[0.2, 1.0, -0.5]} r={0.014} c="#111" />
          {[-1, 1].map((s) => (
            <group key={s}>
              <Rod from={[s * 0.2, 1.0, -0.5]} to={[s * 0.2, 0.9, -0.58]} r={0.014} c="#111" />
              <Rod from={[s * 0.2, 0.9, -0.58]} to={[s * 0.2, 0.86, -0.5]} r={0.014} c="#111" />
            </group>
          ))}
        </>
      ) : (
        <>
          <Rod from={[kind === "mountain" ? -0.36 : -0.28, 1.0, -0.44]} to={[kind === "mountain" ? 0.36 : 0.28, 1.0, -0.44]} r={0.014} c="#222" />
          {[-1, 1].map((s) => (
            <Rod key={s} from={[s * (kind === "mountain" ? 0.36 : 0.28), 1.0, -0.44]} to={[s * (kind === "mountain" ? 0.26 : 0.18), 1.0, -0.44]} r={0.025} c="#111" />
          ))}
          <mesh position={[0.14, 1.04, -0.44]}>
            <sphereGeometry args={[0.033, 10, 8]} />
            <meshLambertMaterial color="#c0c4c8" />
          </mesh>
        </>
      )}
      {/* crank + chainring + pedals (rotating) */}
      <group position={bb} ref={crank}>
        <Cyl r={0.1} l={0.012} p={[0.07, 0, 0]} axis="x" c="#888" seg={20} />
        <Rod from={[0.09, 0, 0]} to={[0.09, 0.17, 0]} r={0.012} c="#555" />
        <Rod from={[-0.09, 0, 0]} to={[-0.09, -0.17, 0]} r={0.012} c="#555" />
        <Box s={[0.09, 0.02, 0.06]} p={[0.13, 0.17, 0]} c="#222" />
        <Box s={[0.09, 0.02, 0.06]} p={[-0.13, -0.17, 0]} c="#222" />
      </group>
      <Rod from={[0.07, 0.33, 0]} to={[0.07, 0.34, 0.54]} r={0.006} c="#444" />
      {kind === "city" && (
        <>
          {/* fenders, rear rack, front basket, chain guard */}
          <mesh position={[0, 0.34, -0.56]} rotation-y={Math.PI / 2}>
            <torusGeometry args={[0.38, 0.03, 4, 16, Math.PI * 0.9]} />
            <meshLambertMaterial color={c} />
          </mesh>
          <mesh position={[0, 0.34, 0.54]} rotation={[0, Math.PI / 2, 0.4]}>
            <torusGeometry args={[0.38, 0.03, 4, 16, Math.PI * 0.9]} />
            <meshLambertMaterial color={c} />
          </mesh>
          <Box s={[0.2, 0.02, 0.32]} p={[0, 0.74, 0.5]} c="#666" />
          <Box s={[0.32, 0.2, 0.24]} p={[0, 0.92, -0.62]} c="#6b5b3e" />
          <Box s={[0.03, 0.07, 0.5]} p={[0.08, 0.33, 0.26]} c="#2a2a2a" />
        </>
      )}
      <TailLight p={[0, kind === "city" ? 0.78 : 0.88, kind === "city" ? 0.66 : 0.26]} s={[0.05, 0.04, 0.02]} braking={braking} />
      {showRider && (
        <RiderBody
          crank={crank}
          pose={{
            seat: [0, seatTop[1] + 0.06, seatTop[2]],
            hands: kind === "road" ? [0.2, 0.93, -0.55] : [kind === "mountain" ? 0.33 : 0.25, 1.01, -0.44],
            feet: { crank: bb, radius: 0.17 },
            lean: kind === "road" ? 0.85 : kind === "mountain" ? 0.5 : 0.18,
            helmet: kind === "city" ? "#e2263a" : kind === "mountain" ? "#f2b705" : "#ffffff",
            shirt: kind === "road" ? "#1f4fa0" : "#2f4f6f",
          }}
        />
      )}
    </group>
  );
}

export function PlayerBike(props: ModelProps & { spec: BikeSpec }) {
  switch (props.spec.id) {
    case "sport":
      return <Sport {...props} />;
    case "scooter":
      return <Scooter {...props} />;
    case "cruiser":
      return <Cruiser {...props} />;
    case "city":
    case "mountain":
    case "road":
      return <BicycleFrame {...props} c={props.color} kind={props.spec.id} />;
    default:
      return <Commuter {...props} />;
  }
}
