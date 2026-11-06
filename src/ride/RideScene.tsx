"use client";
/* eslint-disable react-hooks/immutability -- the ride simulation is a mutable object shared with the render loop and updated every frame (standard react-three-fiber pattern) */

/**
 * The 3D part of ride mode (react-three-fiber). Everything here is original,
 * procedural geometry and canvas-drawn textures: no external models or images.
 */

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import * as THREE from "three";
import { Sky as SkyShader } from "three/examples/jsm/objects/Sky.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { GTAOPass } from "three/examples/jsm/postprocessing/GTAOPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import type { Vehicle } from "@/lib/routing";
import { angleDiff, HOME_LANE, LIGHTING, type Lighting, type Quality, type RideWorld, type TimeOfDay } from "@/ride/rideWorld";
import { PlayerBike, type BikeSpec } from "@/ride/bikes";
import { KIND, TrafficLayer, type HonkHandler, type TrafficKind } from "@/ride/traffic";
import { PedestriansLayer } from "@/ride/pedestrians";
import { signalState, SignalsLayer, type SignalState } from "@/ride/signals";
import type { Instance } from "@/ride/streetDetail";
import type { CityModel } from "@/lib3d/cityModel";
import { makeAsphaltTextures, makeFacadeTextures, makeGlowTexture, makeGroundTexture, makePavingTexture, makeSignTexture } from "@/ride/textures";

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
  /** Next traffic signal on the route, if within ~90 m. */
  signal: { state: SignalState; remaining: number; dist: number } | null;
  /** Set when the rider has crashed (cleared by "Ride on"). */
  crash: Crash | null;
}

export interface Crash {
  /** Seconds since impact. */
  t: number;
  impactKmh: number;
  what: "vehicle" | "building" | "wall";
  kind?: TrafficKind;
  /** Which side the bike falls to. */
  side: 1 | -1;
}

export function createSim(speedKmh: number, maxKmh: number, accel: number): RideSim {
  return { mode: "route", playing: false, s: 0, speedKmh, maxKmh, accel, lat: HOME_LANE, v: 0, a: 0, x: 0, z: 0, yaw: 0, done: false, bumpT: 99, input: { fwd: 0, turn: 0 }, signal: null, crash: null };
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
  onCrash?: (c: Crash) => void;
  tod: TimeOfDay;
  quality: Quality;
  view: CameraView;
  sim: RefObject<RideSim>;
  landmarks: LocalLandmark[];
  reducedMotion: boolean;
  /** Whole-area scenery beyond the detailed corridor (null while building). */
  city: CityModel | null;
  /** Camera zoom: 0 = chase camera, 1 = high aerial view. */
  zoom: RefObject<{ value: number }>;
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
      camera={{ fov: 62, near: 0.1, far: 7000, position: [0, 6, 10] }}
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
      <Exposure value={light.exposure} />
      <SkyEnvironment light={light} />
      {light.sky ? <PhysicalSky light={light} /> : <NightSky light={light} />}
      <hemisphereLight args={[light.hemiSky, light.hemiGround, light.hemiIntensity * 0.45]} />
      <Sun light={light} sim={props.sim} shadows={high} zoom={props.zoom} />

      <Ground world={props.world} light={light} />
      {props.city && <FarCity city={props.city} />}
      <mesh geometry={props.world.detail.marks} receiveShadow>
        <meshStandardMaterial vertexColors roughness={0.6} polygonOffset polygonOffsetFactor={-1} />
      </mesh>
      <mesh geometry={props.world.route}>
        <meshBasicMaterial vertexColors transparent opacity={0.55} depthWrite={false} polygonOffset polygonOffsetFactor={-2} />
      </mesh>
      <mesh geometry={props.world.detail.walls} castShadow receiveShadow>
        <meshStandardMaterial vertexColors roughness={0.95} side={THREE.DoubleSide} />
      </mesh>
      <mesh geometry={props.world.detail.posts}>
        <meshStandardMaterial vertexColors roughness={0.5} metalness={0.6} />
      </mesh>
      <lineSegments geometry={props.world.detail.wires}>
        <lineBasicMaterial color="#1a1a1a" />
      </lineSegments>

      <Buildings world={props.world} glow={light.nightGlow} quality={props.quality} />
      <Signs world={props.world} glow={light.nightGlow} />
      <Trees trees={props.world.detail.trees} />
      <Lamps lamps={props.world.detail.lamps} glow={light.nightGlow} />
      <Poles poles={props.world.detail.poles} />
      <TrafficLayer sim={props.world.traffic} rider={props.sim} clock={props.world.clock} onHonk={props.onHonk} />
      <SignalsLayer junctions={props.world.signals} clock={props.world.clock} />
      <PedestriansLayer sim={props.world.pedestrians} rider={props.sim} />

      {props.landmarks.map((l) => (
        <group key={l.id} position={[l.x, 0, l.z]}>
          <mesh position={[0, 9, 0]}>
            <cylinderGeometry args={[0.18, 0.18, 18, 6]} />
            <meshStandardMaterial color="#e6e6e6" metalness={0.6} roughness={0.35} />
          </mesh>
          <mesh position={[0, 19, 0]}>
            <octahedronGeometry args={[1.8]} />
            <meshStandardMaterial color="#006a4e" emissive="#0a8f69" emissiveIntensity={0.3 + light.nightGlow} roughness={0.3} metalness={0.2} />
          </mesh>
        </group>
      ))}

      {high && <PostFX bloom={light.bloom} threshold={light.bloomThreshold} />}
      <Rider world={props.world} vehicle={props.vehicle} bike={props.bike} bikeColor={props.bikeColor} onCrash={props.onCrash} sim={props.sim} headlight={light.headlight} reducedMotion={props.reducedMotion} view={props.view} zoom={props.zoom} fogNear={light.fogNear} fogFar={light.fogFar} />
    </Canvas>
  );
}

// ---------------------------------------------------------------------------
// Sky, reflections, exposure and post-processing
// ---------------------------------------------------------------------------

function makePhysicalSky(light: Lighting, maxRadiance: number): SkyShader {
  const sky = new SkyShader();
  // Cap the sky's (HDR) radiance so the sun and its haze don't bloom across the whole frame
  // or dominate image-based lighting at dawn and dusk.
  sky.material.fragmentShader = sky.material.fragmentShader.replace(
    "gl_FragColor = vec4( texColor, 1.0 );",
    `gl_FragColor = vec4( min( texColor, vec3( ${maxRadiance.toFixed(2)} ) ), 1.0 );`,
  );
  sky.material.needsUpdate = true;
  const u = sky.material.uniforms;
  // Dhaka: hazy, with scattered cumulus most of the year.
  u.cloudCoverage.value = 0.32;
  u.cloudDensity.value = 0.5;
  u.cloudElevation.value = 0.55;
  u.turbidity.value = light.sky!.turbidity;
  u.rayleigh.value = light.sky!.rayleigh;
  u.mieCoefficient.value = light.sky!.mie;
  u.mieDirectionalG.value = light.sky!.mieG;
  u.sunPosition.value.set(...light.sunDir).normalize();
  return sky;
}

/** Physically based daytime sky (Rayleigh + Mie scattering), centred on the camera. */
function PhysicalSky({ light }: { light: Lighting }) {
  const sky = useMemo(() => {
    const s = makePhysicalSky(light, 6);
    s.scale.setScalar(900);
    s.frustumCulled = false;
    return s;
  }, [light]);
  useEffect(() => () => (sky.material as THREE.Material).dispose(), [sky]);
  useFrame(({ camera }, dt) => {
    sky.position.copy(camera.position);
    sky.material.uniforms.time.value += dt; // slow cloud drift
  });
  return <primitive object={sky} renderOrder={-1} />;
}

/** Night: deep blue gradient, a soft moon and a few stars. */
function NightSky({ light }: { light: Lighting }) {
  const group = useRef<THREE.Group>(null);
  const glow = useMemo(() => makeGlowTexture(), []);
  const { geom, stars } = useMemo(() => {
    const g = new THREE.SphereGeometry(900, 24, 16);
    const zen = new THREE.Color(light.zenith);
    const hor = new THREE.Color(light.horizon);
    const pos = g.getAttribute("position");
    const cols: number[] = [];
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      c.copy(hor).lerp(zen, Math.pow(Math.max(0, pos.getY(i) / 900), 0.55));
      cols.push(c.r, c.g, c.b);
    }
    g.setAttribute("color", new THREE.Float32BufferAttribute(cols, 3));
    const sp: number[] = [];
    let seed = 7;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < 500; i++) {
      const th = rnd() * Math.PI * 2, ph = Math.acos(rnd() * 0.9 + 0.1);
      sp.push(Math.sin(ph) * Math.cos(th) * 850, Math.cos(ph) * 850, Math.sin(ph) * Math.sin(th) * 850);
    }
    const st = new THREE.BufferGeometry();
    st.setAttribute("position", new THREE.Float32BufferAttribute(sp, 3));
    return { geom: g, stars: st };
  }, [light]);
  const moon = useMemo(() => new THREE.Vector3(...light.sunDir).normalize().multiplyScalar(820), [light]);
  useFrame(({ camera }) => group.current?.position.copy(camera.position));
  return (
    <group ref={group}>
      <mesh geometry={geom} renderOrder={-1}>
        <meshBasicMaterial vertexColors side={THREE.BackSide} fog={false} depthWrite={false} />
      </mesh>
      <points geometry={stars} renderOrder={-1}>
        <pointsMaterial color="#dfe7ff" size={1.6} sizeAttenuation={false} fog={false} depthWrite={false} transparent opacity={0.8} />
      </points>
      <sprite position={moon} scale={[55, 55, 1]} renderOrder={-1}>
        <spriteMaterial map={glow} color={light.disc} fog={false} depthWrite={false} transparent blending={THREE.AdditiveBlending} />
      </sprite>
    </group>
  );
}

/** Image-based lighting: the sky is baked into an environment map so paint, chrome and glass reflect it. */
function SkyEnvironment({ light }: { light: Lighting }) {
  const { gl, scene } = useThree();
  useEffect(() => {
    const pmrem = new THREE.PMREMGenerator(gl);
    const envScene = new THREE.Scene();
    if (light.sky) {
      const sky = makePhysicalSky(light, 1.2);
      // No sun disc in the reflection map: it is thousands of times brighter than the sky
      // and would flood every surface facing a low sun. Direct sunlight comes from the sun light.
      sky.material.uniforms.showSunDisc.value = 0;
      sky.scale.setScalar(100);
      envScene.add(sky);
    } else {
      envScene.background = new THREE.Color(light.horizon);
    }
    // A ground plane so reflections aren't lit from below by the sky.
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshBasicMaterial({ color: light.ground }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -2;
    envScene.add(ground);
    const rt = pmrem.fromScene(envScene, 0.02);
    scene.environment = rt.texture;
    scene.environmentIntensity = light.envIntensity;
    return () => {
      scene.environment = null;
      rt.dispose();
      pmrem.dispose();
      ground.geometry.dispose();
    };
  }, [gl, scene, light]);
  return null;
}

function Exposure({ value }: { value: number }) {
  const { gl } = useThree();
  useEffect(() => {
    gl.toneMapping = THREE.ACESFilmicToneMapping;
    gl.toneMappingExposure = value;
  }, [gl, value]);
  return null;
}

/** High quality: ambient occlusion (GTAO) + bloom, then tone mapping. */
function PostFX({ bloom, threshold }: { bloom: number; threshold: number }) {
  const { gl, scene, camera, size } = useThree();
  const fx = useMemo(() => {
    const composer = new EffectComposer(gl);
    composer.addPass(new RenderPass(scene, camera));
    const ao = new GTAOPass(scene, camera, size.width, size.height);
    ao.blendIntensity = 0.85;
    composer.addPass(ao);
    const bl = new UnrealBloomPass(new THREE.Vector2(size.width, size.height), bloom, 0.4, 1.0);
    composer.addPass(bl);
    composer.addPass(new OutputPass());
    return { composer, bl };
    // size is applied in the effect below; rebuilding on resize would be wasteful
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gl, scene, camera]);
  useEffect(() => {
    fx.composer.setPixelRatio(Math.min(gl.getPixelRatio(), 1.25));
    fx.composer.setSize(size.width, size.height);
  }, [fx, size, gl]);
  useEffect(() => {
    fx.bl.strength = bloom;
    fx.bl.threshold = threshold;
  }, [fx, bloom, threshold]);
  useEffect(() => () => fx.composer.dispose(), [fx]);
  useFrame((_, dt) => fx.composer.render(dt), 1);
  return null;
}

/** Ground, asphalt and footpaths with procedural textures. */
function Ground({ world, light }: { world: RideWorld; light: Lighting }) {
  const { gl } = useThree();
  const tex = useMemo(() => {
    const aniso = Math.min(8, gl.capabilities.getMaxAnisotropy());
    const asphalt = makeAsphaltTextures(aniso);
    const paving = makePavingTexture(aniso);
    const ground = makeGroundTexture(aniso);
    ground.repeat.set((world.radius * 2) / 7, (world.radius * 2) / 7);
    return { asphalt, paving, ground };
  }, [gl, world]);
  useEffect(
    () => () => {
      tex.asphalt.map.dispose();
      tex.asphalt.bump.dispose();
      tex.paving.dispose();
      tex.ground.dispose();
    },
    [tex],
  );
  return (
    <>
      <mesh rotation-x={-Math.PI / 2} receiveShadow>
        <circleGeometry args={[Math.max(world.radius, 3200), 64]} />
        <meshStandardMaterial map={tex.ground} color={light.ground} roughness={1} />
      </mesh>
      <mesh geometry={world.roads} receiveShadow>
        <meshStandardMaterial vertexColors map={tex.asphalt.map} bumpMap={tex.asphalt.bump} bumpScale={0.6} roughness={0.9} />
      </mesh>
      <mesh geometry={world.detail.footpaths} receiveShadow>
        <meshStandardMaterial vertexColors map={tex.paving} roughness={0.85} />
      </mesh>
    </>
  );
}

/** Directional sun/moon light; on High it casts shadows in a box around the rider. */
function Sun({ light, sim, shadows, zoom }: { light: Lighting; sim: RefObject<RideSim>; shadows: boolean; zoom: RefObject<{ value: number }> }) {
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
    // Widen the shadow box as the camera rises.
    const half = 70 + zoom.current.value * 520;
    const cam = l.shadow.camera;
    if (shadows && Math.abs(cam.right - half) > 2) {
      cam.left = -half;
      cam.right = half;
      cam.top = half;
      cam.bottom = -half;
      cam.far = 400 + half * 2;
      cam.updateProjectionMatrix();
    }
    l.position.set(s.x + dir.x * (150 + half), dir.y * (150 + half), s.z + dir.z * (150 + half));
    l.target.position.set(s.x, 0, s.z);
    l.target.updateMatrixWorld();
  });
  return <directionalLight ref={ref} color={light.sun} intensity={light.sunIntensity} castShadow={shadows} />;
}

/** The rest of the neighbourhood (beyond the detailed corridor), seen when zoomed out. */
function FarCity({ city }: { city: CityModel }) {
  const trunks = useRef<THREE.InstancedMesh>(null);
  const crowns = useRef<THREE.InstancedMesh>(null);
  const geo = useMemo(() => ({ trunk: new THREE.CylinderGeometry(0.15, 0.25, 3, 5).translate(0, 1.5, 0), crown: new THREE.IcosahedronGeometry(1, 0) }), []);
  useLayoutEffect(() => {
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    const col = new THREE.Color();
    city.trees.forEach((t, i) => {
      q.setFromAxisAngle(up, t.yaw);
      trunks.current?.setMatrixAt(i, m.compose(p.set(t.x, 0, t.z), q, sc.setScalar(t.scale)));
      crowns.current?.setMatrixAt(i, m.compose(p.set(t.x, 3.6 * t.scale, t.z), q, sc.set(2.3 * t.scale, (t.conifer ? 2.8 : 1.8) * t.scale, 2.3 * t.scale)));
      crowns.current?.setColorAt(i, col.copy(TREE_GREENS[Math.floor(t.tint * 5) % 5]));
    });
    for (const r of [trunks, crowns]) {
      if (!r.current) continue;
      r.current.instanceMatrix.needsUpdate = true;
      if (r.current.instanceColor) r.current.instanceColor.needsUpdate = true;
      r.current.computeBoundingSphere();
    }
  }, [city]);
  useEffect(
    () => () => {
      for (const g of [city.buildings, city.roofDetail, city.roads, city.water, city.shore, city.green]) g.dispose();
    },
    [city],
  );
  return (
    <>
      <mesh geometry={city.green} receiveShadow>
        <meshStandardMaterial vertexColors roughness={1} />
      </mesh>
      <mesh geometry={city.shore}>
        <meshStandardMaterial vertexColors roughness={1} />
      </mesh>
      <mesh geometry={city.water}>
        <meshPhysicalMaterial vertexColors roughness={0.06} clearcoat={1} clearcoatRoughness={0.04} />
      </mesh>
      <mesh geometry={city.roads} receiveShadow>
        <meshStandardMaterial vertexColors roughness={0.9} />
      </mesh>
      <mesh geometry={city.buildings} receiveShadow>
        <meshStandardMaterial vertexColors roughness={0.85} />
      </mesh>
      <mesh geometry={city.roofDetail}>
        <meshStandardMaterial vertexColors roughness={0.5} metalness={0.3} />
      </mesh>
      {city.trees.length > 0 && (
        <>
          <instancedMesh ref={trunks} args={[geo.trunk, undefined, city.trees.length]}>
            <meshStandardMaterial color="#5b4636" roughness={0.95} />
          </instancedMesh>
          <instancedMesh ref={crowns} args={[geo.crown, undefined, city.trees.length]}>
            <meshStandardMaterial flatShading roughness={0.85} />
          </instancedMesh>
        </>
      )}
    </>
  );
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
      tex.rough.dispose();
    },
    [tex],
  );
  return (
    <>
      <mesh geometry={world.walls} castShadow receiveShadow>
        <meshStandardMaterial vertexColors map={tex.map} roughnessMap={tex.rough} roughness={1} metalness={0.05} emissiveMap={tex.lit} emissive="#ffffff" emissiveIntensity={glow * 1.1} />
      </mesh>
      <mesh geometry={world.roofs} castShadow receiveShadow>
        <meshStandardMaterial vertexColors roughness={0.9} />
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
      <meshStandardMaterial map={tex} roughness={0.55} side={THREE.DoubleSide} emissiveMap={tex} emissive="#ffffff" emissiveIntensity={glow * 0.6} />
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
const crownColor = (t: Instance, c: THREE.Color) => {
  if (t.tint > 0.93) c.copy(KRISHNACHURA);
  else c.copy(TREE_GREENS[Math.floor(t.tint * 5) % 5]);
};
const placeUpright = (t: Instance, m: THREE.Matrix4) => compose(m, t.x, 0, t.z, t.yaw, 1, 1, 1);
const placePole = (t: Instance, m: THREE.Matrix4) => compose(m, t.x, 0, t.z, t.yaw, 1, t.scale, 1);
const poleColor = (t: Instance, c: THREE.Color) => {
  c.setHSL(0.08, 0.05, 0.55 + t.tint * 0.15);
};

/** Crown lobes per tree: offsets (x, y, z) and size, in tree units. */
const LOBES: [number, number, number, number][] = [
  [0, 0, 0, 1],
  [0.75, -0.35, 0.3, 0.72],
  [-0.6, -0.2, -0.45, 0.78],
];

function Trees({ trees }: { trees: Instance[] }) {
  const trunks = useRef<THREE.InstancedMesh>(null);
  const crowns = useRef<THREE.InstancedMesh>(null);
  const trunkGeo = useMemo(() => new THREE.CylinderGeometry(0.11, 0.19, 3, 5).translate(0, 1.5, 0), []);
  const crownGeo = useMemo(() => new THREE.IcosahedronGeometry(1, 0), []);
  useInstances(trunks, trees, placeTrunk);
  useLayoutEffect(() => {
    const m = crowns.current;
    if (!m) return;
    const mat = new THREE.Matrix4();
    const col = new THREE.Color();
    const shade = new THREE.Color();
    trees.forEach((t, i) => {
      crownColor(t, col);
      const c = Math.cos(t.yaw), sn = Math.sin(t.yaw);
      LOBES.forEach(([ox, oy, oz, k], j) => {
        const sc = t.scale;
        const x = t.x + (ox * c + oz * sn) * 1.6 * sc;
        const z = t.z + (-ox * sn + oz * c) * 1.6 * sc;
        compose(mat, x, (3.6 + oy * 1.4) * sc, z, t.yaw + j, 2.2 * k * sc, 1.6 * k * sc, 2.2 * k * sc);
        m.setMatrixAt(i * 3 + j, mat);
        m.setColorAt(i * 3 + j, shade.copy(col).multiplyScalar(0.85 + j * 0.1));
      });
    });
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    m.computeBoundingSphere();
  }, [trees]);
  if (!trees.length) return null;
  return (
    <>
      <instancedMesh ref={trunks} args={[trunkGeo, undefined, trees.length]} castShadow>
        <meshStandardMaterial color="#5b4636" roughness={0.95} />
      </instancedMesh>
      <instancedMesh ref={crowns} args={[crownGeo, undefined, trees.length * LOBES.length]} castShadow receiveShadow>
        <meshStandardMaterial flatShading roughness={0.85} />
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
        <meshStandardMaterial color="#8a9096" metalness={0.7} roughness={0.35} />
      </instancedMesh>
      <instancedMesh ref={arms} args={[armGeo, undefined, lamps.length]}>
        <meshStandardMaterial color="#8a9096" metalness={0.7} roughness={0.35} />
      </instancedMesh>
      <instancedMesh ref={heads} args={[headGeo, undefined, lamps.length]}>
        <meshStandardMaterial color="#d8d8d0" emissive="#ffd9a0" emissiveIntensity={glow * 2.2} />
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
        <meshStandardMaterial roughness={0.9} />
      </instancedMesh>
      <instancedMesh ref={arms} args={[armGeo, undefined, poles.length]}>
        <meshStandardMaterial color="#4a4a4a" roughness={0.8} />
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
  onCrash,
  sim,
  headlight,
  reducedMotion,
  view,
  zoom,
  fogNear,
  fogFar,
}: {
  world: RideWorld;
  vehicle: Vehicle;
  bike: BikeSpec;
  bikeColor: string;
  onCrash?: (c: Crash) => void;
  sim: RefObject<RideSim>;
  headlight: boolean;
  reducedMotion: boolean;
  view: CameraView;
  zoom: RefObject<{ value: number }>;
  fogNear: number;
  fogFar: number;
}) {
  const body = useRef<THREE.Group>(null);
  /** Smoothed zoom (0 chase … 1 aerial). */
  const zs = useRef(0);
  const locator = useRef<THREE.Group>(null);
  const leanGroup = useRef<THREE.Group>(null);
  const wheels = useRef<(THREE.Group | null)[]>([]);
  const lookAt = useRef(new THREE.Vector3());
  const lean = useRef(0);
  const time = useRef(0);
  const spot = useRef<THREE.SpotLight>(null);
  const spotTarget = useMemo(() => new THREE.Object3D(), []);
  const { camera, setDpr, scene } = useThree();
  const fps = useRef({ frames: 0, time: 0, lowered: false });
  const tmp = useMemo(() => ({ a: new THREE.Vector3(), b: new THREE.Vector3() }), []);
  const crank = useRef<THREE.Group>(null);
  const braking = useRef(false);
  /** Seconds spent waiting behind something in auto-ride (to break standoffs). */
  const waitT = useRef(0);
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

    if (s.crash) {
      // Down and sliding: friction brings the bike to rest; no control.
      s.crash.t += dt;
      s.playing = false;
      s.signal = null;
      braking.current = true;
      s.v = Math.max(0, s.v - 7.5 * dt);
      s.x += -Math.sin(s.yaw) * s.v * dt;
      s.z += -Math.cos(s.yaw) * s.v * dt;
    } else if (s.mode === "route") {
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
      // Two-lane-each-way roads: pass using the other lane in our direction (lanes at -1.5 / -4.5);
      // otherwise pull out towards the centre line.
      const wide = path.widthAt(s.s) >= 10;
      const OVERTAKE = wide ? (s.lat > -3 ? -4.5 : -1.5) : 0.2;
      const HOME = wide && s.lat < -3 ? -4.5 : HOME_LANE;
      const lookAhead = 5 + s.v * 1.4;
      const ahead = occupied(s.lat, 0, lookAhead);
      let targetLat = s.lat;
      const stuckBehind = !!ahead && ahead.v < cruise - 0.5;
      if (stuckBehind) {
        // Pull out to overtake when the centre is clear, or squeeze past after waiting a while.
        if (Math.abs(s.lat - OVERTAKE) > 0.3 && (!occupied(OVERTAKE, -6, lookAhead + 25) || waitT.current > 5)) targetLat = OVERTAKE;
        else target = Math.min(target, Math.max(0, ahead.v + (ahead.f - 6) * 0.5));
      } else if (Math.abs(s.lat - HOME) > 0.05 && !occupied(HOME, -9, 16)) {
        targetLat = HOME;
      } else if (!wide && s.lat < -3) {
        targetLat = HOME_LANE; // road narrowed: back to the normal lane
      }
      s.lat += Math.max(-1.6 * dt, Math.min(1.6 * dt, targetLat - s.lat));

      // Traffic signals: stop at the line on red, and on yellow when there is room to stop.
      s.signal = null;
      for (const st of path.signalStops) {
        const gap = st.s - s.s;
        if (gap < -1) continue;
        if (gap > 90) break;
        const sig = signalState(st.j, st.group, world.clock.t);
        s.signal = { state: sig.state, remaining: sig.remaining, dist: gap };
        if (sig.state === "red" || (sig.state === "yellow" && gap > s.v * 1.2)) target = Math.min(target, Math.sqrt(2 * 3.5 * Math.max(0, gap - 0.5)));
        break;
      }

      // Time spent stuck behind something slower (not counting red lights) → squeeze past after a while.
      waitT.current = s.playing && stuckBehind && !(s.signal && s.signal.state !== "green" && s.signal.dist < 30) ? waitT.current + dt : 0;
      const dv = target - s.v;
      braking.current = dv < -0.3;
      s.v += Math.max(-bike.brake * dt, Math.min(s.accel * dt, dv));
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
      s.signal = null;
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

    // ---- collisions: any vehicle (both modes); buildings and walls when riding freely ----
    if (!s.crash) {
      const fx = -Math.sin(s.yaw), fz = -Math.cos(s.yaw);
      const nose = 0.65 * Math.sign(s.v || 1);
      const px = s.x + fx * nose, pz = s.z + fz * nose;
      const crashNow = (what: Crash["what"], impact: number, kind?: TrafficKind) => {
        const c: Crash = { t: 0, impactKmh: Math.round(impact * 3.6), what, kind, side: Math.random() < 0.5 ? 1 : -1 };
        s.crash = c;
        s.playing = false;
        onCrash?.(c);
      };
      const car = world.traffic.hit(px, pz, 0.35) ?? world.traffic.hit(s.x, s.z, 0.35);
      if (car) {
        // Closing speed along our heading.
        const closing = Math.abs(s.v - car.v * Math.cos(angleDiff(car.dyaw, s.yaw)));
        // Crashes happen when you're steering (free ride); in auto-ride the rider just stops.
        if (s.mode === "free") {
          car.stunT = 8;
          car.v = 0;
        }
        if (s.mode === "free" && closing > 3.3) crashNow("vehicle", closing, car.kind);
        else {
          s.v = 0; // a gentle bump: just stop
          s.x -= fx * 0.25;
          s.z -= fz * 0.25;
        }
      } else if (s.mode === "free") {
        const h = world.collision.test(px, pz, 0.35);
        if (h) {
          if (Math.abs(s.v) > 4) crashNow(h.what, Math.abs(s.v));
          else {
            s.v = 0;
            s.x += h.nx * 0.3;
            s.z += h.nz * 0.3;
          }
        }
      }
    }

    // ---- bike transform ----
    const yawRate = angleDiff(s.yaw, prevYaw) / Math.max(dt, 1e-3);
    const targetLean = s.crash ? s.crash.side * 1.38 : Math.max(-0.3, Math.min(0.3, yawRate * Math.abs(s.v) * 0.045));
    lean.current += (targetLean - lean.current) * (1 - Math.exp(-dt * (s.crash ? 7 : 5)));
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
    // Hard jolt on impact, fading over ~0.8 s.
    const jolt = s.crash && !reducedMotion ? Math.max(0, 1 - s.crash.t / 0.8) * 0.18 : 0;
    const shakeY = (shakeAmp + jolt) * (Math.sin(t * 31) * 0.6 + Math.sin(t * 17.3) * 0.4) + (reducedMotion ? 0 : bump * 1.6);
    const shakeX = shakeAmp * 0.6 * Math.sin(t * 23.7);
    const persp = camera as THREE.PerspectiveCamera;
    let fov: number;

    // Zoom: lift smoothly from the chase camera to a high aerial view of the area.
    zs.current += (zoom.current.value - zs.current) * Math.min(1, dt * (reducedMotion ? 10 : 4));
    const zz = zs.current;
    if (scene.fog instanceof THREE.Fog) {
      scene.fog.near = fogNear * (1 + zz * 14);
      scene.fog.far = fogFar * (1 + zz * 9);
    }

    if (view === "helmet" && zz < 0.02) {
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
      // Pull back a little with speed (capped), and follow more tightly when fast so the bike stays framed.
      const vv = Math.min(Math.abs(s.v), 20);
      const back = THREE.MathUtils.lerp(4.4 + vv * 0.08, 240, Math.pow(zz, 1.4));
      const height = THREE.MathUtils.lerp(1.85 + vv * 0.03, 620, Math.pow(zz, 1.6));
      const k = 1 - Math.exp(-dt * ((reducedMotion ? 2.5 : 4.5) + Math.abs(s.v) * 0.35));
      tmp.a.set(s.x + sinY * back + cosY * shakeX, height + shakeY, s.z + cosY * back - sinY * shakeX);
      camera.position.lerp(tmp.a, k);
      // Look ahead of the bike when close; straight at it from above when zoomed out.
      const ahead = 9 * (1 - Math.min(1, zz * 2));
      tmp.b.set(s.x - sinY * ahead, 1.25 * (1 - zz), s.z - cosY * ahead);
      lookAt.current.lerp(tmp.b, Math.min(1, k * 1.5));
      camera.lookAt(lookAt.current);
      camera.rotateZ(lean.current * 0.25 * (1 - zz));
      fov = 60 + speedT * 16 * (1 - zz);
    }
    // Wider field of view at speed: the classic "sense of speed" cue.
    if (Math.abs(persp.fov - fov) > 0.05) {
      persp.fov += (fov - persp.fov) * Math.min(1, dt * 3);
      persp.updateProjectionMatrix();
    }

    // "You are here" marker, fading in as the camera rises.
    const loc = locator.current;
    if (loc) {
      loc.visible = zz > 0.12;
      loc.position.set(s.x, 0.5, s.z);
      loc.scale.setScalar(1 + zz * 11);
      loc.rotation.y += dt * 1.5;
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
      <group ref={locator} visible={false}>
        <mesh rotation-x={-Math.PI / 2}>
          <ringGeometry args={[1.8, 2.25, 40]} />
          <meshBasicMaterial color="#22e39a" toneMapped={false} transparent opacity={0.9} depthTest={false} />
        </mesh>
        <mesh position={[0, 5, 0]} rotation-x={Math.PI}>
          <coneGeometry args={[0.8, 2.2, 16]} />
          <meshBasicMaterial color="#22e39a" toneMapped={false} depthTest={false} />
        </mesh>
      </group>
      <spotLight ref={spot} visible={headlight} intensity={headlight ? 22 : 0} distance={55} angle={0.55} penumbra={0.6} decay={1.5} color="#fff3cf" />
    </>
  );
}
