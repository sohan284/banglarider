"use client";

import { formatDistance, formatDuration, stepText, t, vehicleName, type Lang } from "@/lib/i18n";
import type { Maneuver, Route, Vehicle } from "@/lib/routing";

/** Rotation (deg) of the arrow icon for each maneuver. */
const ANGLE: Record<Exclude<Maneuver, "arrive" | "uturn">, number> = {
  depart: 0,
  continue: 0,
  "slight-left": -45,
  "slight-right": 45,
  left: -90,
  right: 90,
  "sharp-left": -135,
  "sharp-right": 135,
};

export function ManeuverIcon({ maneuver, className = "size-5" }: { maneuver: Maneuver; className?: string }) {
  if (maneuver === "arrive")
    return (
      <svg viewBox="0 0 24 24" className={className} aria-hidden>
        <path d="M12 22s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12Z" fill="currentColor" />
        <circle cx="12" cy="10" r="2.6" fill="var(--panel)" />
      </svg>
    );
  if (maneuver === "uturn")
    return (
      <svg viewBox="0 0 24 24" className={className} aria-hidden>
        <path d="M8 20V9a4 4 0 0 1 8 0v8m0 0-3-3m3 3 3-3" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  return (
    <svg viewBox="0 0 24 24" className={className} style={{ transform: `rotate(${ANGLE[maneuver]}deg)` }} aria-hidden>
      <path d="M12 20V5m0 0-6 6m6-6 6 6" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

interface Props {
  lang: Lang;
  route: Route;
  vehicle: Vehicle;
  from: string;
  to: string;
  selected: number | null;
  onSelect: (i: number | null) => void;
}

/**
 * Turn-by-turn list. Doubles as the text alternative for the drawn route,
 * so it starts with a plain-language summary.
 */
export default function DirectionsList({ lang, route, vehicle, from, to, selected, onSelect }: Props) {
  return (
    <div className="mt-2">
      <h2 className="text-sm font-semibold">{t("directions", lang)}</h2>
      <p className="mb-2 mt-0.5 text-xs text-[var(--muted)]">
        {t("routeFromTo", lang, { from, to })}{" "}
        {t("routeSummary", lang, {
          distance: formatDistance(route.distance, lang),
          vehicle: vehicleName(vehicle, lang).toLowerCase(),
          time: formatDuration(route.duration, lang),
        })}
      </p>
      <ol className="flex flex-col">
        {route.steps.map((s, i) => (
          <li key={i}>
            <button
              type="button"
              onClick={() => onSelect(selected === i ? null : i)}
              aria-current={selected === i ? "step" : undefined}
              className={`flex w-full items-start gap-3 rounded-lg px-2 py-2 text-left text-sm transition-colors hover:bg-[var(--soft)] ${
                selected === i ? "bg-[var(--soft)] ring-1 ring-[var(--brand)]" : ""
              }`}
            >
              <span
                className={`mt-0.5 grid size-7 shrink-0 place-items-center rounded-full ${
                  s.maneuver === "arrive" ? "bg-[var(--end)] text-white" : "bg-[var(--brand)] text-white"
                }`}
              >
                <ManeuverIcon maneuver={s.maneuver} className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block">{stepText(s, lang)}</span>
                {s.distance > 0 && <span className="block text-xs text-[var(--muted)]">{formatDistance(s.distance, lang)}</span>}
              </span>
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}
