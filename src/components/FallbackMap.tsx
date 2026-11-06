"use client";

/**
 * Simple map for devices without WebGL, low-end devices and reduced-motion
 * users. Plain SVG drawn from roads.geojson: no tiles, no animation.
 * Drag to pan, wheel / pinch / buttons to zoom, tap to choose a point.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { AreaConfig, LngLat } from "@/config/areas";
import type { Landmark } from "@/lib/areaData";
import { t, type Lang } from "@/lib/i18n";
import type { Roads, Route } from "@/lib/routing";
import type { Place } from "@/components/ControlPanel";
import { CATEGORY_ICON } from "@/components/ControlPanel";

interface Props {
  area: AreaConfig;
  lang: Lang;
  roads: Roads;
  landmarks: Landmark[];
  start: Place | null;
  end: Place | null;
  route: Route | null;
  selectedStep: number | null;
  onPick: (p: LngLat) => void;
  onLandmark: (l: Landmark) => void;
}

type View = { x: number; y: number; w: number; h: number };

const SCALE = 100_000; // SVG units per degree of latitude (~1.1 m per unit)
const MAJOR = new Set(["motorway", "trunk", "primary", "secondary", "motorway_link", "trunk_link", "primary_link", "secondary_link"]);
const MINOR = new Set(["tertiary", "tertiary_link", "residential", "unclassified", "living_street", "road"]);

export default function FallbackMap(props: Props) {
  const { area, lang, roads, landmarks, start, end, route, selectedStep } = props;
  const svgRef = useRef<SVGSVGElement>(null);

  // Equirectangular projection centred on the area.
  const proj = useMemo(() => {
    const [w, s, e, n] = area.bbox;
    const k = Math.cos((((s + n) / 2) * Math.PI) / 180);
    const fwd = (p: LngLat | number[]) => [(p[0] - w) * k * SCALE, (n - p[1]) * SCALE] as const;
    const inv = (x: number, y: number): LngLat => [x / (k * SCALE) + w, n - y / SCALE];
    const full: View = { x: 0, y: 0, w: (e - w) * k * SCALE, h: (n - s) * SCALE };
    return { fwd, inv, full };
  }, [area]);

  const [view, setView] = useState<View>(proj.full);

  // Road geometry as three path strings (one per class) for fast rendering.
  const paths = useMemo(() => {
    const out = { major: "", minor: "", other: "" };
    for (const f of roads.features) {
      const d = f.geometry.coordinates
        .map((c, i) => {
          const [x, y] = proj.fwd(c);
          return `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
        })
        .join("");
      const hw = f.properties.highway;
      if (MAJOR.has(hw)) out.major += d;
      else if (MINOR.has(hw)) out.minor += d;
      else out.other += d;
    }
    return out;
  }, [roads, proj]);

  const routePoints = useMemo(
    () => route?.coords.map((c) => proj.fwd(c).map((v) => v.toFixed(1)).join(",")).join(" ") ?? "",
    [route, proj],
  );

  // Fit the view to a new route.
  useEffect(() => {
    if (!route) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const c of route.coords) {
      const [x, y] = proj.fwd(c);
      minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
    const pad = Math.max(maxX - minX, maxY - minY) * 0.25 + 150;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- camera follows the route
    setView({ x: minX - pad, y: minY - pad, w: maxX - minX + 2 * pad, h: maxY - minY + 2 * pad });
  }, [route, proj]);

  // Centre on a selected step.
  useEffect(() => {
    const step = selectedStep !== null ? route?.steps[selectedStep] : undefined;
    if (!step) return;
    const [x, y] = proj.fwd(step.location);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- camera follows the selected step
    setView({ x: x - 250, y: y - 250, w: 500, h: 500 });
  }, [selectedStep, route, proj]);

  // ---- pan / zoom / tap ----
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ moved: boolean; startDist?: number; startView?: View } | null>(null);

  const toSvg = (clientX: number, clientY: number) => {
    const svg = svgRef.current!;
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const m = svg.getScreenCTM();
    return m ? pt.matrixTransform(m.inverse()) : pt;
  };

  const zoomAt = (factor: number, cx?: number, cy?: number) =>
    setView((v) => {
      const w = Math.min(Math.max(v.w * factor, 150), proj.full.w * 1.6);
      const f = w / v.w;
      const px = cx ?? v.x + v.w / 2;
      const py = cy ?? v.y + v.h / 2;
      return { x: px - (px - v.x) * f, y: py - (py - v.y) * f, w, h: v.h * f };
    });

  useEffect(() => {
    const svg = svgRef.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = toSvg(e.clientX, e.clientY);
      zoomAt(e.deltaY > 0 ? 1.15 : 1 / 1.15, p.x, p.y);
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if ((e.target as Element).closest("[data-landmark]")) return;
    svgRef.current!.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 1) gesture.current = { moved: false };
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      gesture.current = { moved: true, startDist: Math.hypot(a.x - b.x, a.y - b.y), startView: view };
    }
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev || !gesture.current) return;
    const next = { x: e.clientX, y: e.clientY };
    pointers.current.set(e.pointerId, next);
    const g = gesture.current;
    if (pointers.current.size === 2 && g.startDist && g.startView) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const c = toSvg((a.x + b.x) / 2, (a.y + b.y) / 2);
      const sv = g.startView;
      const f = Math.min(Math.max(g.startDist / dist, 150 / sv.w), (proj.full.w * 1.6) / sv.w);
      setView({ x: c.x - (c.x - sv.x) * f, y: c.y - (c.y - sv.y) * f, w: sv.w * f, h: sv.h * f });
      return;
    }
    const dx = next.x - prev.x;
    const dy = next.y - prev.y;
    if (Math.abs(dx) + Math.abs(dy) > 0) {
      if (!g.moved && Math.hypot(dx, dy) < 4) return;
      g.moved = true;
      const svg = svgRef.current!;
      const unitsPerPx = view.w / svg.clientWidth;
      setView((v) => ({ ...v, x: v.x - dx * unitsPerPx, y: v.y - dy * unitsPerPx }));
    }
  };

  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    const g = gesture.current;
    pointers.current.delete(e.pointerId);
    if (pointers.current.size === 0) {
      if (g && !g.moved) {
        const p = toSvg(e.clientX, e.clientY);
        props.onPick(proj.inv(p.x, p.y));
      }
      gesture.current = null;
    }
  };

  // Stroke widths in screen pixels regardless of zoom.
  const pin = (p: Place | null, color: string) => {
    if (!p) return null;
    const [x, y] = proj.fwd(p.lngLat);
    const r = view.w / 90;
    return (
      <g transform={`translate(${x} ${y})`} aria-hidden>
        <circle r={r} fill={color} stroke="white" strokeWidth={r / 3} />
        <circle r={r / 3} fill="white" />
      </g>
    );
  };
  const lmR = view.w / 150;

  return (
    <div className="absolute inset-0 bg-[var(--map-bg)]">
      <svg
        ref={svgRef}
        viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
        preserveAspectRatio="xMidYMid meet"
        className="size-full touch-none select-none"
        style={{ cursor: "crosshair" }}
        role="img"
        aria-label={t("mapLabel", lang, { area: area.name[lang] })}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <rect x={proj.full.x} y={proj.full.y} width={proj.full.w} height={proj.full.h} fill="var(--map-area)" />
        <path d={paths.other} fill="none" stroke="var(--road-minor)" strokeWidth={1} vectorEffect="non-scaling-stroke" strokeLinecap="round" />
        <path d={paths.minor} fill="none" stroke="var(--road-minor)" strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />
        <path d={paths.major} fill="none" stroke="var(--road-major)" strokeWidth={4} vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />
        {route && (
          <>
            <polyline points={routePoints} fill="none" stroke="white" strokeWidth={9} vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />
            <polyline points={routePoints} fill="none" stroke="var(--brand)" strokeWidth={5} vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />
          </>
        )}
        {landmarks
          .filter((l) => l.category !== "road")
          .map((l) => {
            const [x, y] = proj.fwd(l.lngLat);
            return (
              <g
                key={l.id}
                data-landmark
                role="button"
                tabIndex={0}
                aria-label={l.name[lang]}
                transform={`translate(${x} ${y})`}
                className="cursor-pointer focus:outline-none [&:focus>circle]:stroke-[var(--ink)]"
                onClick={() => props.onLandmark(l)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    props.onLandmark(l);
                  }
                }}
              >
                <title>{l.name[lang]}</title>
                <circle r={lmR} fill="white" stroke="var(--brand)" strokeWidth={lmR / 4} />
                <text textAnchor="middle" dominantBaseline="central" fontSize={lmR * 1.1} fill="var(--brand)">
                  {CATEGORY_ICON[l.category]}
                </text>
              </g>
            );
          })}
        {pin(start, "var(--start)")}
        {pin(end, "var(--end)")}
      </svg>

      <div className="absolute right-3 top-24 z-10 flex flex-col overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--panel)] shadow md:top-3">
        {[
          { label: t("zoomIn", lang), text: "+", on: () => zoomAt(1 / 1.5) },
          { label: t("zoomOut", lang), text: "−", on: () => zoomAt(1.5) },
          { label: t("resetView", lang), text: "⤢", on: () => setView(proj.full) },
        ].map((b) => (
          <button
            key={b.text}
            type="button"
            onClick={b.on}
            aria-label={b.label}
            title={b.label}
            className="grid size-10 place-items-center border-b border-[var(--line)] text-lg last:border-b-0 hover:bg-[var(--soft)]"
          >
            {b.text}
          </button>
        ))}
      </div>
      <p className="absolute bottom-1 right-2 z-10 hidden rounded bg-white/80 px-1.5 text-[10px] text-[var(--muted)] md:block">
        {t("attribution", lang)}
      </p>
    </div>
  );
}
