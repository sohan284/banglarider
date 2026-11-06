/**
 * English / Bangla strings and formatting. Bangla mode also uses Bangla digits.
 */

import type { Maneuver, Step, Vehicle } from "@/lib/routing";

export type Lang = "en" | "bn";

const en = {
  appName: "Bangla Rider",
  tagline: "Pick two places in {area} and see the route.",
  start: "Start",
  end: "Destination",
  searchStart: "Search start, or tap the map",
  searchEnd: "Search destination, or tap the map",
  noMatches: "No matching places",
  pickOnMapStart: "Tap the map to choose the start",
  pickOnMapEnd: "Tap the map to choose the destination",
  pinned: "Pinned point",
  near: "Near {road}",
  swap: "Swap start and destination",
  clear: "Clear",
  clearField: "Clear {field}",
  vehicle: "Vehicle",
  motorcycle: "Motorcycle",
  bicycle: "Bicycle",
  distance: "Distance",
  time: "Est. time",
  directions: "Directions",
  routeSummary: "{distance} by {vehicle}, about {time}.",
  routeFromTo: "From {from} to {to}.",
  stepsCount: "{n} steps",
  showSteps: "Show directions",
  hideSteps: "Hide directions",
  language: "বাংলা",
  languageLabel: "Switch to Bangla",
  viewMap: "3D map",
  viewSimple: "Simple map",
  viewLabel: "Map style",
  simpleReason_webgl: "Your browser can't show the 3D map, so a simple map is shown.",
  simpleReason_reducedMotion: "Simple map shown because reduced motion is on.",
  simpleReason_lowEnd: "Simple map shown to save battery on this device.",
  loading: "Loading map data…",
  loadError: "Couldn't load the map data.",
  offline: "You're offline. Some map tiles may be missing.",
  tilesFailed: "Base map unavailable; showing roads only.",
  retry: "Try again",
  dismiss: "Dismiss",
  errTooFar_start: "The start is too far from a road. Choose a point closer to a street.",
  errTooFar_end: "The destination is too far from a road. Choose a point closer to a street.",
  errNoRoute: "No route found between these points for a {vehicle}. Try a point on a nearby road.",
  errSamePoint: "Start and destination are the same place.",
  outsideArea: "That point is outside {area}. Only {area} is covered for now.",
  attribution: "© OpenStreetMap contributors",
  zoomIn: "Zoom in",
  zoomOut: "Zoom out",
  resetView: "Fit area",
  mapLabel: "Map of {area}. Use the search boxes to choose places.",
  landmarks: "Places",
  panelToggleOpen: "Expand panel",
  panelToggleClose: "Collapse panel",
  unnamedRoad: "an unnamed road",
  km: "km",
  m: "m",
  min: "min",
  hr: "h",
  ride: "Ride",
  rideLabel: "Ride this route in 3D",
  share: "Share",
  shareTitle: "Route from {from} to {to}",
  linkCopied: "Link copied",
  loading3d: "Loading the 3D world…",
  building3d: "Building {n} buildings…",
  rideError: "The 3D ride couldn't start on this device. Use the map and directions instead.",
  exitRide: "Exit ride",
  play: "Ride",
  pause: "Pause",
  speed: "Speed",
  kmh: "km/h",
  freeMode: "Free ride",
  backToRoute: "Back to route",
  freeHint: "Free ride: W A S D or arrow keys to ride, F to return to the route.",
  freeHintTouch: "Free ride: use the joystick to ride.",
  joystick: "Joystick",
  soundOn: "Sound on",
  soundOff: "Sound off",
  timeOfDay: "Time of day",
  tod_auto: "Auto",
  tod_morning: "Morning",
  tod_noon: "Noon",
  tod_evening: "Evening",
  tod_night: "Night",
  remaining: "{distance} left · {time}",
  progress: "Route progress",
  arrived: "You've arrived at {place}",
  rideAgain: "Ride again",
  backToMap: "Back to map",
  passing: "Passing",
  keysHelp: "Space: pause · F: free ride · B: bike · V: camera · Q: quality · M: sound · T: time of day · Esc: exit",
  minimap: "Minimap",
  viewChase: "Camera: behind the rider",
  viewHelmet: "Camera: helmet view",
  quality: "Graphics quality",
  qualityHigh: "High",
  qualityLow: "Low",
  chooseBike: "Choose your bike",
  topSpeed: "Top speed",
  bikeColor: "Colour",
  close: "Close",
};

type Strings = typeof en;

const bn: Strings = {
  appName: "বাংলা রাইডার",
  tagline: "{area}-এ দুটি স্থান বেছে নিন, রাস্তা দেখুন।",
  start: "শুরু",
  end: "গন্তব্য",
  searchStart: "শুরুর স্থান খুঁজুন, বা মানচিত্রে ট্যাপ করুন",
  searchEnd: "গন্তব্য খুঁজুন, বা মানচিত্রে ট্যাপ করুন",
  noMatches: "কোনো স্থান মেলেনি",
  pickOnMapStart: "শুরুর স্থান বেছে নিতে মানচিত্রে ট্যাপ করুন",
  pickOnMapEnd: "গন্তব্য বেছে নিতে মানচিত্রে ট্যাপ করুন",
  pinned: "চিহ্নিত স্থান",
  near: "{road}-এর কাছে",
  swap: "শুরু ও গন্তব্য অদলবদল করুন",
  clear: "মুছুন",
  clearField: "{field} মুছুন",
  vehicle: "বাহন",
  motorcycle: "মোটরসাইকেল",
  bicycle: "সাইকেল",
  distance: "দূরত্ব",
  time: "আনুমানিক সময়",
  directions: "দিকনির্দেশনা",
  routeSummary: "{vehicle}-এ {distance}, প্রায় {time}।",
  routeFromTo: "{from} থেকে {to}।",
  stepsCount: "{n}টি ধাপ",
  showSteps: "দিকনির্দেশনা দেখুন",
  hideSteps: "দিকনির্দেশনা লুকান",
  language: "English",
  languageLabel: "Switch to English",
  viewMap: "৩ডি মানচিত্র",
  viewSimple: "সাধারণ মানচিত্র",
  viewLabel: "মানচিত্রের ধরন",
  simpleReason_webgl: "আপনার ব্রাউজারে ৩ডি মানচিত্র চলে না, তাই সাধারণ মানচিত্র দেখানো হচ্ছে।",
  simpleReason_reducedMotion: "রিডিউসড মোশন চালু থাকায় সাধারণ মানচিত্র দেখানো হচ্ছে।",
  simpleReason_lowEnd: "এই ডিভাইসে ব্যাটারি বাঁচাতে সাধারণ মানচিত্র দেখানো হচ্ছে।",
  loading: "মানচিত্রের তথ্য লোড হচ্ছে…",
  loadError: "মানচিত্রের তথ্য লোড করা যায়নি।",
  offline: "আপনি অফলাইনে আছেন। মানচিত্রের কিছু অংশ নাও দেখা যেতে পারে।",
  tilesFailed: "মূল মানচিত্র পাওয়া যাচ্ছে না; শুধু রাস্তা দেখানো হচ্ছে।",
  retry: "আবার চেষ্টা করুন",
  dismiss: "বন্ধ করুন",
  errTooFar_start: "শুরুর স্থানটি রাস্তা থেকে অনেক দূরে। রাস্তার কাছাকাছি একটি স্থান বেছে নিন।",
  errTooFar_end: "গন্তব্যটি রাস্তা থেকে অনেক দূরে। রাস্তার কাছাকাছি একটি স্থান বেছে নিন।",
  errNoRoute: "এই দুই স্থানের মধ্যে {vehicle}-এর কোনো পথ পাওয়া যায়নি। কাছের কোনো রাস্তায় স্থান বেছে দেখুন।",
  errSamePoint: "শুরু ও গন্তব্য একই স্থান।",
  outsideArea: "এই স্থানটি {area}-এর বাইরে। আপাতত শুধু {area} দেখানো হয়।",
  attribution: "© OpenStreetMap অবদানকারীরা",
  zoomIn: "বড় করুন",
  zoomOut: "ছোট করুন",
  resetView: "পুরো এলাকা",
  mapLabel: "{area}-এর মানচিত্র। স্থান বেছে নিতে খোঁজার ঘর ব্যবহার করুন।",
  landmarks: "স্থানসমূহ",
  panelToggleOpen: "প্যানেল বড় করুন",
  panelToggleClose: "প্যানেল ছোট করুন",
  unnamedRoad: "নামহীন রাস্তা",
  km: "কিমি",
  m: "মিটার",
  min: "মিনিট",
  hr: "ঘণ্টা",
  ride: "রাইড",
  rideLabel: "এই পথে ৩ডি-তে রাইড করুন",
  share: "শেয়ার",
  shareTitle: "{from} থেকে {to} পর্যন্ত পথ",
  linkCopied: "লিংক কপি হয়েছে",
  loading3d: "৩ডি জগৎ লোড হচ্ছে…",
  building3d: "{n}টি ভবন তৈরি হচ্ছে…",
  rideError: "এই ডিভাইসে ৩ডি রাইড চালু করা যায়নি। মানচিত্র ও দিকনির্দেশনা ব্যবহার করুন।",
  exitRide: "রাইড বন্ধ করুন",
  play: "চালান",
  pause: "থামান",
  speed: "গতি",
  kmh: "কিমি/ঘণ্টা",
  freeMode: "মুক্ত রাইড",
  backToRoute: "পথে ফিরুন",
  freeHint: "মুক্ত রাইড: চালাতে W A S D বা তীর চিহ্ন, পথে ফিরতে F।",
  freeHintTouch: "মুক্ত রাইড: জয়স্টিক দিয়ে চালান।",
  joystick: "জয়স্টিক",
  soundOn: "শব্দ চালু",
  soundOff: "শব্দ বন্ধ",
  timeOfDay: "দিনের সময়",
  tod_auto: "স্বয়ংক্রিয়",
  tod_morning: "সকাল",
  tod_noon: "দুপুর",
  tod_evening: "সন্ধ্যা",
  tod_night: "রাত",
  remaining: "বাকি {distance} · {time}",
  progress: "পথের অগ্রগতি",
  arrived: "আপনি {place}-এ পৌঁছেছেন",
  rideAgain: "আবার রাইড",
  backToMap: "মানচিত্রে ফিরুন",
  passing: "পাশ দিয়ে যাচ্ছেন",
  keysHelp: "স্পেস: থামান · F: মুক্ত রাইড · B: বাইক · V: ক্যামেরা · Q: মান · M: শব্দ · T: দিনের সময় · Esc: বন্ধ",
  minimap: "ছোট মানচিত্র",
  viewChase: "ক্যামেরা: চালকের পেছনে",
  viewHelmet: "ক্যামেরা: হেলমেট ভিউ",
  quality: "গ্রাফিক্সের মান",
  qualityHigh: "উচ্চ",
  qualityLow: "সাধারণ",
  chooseBike: "আপনার বাইক বেছে নিন",
  topSpeed: "সর্বোচ্চ গতি",
  bikeColor: "রং",
  close: "বন্ধ করুন",
};

export const STRINGS: Record<Lang, Strings> = { en, bn };
export type StringKey = keyof Strings;

/** t("near", lang, { road: "Road 11" }) */
export function t(key: StringKey, lang: Lang, vars?: Record<string, string | number>): string {
  let s = STRINGS[lang][key];
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

const BN_DIGITS = "০১২৩৪৫৬৭৮৯";
export function digits(s: string | number, lang: Lang): string {
  const str = String(s);
  return lang === "bn" ? str.replace(/[0-9]/g, (d) => BN_DIGITS[Number(d)]) : str;
}

export function formatDistance(m: number, lang: Lang): string {
  if (m < 950) return `${digits(Math.max(10, Math.round(m / 10) * 10), lang)} ${t("m", lang)}`;
  return `${digits((m / 1000).toFixed(m < 9950 ? 1 : 0), lang)} ${t("km", lang)}`;
}

export function formatDuration(seconds: number, lang: Lang): string {
  const mins = Math.max(1, Math.round(seconds / 60));
  if (mins < 60) return `${digits(mins, lang)} ${t("min", lang)}`;
  const h = Math.floor(mins / 60);
  const rest = mins % 60;
  return `${digits(h, lang)} ${t("hr", lang)}${rest ? ` ${digits(rest, lang)} ${t("min", lang)}` : ""}`;
}

export function vehicleName(v: Vehicle, lang: Lang): string {
  return t(v, lang);
}

/** Road display name, preferring the Bangla name in Bangla mode. */
export function roadName(road: { en?: string; bn?: string }, lang: Lang): string | undefined {
  if (lang === "en") return road.en ?? road.bn;
  if (road.bn) return digits(road.bn, "bn");
  if (!road.en) return undefined;
  // Gulshan's numbered streets ("Road 71") have a standard Bangla form ("সড়ক ৭১").
  const numbered = road.en.match(/^Road\s*(?:No\.?\s*)?(\d+[A-Za-z]?)$/i);
  if (numbered) return `সড়ক ${digits(numbered[1], "bn")}`;
  // Other English names are left as written rather than half-translated.
  return road.en;
}

const COMPASS_EN = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];
const COMPASS_BN = ["উত্তর", "উত্তর-পূর্ব", "পূর্ব", "দক্ষিণ-পূর্ব", "দক্ষিণ", "দক্ষিণ-পশ্চিম", "পশ্চিম", "উত্তর-পশ্চিম"];
function compass(deg: number, lang: Lang): string {
  const i = Math.round(deg / 45) % 8;
  return (lang === "bn" ? COMPASS_BN : COMPASS_EN)[i];
}

const TURN_EN: Record<Exclude<Maneuver, "depart" | "arrive" | "continue">, string> = {
  "slight-left": "Bear left",
  "slight-right": "Bear right",
  left: "Turn left",
  right: "Turn right",
  "sharp-left": "Turn sharp left",
  "sharp-right": "Turn sharp right",
  uturn: "Make a U-turn",
};
const TURN_BN: Record<keyof typeof TURN_EN, string> = {
  "slight-left": "হালকা বামে যান",
  "slight-right": "হালকা ডানে যান",
  left: "বামে মোড় নিন",
  right: "ডানে মোড় নিন",
  "sharp-left": "তীক্ষ্ণ বামে মোড় নিন",
  "sharp-right": "তীক্ষ্ণ ডানে মোড় নিন",
  uturn: "ইউ-টার্ন নিন",
};

/** One human-readable instruction for a route step. */
export function stepText(step: Step, lang: Lang): string {
  const road = roadName(step.road, lang);
  if (lang === "bn") {
    const r = road ?? t("unnamedRoad", "bn");
    switch (step.maneuver) {
      case "depart":
        return `${r} ধরে ${compass(step.bearingAfter, "bn")} দিকে যাত্রা শুরু করুন`;
      case "arrive":
        return "আপনি গন্তব্যে পৌঁছেছেন";
      case "continue":
        return road ? `সোজা ${r}-এ চলুন` : "সোজা চলুন";
      default:
        return road ? `${TURN_BN[step.maneuver]}, ${r}-এ উঠুন` : TURN_BN[step.maneuver];
    }
  }
  const r = road ?? t("unnamedRoad", "en");
  switch (step.maneuver) {
    case "depart":
      return `Head ${compass(step.bearingAfter, "en")} on ${r}`;
    case "arrive":
      return "Arrive at your destination";
    case "continue":
      return road ? `Continue onto ${r}` : "Continue straight";
    default:
      return road ? `${TURN_EN[step.maneuver]} onto ${r}` : TURN_EN[step.maneuver];
  }
}
