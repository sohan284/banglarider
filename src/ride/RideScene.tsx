"use client";
/* eslint-disable react-hooks/immutability -- the ride simulation is a mutable object shared with the render loop and updated every frame (standard react-three-fiber pattern) */

/**
 * The 3D part of ride mode (react-three-fiber). Everything here is original,
 * procedural geometry and canvas-drawn textures: no external models or images.
 */

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import * as THREE from "three";
import type { Vehicle } from "@/lib/routing";
import { angleDiff, HOME_LANE, LIGHTING, type Lighting, type Quality, type RideWorld, type TimeOfDay } from "@/ride/rideWorld";
import { PlayerBike, type BikeSpec } from "@/ride/bikes";
import { KIND, TrafficLayer, type HonkHandler } from "@/ride/traffic";
import type { Instance } from "@/ride/streetDetail";
import { makeFacadeTextures, makeGlowTexture, makeSignTexture } from "@/ride/textures";

// ---------------------------------------------------------------------------
// Shared simulation state (mutated every frame, read by the HUD at ~10 Hz)
// ---------------------------------------------------------------------------

export type CameraView = "chase" | "helmet";

export interface RideSim {
  mode: "route" | "free";
  playing: boolean;
  /** Metres travelled along the route. */
  s: number;
  /** Chosen cruising speed for auto-ride (km/h). */
  speedKmh: number;
  maxKmh: number;
  /** Bike's max acceleration (m/s²). */
  accel: number;
  /** Lateral position relative to the road centre (m, + = right). */
  lat: number;
  /** Current speed (m/s) and smoothed acceleration (m/s²). */
  v: number;
  a: number;
  x: number;
  z: number;
  yaw: number;
  done: boolean;
  /** Seconds since the last speed-breaker hit (for the bump animation). */
  bumpT: number;
  /** -1..1 throttle and steering for free mode (keyboard or joystick). */
  input: { fwd: number; turn: number };
}

export function createSim(speedKmh: number, maxKmh: number, accel: number): RideSim {
  return { mode: "route", playing: false, s: 0, speedKmh, maxKmh, accel, lat: HOME_LANE, v: 0, a: 0, x: 0, z: 0, yaw: 0, done: false, bumpT: 99, input: { fwd: 0, turn: 0 } };
}

export interface LocalLandmark {
  id: string;
  x: number;
  z: number;
}

interface Props {
  world: RideWorld;
  vehicle: Vehicle;
  bike: BikeSpec;
  bikeColor: string;
  onHonk?: HonkHandler;
  tod: TimeOfDay;
  quality: Quality;
  view: CameraView;
  sim: RefObject<RideSim>;
  landmarks: LocalLandmark[];
  reducedMotion: boolean;
  onContextLost: () => void;
}

export default function RideScene(props: Props) {
  const light = LIGHTING[props.tod];
  const high = props.quality === "high";
  return (
    <Canvas
      key={props.quality /* new renderer settings (shadows, AA) need a fresh canvas */}
      dpr={high ? [1, 1.6] : 1}
      shadows={high ? "soft" : false}
      gl={{ antialias: high, powerPreference: "high-performance" }}
      camera={{ fov: 62, near: 0.1, far: 1000, position: [0, 6, 10] }}
      onCreated={({ gl }) => {
        const el = gl.domElement;
        el.addEventListener("webglcontextlost", (e) => {
          e.preventDefault();
          // Our own teardown (e.g. switching quality) also loses the context;
          // only report it if the canvas is still on the page afterwards.
          setTimeout(() => {
            if (el.isConnected) props.onContextLost();
          }, 400);
        });
      }}
      aria-hidden
    >
      <fog attach="fog" args={[light.fog, light.fogNear, light.fogFar]} />
      <Sky light={light} />
      <hemisphereLight args={[light.hemiSky, light.hemiGround, light.hemiIntensity]} />
      <Sun light={light} sim={props.sim} shadows={high} />

      <mesh rotation-x={-Math.PI / 2} receiveShadow>
        <circleGeometry args={[props.world.radius, 48]} />
        <meshLambertMaterial color={light.ground} />
      </mesh>
      <mesh geometry={props.world.roads} receiveShadow>
        <meshLambertMaterial vertexColors />
      </mesh>
      <mesh geometry={props.world.detail.marks} receiveShadow>
        <meshLambertMaterial vertexColors polygonOffset polygonOffsetFactor={-1} />
      </mesh>
      <mesh geometry={props.world.route}>
        <meshBasicMaterial vertexColors transparent opacity={0.7} depthWrite={false} polygonOffset polygonOffsetFactor={-2} />
      </mesh>
      <mesh geometry={props.world.detail.footpaths} receiveShadow>
        <meshLambertMaterial vertexColors />
      </mesh>
      <mesh geometry={props.world.detail.walls} castShadow receiveShadow>
        <meshLambertMaterial vertexColors side={THREE.DoubleSide} />
      </mesh>
      <mesh geometry={props.world.detail.posts}>
        <meshLambertMaterial vertexColors />
      </mesh>
      <lineSegments geometry={props.world.detail.wires}>
        <lineBasicMaterial color="#1a1a1a" />
      </lineSegments>

      <Buildings world={props.world} glow={light.nightGlow} quality={props.quality} />
      <Signs world={props.world} glow={light.nightGlow} />
      <Trees trees={props.world.detail.trees} />
      <Lamps lamps={props.world.detail.lamps} glow={light.nightGlow} />
      <Poles poles={props.world.detail.poles} />
      <TrafficLayer sim={props.world.traffic} rider={props.sim} onHonk={props.onHonk} />

      {props.landmarks.map((l) => (
        <group key={l.id} position={[l.x, 0, l.z]}>
          <mesh position={[0, 9, 0]}>
            <cylinderGeometry args={[0.18, 0.18, 18, 6]} />
            <meshLambertMaterial color="#e6e6e6" />
          </mesh>
          <mesh position={[0, 19, 0]}>
            <octahedronGeometry args={[1.8]} />
            <meshLambertMaterial color="#006a4e" emissive="#0a8f69" emissiveIntensity={0.3 + light.nightGlow} />
          </mesh>
        </group>
      ))}

      <Rider world={props.world} vehicle={props.vehicle} bike={props.bike} bikeColor={props.bikeColor} sim={props.sim} headlight={light.headlight} reducedMotion={props.reducedMotion} view={props.view} />
    </Canvas>
  );
}

// ---------------------------------------------------------------------------
// Sky dome (follows the camera) with a sun / moon disc
// ---------------------------------------------------------------------------

function Sky({ light }: { light: Lighting }) {
  const group = useRef<THREE.Group>(null);
  const glow = useMemo(() => makeGlowTexture(), []);
  const geom = useMemo(() => {
    const g = new THREE.SphereGeometry(900, 24, 16);
    const zen = new THREE.Color(light.zenith);
    const hor = new THREE.Color(light.horizon);
    const pos = g.getAttribute("position");
    const cols: number[] = [];
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const t = Math.max(0, pos.getY(i) / 900);
      c.copy(hor).lerp(zen, Math.pow(t, 0.55));
      cols.push(c.r, c.g, c.b);
    }
    g.setAttribute("color", new THREE.Float32BufferAttribute(cols, 3));
    return g;
  }, [light]);
  useEffect(() => () => geom.dispose(), [geom]);
  const sunPos = useMemo(() => new THREE.Vector3(...light.sunDir).normalize().multiplyScalar(820), [light]);
  const discSize = light.nightGlow > 0.9 ? 55 : 150;
  useFrame(({ camera }) => group.current?.position.copy(camera.position));
  return (
    <group ref={group}>
      <mesh geometry={geom} renderOrder={-1}>
        <meshBasicMaterial vertexColors side={THREE.BackSide} fog={false} depthWrite={false} />
      </mesh>
      <sprite position={sunPos} scale={[discSize, discSize, 1]} renderOrder={-1}>
        <spriteMaterial map={glow} color={light.disc} fog={false} depthWrite={false} transparent blending={THREE.AdditiveBlending} />
      </sprite>
    </group>
  );
}

/** Directional sun/moon light; on High it casts shadows in a box around the rider. */
function Sun({ light, sim, shadows }: { light: Lighting; sim: RefObject<RideSim>; shadows: boolean }) {
  const ref = useRef<THREE.DirectionalLight>(null);
  const dir = useMemo(() => new THREE.Vector3(...light.sunDir).normalize(), [light]);
  useLayoutEffect(() => {
    const l = ref.current!;
    if (!shadows) return;
    const cam = l.shadow.camera;
    cam.left = -70;
    cam.right = 70;
    cam.top = 70;
    cam.bottom = -70;
    cam.near = 1;
    cam.far = 400;
    l.shadow.mapSize.set(2048, 2048);
    l.shadow.bias = -0.0015;
    l.shadow.normalBias = 0.8;
    cam.updateProjectionMatrix();
  }, [shadows]);
  useFrame(() => {
    const l = ref.current!;
    const s = sim.current;
    l.position.set(s.x + dir.x * 150, dir.y * 150, s.z + dir.z * 150);
    l.target.position.set(s.x, 0, s.z);
    l.target.updateMatrixWorld();
  });
  return <directionalLight ref={ref} color={light.sun} intensity={light.sunIntensity} castShadow={shadows} />;
}

// ---------------------------------------------------------------------------
// Buildings and signs (textured)
// ---------------------------------------------------------------------------

function Buildings({ world, glow, quality }: { world: RideWorld; glow: number; quality: Quality }) {
  const { gl } = useThree();
  const tex = useMemo(() => makeFacadeTextures(quality === "high" ? Math.min(8, gl.capabilities.getMaxAnisotropy()) : 1), [gl, quality]);
  useEffect(
    () => () => {
      tex.map.dispose();
      tex.lit.dispose();
    },
    [tex],
  );
  return (
    <>
      <mesh geometry={world.walls} castShadow receiveShadow>
        <meshLambertMaterial vertexColors map={tex.map} emissiveMap={tex.lit} emissive="#ffffff" emissiveIntensity={glow * 0.95} />
      </mesh>
      <mesh geometry={world.roofs} castShadow receiveShadow>
        <meshLambertMaterial vertexColors />
      </mesh>
    </>
  );
}

function Signs({ world, glow }: { world: RideWorld; glow: number }) {
  const { gl } = useThree();
  const [tex, setTex] = useState<THREE.Texture | null>(null);
  useEffect(() => {
    let alive = true;
    let made: THREE.Texture | null = null;
    void makeSignTexture(Math.min(4, gl.capabilities.getMaxAnisotropy())).then((t) => {
      made = t;
      if (alive) setTex(t);
      else t.dispose();
    });
    return () => {
      alive = false;
      made?.dispose();
    };
  }, [gl]);
  if (!tex) return null;
  return (
    <mesh geometry={world.detail.signs}>
      <meshLambertMaterial map={tex} side={THREE.DoubleSide} emissiveMap={tex} emissive="#ffffff" emissiveIntensity={glow * 0.55} />
    </mesh>
  );
}

// ---------------------------------------------------------------------------
// Instanced street furniture
// ---------------------------------------------------------------------------

function useInstances(
  mesh: RefObject<THREE.InstancedMesh | null>,
  items: Instance[],
  place: (i: Instance, m: THREE.Matrix4) => void,
  color?: (i: Instance, c: THREE.Color) => void,
) {
  useLayoutEffect(() => {
    const m = mesh.current;
    if (!m) return;
    const mat = new THREE.Matrix4();
    const col = new THREE.Color();
    items.forEach((it, i) => {
      place(it, mat);
      m.setMatrixAt(i, mat);
      if (color) {
        color(it, col);
        m.setColorAt(i, col);
      }
    });
    m.count = items.length;
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    m.computeBoundingSphere();
  }, [mesh, items, place, color]);
}

const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
function compose(m: THREE.Matrix4, x: number, y: number, z: number, yaw: number, sx: number, sy: number, sz: number) {
  _q.setFromAxisAngle(_up, yaw);
  m.compose(_p.set(x, y, z), _q, _s.set(sx, sy, sz));
}

const TREE_GREENS = ["#3d6b2c", "#4f7d32", "#5d8a3a", "#355f2a", "#6b9442"].map((c) => new THREE.Color(c));
const KRISHNACHURA = new THREE.Color("#d9532b"); // Dhaka's flame trees

const placeTrunk = (t: Instance, m: THREE.Matrix4) => compose(m, t.x, 0, t.z, t.yaw, t.scale, t.scale, t.scale);
const placeCrown = (t: Instance, m: THREE.Matrix4) => compose(m, t.x, 3.6 * t.scale, t.z, t.yaw, 2.3 * t.scale, 1.7 * t.scale, 2.3 * t.scale);
const crownColor = (t: Instance, c: THREE.Color) => {
  if (t.tint > 0.93) c.copy(KRISHNACHURA);
  else c.copy(TREE_GREENS[Math.floor(t.tint * 5) % 5]);
};
const placeUpright = (t: Instance, m: THREE.Matrix4) => compose(m, t.x, 0, t.z, t.yaw, 1, 1, 1);
const placePole = (t: Instance, m: THREE.Matrix4) => compose(m, t.x, 0, t.z, t.yaw, 1, t.scale, 1);
const poleColor = (t: Instance, c: THREE.Color) => {
  c.setHSL(0.08, 0.05, 0.55 + t.tint * 0.15);
};

function Trees({ trees }: { trees: Instance[] }) {
  const trunks = useRef<THREE.InstancedMesh>(null);
  const crowns = useRef<THREE.InstancedMesh>(null);
  const trunkGeo = useMemo(() => new THREE.CylinderGeometry(0.11, 0.19, 3, 5).translate(0, 1.5, 0), []);
  const crownGeo = useMemo(() => new THREE.IcosahedronGeometry(1, 0), []);
  useInstances(trunks, trees, placeTrunk);
  useInstances(crowns, trees, placeCrown, crownColor);
  if (!trees.length) return null;
  return (
    <>
      <instancedMesh ref={trunks} args={[trunkGeo, undefined, trees.length]} castShadow>
        <meshLambertMaterial color="#5b4636" />
      </instancedMesh>
      <instancedMesh ref={crowns} args={[crownGeo, undefined, trees.length]} castShadow receiveShadow>
        <meshLambertMaterial flatShading />
      </instancedMesh>
    </>
  );
}

function Lamps({ lamps, glow }: { lamps: Instance[]; glow: number }) {
  const poles = useRef<THREE.InstancedMesh>(null);
  const arms = useRef<THREE.InstancedMesh>(null);
  const heads = useRef<THREE.InstancedMesh>(null);
  const poleGeo = useMemo(() => new THREE.CylinderGeometry(0.06, 0.1, 7.2, 6).translate(0, 3.6, 0), []);
  const armGeo = useMemo(() => new THREE.BoxGeometry(0.07, 0.07, 2.2).translate(0, 7.1, 1.1), []);
  const headGeo = useMemo(() => new THREE.BoxGeometry(0.32, 0.12, 0.7).translate(0, 7.0, 2.2), []);
  useInstances(poles, lamps, placeUpright);
  useInstances(arms, lamps, placeUpright);
  useInstances(heads, lamps, placeUpright);
  const glowTex = useMemo(() => makeGlowTexture(), []);
  const glowGeo = useMemo(() => {
    const pos: number[] = [];
    for (const l of lamps) pos.push(l.x + Math.sin(l.yaw) * 2.2, 6.85, l.z + Math.cos(l.yaw) * 2.2);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    return g;
  }, [lamps]);
  if (!lamps.length) return null;
  return (
    <>
      <instancedMesh ref={poles} args={[poleGeo, undefined, lamps.length]} castShadow>
        <meshLambertMaterial color="#7d8288" />
      </instancedMesh>
      <instancedMesh ref={arms} args={[armGeo, undefined, lamps.length]}>
        <meshLambertMaterial color="#7d8288" />
      </instancedMesh>
      <instancedMesh ref={heads} args={[headGeo, undefined, lamps.length]}>
        <meshLambertMaterial color="#d8d8d0" emissive="#ffd9a0" emissiveIntensity={glow * 2} />
      </instancedMesh>
      {glow > 0 && (
        <points geometry={glowGeo}>
          <pointsMaterial map={glowTex} color="#ffcf8a" size={7} sizeAttenuation transparent opacity={0.85 * glow} depthWrite={false} blending={THREE.AdditiveBlending} />
        </points>
      )}
    </>
  );
}

function Poles({ poles }: { poles: Instance[] }) {
  const posts = useRef<THREE.InstancedMesh>(null);
  const arms = useRef<THREE.InstancedMesh>(null);
  const postGeo = useMemo(() => new THREE.BoxGeometry(0.24, 9, 0.24).translate(0, 4.5, 0), []);
  const armGeo = useMemo(() => new THREE.BoxGeometry(1.5, 0.1, 0.1).translate(0, 8.1, 0), []);
  useInstances(posts, poles, placePole, poleColor);
  useInstances(arms, poles, placePole);
  if (!poles.length) return null;
  return (
    <>
      <instancedMesh ref={posts} args={[postGeo, undefined, poles.length]} castShadow>
        <meshLambertMaterial />
      </instancedMesh>
      <instancedMesh ref={arms} args={[armGeo, undefined, poles.length]}>
        <meshLambertMaterial color="#4a4a4a" />
      </instancedMesh>
    </>
  );
}

// ---------------------------------------------------------------------------
// Rider: simulation, model transform and cameras
// ---------------------------------------------------------------------------

function Rider({
  world,
  vehicle,
  bike,
  bikeColor,
  sim,
  headlight,
  reducedMotion,
  view,
}: {
  world: RideWorld;
  vehicle: Vehicle;
  bike: BikeSpec;
  bikeColor: string;
  sim: RefObject<RideSim>;
  headlight: boolean;
  reducedMotion: boolean;
  view: CameraView;
}) {
  const body = useRef<THREE.Group>(null);
  const leanGroup = useRef<THREE.Group>(null);
  const wheels = useRef<(THREE.Group | null)[]>([]);
  const lookAt = useRef(new THREE.Vector3());
  const lean = useRef(0);
  const time = useRef(0);
  const spot = useRef<THREE.SpotLight>(null);
  const spotTarget = useMemo(() => new THREE.Object3D(), []);
  const { camera, setDpr } = useThree();
  const fps = useRef({ frames: 0, time: 0, lowered: false });
  const tmp = useMemo(() => ({ a: new THREE.Vector3(), b: new THREE.Vector3() }), []);
  const crank = useRef<THREE.Group>(null);
  const braking = useRef(false);
  const wheelRadius = bike.wheelR;
  const maxSpeed = bike.maxKmh / 3.6;

  const wheelRef = (i: number) => (g: THREE.Group | null) => {
    wheels.current[i] = g;
  };

  // Place everything at the route start before the first frame.
  useEffect(() => {
    const s = sim.current;
    const p = world.path.sample(s.s);
    if (s.mode === "route") Object.assign(s, { x: p.x, z: p.z, yaw: p.yaw });
    camera.position.set(s.x + Math.sin(s.yaw) * 6, 2.5, s.z + Math.cos(s.yaw) * 6);
    lookAt.current.set(s.x - Math.sin(s.yaw) * 8, 1.3, s.z - Math.cos(s.yaw) * 8);
    camera.lookAt(lookAt.current);
  }, [world, sim, camera]);

  useEffect(() => {
    spot.current!.target = spotTarget;
  }, [spotTarget]);

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.1);
    time.current += dt;
    const s = sim.current;
    const prevYaw = s.yaw;
    const prevV = s.v;
    const path = world.path;

    if (s.mode === "route") {
      // Cruise speed, but never faster than the road allows (corners, humps, arrival).
      const cruise = s.playing ? s.speedKmh / 3.6 : 0;
      let target = Math.min(cruise, path.limitAt(s.s + 1));

      // Traffic: keep left, overtake slower vehicles when the centre is clear, otherwise follow.
      const centre = path.sample(s.s, 3 + s.v * 0.45);
      const fx = -Math.sin(centre.yaw), fz = -Math.cos(centre.yaw);
      const rxv = Math.cos(centre.yaw), rzv = -Math.sin(centre.yaw);
      const occupied = (lat: number, fMin: number, fMax: number) => {
        let nearest: { f: number; v: number } | null = null;
        for (const o of world.traffic.vehicles) {
          const dx = o.x - centre.x, dz = o.z - centre.z;
          if (Math.abs(dx) > 60 || Math.abs(dz) > 60) continue;
          const f = dx * fx + dz * fz;
          if (f < fMin || f > fMax) continue;
          const l = dx * rxv + dz * rzv;
          if (Math.abs(l - lat) < KIND[o.kind].width / 2 + 0.55 && (!nearest || f < nearest.f)) {
            // Oncoming vehicles count as a closing speed, not a leader speed.
            const sameDir = Math.cos(angleDiff(o.yaw, centre.yaw)) > 0;
            nearest = { f, v: sameDir ? o.v : -o.v };
          }
        }
        return nearest;
      };
      const OVERTAKE = 0.2;
      const lookAhead = 5 + s.v * 1.4;
      const ahead = occupied(s.lat, 0, lookAhead);
      let targetLat = s.lat;
      if (ahead && ahead.v < cruise - 0.5) {
        if (Math.abs(s.lat - OVERTAKE) > 0.3 && !occupied(OVERTAKE, -6, lookAhead + 25)) targetLat = OVERTAKE;
        else target = Math.min(target, Math.max(0, ahead.v + (ahead.f - 6) * 0.5));
      } else if (Math.abs(s.lat - HOME_LANE) > 0.05 && !occupied(HOME_LANE, -9, 16)) {
        targetLat = HOME_LANE;
      }
      s.lat += Math.max(-1.6 * dt, Math.min(1.6 * dt, targetLat - s.lat));

      const dv = target - s.v;
      braking.current = dv < -0.3;
      s.v += Math.max(-4.5 * dt, Math.min(s.accel * dt, dv));
      const prevS = s.s;
      s.s = Math.min(path.length, s.s + s.v * dt);
      for (const b of path.breakers) if (prevS < b && s.s >= b) s.bumpT = 0;
      if (s.s >= path.length - 0.3 && s.playing) {
        s.playing = false;
        s.done = true;
        s.v = 0;
      }
      const p = path.sample(s.s, 3 + s.v * 0.45);
      s.x = p.x + Math.cos(p.yaw) * s.lat;
      s.z = p.z - Math.sin(p.yaw) * s.lat;
      s.yaw += angleDiff(p.yaw, s.yaw) * (1 - Math.exp(-dt * 7));
    } else {
      const max = s.maxKmh / 3.6;
      const { fwd, turn } = s.input;
      const accel = fwd > 0 ? s.accel * fwd : fwd < 0 ? 7 * fwd : 0;
      braking.current = fwd < 0;
      s.v += accel * dt;
      s.v -= s.v * (fwd === 0 ? 0.5 : 0.12) * dt;
      s.v = Math.max(-2.5, Math.min(max, s.v));
      if (Math.abs(s.v) < 0.05 && fwd === 0) s.v = 0;
      const grip = Math.min(1, Math.abs(s.v) / 3) * Math.sign(s.v || 1);
      s.yaw -= turn * 1.6 * grip * dt;
      s.x += -Math.sin(s.yaw) * s.v * dt;
      s.z += -Math.cos(s.yaw) * s.v * dt;
      const r = Math.hypot(s.x, s.z);
      if (r > world.radius - 20) {
        s.x *= (world.radius - 20) / r;
        s.z *= (world.radius - 20) / r;
        s.v *= 0.5;
      }
    }
    s.a += ((s.v - prevV) / Math.max(dt, 1e-3) - s.a) * Math.min(1, dt * 5);
    s.bumpT += dt;

    // ---- bike transform ----
    const yawRate = angleDiff(s.yaw, prevYaw) / Math.max(dt, 1e-3);
    const targetLean = Math.max(-0.3, Math.min(0.3, yawRate * Math.abs(s.v) * 0.045));
    lean.current += (targetLean - lean.current) * (1 - Math.exp(-dt * 5));
    const bump = s.bumpT < 0.32 ? Math.sin((Math.PI * s.bumpT) / 0.32) * 0.09 : 0;
    // Nose dips a little when braking, lifts when accelerating.
    const pitch = Math.max(-0.05, Math.min(0.04, s.a * 0.012));
    body.current!.position.set(s.x, bump, s.z);
    body.current!.rotation.set(0, s.yaw, 0);
    leanGroup.current!.rotation.set(pitch, 0, lean.current);
    for (const w of wheels.current) if (w) w.rotation.x -= (s.v * dt) / wheelRadius;
    // Pedal cadence: crank turns ~1/2.6 of a wheel turn (gearing), only when pedalling.
    if (crank.current && (s.a > -0.2 || s.mode === "free")) crank.current.rotation.x -= ((s.v * dt) / wheelRadius) / 2.6;

    // ---- camera ----
    const speedT = Math.min(1, Math.abs(s.v) / maxSpeed);
    const sinY = Math.sin(s.yaw), cosY = Math.cos(s.yaw);
    const shakeAmp = reducedMotion ? 0 : (vehicle === "motorcycle" ? 0.014 : 0.009) * speedT;
    const t = time.current;
    const shakeY = shakeAmp * (Math.sin(t * 31) * 0.6 + Math.sin(t * 17.3) * 0.4) + (reducedMotion ? 0 : bump * 1.6);
    const shakeX = shakeAmp * 0.6 * Math.sin(t * 23.7);
    const persp = camera as THREE.PerspectiveCamera;
    let fov: number;

    if (view === "helmet") {
      // Rider's eyes: just behind the handlebars, rolling with the lean.
      const lz = bike.eye.z;
      const eyeY = bike.eye.y + bump;
      camera.position.set(s.x + sinY * lz + cosY * shakeX, eyeY + shakeY, s.z + cosY * lz - sinY * shakeX);
      lookAt.current.set(s.x - sinY * 14, 1.15, s.z - cosY * 14);
      camera.lookAt(lookAt.current);
      camera.rotateZ(lean.current * 0.7);
      fov = 74 + speedT * 12;
    } else {
      // Low chase camera: chest height, a few metres back.
      const back = 4.4 + Math.abs(s.v) * 0.07;
      const height = 1.85 + Math.abs(s.v) * 0.025;
      const k = 1 - Math.exp(-dt * (reducedMotion ? 2.5 : 4.5));
      tmp.a.set(s.x + sinY * back + cosY * shakeX, height + shakeY, s.z + cosY * back - sinY * shakeX);
      camera.position.lerp(tmp.a, k);
      tmp.b.set(s.x - sinY * 9, 1.25, s.z - cosY * 9);
      lookAt.current.lerp(tmp.b, Math.min(1, k * 1.5));
      camera.lookAt(lookAt.current);
      camera.rotateZ(lean.current * 0.25);
      fov = 60 + speedT * 16;
    }
    // Wider field of view at speed: the classic "sense of speed" cue.
    if (Math.abs(persp.fov - fov) > 0.05) {
      persp.fov += (fov - persp.fov) * Math.min(1, dt * 3);
      persp.updateProjectionMatrix();
    }

    // Headlight
    spot.current?.position.set(s.x - sinY * 0.8, 1.0, s.z - cosY * 0.8);
    spotTarget.position.set(s.x - sinY * 18, 0, s.z - cosY * 18);
    spotTarget.updateMatrixWorld();

    // Auto quality: drop resolution once if the frame rate stays low.
    const f = fps.current;
    f.frames++;
    f.time += rawDt;
    if (f.time > 3) {
      if (!f.lowered && f.frames / f.time < 28) {
        setDpr(1);
        f.lowered = true;
      }
      f.frames = 0;
      f.time = 0;
    }
  });

  return (
    <>
      <group ref={body}>
        <group ref={leanGroup}>
          <PlayerBike spec={bike} color={bikeColor} wheelRef={wheelRef} crank={crank} showRider={view !== "helmet"} headlightOn={headlight} braking={braking} />
        </group>
      </group>
      <primitive object={spotTarget} />
      <spotLight ref={spot} visible={headlight} intensity={headlight ? 90 : 0} distance={60} angle={0.55} penumbra={0.6} decay={1.5} color="#fff3cf" />
    </>
  );
}
