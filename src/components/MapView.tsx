"use client";

/**
 * 3D map (MapLibre GL). Loaded lazily by RiderApp.
 *
 * Base map: OpenFreeMap "liberty" vector tiles. If that style can't load
 * (offline, blocked, outage) we switch to a local style that draws only our
 * own roads + buildings, so the app keeps working.
 */

import { useEffect, useRef } from "react";
import {
  LngLatBounds,
  Map as MapLibreMap,
  Marker,
  NavigationControl,
  setWorkerUrl,
  type GeoJSONSource,
  type MapMouseEvent,
  type PaddingOptions,
  type StyleSpecification,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { AreaConfig, LngLat } from "@/config/areas";
import type { Landmark } from "@/lib/areaData";
import { t, type Lang } from "@/lib/i18n";
import type { Roads, Route } from "@/lib/routing";
import type { Place } from "@/components/ControlPanel";
import { CATEGORY_ICON } from "@/components/ControlPanel";

setWorkerUrl("/vendor/maplibre-gl-worker.mjs");

const BASE_STYLE = "https://tiles.openfreemap.org/styles/liberty";
const STYLE_TIMEOUT_MS = 10_000;
const OSM_ATTRIBUTION = '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a>';

const LOCAL_STYLE: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: "bg", type: "background", paint: { "background-color": "#eef0e6" } }],
};

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
  onPick: (p: LngLat) => void;
  onLandmark: (l: Landmark) => void;
  onTilesFailed: () => void;
}

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

function routeGeoJSON(route: Route | null): GeoJSON.FeatureCollection {
  if (!route) return EMPTY;
  return { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: route.coords } }] };
}

function padBounds(b: AreaConfig["bbox"], pad: number): [[number, number], [number, number]] {
  return [
    [b[0] - pad, b[1] - pad],
    [b[2] + pad, b[3] + pad],
  ];
}

/** Map padding so routes aren't hidden behind the control panel. */
function panelPadding(): PaddingOptions {
  const panel = document.querySelector<HTMLElement>("[data-panel]")?.getBoundingClientRect();
  const wide = window.matchMedia("(min-width: 768px)").matches;
  if (wide) return { top: 60, bottom: 60, left: (panel?.right ?? 400) + 40, right: 70 };
  // Phone: the panel is a bottom sheet; keep the route in the visible strip above it.
  const covered = panel ? window.innerHeight - panel.top : window.innerHeight * 0.5;
  const bottom = Math.min(covered + 24, window.innerHeight - 160);
  return { top: 60, bottom, left: 30, right: 56 };
}

function pinElement(kind: "start" | "end"): HTMLElement {
  const el = document.createElement("div");
  el.className = "br-pin";
  el.setAttribute("aria-hidden", "true");
  el.innerHTML = `<svg viewBox="0 0 32 42" width="32" height="42"><path d="M16 41s14-13 14-25A14 14 0 0 0 2 16c0 12 14 25 14 25Z" fill="var(--${kind})" stroke="white" stroke-width="2.5"/><circle cx="16" cy="16" r="5.5" fill="white"/></svg>`;
  return el;
}

/** (Re)adds our sources and layers. Runs after every style load. */
function addOverlays(map: MapLibreMap, local: boolean, p: Props) {
  const style = map.getStyle();
  // Replace the base map's own building layer with our height-aware one.
  for (const layer of style.layers ?? []) {
    if ("source-layer" in layer && layer["source-layer"] === "building") map.removeLayer(layer.id);
  }
  const firstSymbol = style.layers?.find((l) => l.type === "symbol")?.id;

  if (local) {
    map.addSource("br-roads", { type: "geojson", data: p.roads });
    map.addLayer({
      id: "br-roads",
      type: "line",
      source: "br-roads",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": ["match", ["get", "highway"], ["primary", "trunk", "secondary", "motorway"], "#f6c86b", "#ffffff"],
        "line-width": ["interpolate", ["linear"], ["zoom"], 13, 1, 17, ["match", ["get", "highway"], ["primary", "trunk", "secondary"], 12, 6]],
      },
    });
  }

  map.addSource("br-buildings", { type: "geojson", data: p.area.data.buildings });
  map.addLayer(
    {
      id: "br-buildings",
      type: "fill-extrusion",
      source: "br-buildings",
      minzoom: 13,
      paint: {
        "fill-extrusion-color": ["interpolate", ["linear"], ["get", "h"], 6, "#e4ddd3", 20, "#d6cabb", 60, "#b9a993", 120, "#998a78"],
        "fill-extrusion-height": ["get", "h"],
        "fill-extrusion-base": ["coalesce", ["get", "mh"], 0],
        "fill-extrusion-opacity": 0.88,
      },
    },
    firstSymbol,
  );

  map.addSource("br-route", { type: "geojson", data: routeGeoJSON(p.route) });
  map.addLayer({
    id: "br-route-casing",
    type: "line",
    source: "br-route",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#ffffff", "line-width": ["interpolate", ["linear"], ["zoom"], 13, 6, 18, 16] },
  });
  map.addLayer({
    id: "br-route",
    type: "line",
    source: "br-route",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#006a4e", "line-width": ["interpolate", ["linear"], ["zoom"], 13, 3.5, 18, 10] },
  });
}

export default function MapView(props: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const latest = useRef(props);
  const pins = useRef<{ start?: Marker; end?: Marker }>({});
  const landmarkMarkers = useRef<{ lm: Landmark; el: HTMLButtonElement; marker: Marker }[]>([]);

  useEffect(() => {
    latest.current = props;
  });

  // ---- create map once ----
  useEffect(() => {
    const { area, reducedMotion } = latest.current;
    const container = containerRef.current!;
    let usingLocal = false;
    let styleLoaded = false;

    const map = new MapLibreMap({
      container,
      style: BASE_STYLE,
      center: area.center,
      zoom: area.zoom,
      minZoom: area.minZoom,
      maxZoom: 19,
      pitch: 50,
      bearing: -12,
      maxPitch: 70,
      maxBounds: padBounds(area.bbox, 0.012),
      attributionControl: { compact: false, customAttribution: OSM_ATTRIBUTION },
      fadeDuration: reducedMotion ? 0 : 300,
    });
    mapRef.current = map;
    map.addControl(new NavigationControl({ visualizePitch: true }), "top-right");
    map.getCanvas().style.cursor = "crosshair";

    const switchToLocalStyle = () => {
      if (usingLocal) return;
      usingLocal = true;
      map.setStyle(LOCAL_STYLE);
      latest.current.onTilesFailed();
    };
    const timer = setTimeout(() => {
      if (!styleLoaded) switchToLocalStyle();
    }, STYLE_TIMEOUT_MS);
    map.on("error", () => {
      if (!styleLoaded) switchToLocalStyle();
    });

    map.on("style.load", () => {
      styleLoaded = true;
      clearTimeout(timer);
      addOverlays(map, usingLocal, latest.current);
    });

    map.on("click", (e: MapMouseEvent) => {
      const target = e.originalEvent.target as HTMLElement | null;
      if (target?.closest(".maplibregl-marker")) return;
      latest.current.onPick([e.lngLat.lng, e.lngLat.lat]);
    });

    return () => {
      clearTimeout(timer);
      map.remove();
      mapRef.current = null;
      pins.current = {};
      landmarkMarkers.current = [];
    };
  }, []);

  // ---- route line + camera fit ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => (map.getSource("br-route") as GeoJSONSource | undefined)?.setData(routeGeoJSON(props.route));
    if (map.getSource("br-route")) apply();
    if (props.route) {
      const b = new LngLatBounds();
      for (const c of props.route.coords) b.extend(c);
      map.fitBounds(b, { padding: panelPadding(), maxZoom: 17, duration: props.reducedMotion ? 0 : 900, pitch: 45 });
    }
  }, [props.route, props.reducedMotion]);

  // ---- start / end pins ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    for (const kind of ["start", "end"] as const) {
      const place = props[kind];
      const existing = pins.current[kind];
      if (!place) {
        existing?.remove();
        delete pins.current[kind];
      } else if (existing) {
        existing.setLngLat(place.lngLat);
      } else {
        pins.current[kind] = new Marker({ element: pinElement(kind), anchor: "bottom" }).setLngLat(place.lngLat).addTo(map);
      }
    }
    // Single pin and no route yet: bring it into view.
    if (!props.route) {
      const only = props.end ?? props.start;
      if (only && !map.getBounds().contains(only.lngLat)) map.easeTo({ center: only.lngLat, duration: props.reducedMotion ? 0 : 600 });
    }
    // props.route intentionally excluded: fitting is handled by the route effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.start, props.end, props.reducedMotion]);

  // ---- landmark markers (buttons, so they're keyboard reachable) ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    for (const m of landmarkMarkers.current) m.marker.remove();
    landmarkMarkers.current = props.landmarks
      .filter((lm) => lm.category !== "road")
      .map((lm) => {
        const el = document.createElement("button");
        el.type = "button";
        el.className = "br-landmark";
        el.dataset.category = lm.category;
        el.innerHTML = `<span aria-hidden="true">${CATEGORY_ICON[lm.category]}</span><span class="br-landmark-label"></span>`;
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          latest.current.onLandmark(lm);
        });
        const marker = new Marker({ element: el, anchor: "center" }).setLngLat(lm.lngLat).addTo(map);
        return { lm, el, marker };
      });
  }, [props.landmarks]);

  // ---- marker labels follow the language ----
  useEffect(() => {
    for (const { lm, el } of landmarkMarkers.current) {
      const name = lm.name[props.lang];
      el.setAttribute("aria-label", name);
      el.setAttribute("title", name);
      el.querySelector(".br-landmark-label")!.textContent = name;
    }
    const map = mapRef.current;
    if (map) map.getCanvas().setAttribute("aria-label", t("mapLabel", props.lang, { area: props.area.name[props.lang] }));
  }, [props.lang, props.landmarks, props.area]);

  // ---- fly to a selected step ----
  useEffect(() => {
    const map = mapRef.current;
    const step = props.selectedStep !== null ? props.route?.steps[props.selectedStep] : undefined;
    if (!map || !step) return;
    map.flyTo({
      center: step.location,
      zoom: 17.5,
      bearing: step.maneuver === "arrive" ? map.getBearing() : step.bearingAfter,
      pitch: 60,
      padding: panelPadding(),
      duration: props.reducedMotion ? 0 : 1200,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.selectedStep]);

  // Inline size: MapLibre's own (unlayered) CSS sets `position: relative` on the
  // container, which beats Tailwind's layered `absolute inset-0`.
  return (
    <div className="absolute inset-0">
      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
    </div>
  );
}
