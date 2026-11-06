"use client";

import { useId, useMemo, useRef, useState } from "react";
import type { LngLat } from "@/config/areas";
import type { Landmark, LandmarkCategory } from "@/lib/areaData";
import type { MapMode } from "@/lib/capabilities";
import { digits, formatDistance, formatDuration, t, vehicleName, type Lang } from "@/lib/i18n";
import type { Route, Vehicle } from "@/lib/routing";
import DirectionsList from "@/components/DirectionsList";

export type Field = "start" | "end";
export interface Place {
  lngLat: LngLat;
  name: { en: string; bn: string };
  landmarkId?: string;
}

interface Props {
  lang: Lang;
  onLang: (l: Lang) => void;
  areaName: string;
  vehicle: Vehicle;
  onVehicle: (v: Vehicle) => void;
  mode: MapMode | null;
  canUse3D: boolean;
  onMode: (m: MapMode) => void;
  landmarks: Landmark[];
  disabled: boolean;
  start: Place | null;
  end: Place | null;
  active: Field;
  onActive: (f: Field) => void;
  onPlace: (f: Field, p: Place | null) => void;
  onSwap: () => void;
  route: Route | null;
  routeError: string | null;
  selectedStep: number | null;
  onSelectStep: (i: number | null) => void;
  canRide: boolean;
  onRide: () => void;
  onRidePrefetch: () => void;
  onShare: () => void;
}

const NEXT_MODE: Record<MapMode, MapMode> = { diorama: "map", map: "simple", simple: "diorama" };
const MODE_LABEL = { diorama: "viewDiorama", map: "viewMap", simple: "viewSimple" } as const;

export const CATEGORY_ICON: Record<LandmarkCategory, string> = {
  circle: "◎",
  park: "♣",
  lake: "≈",
  market: "▣",
  mosque: "☪",
  hospital: "✚",
  road: "═",
  education: "✎",
  embassy: "⚑",
  transport: "⇄",
  other: "●",
};

export default function ControlPanel(p: Props) {
  const { lang } = p;
  const [stepsOpen, setStepsOpen] = useState(false);
  const stepsId = useId();

  return (
    <section
      data-panel
      aria-label={t("appName", lang)}
      className="absolute inset-x-0 bottom-0 z-20 flex max-h-[78dvh] flex-col rounded-t-2xl bg-[var(--panel)] shadow-[0_-4px_24px_rgba(0,0,0,0.18)]
                 md:inset-x-auto md:bottom-3 md:left-3 md:top-3 md:max-h-none md:w-[380px] md:rounded-2xl md:shadow-xl"
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-4 pb-2 pt-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-lg font-bold leading-tight text-[var(--brand-ink)]">{t("appName", lang)}</p>
          <p className="truncate text-xs text-[var(--muted)]">{p.areaName}</p>
        </div>
        {p.canUse3D && p.mode && (
          <button
            type="button"
            onClick={() => p.onMode(NEXT_MODE[p.mode!])}
            className="btn-chip"
            aria-label={`${t("viewLabel", lang)}: ${t(MODE_LABEL[p.mode], lang)}. ${t("viewSwitchTo", lang, { mode: t(MODE_LABEL[NEXT_MODE[p.mode]], lang) })}`}
          >
            {t(MODE_LABEL[p.mode], lang)} ▾
          </button>
        )}
        <button
          type="button"
          onClick={() => p.onLang(lang === "en" ? "bn" : "en")}
          className="btn-chip"
          aria-label={t("languageLabel", lang)}
          lang={lang === "en" ? "bn" : "en"}
        >
          {t("language", lang)}
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        {/* Vehicle */}
        <fieldset className="mb-3">
          <legend className="sr-only">{t("vehicle", lang)}</legend>
          <div className="grid grid-cols-2 gap-1 rounded-xl bg-[var(--soft)] p-1">
            {(["motorcycle", "bicycle"] as const).map((v) => (
              <label
                key={v}
                className="flex cursor-pointer items-center justify-center gap-1.5 rounded-lg py-1.5 text-sm font-medium transition-colors has-[:checked]:bg-[var(--panel)] has-[:checked]:text-[var(--brand-ink)] has-[:checked]:shadow-sm has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-[var(--brand)]"
              >
                <input type="radio" name="vehicle" value={v} checked={p.vehicle === v} onChange={() => p.onVehicle(v)} className="sr-only" />
                <span aria-hidden>{v === "motorcycle" ? "🏍" : "🚲"}</span>
                {vehicleName(v, lang)}
              </label>
            ))}
          </div>
        </fieldset>

        {/* Places */}
        <div className="relative flex flex-col gap-2">
          <PlaceField field="start" {...p} />
          <PlaceField field="end" {...p} />
          <button
            type="button"
            onClick={p.onSwap}
            disabled={!p.start && !p.end}
            aria-label={t("swap", lang)}
            title={t("swap", lang)}
            className="absolute right-11 top-1/2 z-10 grid size-8 -translate-y-1/2 place-items-center rounded-full border border-[var(--line)] bg-[var(--panel)] text-[var(--muted)] shadow-sm hover:text-[var(--ink)] disabled:opacity-40"
          >
            <svg viewBox="0 0 24 24" className="size-4" aria-hidden>
              <path d="M7 4v14m0 0-3-3m3 3 3-3M17 20V6m0 0-3 3m3-3 3 3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>

        {/* Hint for tapping */}
        {!p.disabled && (!p.start || !p.end) && (
          <p className="mt-2 text-xs text-[var(--muted)]" aria-live="polite">
            {t(p.active === "start" ? "pickOnMapStart" : "pickOnMapEnd", lang)}
          </p>
        )}

        {/* Route error */}
        {p.routeError && (
          <p role="alert" className="mt-3 rounded-lg bg-[var(--warn-bg)] px-3 py-2 text-sm text-[var(--warn-ink)]">
            {p.routeError}
          </p>
        )}

        {/* Summary + directions */}
        {p.route && p.start && p.end && (
          <div className="mt-3">
            <div className="flex items-stretch gap-2">
              <div className="flex-1 rounded-xl bg-[var(--soft)] px-3 py-2">
                <p className="text-xs text-[var(--muted)]">{t("distance", lang)}</p>
                <p className="text-lg font-bold">{formatDistance(p.route.distance, lang)}</p>
              </div>
              <div className="flex-1 rounded-xl bg-[var(--soft)] px-3 py-2">
                <p className="text-xs text-[var(--muted)]">{t("time", lang)}</p>
                <p className="text-lg font-bold">{formatDuration(p.route.duration, lang)}</p>
              </div>
            </div>

            <div className="mt-3 flex gap-2">
              {p.canRide && (
                <button
                  type="button"
                  onClick={p.onRide}
                  onPointerEnter={p.onRidePrefetch}
                  onFocus={p.onRidePrefetch}
                  aria-label={t("rideLabel", lang)}
                  className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-[var(--brand)] px-4 py-2.5 text-base font-bold text-white shadow-sm hover:brightness-110"
                >
                  <span aria-hidden>{p.vehicle === "motorcycle" ? "🏍" : "🚲"}</span>
                  {t("ride", lang)}
                </button>
              )}
              <button
                type="button"
                onClick={p.onShare}
                className={`flex items-center justify-center gap-1.5 rounded-xl border border-[var(--line)] px-4 py-2.5 text-sm font-semibold hover:bg-[var(--soft)] ${p.canRide ? "" : "flex-1"}`}
              >
                <svg viewBox="0 0 24 24" className="size-4" aria-hidden>
                  <path d="M12 3v12m0-12-4 4m4-4 4 4M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                {t("share", lang)}
              </button>
            </div>

            <button
              type="button"
              className="mt-3 flex w-full items-center justify-between rounded-lg py-1 text-left text-sm font-semibold md:hidden"
              aria-expanded={stepsOpen}
              aria-controls={stepsId}
              onClick={() => setStepsOpen((o) => !o)}
            >
              <span>
                {t(stepsOpen ? "hideSteps" : "showSteps", lang)} · {t("stepsCount", lang, { n: digits(p.route.steps.length, lang) })}
              </span>
              <span aria-hidden className={`transition-transform ${stepsOpen ? "rotate-180" : ""}`}>
                ▾
              </span>
            </button>
            <div id={stepsId} className={`${stepsOpen ? "block" : "hidden"} md:block`}>
              <DirectionsList
                lang={lang}
                route={p.route}
                vehicle={p.vehicle}
                from={p.start.name[lang]}
                to={p.end.name[lang]}
                selected={p.selectedStep}
                onSelect={p.onSelectStep}
              />
            </div>
          </div>
        )}

        <p className="mt-4 text-[11px] text-[var(--muted)]">
          <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer" className="underline">
            {t("attribution", lang)}
          </a>
        </p>
      </div>
    </section>
  );
}

/** Accessible combobox: type to filter landmarks, arrows to move, Enter to choose. */
function PlaceField(props: Props & { field: Field }) {
  const { field, lang, landmarks } = props;
  const value = field === "start" ? props.start : props.end;
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const isActive = props.active === field;
  const label = t(field === "start" ? "start" : "end", lang);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? landmarks.filter((l) => l.name.en.toLowerCase().includes(q) || l.name.bn.includes(q))
      : landmarks;
    return [...list].sort((a, b) => a.name[lang].localeCompare(b.name[lang], lang === "bn" ? "bn" : "en"));
  }, [query, landmarks, lang]);

  const choose = (l: Landmark) => {
    props.onPlace(field, { lngLat: l.lngLat, name: l.name, landmarkId: l.id });
    setQuery("");
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setHighlight((h) => Math.min(h + 1, matches.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter" && open && matches[highlight]) {
      e.preventDefault();
      choose(matches[highlight]);
    } else if (e.key === "Escape") {
      setOpen(false);
      setQuery("");
    }
  };

  const shown = open ? query : value ? value.name[lang] : query;
  const optionId = (i: number) => `${listId}-o${i}`;

  return (
    <div className="relative">
      <div
        className={`flex items-center gap-2 rounded-xl border bg-[var(--panel)] pl-3 pr-1 transition-colors ${
          isActive ? "border-[var(--brand)] ring-2 ring-[var(--brand)]/25" : "border-[var(--line)]"
        }`}
      >
        <span
          aria-hidden
          className={`size-3 shrink-0 rounded-full ${field === "start" ? "bg-[var(--start)]" : "bg-[var(--end)]"} ring-2 ring-white`}
        />
        <label className="sr-only" htmlFor={`${listId}-input`}>
          {label}
        </label>
        <input
          ref={inputRef}
          id={`${listId}-input`}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && matches[highlight] ? optionId(highlight) : undefined}
          autoComplete="off"
          disabled={props.disabled}
          placeholder={t(field === "start" ? "searchStart" : "searchEnd", lang)}
          value={shown}
          onFocus={() => {
            props.onActive(field);
            setOpen(true);
            setHighlight(0);
          }}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            setHighlight(0);
          }}
          onKeyDown={onKeyDown}
          className="min-w-0 flex-1 bg-transparent py-2.5 pr-10 focus-visible:outline-none text-[15px] outline-none placeholder:text-[var(--muted)] disabled:opacity-50"
        />
        {value && (
          <button
            type="button"
            onClick={() => {
              props.onPlace(field, null);
              props.onActive(field);
              inputRef.current?.focus();
            }}
            aria-label={t("clearField", lang, { field: label })}
            className="grid size-8 shrink-0 place-items-center rounded-full text-[var(--muted)] hover:bg-[var(--soft)] hover:text-[var(--ink)]"
          >
            ✕
          </button>
        )}
        {!value && <span className="size-8 shrink-0" aria-hidden />}
      </div>

      {open && !props.disabled && (
        <ul
          id={listId}
          role="listbox"
          aria-label={t("landmarks", lang)}
          className="absolute inset-x-0 top-full z-30 mt-1 max-h-60 overflow-y-auto rounded-xl border border-[var(--line)] bg-[var(--panel)] py-1 shadow-lg"
        >
          {matches.length === 0 && <li className="px-3 py-2 text-sm text-[var(--muted)]">{t("noMatches", lang)}</li>}
          {matches.map((l, i) => (
            <li
              key={l.id}
              id={optionId(i)}
              role="option"
              aria-selected={i === highlight}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(l);
              }}
              onMouseEnter={() => setHighlight(i)}
              className={`flex cursor-pointer items-center gap-2 px-3 py-2 text-sm ${i === highlight ? "bg-[var(--soft)]" : ""}`}
            >
              <span aria-hidden className="w-5 text-center text-[var(--brand)]">
                {CATEGORY_ICON[l.category]}
              </span>
              <span className="min-w-0 flex-1 truncate">{l.name[lang]}</span>
              <span className="truncate text-xs text-[var(--muted)]" lang={lang === "en" ? "bn" : "en"}>
                {l.name[lang === "en" ? "bn" : "en"]}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
