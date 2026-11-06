/**
 * Textures drawn at runtime on <canvas> (no image files):
 *  - building facade atlas (4 bays × 4 floors) + matching "lit windows" map
 *  - shop-sign / billboard atlas with Bangla text
 *  - soft round glow sprite for lamps and the sun
 * Browser-only.
 */

import * as THREE from "three";
import { SIGN_COLS, SIGN_ROWS } from "@/ride/streetDetail";

function rand(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function canvas(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return [c, c.getContext("2d")!] as const;
}

function toTexture(c: HTMLCanvasElement, repeat: boolean, anisotropy: number): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = anisotropy;
  t.needsUpdate = true;
  return t;
}

/**
 * Facade atlas. White-ish base (multiplied by each building's vertex colour),
 * window grilles, balconies with hanging laundry, AC units, floor slabs and grime.
 */
export function makeFacadeTextures(anisotropy: number): { map: THREE.CanvasTexture; lit: THREE.CanvasTexture } {
  const S = 128; // one bay × one floor
  const N = 4;
  const [c, g] = canvas(S * N, S * N);
  const [e, ge] = canvas(S * N, S * N);
  const r = rand(7);
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, S * N, S * N);
  ge.fillStyle = "#000000";
  ge.fillRect(0, 0, S * N, S * N);

  // Grime / rain streaks
  for (let i = 0; i < 260; i++) {
    g.fillStyle = `rgba(90,80,70,${0.03 + r() * 0.05})`;
    const x = r() * S * N;
    g.fillRect(x, r() * S * N, 1 + r() * 3, 10 + r() * 50);
  }

  const laundry = ["#d94f4f", "#3d7cc9", "#f2c14e", "#57a773", "#e98ac5", "#ffffff", "#f08a3c"];
  const lights = ["#ffd58a", "#fff0cf", "#e9f3ff", "#ffc477"];

  for (let by = 0; by < N; by++) {
    for (let bx = 0; bx < N; bx++) {
      const x0 = bx * S, y0 = by * S;
      const kind = r();
      // Floor slab line at the bottom of each floor
      g.fillStyle = "rgba(120,110,100,0.45)";
      g.fillRect(x0, y0 + S - 9, S, 9);
      g.fillStyle = "rgba(255,255,255,0.5)";
      g.fillRect(x0, y0 + S - 11, S, 2);

      if (kind < 0.62) {
        // Window with frame + Dhaka-style grille
        const wx = x0 + 26, wy = y0 + 24, ww = S - 52, wh = S - 58;
        g.fillStyle = "#c9c4bc";
        g.fillRect(wx - 5, wy - 5, ww + 10, wh + 10);
        g.fillStyle = r() < 0.5 ? "#3f4b56" : "#4e5a63";
        g.fillRect(wx, wy, ww, wh);
        // reflection
        g.fillStyle = "rgba(255,255,255,0.12)";
        g.beginPath();
        g.moveTo(wx, wy + wh);
        g.lineTo(wx + ww * 0.4, wy);
        g.lineTo(wx + ww * 0.55, wy);
        g.lineTo(wx + ww * 0.15, wy + wh);
        g.fill();
        g.strokeStyle = "#2b2b2b";
        g.lineWidth = 2;
        for (let k = 1; k < 7; k++) {
          g.beginPath();
          g.moveTo(wx + (ww * k) / 7, wy);
          g.lineTo(wx + (ww * k) / 7, wy + wh);
          g.stroke();
        }
        g.beginPath();
        g.moveTo(wx, wy + wh / 2);
        g.lineTo(wx + ww, wy + wh / 2);
        g.stroke();
        // sunshade (chajja) above window
        g.fillStyle = "rgba(110,100,90,0.55)";
        g.fillRect(wx - 10, wy - 12, ww + 20, 6);
        // AC unit sometimes
        if (r() < 0.3) {
          g.fillStyle = "#e6e6e2";
          g.fillRect(wx + ww - 30, wy + wh + 8, 34, 18);
          g.fillStyle = "#9a9a96";
          for (let k = 0; k < 4; k++) g.fillRect(wx + ww - 27 + k * 8, wy + wh + 11, 5, 12);
        }
        if (r() < 0.42) {
          ge.fillStyle = lights[Math.floor(r() * lights.length)];
          ge.fillRect(wx, wy, ww, wh);
          ge.fillStyle = "rgba(0,0,0,0.55)";
          for (let k = 1; k < 7; k++) ge.fillRect(wx + (ww * k) / 7 - 1, wy, 2, wh);
        }
      } else if (kind < 0.85) {
        // Balcony: recessed opening, railing, laundry
        const wx = x0 + 12, wy = y0 + 14, ww = S - 24, wh = S - 32;
        g.fillStyle = "#5d636b";
        g.fillRect(wx, wy, ww, wh);
        g.fillStyle = "#7a8088";
        g.fillRect(wx + 18, wy + 8, ww - 36, wh - 30); // door
        // laundry line
        g.strokeStyle = "#333";
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(wx + 4, wy + 18);
        g.lineTo(wx + ww - 4, wy + 18);
        g.stroke();
        const items = 2 + Math.floor(r() * 4);
        for (let k = 0; k < items; k++) {
          g.fillStyle = laundry[Math.floor(r() * laundry.length)];
          g.fillRect(wx + 8 + k * ((ww - 20) / items), wy + 18, 12 + r() * 8, 20 + r() * 18);
        }
        // railing
        g.fillStyle = "#d8d3c8";
        g.fillRect(wx - 4, wy + wh - 34, ww + 8, 34);
        g.fillStyle = "rgba(0,0,0,0.25)";
        g.fillRect(wx - 4, wy + wh - 34, ww + 8, 3);
        if (r() < 0.35) {
          ge.fillStyle = lights[Math.floor(r() * lights.length)];
          ge.fillRect(wx + 18, wy + 8, ww - 36, wh - 30 - 34 + 30);
        }
      } else {
        // Blank wall panel with a small vent window
        g.fillStyle = "#4b555e";
        g.fillRect(x0 + S / 2 - 12, y0 + 30, 24, 18);
        g.fillStyle = "rgba(0,0,0,0.06)";
        g.fillRect(x0 + 8, y0 + 8, S - 16, S - 26);
      }
    }
  }
  return { map: toTexture(c, true, anisotropy), lit: toTexture(e, true, anisotropy) };
}

const SHOP_TEXTS: { bn: string; en: string; bg: string; fg: string }[] = [
  { bn: "চা ও নাস্তা", en: "TEA & SNACKS", bg: "#c62828", fg: "#ffffff" },
  { bn: "ফার্মেসি", en: "PHARMACY", bg: "#1b7f4a", fg: "#ffffff" },
  { bn: "মোবাইল সার্ভিসিং", en: "MOBILE SERVICING", bg: "#1f4fa0", fg: "#ffffff" },
  { bn: "সুপার শপ", en: "SUPER SHOP", bg: "#f2b705", fg: "#1a1a1a" },
  { bn: "টেইলার্স", en: "TAILORS", bg: "#6a1b9a", fg: "#ffffff" },
  { bn: "ফটোকপি ও প্রিন্ট", en: "PHOTOCOPY & PRINT", bg: "#00838f", fg: "#ffffff" },
  { bn: "রেস্টুরেন্ট", en: "RESTAURANT", bg: "#e65100", fg: "#ffffff" },
  { bn: "ফলের দোকান", en: "FRUIT SHOP", bg: "#2e7d32", fg: "#fff59d" },
];
const BILLBOARD_TEXTS: { bn: string; en: string; bg: string; fg: string }[] = [
  { bn: "গুলশানে স্বাগতম", en: "WELCOME TO GULSHAN", bg: "#006a4e", fg: "#ffffff" },
  { bn: "হেলমেট পরুন, নিরাপদ থাকুন", en: "WEAR A HELMET", bg: "#f4f1e8", fg: "#c8102e" },
  { bn: "পরিচ্ছন্ন ঢাকা, সুন্দর ঢাকা", en: "CLEAN DHAKA", bg: "#0d47a1", fg: "#ffffff" },
  { bn: "সাবধানে চালান", en: "RIDE CAREFULLY", bg: "#f2b705", fg: "#1a1a1a" },
];

/** Reads the Bangla web font that next/font loaded (falls back to system fonts). */
async function banglaFont(): Promise<string> {
  const fam = getComputedStyle(document.documentElement).getPropertyValue("--font-bengali").trim() || "sans-serif";
  try {
    await document.fonts.load(`700 60px ${fam}`, "বাংলা");
  } catch {
    /* use whatever is available */
  }
  return fam;
}

export async function makeSignTexture(anisotropy: number): Promise<THREE.CanvasTexture> {
  const CW = 512, CH = 170;
  const [c, g] = canvas(CW * SIGN_COLS, CH * SIGN_ROWS);
  const fam = await banglaFont();
  const draw = (cell: number, t: (typeof SHOP_TEXTS)[number], billboard: boolean) => {
    const x = (cell % SIGN_COLS) * CW;
    const y = Math.floor(cell / SIGN_COLS) * CH;
    g.fillStyle = t.bg;
    g.fillRect(x, y, CW, CH);
    if (billboard) {
      g.strokeStyle = "#e9e5da";
      g.lineWidth = 10;
      g.strokeRect(x + 5, y + 5, CW - 10, CH - 10);
    } else {
      // weathering
      g.fillStyle = "rgba(0,0,0,0.12)";
      g.fillRect(x, y + CH - 14, CW, 14);
    }
    g.fillStyle = t.fg;
    g.textAlign = "center";
    g.textBaseline = "middle";
    let size = 70;
    g.font = `700 ${size}px ${fam}`;
    while (g.measureText(t.bn).width > CW - 50 && size > 30) {
      size -= 4;
      g.font = `700 ${size}px ${fam}`;
    }
    g.fillText(t.bn, x + CW / 2, y + CH * 0.42);
    g.font = `600 24px ${fam}`;
    g.globalAlpha = 0.85;
    g.fillText(t.en, x + CW / 2, y + CH * 0.8);
    g.globalAlpha = 1;
  };
  SHOP_TEXTS.forEach((t, i) => draw(i, t, false));
  BILLBOARD_TEXTS.forEach((t, i) => draw(SHOP_TEXTS.length + i, t, true));
  const tex = toTexture(c, false, anisotropy);
  return tex;
}

export function makeGlowTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(64, 64);
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.25, "rgba(255,255,255,0.6)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
