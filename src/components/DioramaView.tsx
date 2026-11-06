"use client";
/* eslint-disable react-hooks/immutability -- camera/controls animation state is mutated in the render loop (react-three-fiber pattern) */

/**
 * The 3D "diorama" start screen: a stylised, high-angle 3D model of the whole
 * area (buildings, roads, lakes, parks, trees) with numbered landmark labels
 * and light beams. Drag to pan, scroll/pinch to zoom, right-drag or two-finger
 * twist to rotate. Tap the ground (or a label) to choose places; the route is
 * drawn in 3D. Lazy-loaded; same props as the street map.
 */

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import * as THREE from "three";
import { MapControls } from "three/examples/jsm/controls/MapControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { GTAOPass } from "three/examples/jsm/postprocessing/GTAOPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import type { AreaConfig, LngLat } from "@/config/areas";
import { loadCityData, type Landmark } from "@/lib/areaData";
import { t, type Lang } from "@/lib/i18n";
import type { Roads, Route } from "@/lib/routing";
import { buildCityModel, type CityModel, type TreeInstance } from "@/lib3d/cityModel";
import { GeometryWriter, makeProjector, ribbon, type Projector } from "@/ride/rideWorld";
import { makeAsphaltTextures, makeGroundTexture } from "@/ride/textures";
import type { Place } from "@/components/ControlPanel";

interface Props {
  area: AreaConfig;
  lang: Lang;
  roads: Roads;
  landmarks: Landmark[];
  start: Place | null;
  end: Place | null;
  route: Route | null;
  selectedStep: number | null;
  reducedMotion: boolean;
  lowEnd: boolean;
  /** False while ride mode is open: stop rendering so only one 3D scene uses the GPU. */
  active?: boolean;
  onPick: (p: LngLat) => void;
  onLandmark: (l: Landmark) => void;
}

const ZOOM_BTN = "grid size-10 place-items-center border-b border-black/10 text-lg text-[#17201c] last:border-b-0 hover:bg-black/5";

/** Where the camera should glide to. */
interface CamGoal {
  target: THREE.Vector3;
  distance: number;
}

export default function DioramaView(props: Props) {
  const proj = useMemo(() => makeProjector(props.area.center), [props.area]);
  const [model, setModel] = useState<CityModel | null>(null);
  const [failed, setFailed] = useState(false);
  const labelRefs = useRef(new Map<string, HTMLButtonElement>());
  const goal = useRef<CamGoal | null>(null);
  const controlsRef = useRef<MapControls | null>(null);
  const quality = props.lowEnd ? "low" : "high";

  useEffect(() => {
    let alive = true;
    loadCityData(props.area)
      .then(async (d) => {
        await new Promise((r) => setTimeout(r, 20)); // let the loading text paint
        if (!alive) return;
        setModel(buildCityModel({ proj, roads: props.roads, buildings: d.buildings, landuse: d.landuse, quality }));
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [props.area, props.roads, proj, quality]);

  // Glide to the route, or to a selected step.
  useEffect(() => {
    if (!props.route) return;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const c of props.route.coords) {
      const [x, z] = proj.toLocal(c);
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
    }
    goal.current = { target: new THREE.Vector3((x0 + x1) / 2, 0, (z0 + z1) / 2), distance: Math.max(x1 - x0, z1 - z0) * 1.25 + 180 };
  }, [props.route, proj]);
  useEffect(() => {
    const step = props.selectedStep !== null ? props.route?.steps[props.selectedStep] : undefined;
    if (!step) return;
    const [x, z] = proj.toLocal(step.location);
    goal.current = { target: new THREE.Vector3(x, 0, z), distance: 220 };
  }, [props.selectedStep, props.route, proj]);

  const zoomBy = (f: number) => {
    const c = controlsRef.current;
    if (!c) return;
    const cam = c.object as THREE.PerspectiveCamera;
    goal.current = { target: c.target.clone(), distance: THREE.MathUtils.clamp(cam.position.distanceTo(c.target) * f, 60, 3200) };
  };

  const zoomIn = () => zoomBy(0.6);
  const zoomOut = () => zoomBy(1.6);
  const resetView = () => {
    goal.current = { target: new THREE.Vector3(0, 0, -60), distance: 1000 };
  };

  const labelled = useMemo(() => props.landmarks.map((l, i) => ({ l, n: i + 1 })), [props.landmarks]);

  return (
    <div className="absolute inset-0 bg-[#cfe3f1]">
      {!model && !failed && (
        <div className="absolute inset-0 grid place-items-center text-sm font-medium text-[#17201c]" role="status">
          {t("building3dCity", props.lang)}
        </div>
      )}
      {failed && (
        <p role="alert" className="absolute inset-x-0 top-24 mx-auto max-w-sm rounded-lg bg-white px-4 py-3 text-center text-sm shadow">
          {t("loadError", props.lang)}
        </p>
      )}
      {model && (
        <Canvas
          shadows={quality === "high" ? "soft" : false}
          dpr={quality === "high" ? [1, 1.6] : 1}
          camera={{ fov: 42, near: 2, far: 9000, position: [0, 900, 950] }}
          gl={{ antialias: quality === "high", powerPreference: "high-performance" }}
          frameloop={props.active === false ? "never" : "always"}
          aria-hidden
        >
          <Scene {...props} model={model} proj={proj} quality={quality} goal={goal} controlsRef={controlsRef} labelRefs={labelRefs} labelled={labelled} />
        </Canvas>
      )}

      {/* Landmark labels (positioned every frame from 3D) */}
      {model && (
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          {labelled.map(({ l, n }) => (
            <button
              key={l.id}
              ref={(el) => {
                if (el) labelRefs.current.set(l.id, el);
                else labelRefs.current.delete(l.id);
              }}
              type="button"
              onClick={() => props.onLandmark(l)}
              className="br-pill pointer-events-auto absolute left-0 top-0 flex items-center gap-2 rounded-full bg-white/95 py-1 pl-1 pr-3.5 text-left shadow-lg ring-1 ring-black/5 transition-opacity hover:bg-white focus-visible:outline-2 focus-visible:outline-[#2563eb]"
              style={{ opacity: 0 }}
              aria-label={`${n}. ${l.name[props.lang]}`}
            >
              <span className="grid size-7 shrink-0 place-items-center rounded-full bg-[#2563eb] text-[13px] font-bold text-white">{n}</span>
              <span className="leading-tight">
                <span className="block text-[9px] font-semibold uppercase tracking-wider text-[#2563eb]">{t(`cat_${l.category}`, props.lang)}</span>
                <span className="block whitespace-nowrap text-[14px] font-semibold text-[#17201c]">{l.name[props.lang]}</span>
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Zoom / reset */}
      <div className="absolute right-3 top-3 z-10 flex flex-col overflow-hidden rounded-xl border border-black/10 bg-white/95 shadow">
        <button type="button" onClick={zoomIn} aria-label={t("zoomIn", props.lang)} title={t("zoomIn", props.lang)} className={ZOOM_BTN}>
          +
        </button>
        <button type="button" onClick={zoomOut} aria-label={t("zoomOut", props.lang)} title={t("zoomOut", props.lang)} className={ZOOM_BTN}>
          −
        </button>
        <button type="button" onClick={resetView} aria-label={t("resetView", props.lang)} title={t("resetView", props.lang)} className={ZOOM_BTN}>
          ⤢
        </button>
      </div>
      <p className="pointer-events-none absolute bottom-1 right-2 hidden rounded bg-white/80 px-1.5 text-[10px] text-[#5d6b64] md:block">{t("attribution", props.lang)}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------

interface SceneProps extends Props {
  model: CityModel;
  proj: Projector;
  quality: "low" | "high";
  goal: RefObject<CamGoal | null>;
  controlsRef: RefObject<MapControls | null>;
  labelRefs: RefObject<Map<string, HTMLButtonElement>>;
  labelled: { l: Landmark; n: number }[];
}

const SUN = new THREE.Vector3(-0.45, 0.85, 0.35).normalize();

function Scene(p: SceneProps) {
  const { gl, scene } = useThree();
  const high = p.quality === "high";
  const tex = useMemo(() => {
    const aniso = Math.min(8, gl.capabilities.getMaxAnisotropy());
    const ground = makeGroundTexture(aniso);
    ground.repeat.set(900, 900);
    return { asphalt: makeAsphaltTextures(aniso), ground };
  }, [gl]);

  // Soft neutral reflections + exposure.
  useEffect(() => {
    gl.toneMapping = THREE.ACESFilmicToneMapping;
    gl.toneMappingExposure = 0.95;
    const pmrem = new THREE.PMREMGenerator(gl);
    const rt = pmrem.fromScene(new RoomEnvironment(), 0.04);
    scene.environment = rt.texture;
    scene.environmentIntensity = 0.35;
    scene.background = new THREE.Color("#cfe3f1");
    scene.fog = new THREE.Fog("#d6ecf6", 3000, 8000);
    return () => {
      scene.environment = null;
      rt.dispose();
      pmrem.dispose();
    };
  }, [gl, scene]);

  return (
    <>
      <hemisphereLight args={["#e8f3ff", "#6d8f4a", 1.1]} />
      <SunLight shadows={high} controlsRef={p.controlsRef} />
      <Controls goal={p.goal} controlsRef={p.controlsRef} reducedMotion={p.reducedMotion} />
      <Picker proj={p.proj} onPick={p.onPick} />
      <Labels {...p} />

      <mesh rotation-x={-Math.PI / 2} position={[0, -0.05, 0]} receiveShadow>
        <planeGeometry args={[12000, 12000]} />
        <meshStandardMaterial map={tex.ground} color="#c6ef8c" roughness={1} />
      </mesh>
      <mesh geometry={p.model.green} receiveShadow>
        <meshStandardMaterial vertexColors roughness={1} />
      </mesh>
      <mesh geometry={p.model.shore} receiveShadow>
        <meshStandardMaterial vertexColors roughness={1} />
      </mesh>
      <mesh geometry={p.model.water}>
        <meshPhysicalMaterial vertexColors roughness={0.08} metalness={0} clearcoat={1} clearcoatRoughness={0.05} />
      </mesh>
      <mesh geometry={p.model.roads} receiveShadow>
        <meshStandardMaterial vertexColors map={tex.asphalt.map} roughness={0.9} />
      </mesh>
      <mesh geometry={p.model.markings}>
        <meshStandardMaterial vertexColors roughness={0.6} />
      </mesh>
      <mesh geometry={p.model.buildings} castShadow receiveShadow>
        <meshStandardMaterial vertexColors roughness={0.85} />
      </mesh>
      <mesh geometry={p.model.roofDetail} castShadow>
        <meshStandardMaterial vertexColors roughness={0.45} metalness={0.3} />
      </mesh>
      <Trees trees={p.model.trees} />
      <Beams landmarks={p.landmarks} proj={p.proj} />
      <RouteLayer {...p} />
      {high && <AO />}
    </>
  );
}

function SunLight({ shadows, controlsRef }: { shadows: boolean; controlsRef: RefObject<MapControls | null> }) {
  const ref = useRef<THREE.DirectionalLight>(null);
  useLayoutEffect(() => {
    const l = ref.current!;
    l.shadow.mapSize.set(4096, 4096);
    l.shadow.bias = -0.0004;
    l.shadow.normalBias = 1.2;
  }, []);
  useFrame(({ camera }) => {
    const l = ref.current!;
    const c = controlsRef.current;
    const target = c ? c.target : new THREE.Vector3();
    // Shadow box sized to what is on screen.
    const d = Math.min(1600, camera.position.distanceTo(target) * 0.9 + 80);
    const cam = l.shadow.camera;
    if (Math.abs(cam.right - d) > 1) {
      cam.left = -d;
      cam.right = d;
      cam.top = d;
      cam.bottom = -d;
      cam.near = 10;
      cam.far = 4000;
      cam.updateProjectionMatrix();
    }
    l.position.copy(target).addScaledVector(SUN, 1500);
    l.target.position.copy(target);
    l.target.updateMatrixWorld();
  });
  return <directionalLight ref={ref} color="#fff3df" intensity={2.6} castShadow={shadows} />;
}

/** Pan / zoom / rotate, plus smooth glides to goals. */
function Controls({ goal, controlsRef, reducedMotion }: { goal: RefObject<CamGoal | null>; controlsRef: RefObject<MapControls | null>; reducedMotion: boolean }) {
  const { camera, gl } = useThree();
  useEffect(() => {
    const c = new MapControls(camera, gl.domElement);
    c.enableDamping = true;
    c.dampingFactor = 0.09;
    c.screenSpacePanning = false;
    c.minDistance = 50;
    c.maxDistance = 3400;
    c.maxPolarAngle = 1.2;
    c.zoomToCursor = true;
    // Start tilted ~50° looking north over the middle of Gulshan, like a diorama.
    c.target.set(0, 0, -60);
    camera.position.set(140, 720, 600);
    c.update();
    controlsRef.current = c;
    return () => {
      c.dispose();
      controlsRef.current = null;
    };
  }, [camera, gl, controlsRef]);
  useFrame((_, dt) => {
    const c = controlsRef.current;
    if (!c) return;
    const g = goal.current;
    if (g) {
      const k = reducedMotion ? 1 : 1 - Math.exp(-dt * 3);
      const offset = camera.position.clone().sub(c.target);
      const dist = offset.length();
      const newDist = dist + (g.distance - dist) * k;
      c.target.lerp(g.target, k);
      camera.position.copy(c.target).add(offset.setLength(newDist));
      if (c.target.distanceTo(g.target) < 1 && Math.abs(newDist - g.distance) < 2) goal.current = null;
    }
    c.update();
  });
  return null;
}

/** Click/tap on the ground (not a drag) → a map point. */
function Picker({ proj, onPick }: { proj: Projector; onPick: (p: LngLat) => void }) {
  const { camera, gl } = useThree();
  const latest = useRef(onPick);
  useEffect(() => {
    latest.current = onPick;
  }, [onPick]);
  useEffect(() => {
    const el = gl.domElement;
    let down: { x: number; y: number } | null = null;
    const ray = new THREE.Raycaster();
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const onDown = (e: PointerEvent) => {
      down = { x: e.clientX, y: e.clientY };
    };
    const onUp = (e: PointerEvent) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6 || e.button !== 0) return;
      down = null;
      const r = el.getBoundingClientRect();
      ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
      const hit = new THREE.Vector3();
      if (ray.ray.intersectPlane(plane, hit)) latest.current(proj.toLngLat(hit.x, hit.z));
    };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointerup", onUp);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointerup", onUp);
    };
  }, [camera, gl, proj]);
  return null;
}

/** Positions the HTML pills over their 3D anchors and hides overlapping ones. */
function Labels(p: SceneProps) {
  const { size } = useThree();
  const anchors = useMemo(() => p.labelled.map(({ l }) => {
    const [x, z] = p.proj.toLocal(l.lngLat);
    return { id: l.id, v: new THREE.Vector3(x, l.category === "road" ? 8 : 34, z) };
  }), [p.labelled, p.proj]);
  const tmp = useMemo(() => new THREE.Vector3(), []);
  useFrame(({ camera }) => {
    const placed: { x: number; y: number; w: number; h: number }[] = [];
    const items = anchors
      .map((a) => ({ a, d: camera.position.distanceTo(a.v) }))
      .sort((x, y) => x.d - y.d);
    for (const { a, d } of items) {
      const el = p.labelRefs.current.get(a.id);
      if (!el) continue;
      tmp.copy(a.v).project(camera);
      const visible = tmp.z < 1 && Math.abs(tmp.x) < 1.1 && Math.abs(tmp.y) < 1.1 && d < 3600;
      const x = (tmp.x * 0.5 + 0.5) * size.width;
      const y = (-tmp.y * 0.5 + 0.5) * size.height;
      const w = el.offsetWidth, h = el.offsetHeight;
      const box = { x: x - w / 2, y: y - h, w, h };
      const overlaps = placed.some((b) => box.x < b.x + b.w + 4 && box.x + box.w + 4 > b.x && box.y < b.y + b.h + 4 && box.y + box.h + 4 > b.y);
      const show = visible && !overlaps;
      if (show) placed.push(box);
      el.style.transform = `translate(${Math.round(box.x)}px, ${Math.round(box.y)}px)`;
      el.style.opacity = show ? "1" : "0";
      el.style.pointerEvents = show ? "auto" : "none";
      el.tabIndex = show ? 0 : -1;
    }
  });
  return null;
}

const TREE_GREENS = ["#4f8f37", "#5c9c3c", "#6aa845", "#457f31", "#77b14d"].map((c) => new THREE.Color(c));
const CONIFER = ["#2f6b3a", "#356f3d", "#3e7a44"].map((c) => new THREE.Color(c));

function Trees({ trees }: { trees: TreeInstance[] }) {
  const round = useMemo(() => trees.filter((t) => !t.conifer), [trees]);
  const conif = useMemo(() => trees.filter((t) => t.conifer), [trees]);
  const trunks = useRef<THREE.InstancedMesh>(null);
  const crowns = useRef<THREE.InstancedMesh>(null);
  const cones = useRef<THREE.InstancedMesh>(null);
  const geo = useMemo(
    () => ({
      trunk: new THREE.CylinderGeometry(0.15, 0.25, 3, 5).translate(0, 1.5, 0),
      crown: new THREE.IcosahedronGeometry(1, 1),
      cone: new THREE.ConeGeometry(1.7, 5, 7).translate(0, 2.5, 0),
    }),
    [],
  );
  useLayoutEffect(() => {
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3(), s = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    const col = new THREE.Color();
    trees.forEach((t, i) => {
      q.setFromAxisAngle(up, t.yaw);
      const k = t.scale * 1.5;
      trunks.current?.setMatrixAt(i, m.compose(pos.set(t.x, 0, t.z), q, s.set(k, k, k)));
    });
    round.forEach((t, i) => {
      q.setFromAxisAngle(up, t.yaw);
      const k = t.scale * 1.5;
      crowns.current?.setMatrixAt(i, m.compose(pos.set(t.x, 3.6 * k, t.z), q, s.set(2.4 * k, 2.1 * k, 2.4 * k)));
      crowns.current?.setColorAt(i, t.tint > 0.95 ? col.set("#d9532b") : col.copy(TREE_GREENS[Math.floor(t.tint * 5) % 5]));
    });
    conif.forEach((t, i) => {
      q.setFromAxisAngle(up, t.yaw);
      const k = t.scale * 1.5;
      cones.current?.setMatrixAt(i, m.compose(pos.set(t.x, 2.2 * k, t.z), q, s.set(k, k * 1.2, k)));
      cones.current?.setColorAt(i, CONIFER[Math.floor(t.tint * 3) % 3]);
    });
    for (const r of [trunks, crowns, cones]) {
      if (!r.current) continue;
      r.current.instanceMatrix.needsUpdate = true;
      if (r.current.instanceColor) r.current.instanceColor.needsUpdate = true;
      r.current.computeBoundingSphere();
    }
  }, [trees, round, conif]);
  return (
    <>
      <instancedMesh ref={trunks} args={[geo.trunk, undefined, trees.length]} castShadow>
        <meshStandardMaterial color="#6b4f3a" roughness={0.95} />
      </instancedMesh>
      {round.length > 0 && (
        <instancedMesh ref={crowns} args={[geo.crown, undefined, round.length]} castShadow receiveShadow>
          <meshStandardMaterial flatShading roughness={0.85} />
        </instancedMesh>
      )}
      {conif.length > 0 && (
        <instancedMesh ref={cones} args={[geo.cone, undefined, conif.length]} castShadow receiveShadow>
          <meshStandardMaterial flatShading roughness={0.85} />
        </instancedMesh>
      )}
    </>
  );
}

/** Soft light beams rising from landmarks. */
function Beams({ landmarks, proj }: { landmarks: Landmark[]; proj: Projector }) {
  const alpha = useMemo(() => {
    const c = document.createElement("canvas");
    c.width = 4;
    c.height = 128;
    const g = c.getContext("2d")!;
    const grad = g.createLinearGradient(0, 0, 0, 128);
    grad.addColorStop(0, "rgba(255,255,255,0)");
    grad.addColorStop(1, "rgba(255,255,255,1)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 4, 128);
    return new THREE.CanvasTexture(c);
  }, []);
  const geo = useMemo(() => new THREE.CylinderGeometry(1.6, 1.6, 70, 16, 1, true).translate(0, 35, 0), []);
  return (
    <>
      {landmarks
        .filter((l) => l.category !== "road")
        .map((l) => {
          const [x, z] = proj.toLocal(l.lngLat);
          return (
            <mesh key={l.id} geometry={geo} position={[x, 0, z]} renderOrder={2}>
              <meshBasicMaterial color="#8fe3ff" alphaMap={alpha} transparent opacity={0.55} depthWrite={false} side={THREE.DoubleSide} blending={THREE.AdditiveBlending} />
            </mesh>
          );
        })}
    </>
  );
}

/** Route ribbon and start/end pins. */
function RouteLayer(p: SceneProps) {
  const route = useMemo(() => {
    if (!p.route) return null;
    const pts = p.route.coords.map((c) => p.proj.toLocal(c));
    const core = new GeometryWriter();
    ribbon(core, pts, 6, 0.5, new THREE.Color("#22e39a"));
    const glow = new GeometryWriter();
    ribbon(glow, pts, 22, 0.4, new THREE.Color("#22e39a"));
    return { core: core.build(), glow: glow.build() };
  }, [p.route, p.proj]);
  useEffect(
    () => () => {
      route?.core.dispose();
      route?.glow.dispose();
    },
    [route],
  );
  const pins = useMemo(
    () =>
      (
        [
          [p.start, "#0f8a5f"],
          [p.end, "#e2263a"],
        ] as const
      )
        .filter(([pl]) => pl)
        .map(([pl, color]) => ({ pos: p.proj.toLocal(pl!.lngLat), color })),
    [p.start, p.end, p.proj],
  );
  const bob = useRef<THREE.Group>(null);
  const pinRefs = useRef<(THREE.Group | null)[]>([]);
  useFrame(({ clock, camera }) => {
    if (bob.current && !p.reducedMotion) bob.current.position.y = Math.sin(clock.elapsedTime * 2.2) * 1.5;
    // Keep pins a readable size at any zoom.
    for (const g of pinRefs.current) {
      if (!g) continue;
      const s = Math.max(1, camera.position.distanceTo(g.position) / 420);
      g.scale.setScalar(s);
    }
  });
  return (
    <>
      {route && (
        <>
          <mesh geometry={route.glow} renderOrder={1}>
            <meshBasicMaterial vertexColors transparent opacity={0.35} depthWrite={false} polygonOffset polygonOffsetFactor={-3} />
          </mesh>
          <mesh geometry={route.core} renderOrder={2}>
            <meshStandardMaterial vertexColors emissive="#0fbf78" emissiveIntensity={0.8} roughness={0.4} polygonOffset polygonOffsetFactor={-4} />
          </mesh>
        </>
      )}
      <group ref={bob}>
        {pins.map(({ pos, color }, i) => (
          <group key={i} position={[pos[0], 0, pos[1]]} ref={(g) => void (pinRefs.current[i] = g)}>
            <mesh position={[0, 9, 0]} castShadow>
              <cylinderGeometry args={[0.6, 0.6, 18, 10]} />
              <meshStandardMaterial color="#f5f5f2" roughness={0.4} />
            </mesh>
            <mesh position={[0, 22, 0]} castShadow>
              <sphereGeometry args={[5, 24, 16]} />
              <meshStandardMaterial color={color} roughness={0.25} metalness={0.1} emissive={color} emissiveIntensity={0.25} />
            </mesh>
          </group>
        ))}
      </group>
    </>
  );
}

/** Ambient occlusion pass (High): grounds buildings and trees like a diorama. */
function AO() {
  const { gl, scene, camera, size } = useThree();
  const fx = useMemo(() => {
    const composer = new EffectComposer(gl);
    composer.addPass(new RenderPass(scene, camera));
    const ao = new GTAOPass(scene, camera, size.width, size.height);
    ao.blendIntensity = 0.9;
    composer.addPass(ao);
    composer.addPass(new OutputPass());
    return composer;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gl, scene, camera]);
  useEffect(() => {
    fx.setPixelRatio(Math.min(gl.getPixelRatio(), 1.25));
    fx.setSize(size.width, size.height);
  }, [fx, size, gl]);
  useEffect(() => () => fx.dispose(), [fx]);
  useFrame((_, dt) => fx.render(dt), 1);
  return null;
}
