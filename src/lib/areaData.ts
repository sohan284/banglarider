/**
 * Loads an area's generated data files (see scripts/prepare-area.ts) and
 * builds the routing graph once per area. buildings.geojson is not loaded
 * here: the 3D map streams it directly by URL.
 */

import type { AreaConfig, LngLat } from "@/config/areas";
import { buildGraph, type RoadGraph, type Roads } from "@/lib/routing";

export type LandmarkCategory =
  | "circle"
  | "park"
  | "lake"
  | "market"
  | "mosque"
  | "hospital"
  | "road"
  | "education"
  | "embassy"
  | "transport"
  | "other";

export interface Landmark {
  id: string;
  category: LandmarkCategory;
  name: { en: string; bn: string };
  lngLat: LngLat;
  osm: string | null;
  bnSource: "osm" | "manual";
  verify: string[];
}

export interface AreaData {
  roads: Roads;
  landmarks: Landmark[];
  graph: RoadGraph;
}

export class DataLoadError extends Error {
  constructor(message: string, public offline: boolean) {
    super(message);
  }
}

const cache = new Map<string, Promise<AreaData>>();

async function getJson<T>(url: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    throw new DataLoadError(`Network error loading ${url}`, typeof navigator !== "undefined" && !navigator.onLine);
  }
  if (!res.ok) throw new DataLoadError(`HTTP ${res.status} loading ${url}`, false);
  try {
    return (await res.json()) as T;
  } catch {
    throw new DataLoadError(`Invalid JSON in ${url}`, false);
  }
}

export function loadAreaData(area: AreaConfig): Promise<AreaData> {
  let p = cache.get(area.id);
  if (!p) {
    p = Promise.all([getJson<Roads>(area.data.roads), getJson<Landmark[]>(area.data.landmarks)]).then(([roads, landmarks]) => ({
      roads,
      landmarks,
      graph: buildGraph(roads),
    }));
    // Don't cache failures, so "Try again" really retries.
    p.catch(() => cache.delete(area.id));
    cache.set(area.id, p);
  }
  return p;
}

// ---------------------------------------------------------------------------
// Heavier 3D data (buildings + land use), shared by the 3D city view and ride
// mode so it is only downloaded once.
// ---------------------------------------------------------------------------

import type { BuildingsFC, LanduseFC } from "@/lib3d/cityModel";

export interface CityData {
  buildings: BuildingsFC;
  /** Optional: older data folders may not have land use yet. */
  landuse: LanduseFC | null;
}

const cityCache = new Map<string, Promise<CityData>>();

export function loadCityData(area: AreaConfig): Promise<CityData> {
  let p = cityCache.get(area.id);
  if (!p) {
    p = Promise.all([getJson<BuildingsFC>(area.data.buildings), getJson<LanduseFC>(area.data.landuse).catch(() => null)]).then(([buildings, landuse]) => ({
      buildings,
      landuse,
    }));
    p.catch(() => cityCache.delete(area.id));
    cityCache.set(area.id, p);
  }
  return p;
}
