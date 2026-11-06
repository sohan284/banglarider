"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getArea, type LngLat } from "@/config/areas";
import { DataLoadError, loadAreaData, type AreaData, type Landmark } from "@/lib/areaData";
import { detectCapabilities, storeMapMode, storedMapMode, type Capabilities, type MapMode } from "@/lib/capabilities";
import { t, vehicleName, type Lang } from "@/lib/i18n";
import { findRoute, MAX_SNAP_M, RouteError, snapToRoad, type Route, type Vehicle } from "@/lib/routing";
import ControlPanel, { type Field, type Place } from "@/components/ControlPanel";
import FallbackMap from "@/components/FallbackMap";
import StatusBanner, { type Banner } from "@/components/StatusBanner";

// MapLibre is large; load it only when the 3D map is actually used.
const MapView = dynamic(() => import("@/components/MapView"), { ssr: false });
// Ride mode pulls in three.js; it is only downloaded when the user presses Ride.
const loadRideMode = () => import("@/ride/RideMode");
const RideMode = dynamic(loadRideMode, { ssr: false, loading: () => <div className="fixed inset-0 z-50 bg-[#0b3d2e]" /> });

/** Encodes a place for a share link: landmark id, or "lat,lng". */
function encodePlace(p: Place): string {
  return p.landmarkId ?? `${p.lngLat[1].toFixed(5)},${p.lngLat[0].toFixed(5)}`;
}

type RouteState = { route: Route; error?: undefined } | { route?: undefined; error: RouteError } | null;

function readPref<T extends string>(key: string, allowed: readonly T[]): T | null {
  try {
    const v = localStorage.getItem(key);
    return v && (allowed as readonly string[]).includes(v) ? (v as T) : null;
  } catch {
    return null;
  }
}
function writePref(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

export default function RiderApp({ areaId }: { areaId?: string }) {
  const area = getArea(areaId);

  const [lang, setLangState] = useState<Lang>("en");
  const [vehicle, setVehicleState] = useState<Vehicle>("motorcycle");
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [mode, setModeState] = useState<MapMode | null>(null);

  const [data, setData] = useState<AreaData | null>(null);
  const [loadError, setLoadError] = useState<DataLoadError | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);

  const [start, setStart] = useState<Place | null>(null);
  const [end, setEnd] = useState<Place | null>(null);
  const [active, setActive] = useState<Field>("start");
  const [selectedStep, setSelectedStep] = useState<number | null>(null);

  const [online, setOnline] = useState(true);
  const [tilesFailed, setTilesFailed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [reasonDismissed, setReasonDismissed] = useState(false);
  const [riding, setRiding] = useState(false);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const urlRead = useRef(false);

  // ---- one-time browser setup (preferences, capabilities, connectivity) ----
  useEffect(() => {
    const c = detectCapabilities();
    const storedLang = readPref("br:lang", ["en", "bn"] as const);
    const storedVehicle = readPref("br:vehicle", ["motorcycle", "bicycle"] as const);
    const stored = storedMapMode();
    /* eslint-disable react-hooks/set-state-in-effect -- browser-only values must be read after hydration */
    setCaps(c);
    if (storedLang) setLangState(storedLang);
    if (storedVehicle) setVehicleState(storedVehicle);
    setModeState(c.webgl ? (stored ?? c.recommended) : "simple");
    setOnline(navigator.onLine);
    /* eslint-enable react-hooks/set-state-in-effect */
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang;
    document.title = `${t("appName", lang)} · ${area.name[lang]}`;
  }, [lang, area]);

  // ---- data ----
  useEffect(() => {
    let cancelled = false;
    loadAreaData(area)
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setLoadError(null);
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(e instanceof DataLoadError ? e : new DataLoadError(String(e), false));
      });
    return () => {
      cancelled = true;
    };
  }, [area, loadAttempt]);

  // ---- preferences ----
  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    writePref("br:lang", l);
  }, []);
  const setVehicle = useCallback((v: Vehicle) => {
    setVehicleState(v);
    writePref("br:vehicle", v);
  }, []);
  const setMode = useCallback((m: MapMode) => {
    setModeState(m);
    storeMapMode(m);
  }, []);

  const flash = useCallback((msg: string) => {
    setNotice(msg);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 6000);
  }, []);

  // ---- choosing places ----
  const assign = useCallback(
    (field: Field, place: Place | null) => {
      setSelectedStep(null);
      if (field === "start") {
        setStart(place);
        if (place && !end) setActive("end");
      } else {
        setEnd(place);
        if (place && !start) setActive("start");
      }
    },
    [start, end],
  );

  /** Turns a map point into a Place snapped to the nearest usable road. */
  const placeFromPoint = useCallback(
    (p: LngLat, v: Vehicle): Place | "outside" | "too-far" => {
      if (!data) return "too-far";
      const [w, s, e, n] = area.bbox;
      if (p[0] < w || p[0] > e || p[1] < s || p[1] > n) return "outside";
      const snap = snapToRoad(data.graph, p, v);
      if (!snap || snap.dist > MAX_SNAP_M) return "too-far";
      const road = snap.roadName;
      const name =
        road.en || road.bn
          ? { en: t("near", "en", { road: road.en ?? road.bn! }), bn: t("near", "bn", { road: road.bn ?? road.en! }) }
          : { en: t("pinned", "en"), bn: t("pinned", "bn") };
      return { lngLat: snap.point, name };
    },
    [data, area],
  );

  const pickPoint = useCallback(
    (p: LngLat) => {
      const place = placeFromPoint(p, vehicle);
      if (place === "outside") flash(t("outsideArea", lang, { area: area.name[lang] }));
      else if (place === "too-far") flash(t(active === "start" ? "errTooFar_start" : "errTooFar_end", lang));
      else assign(active, place);
    },
    [placeFromPoint, vehicle, area, active, lang, assign, flash],
  );

  const pickLandmark = useCallback(
    (lm: Landmark) => assign(active, { lngLat: lm.lngLat, name: lm.name, landmarkId: lm.id }),
    [active, assign],
  );

  const swap = useCallback(() => {
    setStart(end);
    setEnd(start);
    setSelectedStep(null);
  }, [start, end]);

  // ---- shareable links: ?from=<landmark id | lat,lng>&to=…&v=bicycle ----
  useEffect(() => {
    if (!data || urlRead.current) return;
    urlRead.current = true;
    const q = new URLSearchParams(window.location.search);
    const v = q.get("v") === "bicycle" ? "bicycle" : q.get("v") === "motorcycle" ? "motorcycle" : null;
    const veh = v ?? vehicle;
    const resolve = (raw: string | null): Place | null => {
      if (!raw) return null;
      const lm = data.landmarks.find((l) => l.id === raw);
      if (lm) return { lngLat: lm.lngLat, name: lm.name, landmarkId: lm.id };
      const m = raw.match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
      if (!m) return null;
      const place = placeFromPoint([Number(m[2]), Number(m[1])], veh);
      return typeof place === "string" ? null : place;
    };
    const from = resolve(q.get("from"));
    const to = resolve(q.get("to"));
    /* eslint-disable react-hooks/set-state-in-effect -- one-time read of the share link once data is ready */
    if (v) setVehicleState(v);
    if (from) setStart(from);
    if (to) setEnd(to);
    if (from && !to) setActive("end");
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [data, vehicle, placeFromPoint]);

  const shareUrl = useMemo(() => {
    if (typeof window === "undefined") return "";
    const q = new URLSearchParams();
    if (start) q.set("from", encodePlace(start));
    if (end) q.set("to", encodePlace(end));
    if (start || end) q.set("v", vehicle);
    const qs = q.toString();
    return `${window.location.origin}${window.location.pathname}${qs ? `?${qs}` : ""}`;
  }, [start, end, vehicle]);

  // Keep the address bar in sync so the current route can be bookmarked.
  useEffect(() => {
    if (!urlRead.current || !shareUrl) return;
    if (shareUrl !== window.location.href) window.history.replaceState(null, "", shareUrl);
  }, [shareUrl]);

  const share = useCallback(async () => {
    const title = start && end ? t("shareTitle", lang, { from: start.name[lang], to: end.name[lang] }) : t("appName", lang);
    try {
      if (navigator.share) {
        await navigator.share({ title, url: shareUrl });
        return;
      }
      await navigator.clipboard.writeText(shareUrl);
      flash(t("linkCopied", lang));
    } catch (e) {
      if ((e as Error).name !== "AbortError") window.prompt(t("share", lang), shareUrl);
    }
  }, [shareUrl, start, end, lang, flash]);

  // ---- routing ----
  const routeState: RouteState = useMemo(() => {
    if (!data || !start || !end) return null;
    try {
      return { route: findRoute(data.graph, start.lngLat, end.lngLat, vehicle) };
    } catch (e) {
      return { error: e instanceof RouteError ? e : new RouteError("no-route") };
    }
  }, [data, start, end, vehicle]);

  const routeError = useMemo(() => {
    const e = routeState?.error;
    if (!e) return null;
    if (e.code === "too-far") return t(e.which === "end" ? "errTooFar_end" : "errTooFar_start", lang);
    if (e.code === "same-point") return t("errSamePoint", lang);
    return t("errNoRoute", lang, { vehicle: vehicleName(vehicle, lang).toLowerCase() });
  }, [routeState, lang, vehicle]);

  // ---- banners ----
  const banners: Banner[] = [];
  if (loadError)
    banners.push({
      id: "load",
      tone: "error",
      text: loadError.offline ? `${t("loadError", lang)} ${t("offline", lang)}` : t("loadError", lang),
      action: { label: t("retry", lang), onClick: () => setLoadAttempt((n) => n + 1) },
    });
  if (!online) banners.push({ id: "offline", tone: "warn", text: t("offline", lang) });
  if (tilesFailed && mode === "map") banners.push({ id: "tiles", tone: "info", text: t("tilesFailed", lang) });
  if (mode === "simple" && caps?.reason && !reasonDismissed && !storedMapMode())
    banners.push({
      id: "reason",
      tone: "info",
      text: t(`simpleReason_${caps.reason}`, lang),
      onDismiss: () => setReasonDismissed(true),
    });
  if (notice) banners.push({ id: "notice", tone: "warn", text: notice, onDismiss: () => setNotice(null) });

  const route = routeState?.route ?? null;
  const landmarks = data?.landmarks ?? [];
  const reducedMotion = caps?.reducedMotion ?? false;

  return (
    <main className="fixed inset-0 overflow-hidden bg-[var(--map-bg)] text-[var(--ink)]">
      <h1 className="sr-only">
        {t("appName", lang)} · {area.name[lang]}
      </h1>

      <div className="absolute inset-0" aria-label={t("mapLabel", lang, { area: area.name[lang] })} role="region">
        {data && mode === "map" && (
          <MapView
            area={area}
            lang={lang}
            roads={data.roads}
            landmarks={landmarks}
            start={start}
            end={end}
            route={route}
            selectedStep={selectedStep}
            reducedMotion={reducedMotion}
            onPick={pickPoint}
            onLandmark={pickLandmark}
            onTilesFailed={() => setTilesFailed(true)}
          />
        )}
        {data && mode === "simple" && (
          <FallbackMap
            area={area}
            lang={lang}
            roads={data.roads}
            landmarks={landmarks}
            start={start}
            end={end}
            route={route}
            selectedStep={selectedStep}
            onPick={pickPoint}
            onLandmark={pickLandmark}
          />
        )}
      </div>

      {!data && !loadError && (
        <div className="absolute inset-0 grid place-items-center" role="status" aria-live="polite">
          <div className="flex flex-col items-center gap-3 px-6 text-center">
            <p className="text-3xl font-bold text-[var(--brand-ink)]">{t("appName", lang)}</p>
            <p className="max-w-xs text-sm text-[var(--muted)]">{t("tagline", lang, { area: area.name[lang] })}</p>
            <span className="mt-2 size-9 animate-spin rounded-full border-4 border-[var(--brand)] border-t-transparent motion-reduce:animate-none" aria-hidden />
            <p className="text-sm font-medium">{t("loading", lang)}</p>
          </div>
        </div>
      )}

      <StatusBanner banners={banners} lang={lang} />

      <ControlPanel
        lang={lang}
        onLang={setLang}
        areaName={area.name[lang]}
        vehicle={vehicle}
        onVehicle={setVehicle}
        mode={mode}
        canUse3D={caps?.webgl ?? false}
        onMode={setMode}
        landmarks={landmarks}
        disabled={!data}
        start={start}
        end={end}
        active={active}
        onActive={setActive}
        onPlace={assign}
        onSwap={swap}
        route={route}
        routeError={routeError}
        selectedStep={selectedStep}
        onSelectStep={setSelectedStep}
        canRide={!!caps?.webgl}
        onRide={() => setRiding(true)}
        onRidePrefetch={() => void loadRideMode()}
        onShare={share}
      />

      {riding && route && data && end && (
        <RideMode
          area={area}
          lang={lang}
          route={route}
          roads={data.roads}
          landmarks={landmarks}
          vehicle={vehicle}
          destination={end.name[lang]}
          reducedMotion={reducedMotion}
          lowEnd={caps?.lowEnd ?? false}
          onExit={() => setRiding(false)}
        />
      )}
    </main>
  );
}
