"use client";
/* eslint-disable react-hooks/immutability -- the ride simulation is a mutable object shared with the render loop and updated every frame (standard react-three-fiber pattern) */

/**
 * Ride mode: full-screen 3D ride along the route, with HUD, minimap,
 * controls, landmark pop-ups and synthesized sound. Lazy-loaded by RiderApp
 * (this file and three.js are only downloaded when the user presses Ride).
 */

import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AreaConfig } from "@/config/areas";
import type { Landmark } from "@/lib/areaData";
import { digits, formatDistance, formatDuration, stepText, t, type Lang } from "@/lib/i18n";
import { VEHICLES, type Roads, type Route, type Vehicle } from "@/lib/routing";
import { ManeuverIcon } from "@/components/DirectionsList";
import { CATEGORY_ICON } from "@/components/ControlPanel";
import RideScene, { createSim, type CameraView, type LocalLandmark, type RideSim } from "@/ride/RideScene";
import { RideSound } from "@/ride/rideSound";
import { BIKE_COLORS, bikesFor, getBike } from "@/ride/bikes";
import type { TrafficKind } from "@/ride/traffic";
import { buildRideWorld, TIMES, timeOfDayNow, type BuildingsFC, type Quality, type RideWorld, type TimeOfDay } from "@/ride/rideWorld";

interface Props {
  area: AreaConfig;
  lang: Lang;
  route: Route;
  roads: Roads;
  landmarks: Landmark[];
  vehicle: Vehicle;
  destination: string;
  reducedMotion: boolean;
  lowEnd: boolean;
  onExit: () => void;
}

type TodChoice = "auto" | TimeOfDay;
const TOD_CHOICES: TodChoice[] = ["auto", ...TIMES];
const POPUP_RADIUS_M = 80;

function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writePref(key: string, v: string) {
  try {
    localStorage.setItem(key, v);
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Error boundary for the WebGL canvas
// ---------------------------------------------------------------------------

class SceneBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface Hud {
  s: number;
  v: number;
  mode: RideSim["mode"];
  playing: boolean;
  done: boolean;
}

export default function RideMode(props: Props) {
  const { lang, route, vehicle } = props;
  const spec = VEHICLES[vehicle];
  const [bikeId, setBikeId] = useState(() => getBike(readPref(`br:bike:${vehicle}`), vehicle).id);
  const bike = getBike(bikeId, vehicle);
  const [bikeColor, setBikeColor] = useState(() => {
    const c = readPref(`br:bikeColor:${vehicle}`);
    return c && BIKE_COLORS.includes(c) ? c : vehicle === "motorcycle" ? BIKE_COLORS[0] : BIKE_COLORS[4];
  });
  const [pickerOpen, setPickerOpen] = useState(false);
  const [world, setWorld] = useState<RideWorld | null>(null);
  const [loadStage, setLoadStage] = useState<{ key: "loading3d" | "building3d"; n?: number }>({ key: "loading3d" });
  const [failed, setFailed] = useState(false);
  const [speed, setSpeed] = useState(() => Math.min(bike.maxKmh, vehicle === "motorcycle" ? 45 : 18));
  const [todChoice, setTodChoice] = useState<TodChoice>(() => (TOD_CHOICES as string[]).includes(readPref("br:tod") ?? "") ? (readPref("br:tod") as TodChoice) : "auto");
  const [soundOn, setSoundOn] = useState(() => readPref("br:sound") === "on");
  const soundOnRef = useRef(soundOn);
  useEffect(() => {
    soundOnRef.current = soundOn;
  }, [soundOn]);
  // Client-only component (loaded with ssr: false), so window is available here.
  const [coarse] = useState(() => window.matchMedia("(pointer: coarse)").matches);
  const [quality, setQuality] = useState<Quality>(() => {
    const q = readPref("br:quality");
    return q === "low" || q === "high" ? q : props.lowEnd || coarse ? "low" : "high";
  });
  const [view, setView] = useState<CameraView>(() => (readPref("br:view3d") === "helmet" ? "helmet" : "chase"));
  const buildingsRef = useRef<BuildingsFC | null>(null);
  const [hud, setHud] = useState<Hud>({ s: 0, v: 0, mode: "route", playing: false, done: false });
  const [popup, setPopup] = useState<Landmark | null>(null);
  const sim = useRef<RideSim>(createSim(speed, bike.maxKmh, bike.accel));
  const sound = useRef<RideSound | null>(null);
  const minimap = useRef<HTMLCanvasElement>(null);
  const playBtn = useRef<HTMLButtonElement>(null);
  const shownLandmarks = useRef(new Set<string>());
  const popupTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const tod: TimeOfDay = todChoice === "auto" ? timeOfDayNow() : todChoice;

  // ---- load buildings and build the world (rebuilt when quality changes) ----
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        let buildings = buildingsRef.current;
        if (!buildings) {
          const res = await fetch(props.area.data.buildings);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          buildings = (await res.json()) as BuildingsFC;
          buildingsRef.current = buildings;
        }
        if (cancelled) return;
        setLoadStage({ key: "building3d", n: buildings.features.length });
        // Let the loading text paint before the (synchronous) geometry build.
        await new Promise((r) => setTimeout(r, 30));
        const markets = props.landmarks.filter((l) => l.category === "market").map((l) => l.lngLat);
        const w = buildRideWorld(route, props.roads, buildings, { vehicle, quality, markets });
        if (cancelled) return;
        setWorld((old) => {
          if (old) disposeWorld(old);
          return w;
        });
        if (!props.reducedMotion && sim.current.s === 0 && !sim.current.done) sim.current.playing = true;
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.area, props.roads, props.landmarks, route, vehicle, quality, props.reducedMotion]);

  // ---- focus the main control once the world is ready ----
  const ready = !!world;
  useEffect(() => {
    if (ready) playBtn.current?.focus();
  }, [ready]);

  // ---- sound lifecycle ----
  useEffect(() => {
    sound.current = new RideSound(vehicle, props.area.audio, bike.sound);
    if (soundOnRef.current) sound.current.start();
    return () => sound.current?.dispose();
  }, [vehicle, props.area, bike.sound]);
  useEffect(() => {
    if (soundOn && ready) sound.current?.start();
    else sound.current?.stop();
  }, [soundOn, ready]);

  // ---- speed slider + bike → sim ----
  useEffect(() => {
    sim.current.speedKmh = speed;
  }, [speed]);
  useEffect(() => {
    sim.current.maxKmh = bike.maxKmh;
    sim.current.accel = bike.accel;
  }, [bike]);

  const chooseBike = useCallback(
    (id: string) => {
      const b = getBike(id, vehicle);
      setBikeId(b.id);
      writePref(`br:bike:${vehicle}`, b.id);
      setSpeed((v) => Math.min(b.maxKmh, Math.max(v, Math.round(b.maxKmh * 0.45))));
    },
    [vehicle, setBikeId, setSpeed],
  );
  const chooseColor = useCallback(
    (c: string) => {
      setBikeColor(c);
      writePref(`br:bikeColor:${vehicle}`, c);
    },
    [vehicle, setBikeColor],
  );

  /** A real vehicle honked: pan it to where it is relative to the rider. */
  const onHonk = useCallback((kind: TrafficKind, x: number, z: number) => {
    const s = sim.current;
    const dx = x - s.x, dz = z - s.z;
    const dist = Math.hypot(dx, dz);
    const pan = Math.max(-1, Math.min(1, (dx * Math.cos(s.yaw) - dz * Math.sin(s.yaw)) / Math.max(4, dist)));
    sound.current?.honk(kind, pan, dist);
  }, []);

  // ---- landmarks in local coordinates ----
  const localLandmarks = useMemo<(LocalLandmark & { lm: Landmark })[]>(() => {
    if (!world) return [];
    return props.landmarks
      .filter((l) => l.category !== "road")
      .map((l) => {
        const [x, z] = world.proj.toLocal(l.lngLat);
        return { id: l.id, x, z, lm: l };
      })
      .filter((l) => Math.hypot(l.x, l.z) < world.radius);
  }, [world, props.landmarks]);

  // ---- HUD tick (10 Hz): numbers, minimap, sound, pop-ups ----
  useEffect(() => {
    if (!world) return;
    const id = setInterval(() => {
      const s = sim.current;
      setHud({ s: s.mode === "route" ? s.s : world.path.nearestS(s.x, s.z), v: s.v, mode: s.mode, playing: s.playing, done: s.done });
      let marketDist = Infinity;
      let mosqueDist = Infinity;
      for (const l of localLandmarks) {
        const d = Math.hypot(l.x - s.x, l.z - s.z);
        if (l.lm.category === "market") marketDist = Math.min(marketDist, d);
        if (l.lm.category === "mosque") mosqueDist = Math.min(mosqueDist, d);
      }
      sound.current?.update({ v: s.v, a: s.a, marketDist, mosqueDist });
      drawMinimap(minimap.current, world, s, localLandmarks);
      for (const l of localLandmarks) {
        if (shownLandmarks.current.has(l.id)) continue;
        if (Math.hypot(l.x - s.x, l.z - s.z) < POPUP_RADIUS_M) {
          shownLandmarks.current.add(l.id);
          setPopup(l.lm);
          if (popupTimer.current) clearTimeout(popupTimer.current);
          popupTimer.current = setTimeout(() => setPopup(null), 5000);
          break;
        }
      }
    }, 100);
    return () => clearInterval(id);
  }, [world, localLandmarks]);

  // ---- actions ----
  const togglePlay = useCallback(() => {
    const s = sim.current;
    if (s.mode === "free") return;
    if (s.done) {
      s.s = 0;
      s.done = false;
      shownLandmarks.current.clear();
    }
    s.playing = !s.playing;
  }, []);

  const setFree = useCallback(
    (free: boolean) => {
      const s = sim.current;
      if (!world || (s.mode === "free") === free) return;
      if (free) {
        s.mode = "free";
        s.playing = false;
        s.done = false;
      } else {
        s.mode = "route";
        s.s = world.path.nearestS(s.x, s.z);
        s.v = 0;
        s.input = { fwd: 0, turn: 0 };
        s.playing = true;
      }
    },
    [world],
  );

  const restart = useCallback(() => {
    const s = sim.current;
    Object.assign(s, { mode: "route", s: 0, v: 0, done: false, playing: true });
    shownLandmarks.current.clear();
  }, []);

  const cycleTod = useCallback(() => {
    setTodChoice((c) => {
      const next = TOD_CHOICES[(TOD_CHOICES.indexOf(c) + 1) % TOD_CHOICES.length];
      writePref("br:tod", next);
      return next;
    });
  }, [setTodChoice]);

  const toggleQuality = useCallback(() => {
    setQuality((q) => {
      const next = q === "high" ? "low" : "high";
      writePref("br:quality", next);
      return next;
    });
  }, [setQuality]);

  const toggleView = useCallback(() => {
    setView((v) => {
      const next = v === "chase" ? "helmet" : "chase";
      writePref("br:view3d", next);
      return next;
    });
  }, [setView]);

  const toggleSound = useCallback(() => {
    setSoundOn((on) => {
      writePref("br:sound", on ? "off" : "on");
      return !on;
    });
  }, [setSoundOn]);

  // ---- keyboard ----
  useEffect(() => {
    const keys = new Set<string>();
    const steer = () => {
      const s = sim.current;
      const has = (...k: string[]) => k.some((x) => keys.has(x));
      s.input.fwd = (has("w", "arrowup") ? 1 : 0) - (has("s", "arrowdown") ? 1 : 0);
      s.input.turn = (has("d", "arrowright") ? 1 : 0) - (has("a", "arrowleft") ? 1 : 0);
    };
    const isField = (el: EventTarget | null) => el instanceof HTMLInputElement || el instanceof HTMLSelectElement;
    const down = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(k)) {
        if (k.startsWith("arrow") && isField(e.target)) return; // arrows still move a focused slider
        e.preventDefault();
        keys.add(k);
        setFree(true);
        steer();
        return;
      }
      if (e.target instanceof HTMLButtonElement && (k === " " || k === "enter")) return;
      if (k === " ") {
        e.preventDefault();
        togglePlay();
      } else if (k === "escape") props.onExit();
      else if (k === "f") setFree(sim.current.mode !== "free");
      else if (k === "m") toggleSound();
      else if (k === "t") cycleTod();
      else if (k === "v") toggleView();
      else if (k === "q") toggleQuality();
      else if (k === "b") setPickerOpen((o) => !o);
      else if (k === "+" || k === "=") setSpeed((v) => Math.min(sim.current.maxKmh, v + 5));
      else if (k === "-") setSpeed((v) => Math.max(spec.minKmh, v - 5));
    };
    const up = (e: KeyboardEvent) => {
      keys.delete(e.key.toLowerCase());
      steer();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [setFree, togglePlay, toggleSound, cycleTod, toggleView, toggleQuality, props, spec]);

  // ---- derived HUD values ----
  const nextIdx = useMemo(() => {
    const i = route.steps.findIndex((st, idx) => idx > 0 && route.cumDist[st.coordIndex] > hud.s + 3);
    return i === -1 ? route.steps.length - 1 : i;
  }, [route, hud.s]);
  const nextStep = route.steps[nextIdx];
  const toNext = Math.max(0, route.cumDist[nextStep.coordIndex] - hud.s);
  const left = Math.max(0, route.distance - hud.s);
  const pct = Math.min(100, (hud.s / route.distance) * 100);
  const isFree = hud.mode === "free";

  // Announce each new instruction once for screen readers.
  const announcement = `${stepText(nextStep, lang)}. ${formatDistance(toNext, lang)}`;
  const [spoken, setSpoken] = useState("");
  const lastIdx = useRef(-1);
  useEffect(() => {
    if (nextIdx !== lastIdx.current) {
      lastIdx.current = nextIdx;
      setSpoken(announcement);
    }
  }, [nextIdx, announcement]);

  // ---- render ----
  const btn =
    "grid size-9 shrink-0 text-sm sm:size-11 sm:text-base place-items-center rounded-full bg-white/90 text-[#17201c] shadow-md backdrop-blur hover:bg-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white";

  const errorView = (
    <div className="grid size-full place-items-center bg-[var(--map-bg)] p-6 text-center">
      <div className="max-w-sm">
        <p role="alert" className="text-base">
          {t("rideError", lang)}
        </p>
        <button type="button" onClick={props.onExit} className="mt-4 rounded-lg bg-[var(--brand)] px-4 py-2 font-semibold text-white">
          {t("backToMap", lang)}
        </button>
      </div>
    </div>
  );

  return (
    <div role="dialog" aria-modal="true" aria-label={t("rideLabel", lang)} className="fixed inset-0 z-50 bg-black text-white">
      {failed ? (
        errorView
      ) : !world ? (
        <div className="grid size-full place-items-center bg-gradient-to-b from-[#0b3d2e] to-[#006a4e]" role="status" aria-live="polite">
          <div className="flex flex-col items-center gap-4 px-6 text-center">
            <span className="text-5xl motion-safe:animate-bounce" aria-hidden>
              {vehicle === "motorcycle" ? "🏍" : "🚲"}
            </span>
            <p className="text-lg font-semibold">{t(loadStage.key, lang, { n: digits(loadStage.n ?? 0, lang) })}</p>
            <div className="h-1.5 w-48 overflow-hidden rounded-full bg-white/20">
              <div className={`h-full rounded-full bg-white transition-all duration-700 ${loadStage.key === "loading3d" ? "w-1/3" : "w-5/6"}`} />
            </div>
            <button type="button" onClick={props.onExit} className="mt-2 text-sm underline">
              {t("backToMap", lang)}
            </button>
          </div>
        </div>
      ) : (
        <SceneBoundary fallback={errorView}>
          <div className="absolute inset-0">
            <RideScene
              world={world}
              vehicle={vehicle}
              bike={bike}
              bikeColor={bikeColor}
              onHonk={onHonk}
              tod={tod}
              quality={quality}
              view={view}
              sim={sim}
              landmarks={localLandmarks}
              reducedMotion={props.reducedMotion}
              onContextLost={() => setFailed(true)}
            />
          </div>

          {/* Top: next turn + progress */}
          <div className="pointer-events-none absolute inset-x-0 top-0 flex flex-col items-center gap-2 p-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
            {!isFree && !hud.done && (
              <div className="pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-2xl bg-[#006a4e]/95 px-4 py-3 shadow-lg">
                <ManeuverIcon maneuver={nextStep.maneuver} className="size-9 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-2xl font-bold leading-none">{formatDistance(toNext, lang)}</p>
                  <p className="mt-1 line-clamp-2 text-sm leading-snug text-white/90">{stepText(nextStep, lang)}</p>
                </div>
              </div>
            )}
            {isFree && (
              <p className="pointer-events-auto w-full max-w-md rounded-2xl bg-black/65 px-4 py-2.5 text-sm shadow-lg">
                {t(coarse ? "freeHintTouch" : "freeHint", lang)}
              </p>
            )}
            <div className="w-full max-w-md rounded-full bg-black/45 px-3 py-1.5 text-xs shadow backdrop-blur">
              <div className="flex items-center justify-between gap-2">
                <span>{t("remaining", lang, { distance: formatDistance(left, lang), time: formatDuration(left / Math.max(1, (speed * 1000) / 3600), lang) })}</span>
                <span>
                  {digits(Math.round(Math.abs(hud.v) * 3.6), lang)} {t("kmh", lang)}
                </span>
              </div>
              <div
                className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/25"
                role="progressbar"
                aria-label={t("progress", lang)}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(pct)}
              >
                <div className="h-full rounded-full bg-[#2fd39b]" style={{ width: `${pct}%` }} />
              </div>
            </div>
          </div>

          <p className="sr-only" aria-live="polite">
            {spoken}
          </p>

          {/* Landmark pop-up */}
          {popup && (
            <div role="status" className="pointer-events-none absolute inset-x-0 top-[38%] flex justify-center px-4">
              <div className="flex items-center gap-3 rounded-2xl bg-white px-4 py-3 text-[#17201c] shadow-xl motion-safe:animate-[pop_.35s_ease-out]">
                <span className="grid size-10 place-items-center rounded-full bg-[#006a4e] text-xl text-white" aria-hidden>
                  {CATEGORY_ICON[popup.category]}
                </span>
                <div>
                  <p className="text-xs uppercase tracking-wide text-[#5d6b64]">{t("passing", lang)}</p>
                  <p className="font-semibold">{popup.name[lang]}</p>
                  <p className="text-xs text-[#5d6b64]" lang={lang === "en" ? "bn" : "en"}>
                    {popup.name[lang === "en" ? "bn" : "en"]}
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Minimap */}
          <canvas
            ref={minimap}
            aria-label={t("minimap", lang)}
            role="img"
            className="absolute right-3 top-[9.5rem] size-28 rounded-2xl border-2 border-white/80 shadow-lg md:top-[10.5rem] md:size-36"
          />

          {/* Joystick (touch, free mode) */}
          {isFree && coarse && <Joystick sim={sim} label={t("joystick", lang)} />}

          {/* Arrival */}
          {hud.done && !isFree && (
            <div className="absolute inset-0 grid place-items-center bg-black/40 p-6">
              <div className="w-full max-w-sm rounded-2xl bg-white p-5 text-center text-[#17201c] shadow-2xl">
                <p className="text-4xl" aria-hidden>
                  🏁
                </p>
                <p className="mt-2 text-lg font-bold" role="status">
                  {t("arrived", lang, { place: props.destination })}
                </p>
                <div className="mt-4 flex gap-2">
                  <button type="button" onClick={restart} className="flex-1 rounded-lg bg-[#006a4e] px-3 py-2 font-semibold text-white">
                    {t("rideAgain", lang)}
                  </button>
                  <button type="button" onClick={props.onExit} className="flex-1 rounded-lg border border-[#d5ded9] px-3 py-2 font-semibold">
                    {t("backToMap", lang)}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Bike picker */}
          {pickerOpen && (
            <div
              id="bike-picker"
              role="dialog"
              aria-label={t("chooseBike", lang)}
              className="absolute inset-x-3 bottom-36 z-10 mx-auto max-w-md rounded-2xl bg-white p-4 text-[#17201c] shadow-2xl sm:bottom-40"
            >
              <div className="mb-3 flex items-center justify-between">
                <p className="font-bold">{t("chooseBike", lang)}</p>
                <button type="button" onClick={() => setPickerOpen(false)} aria-label={t("close", lang)} className="grid size-8 place-items-center rounded-full hover:bg-black/5">
                  ✕
                </button>
              </div>
              <fieldset>
                <legend className="sr-only">{t("chooseBike", lang)}</legend>
                <div className="grid gap-2">
                  {bikesFor(vehicle).map((b) => (
                    <label
                      key={b.id}
                      className="flex cursor-pointer items-center gap-3 rounded-xl border border-[#d5ded9] px-3 py-2 has-[:checked]:border-[#006a4e] has-[:checked]:bg-[#eef6f2] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-[#006a4e]"
                    >
                      <input type="radio" name="bike" className="sr-only" checked={b.id === bike.id} onChange={() => chooseBike(b.id)} />
                      <span className="text-2xl" aria-hidden>
                        {vehicle === "motorcycle" ? "🏍" : "🚲"}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-semibold">{b.name[lang]}</span>
                        <span className="block text-xs text-[#5d6b64]">{b.blurb[lang]}</span>
                      </span>
                      <span className="shrink-0 text-right text-xs">
                        <span className="block text-[#5d6b64]">{t("topSpeed", lang)}</span>
                        <span className="font-bold">
                          {digits(b.maxKmh, lang)} {t("kmh", lang)}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <fieldset className="mt-3">
                <legend className="mb-1.5 text-xs font-semibold text-[#5d6b64]">{t("bikeColor", lang)}</legend>
                <div className="flex flex-wrap gap-2">
                  {BIKE_COLORS.map((c, i) => (
                    <label key={c} className="cursor-pointer">
                      <input type="radio" name="bike-color" className="peer sr-only" checked={c === bikeColor} onChange={() => chooseColor(c)} aria-label={`${t("bikeColor", lang)} ${digits(i + 1, lang)}`} />
                      <span
                        className="block size-8 rounded-full border-2 border-white shadow ring-2 ring-transparent peer-checked:ring-[#006a4e] peer-focus-visible:ring-[#17201c]"
                        style={{ background: c }}
                      />
                    </label>
                  ))}
                </div>
              </fieldset>
            </div>
          )}

          {/* Bottom controls */}
          <div className="absolute inset-x-0 bottom-0 flex flex-col items-center gap-2 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            {!isFree && (
              <label className="flex w-full max-w-md items-center gap-3 rounded-full bg-black/55 px-4 py-2 text-sm shadow backdrop-blur">
                <span className="shrink-0">{t("speed", lang)}</span>
                <input
                  type="range"
                  min={spec.minKmh}
                  max={bike.maxKmh}
                  step={1}
                  value={speed}
                  onChange={(e) => setSpeed(Number(e.target.value))}
                  className="min-w-0 flex-1 accent-[#2fd39b]"
                />
                <span className="w-20 shrink-0 text-right tabular-nums">
                  {digits(speed, lang)} {t("kmh", lang)}
                </span>
              </label>
            )}
            <div className="flex max-w-full flex-wrap items-center justify-center gap-1 sm:gap-2">
              <button type="button" onClick={props.onExit} className={btn} aria-label={t("exitRide", lang)} title={t("exitRide", lang)}>
                ✕
              </button>
              {!isFree && (
                <button
                  ref={playBtn}
                  type="button"
                  onClick={togglePlay}
                  className={`${btn} size-11 sm:size-14 bg-[#2fd39b] text-xl text-[#06291d]`}
                  aria-label={t(hud.playing ? "pause" : "play", lang)}
                  title={t(hud.playing ? "pause" : "play", lang)}
                >
                  {hud.playing ? "❚❚" : "▶"}
                </button>
              )}
              <button
                type="button"
                onClick={() => setFree(!isFree)}
                className={`${btn} w-auto whitespace-nowrap px-2.5 text-xs font-semibold sm:w-auto sm:px-4 sm:text-sm`}
                aria-pressed={isFree}
              >
                {t(isFree ? "backToRoute" : "freeMode", lang)}
              </button>
              <button
                type="button"
                onClick={() => setPickerOpen((o) => !o)}
                className={btn}
                aria-expanded={pickerOpen}
                aria-controls="bike-picker"
                aria-label={t("chooseBike", lang)}
                title={t("chooseBike", lang)}
              >
                {vehicle === "motorcycle" ? "🏍" : "🚲"}
              </button>
              <button
                type="button"
                onClick={toggleView}
                className={btn}
                aria-label={t(view === "helmet" ? "viewHelmet" : "viewChase", lang)}
                title={t(view === "helmet" ? "viewHelmet" : "viewChase", lang)}
              >
                {view === "helmet" ? "🪖" : "🎥"}
              </button>
              <button
                type="button"
                onClick={toggleQuality}
                className={`${btn} text-xs font-bold`}
                aria-label={`${t("quality", lang)}: ${t(quality === "high" ? "qualityHigh" : "qualityLow", lang)}`}
                title={`${t("quality", lang)}: ${t(quality === "high" ? "qualityHigh" : "qualityLow", lang)}`}
              >
                {quality === "high" ? "HD" : "SD"}
              </button>
              <button type="button" onClick={toggleSound} className={btn} aria-pressed={soundOn} aria-label={t(soundOn ? "soundOn" : "soundOff", lang)} title={t(soundOn ? "soundOn" : "soundOff", lang)}>
                {soundOn ? "🔊" : "🔇"}
              </button>
              <button
                type="button"
                onClick={cycleTod}
                className={`${btn} sm:w-auto sm:px-3 text-xs font-semibold`}
                title={`${t("timeOfDay", lang)}: ${t(`tod_${todChoice}`, lang)}`}
                aria-label={`${t("timeOfDay", lang)}: ${t(`tod_${todChoice}`, lang)}`}
              >
                {tod === "night" ? "🌙" : tod === "evening" ? "🌇" : tod === "morning" ? "🌅" : "☀️"}
                <span className="hidden sm:inline"> {t(`tod_${todChoice}`, lang)}</span>
              </button>
            </div>
            <p className="hidden text-[11px] text-white/80 [text-shadow:0_1px_2px_#000] md:block">{t("keysHelp", lang)}</p>
          </div>
        </SceneBoundary>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Minimap (north-up, ~700 m across, centred on the rider)
// ---------------------------------------------------------------------------

function drawMinimap(canvas: HTMLCanvasElement | null, world: RideWorld, s: RideSim, landmarks: LocalLandmark[]) {
  if (!canvas) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const size = canvas.clientWidth;
  if (canvas.width !== Math.round(size * dpr)) {
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const span = 700;
  const k = size / span;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "rgba(20, 30, 26, 0.82)";
  ctx.fillRect(0, 0, size, size);
  ctx.save();
  ctx.translate(size / 2, size / 2);
  ctx.scale(k, k);
  ctx.translate(-s.x, -s.z);

  const { xs, zs, cum } = world.path;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = 8;
  ctx.strokeStyle = "rgba(255,255,255,0.35)";
  ctx.beginPath();
  for (let i = 0; i < xs.length; i++) (i ? ctx.lineTo : ctx.moveTo).call(ctx, xs[i], zs[i]);
  ctx.stroke();

  // Travelled part
  if (s.mode === "route") {
    ctx.strokeStyle = "#2fd39b";
    ctx.beginPath();
    ctx.moveTo(xs[0], zs[0]);
    for (let i = 1; i < xs.length && cum[i] <= s.s; i++) ctx.lineTo(xs[i], zs[i]);
    ctx.lineTo(s.x, s.z);
    ctx.stroke();
  }

  ctx.fillStyle = "#ffd166";
  for (const l of landmarks) {
    ctx.beginPath();
    ctx.arc(l.x, l.z, 9, 0, Math.PI * 2);
    ctx.fill();
  }
  // Destination
  const n = xs.length - 1;
  ctx.fillStyle = "#e2263a";
  ctx.beginPath();
  ctx.arc(xs[n], zs[n], 13, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Rider arrow (always centred)
  ctx.save();
  ctx.translate(size / 2, size / 2);
  ctx.rotate(-s.yaw);
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "#006a4e";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, -9);
  ctx.lineTo(6.5, 7);
  ctx.lineTo(0, 3.5);
  ctx.lineTo(-6.5, 7);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Touch joystick for free mode
// ---------------------------------------------------------------------------

function Joystick({ sim, label }: { sim: React.RefObject<RideSim>; label: string }) {
  const base = useRef<HTMLDivElement>(null);
  const [knob, setKnob] = useState({ x: 0, y: 0 });
  const R = 48;

  const move = (e: React.PointerEvent) => {
    const r = base.current!.getBoundingClientRect();
    let dx = e.clientX - (r.left + r.width / 2);
    let dy = e.clientY - (r.top + r.height / 2);
    const d = Math.hypot(dx, dy);
    if (d > R) {
      dx = (dx / d) * R;
      dy = (dy / d) * R;
    }
    setKnob({ x: dx, y: dy });
    sim.current.input.turn = dx / R;
    sim.current.input.fwd = -dy / R;
  };
  const release = () => {
    setKnob({ x: 0, y: 0 });
    sim.current.input.turn = 0;
    sim.current.input.fwd = 0;
  };

  return (
    <div
      ref={base}
      role="application"
      aria-label={label}
      className="absolute bottom-28 left-5 size-32 touch-none rounded-full border-2 border-white/60 bg-black/35 backdrop-blur"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        move(e);
      }}
      onPointerMove={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) move(e);
      }}
      onPointerUp={release}
      onPointerCancel={release}
    >
      <div
        className="absolute left-1/2 top-1/2 size-14 rounded-full bg-white/90 shadow-lg"
        style={{ transform: `translate(calc(-50% + ${knob.x}px), calc(-50% + ${knob.y}px))` }}
      />
    </div>
  );
}

function disposeWorld(w: RideWorld) {
  for (const g of [w.roads, w.route, w.walls, w.roofs, w.detail.marks, w.detail.footpaths, w.detail.walls, w.detail.wires, w.detail.signs, w.detail.posts]) g.dispose();
}
