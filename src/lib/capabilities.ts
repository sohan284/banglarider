/**
 * Decides whether this device should get the 3D map or the simple (SVG) map.
 * Browser-only; call from effects / event handlers.
 */

export type MapMode = "diorama" | "map" | "simple";
export type SimpleReason = "webgl" | "reducedMotion" | "lowEnd";

export interface Capabilities {
  webgl: boolean;
  reducedMotion: boolean;
  lowEnd: boolean;
  /** What we'd pick automatically, and why if it's the simple map. */
  recommended: MapMode;
  reason: SimpleReason | null;
}

function hasWebGL(): boolean {
  try {
    const canvas = document.createElement("canvas");
    const gl = (canvas.getContext("webgl2") || canvas.getContext("webgl")) as WebGLRenderingContext | null;
    if (!gl) return false;
    // Software renderers technically work but are far too slow for 3D buildings.
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "";
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return !/swiftshader|llvmpipe|software/i.test(renderer);
  } catch {
    return false;
  }
}

export function detectCapabilities(): Capabilities {
  const webgl = hasWebGL();
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  const nav = navigator as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } };
  const lowEnd =
    (nav.deviceMemory !== undefined && nav.deviceMemory <= 2) ||
    (nav.hardwareConcurrency !== undefined && nav.hardwareConcurrency <= 2) ||
    nav.connection?.saveData === true;

  const reason: SimpleReason | null = !webgl ? "webgl" : reducedMotion ? "reducedMotion" : lowEnd ? "lowEnd" : null;
  return { webgl, reducedMotion, lowEnd, recommended: reason ? "simple" : "diorama", reason };
}

const VIEW_KEY = "br:view";

/** The user's manual choice, if any (overrides the automatic one). */
export function storedMapMode(): MapMode | null {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    return v === "diorama" || v === "map" || v === "simple" ? v : null;
  } catch {
    return null;
  }
}

export function storeMapMode(mode: MapMode) {
  try {
    localStorage.setItem(VIEW_KEY, mode);
  } catch {
    /* storage unavailable: choice lasts for this visit only */
  }
}
