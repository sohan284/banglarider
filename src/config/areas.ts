/**
 * Everything area-specific lives here.
 *
 * To add a new area:
 *   1. Add an entry to AREAS below (id, names, bbox, center, zoom).
 *   2. Add scripts/landmark-seeds/<id>.ts describing its landmarks.
 *   3. Run `npm run prepare-area -- <id>` to generate public/data/<id>/.
 *
 * Nothing else in the app hard-codes an area.
 */

export type LngLat = [lng: number, lat: number];

/** [west, south, east, north] in WGS84 degrees. */
export type BBox = [west: number, south: number, east: number, north: number];

export interface AreaConfig {
  id: string;
  name: { en: string; bn: string };
  /** Data is downloaded for this box and the map is restricted to (a padded version of) it. */
  bbox: BBox;
  center: LngLat;
  zoom: number;
  minZoom: number;
  /**
   * Optional real recordings for ride mode (e.g. CC0 street ambience, an azan).
   * Leave unset to use only the built-in synthesized soundscape.
   */
  audio?: { ambience?: string; azan?: string };
  /** Public URLs of the generated data files. */
  data: {
    roads: string;
    buildings: string;
    landuse: string;
    landmarks: string;
    meta: string;
  };
}

function dataFiles(id: string): AreaConfig["data"] {
  const base = `/data/${id}`;
  return {
    roads: `${base}/roads.geojson`,
    buildings: `${base}/buildings.geojson`,
    landuse: `${base}/landuse.geojson`,
    landmarks: `${base}/landmarks.json`,
    meta: `${base}/meta.json`,
  };
}

export const AREAS: Record<string, AreaConfig> = {
  gulshan: {
    id: "gulshan",
    name: { en: "Gulshan", bn: "গুলশান" },
    // Gulshan 1 & 2, plus Banani (west), Niketan (south) and the Baridhara edge (north-east).
    bbox: [90.4, 23.773, 90.428, 23.805],
    center: [90.4155, 23.7885],
    zoom: 14.6,
    minZoom: 13.5,
    data: dataFiles("gulshan"),
  },
};

export const DEFAULT_AREA_ID = "gulshan";

export function getArea(id: string | null | undefined): AreaConfig {
  return (id && AREAS[id]) || AREAS[DEFAULT_AREA_ID];
}
