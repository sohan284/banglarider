# Bangla Rider · বাংলা রাইডার

Pick a start and a destination in **Gulshan, Dhaka**, see the real road route on a 3D map with distance, time and turn-by-turn directions in English or Bangla, then **ride it** on a motorcycle or bicycle in an immersive 3D view.

- Static site: no backend. Routing runs in the browser on OpenStreetMap road data.
- Built with Next.js (App Router, static export), TypeScript, Tailwind CSS, MapLibre GL, ngraph.path and three.js (react-three-fiber).
- Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) (ODbL 1.0).

> **Status:** Phase 1 (map, search, routing, directions, EN/BN, fallback map) and Phase 2 (3D ride mode, time-of-day lighting, sound, share links) are done.

---

## Setup

Requires Node.js 20+ (developed on Node 24).

```bash
npm install
npm run dev          # http://localhost:3000
```

`npm run dev` and `npm run build` first run `scripts/copy-vendor.mjs`. It copies MapLibre's web-worker file to `public/vendor/` (git-ignored), because MapLibre 6 loads its worker by URL.

```bash
npm run build        # static site in ./out
npm run lint
```

The generated area data in `public/data/gulshan/` is committed, so you don't need to run the data script to develop.

---

## Data script

`scripts/prepare-area.ts` downloads OSM data for an area's bounding box from the Overpass API and writes compact files to `public/data/<area>/`:

| File | Contents |
|---|---|
| `roads.geojson` | Routable road centre-lines: `name`, `name_bn`, `highway`, `oneway` (1 / -1 / 0), `motor`, `bike`, `bike_contraflow` |
| `buildings.geojson` | Footprints with height `h` (and `mh` min-height) in metres. Height comes from `height`, then `building:levels × 3 m`, then a default of **3 floors × 3 m = 9 m** |
| `landmarks.json` | ~25 notable places with English + Bangla names and a `verify` list of caveats |
| `meta.json` | OSM timestamp, counts, file sizes |

### Commands

```bash
# Full run for Gulshan (downloads roads, buildings, landmark candidates)
npm run prepare:gulshan

# Same thing, generic form (any area id from src/config/areas.ts)
npm run prepare-area -- gulshan

# Ignore the local download cache and fetch fresh data
npm run prepare-area -- gulshan --force

# Regenerate only some outputs (e.g. after editing landmark seeds; uses the cache)
npm run prepare-area -- gulshan --only landmarks
npm run prepare-area -- gulshan --only roads,buildings

# Try a specific Overpass server first
npm run prepare-area -- gulshan --endpoint https://overpass-api.de/api/interpreter
```

Notes:

- Raw Overpass responses are cached in `.cache/overpass/` (git-ignored), so reruns are fast and don't hit the API.
- Public Overpass servers are often busy. The script retries with exponential backoff and rotates through several mirrors. A full run usually takes 1–5 minutes.
- Each run also writes `.cache/overpass/<area>-landmark-candidates.tsv`, a list of every named place in the box. Use it to write or adjust landmark seeds.
- At the end the script prints the landmarks that need a human check (see below).

### Landmarks to verify (Gulshan, data from 2026-11-06)

Every coordinate comes from OSM except **Gulshan 1 Circle**. OSM has no feature with that name, so its point is taken from where Gulshan Avenue's link roads meet. Please confirm it on the ground or against imagery.

Also flagged:

- **Banani–Gulshan Lake**: the point is the centre of a long, thin lake and may fall on the shore.
- **Police Plaza Concord**: about 10 m south of the bounding box. It is still reachable because it snaps to the nearest road.
- **Gulshan Police Station**: OSM has two "Gulshan Police Station / Gulshan Thana" features about 600 m apart; the script picked `way/345170862`.
- **Manual Bangla names** (not from OSM) for Baridhara Park, Banani–Gulshan Lake, Gulshan 2 City Corporation Market, Pink City, Baridhara Mosque, Gulshan Club, U.S. Embassy, Gulshan Police Station and The Westin. A Bangla speaker should check these.

The full list is in `public/data/gulshan/landmarks.json` (the `verify` field).

---

## How routing works

`src/lib/routing.ts`:

1. **Graph:** each road vertex becomes a node. Roads that share an OSM node share a coordinate, so they connect. Bridges without a shared node stay separate.
2. **Directions:** each segment gets directed links allowed by `oneway`, `junction=roundabout` and access tags. Both vehicles obey one-way rules unless OSM says `oneway:bicycle=no`.
3. **Vehicle rules:**
   - Motorcycles can't use cycleways or paths.
   - Bicycles can't use motorways, or paths not marked for bicycles.
   - Private and no-access roads are excluded.
4. **Snapping:** a tap or landmark snaps to the nearest usable road within 150 m. If the nearest road is a dead end (e.g. a one-way leaving the area), the next-nearest roads are tried.
5. **Search:** A* (`ngraph.path`, oriented) with a straight-line distance heuristic. The whole Gulshan graph (~6,200 nodes) builds in ~15 ms, and a route takes under 5 ms.
6. **Directions:** consecutive segments are grouped by road name, very short pieces are merged, and turn angles become left / right / slight / sharp / U-turn instructions.
7. **Time:** the estimate uses average Dhaka traffic speeds: motorcycle **18 km/h**, bicycle **12 km/h** (`VEHICLES` in `routing.ts`).

## Ride mode

Press **Ride** after choosing a route. The ride code and three.js (~930 KB uncompressed) download only at that moment; the first page load never includes them.

**The scene** (everything procedural, so no model or image files)
- **Buildings:** about 5,800 real footprints within ~320 m of the route, extruded to their OSM heights.
  - Facades come from a canvas-drawn texture: window grilles, sunshades, balconies with hanging laundry, AC units, floor slabs and grime.
  - Some windows light up in the evening and at night.
  - Many roofs carry water tanks and stair rooms.
- **Streets** (within ~170 m of the route; 110 m on Low):
  - footpaths with kerbs, painted black and yellow on main roads
  - lane markings and zebra crossings
  - plot boundary walls with gates
  - trees, including red Krishnachura
  - street lamps that glow at night
  - electric poles with sagging and tangled overhead wires
  - Bangla shop signs near markets, and roadside billboards
- **Speed humps:** yellow and black, on straight stretches of the route.
- **Sky and light:** a gradient sky with a sun or moon, and warm haze at every time of day. Shadows are on in High quality.
- **Draw calls:** merged geometry and instancing keep the scene to about 25 draw calls.

**How riding feels**
- **Auto-ride speed:** you pick a cruising speed, and the rider brakes for corners, speed humps and the destination, then accelerates out. Corner speed uses a comfortable sideways acceleration for each vehicle.
- **Physical cues:**
  - bumps over speed humps
  - the nose dips under braking
  - leaning into turns
  - light vibration
  - the field of view widens with speed
  - Reduced-motion users get none of the vibration or bumps.
- **Cameras (V):** a low chase camera at chest height, or a **helmet view** showing handlebars, mirrors and speedometer.
- **Free mode:** ride anywhere with W A S D or the arrow keys, or the on-screen joystick on touch screens. "Back to route" (or F) returns to the nearest point on the route.

**On-screen display**
- **Next-turn card:** arrow, distance and instruction, also announced to screen readers when the step changes.
- **Progress bar:** distance left, time left and current speed.
- **Minimap:** north-up, about 700 m across.
- **Landmark pop-ups:** shown when you pass within 80 m of a landmark.
- **Arrival:** a card with "Ride again" or "Back to map".

**Lighting and sound**
- **Time of day (T):** Auto (follows the device clock), Morning, Noon, Evening or Night.
- **Sound (M):** off by default, synthesized live with Web Audio:
  - motorcycle engine with fake gears and throttle load, or bicycle freewheel ticks when coasting
  - wind and tyre noise
  - a low city rumble
  - random rickshaw bells and CNG, car and bus horns around you
  - market chatter that grows louder near markets
- **Real recordings (optional):** set `audio: { ambience, azan }` for an area in `src/config/areas.ts`, with files in `public/audio/`. Use CC0 or your own recordings, and list them under Licenses. The ambience loop then replaces the synthetic rumble, and the azan plays once when you pass a mosque. No recordings are bundled.

| Key | Action |
|---|---|
| Space | Pause / ride |
| W A S D / arrows | Free ride (steer, accelerate, brake) |
| F | Toggle free ride / back to route |
| V | Chase camera / helmet view |
| Q | Graphics quality High / Low |
| + / − | Speed |
| M | Sound on/off |
| T | Cycle time of day |
| Esc | Exit ride |

**Performance and quality**
- **Graphics quality (Q or the HD/SD button):**
  - Phones and low-end devices start on **Low**: no shadows, 1× resolution, fewer trees and signs, no painted kerbs.
  - Desktops start on **High**: shadows, up to 1.6× resolution, anisotropic filtering.
- **Safety net:** resolution drops to 1× automatically if the frame rate stays under 28 fps.
- **Measured** (headless Chrome on an Apple M4, phone-sized screen, CPU throttled 4×): 60 fps on both Low and High.
- **Real mid-range Android: not yet measured.** Low is the safe default there.

**Fallbacks**
- The Ride button appears only when WebGL is available.
- If the 3D scene fails or the GPU context is lost, the ride shows a message and offers to go back to the map.

## Shareable links

The address bar always reflects the current route, e.g.

```
/?from=united-hospital&to=gulshan-1-circle&v=bicycle
/?from=23.79483,90.41425&to=gulshan-club&v=motorcycle
```

- `from` / `to`: a landmark id from `landmarks.json`, or `lat,lng`. Points are snapped to the nearest road.
- `v`: `motorcycle` (default) or `bicycle`.

The **Share** button uses the system share sheet where available, and otherwise copies the link.

## 3D map and simple-map fallback

- **3D map:** MapLibre with OpenFreeMap "liberty" vector tiles. The base map's buildings are replaced with our `buildings.geojson` as 3D extrusions. If the tile style doesn't load within 10 s (offline, blocked), the map switches to a local style that draws only our own roads and buildings.
- **Simple map:** a lightweight SVG drawing of the roads, with the same tap, landmark and route features and no animation. It is chosen automatically when:
  - WebGL is missing or software-rendered,
  - the user prefers reduced motion,
  - the device is low-end (≤ 2 GB RAM, ≤ 2 CPU cores, or Data Saver on).

  Users with WebGL can switch either way; the choice is remembered.
- The MapLibre bundle is lazy-loaded, so simple-map users never download it.

## Accessibility

- **Keyboard:** the place fields are accessible comboboxes (type to filter, ↑/↓, Enter, Esc). Landmark markers and directions steps are buttons.
- **Text version of the route:** the directions list is the text alternative. It starts with a plain summary ("From A to B. 3.0 km by motorcycle, about 10 min.").
- **Language:** switching to Bangla also switches digits (৩.০ কিমি) and sets `lang` on the page.
- **Messages:** errors and status use `role="alert"` / `role="status"`.

---

## Deploy to Vercel

The app is a static export (`output: "export"` in `next.config.ts`).

1. Push the repo to GitHub, GitLab or Bitbucket.
2. In Vercel: **Add New → Project →** import the repo. The framework preset is detected as **Next.js**; keep the defaults (build command `npm run build`).
3. Deploy.

Or from the CLI:

```bash
npm i -g vercel
vercel          # preview
vercel --prod   # production
```

Any static host also works: upload the `out/` folder. It must serve `.mjs` files with a JavaScript MIME type, which is needed for the MapLibre worker.

---

## Adding a new area

1. **Config:** add an entry to `AREAS` in `src/config/areas.ts`, with `id`, names, `bbox` `[west, south, east, north]`, `center`, `zoom` and `minZoom`. Data file paths are derived from the `id`.
2. **Seeds:** create `scripts/landmark-seeds/<id>.ts` exporting a `LandmarkSeed[]` (copy `gulshan.ts`). Run the script once to get the candidates TSV, then write name regexes against the real OSM names.
3. **Generate:** run `npm run prepare-area -- <id>` and review the printed verification list.
4. **Use it:** pass the area id to `<RiderApp areaId="<id>" />`. An area switcher in the UI is not built yet; that is out of scope for now.

Nothing else hard-codes an area.

---

## Project structure

```
scripts/
  prepare-area.ts             Overpass → compact area files
  landmark-seeds/gulshan.ts   landmark definitions for Gulshan
  copy-vendor.mjs             copies the MapLibre worker into public/vendor
public/data/gulshan/          generated data (roads, buildings, landmarks, meta)
src/
  config/areas.ts             all area-specific settings
  app/                        layout, page, 404, global styles
  components/
    RiderApp.tsx              app state: data, places, route, preferences
    MapView.tsx               3D MapLibre map (lazy-loaded)
    FallbackMap.tsx           SVG simple map
    ControlPanel.tsx          search fields, vehicle, language, summary
    DirectionsList.tsx        turn-by-turn list
    StatusBanner.tsx          offline / errors / notices
  lib/
    routing.ts                graph, snapping, A*, directions
    areaData.ts               data loading + caching
    i18n.ts                   EN/BN strings, Bangla digits, instruction text
    capabilities.ts           WebGL / reduced motion / low-end detection
  ride/                       lazy-loaded ride mode
    RideMode.tsx              HUD, controls, minimap, joystick, pop-ups
    RideScene.tsx             three.js scene, bike + rider models, cameras, riding physics
    rideWorld.ts              local projection, buildings, speed profile, lighting presets
    streetDetail.ts           footpaths, markings, walls, trees, lamps, poles + wires, signs
    textures.ts               canvas-drawn facades, Bangla signs, glow sprite
    rideSound.ts              synthesized engine + Dhaka street soundscape
```

## Licenses

| Item | License |
|---|---|
| Map data | © OpenStreetMap contributors, [ODbL 1.0](https://opendatacommons.org/licenses/odbl/) |
| Base map tiles | [OpenFreeMap](https://openfreemap.org/) (OpenMapTiles schema, © OpenMapTiles, data © OSM) |
| MapLibre GL JS | BSD-3-Clause |
| ngraph.graph / ngraph.path | BSD-3-Clause / MIT |
| three.js / @react-three/fiber | MIT / MIT |
| Fonts | Geist (OFL 1.1), Noto Sans Bengali (OFL 1.1) |
| Icons | Original inline SVG and Unicode symbols |
| 3D models (motorcycle, bicycle, riders, landmark markers) | Original: built procedurally in code (`src/ride/RideScene.tsx`) from basic shapes; no external model files. Same license as this project |
| Textures (facades, signs) | Original: drawn at runtime on canvas (`src/ride/textures.ts`); sign text is generic, no real brands |
| Sounds | Original: synthesized at runtime with Web Audio; no audio files bundled |

## Known limitations

- **Data quality:** routes are only as good as OSM. About 77% of buildings have no height in OSM and use the 9 m default. Some one-way tags may be outdated.
- **Area edges:** roads that cross the bounding box are cut off, so routes can't leave and come back into the area.
- **Turns and timing:** there are no turn restrictions (`restriction=*` relations), traffic signals or live traffic. Times assume a constant average speed.
- **Roundabouts:** these get generic turn instructions, not "take the 2nd exit".
- **Base-map labels:** these come from OpenFreeMap and don't switch language. Some Bangla labels may not render if the tile font has no Bengali glyphs. Our own UI and markers are fully bilingual.
- **Bangla names:** some landmark names are manual translations (flagged above). Roads without a Bangla name in OSM show their English name, except numbered roads ("Road 71" → "সড়ক ৭১").
- **Offline:** the app needs the network for its first load. There is no service worker yet.
- **Ride mode:**
  - The ground is flat (no elevation), with no water, traffic or pedestrians yet.
  - Trees, walls, poles and signs are placed procedurally along roads, not from real survey data.
  - Speed humps are placed by a fixed rule on straight stretches, not at their real locations.
  - Free mode has no collisions; you can ride through buildings.
  - Only buildings near the route are drawn.
  - The camera can pass through tall buildings on tight corners.
- **Performance:** 30+ fps on mid-range Android is the target, but it has only been tested with desktop emulation so far (see Ride mode).
# banglarider
