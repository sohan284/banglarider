/**
 * Ride soundscape, synthesized live with Web Audio (no audio files needed):
 *  - motorcycle engine with fake gears and throttle load, or bicycle freewheel ticks
 *  - wind / tyre noise rising with speed
 *  - Dhaka street ambience: low traffic rumble, random rickshaw bells,
 *    CNG / car / bus horns panned around the listener
 *  - market chatter that swells near markets
 *
 * Optional real recordings (e.g. CC0 Dhaka ambience, an azan) can be plugged
 * in via AreaConfig.audio; they are only fetched when configured.
 */

import type { Vehicle } from "@/lib/routing";
import type { EngineSound } from "@/ride/bikes";
import type { TrafficKind } from "@/ride/traffic";

/** Engine character per bike: idle pitch, rise per km/h, gear band (km/h, 0 = CVT), filter brightness, putt depth. */
const ENGINE: Record<Exclude<EngineSound, "bicycle">, { idle: number; perKmh: number; gear: number; bright: number; putt: number; vol: number }> = {
  commuter: { idle: 32, perKmh: 0.45, gear: 18, bright: 9, putt: 0.4, vol: 1 },
  sport: { idle: 55, perKmh: 0.55, gear: 34, bright: 16, putt: 0.2, vol: 1.15 },
  scooter: { idle: 48, perKmh: 1.1, gear: 0, bright: 7, putt: 0.25, vol: 0.85 },
  cruiser: { idle: 22, perKmh: 0.3, gear: 26, bright: 6, putt: 0.65, vol: 1.2 },
  hyper: { idle: 72, perKmh: 0.62, gear: 48, bright: 24, putt: 0.12, vol: 1.2 },
  superbike: { idle: 64, perKmh: 0.55, gear: 52, bright: 20, putt: 0.15, vol: 1.25 },
  naked: { idle: 44, perKmh: 0.5, gear: 40, bright: 14, putt: 0.35, vol: 1.15 },
  adventure: { idle: 36, perKmh: 0.45, gear: 36, bright: 10, putt: 0.5, vol: 1.1 },
};

export interface SoundContext {
  /** Speed in m/s. */
  v: number;
  /** Acceleration in m/s² (positive = throttle). */
  a: number;
  /** Metres to the nearest market, or Infinity. */
  marketDist: number;
  /** Metres to the nearest mosque, or Infinity. */
  mosqueDist: number;
}

export class RideSound {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private noiseBuf!: AudioBuffer;
  private engine: { osc1: OscillatorNode; osc2: OscillatorNode; filter: BiquadFilterNode; gain: GainNode; am: GainNode; amOsc: OscillatorNode } | null = null;
  private wind!: { filter: BiquadFilterNode; gain: GainNode };
  private rumble!: GainNode;
  private chatter!: GainNode;
  private hornTimer: ReturnType<typeof setTimeout> | null = null;
  private tickPhase = 0;
  private lastUpdate = 0;
  private recordings: { ambience?: HTMLAudioElement; azan?: HTMLAudioElement } = {};
  private azanPlayed = false;
  private running = false;

  constructor(
    private vehicle: Vehicle,
    private files: { ambience?: string; azan?: string } = {},
    private profile: EngineSound = vehicle === "motorcycle" ? "commuter" : "bicycle",
  ) {}

  start() {
    this.running = true;
    if (this.ctx) {
      void this.ctx.resume();
      void this.recordings.ambience?.play().catch(() => {});
      this.scheduleHorn();
      return;
    }
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.7;
    const comp = ctx.createDynamicsCompressor();
    this.master.connect(comp).connect(ctx.destination);

    const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;

    // Wind / tyres
    const wf = ctx.createBiquadFilter();
    wf.type = "lowpass";
    wf.frequency.value = 500;
    const wg = ctx.createGain();
    wg.gain.value = 0;
    this.loopNoise().connect(wf).connect(wg).connect(this.master);
    this.wind = { filter: wf, gain: wg };

    // City rumble: brown-ish noise, always on, quiet
    const rf = ctx.createBiquadFilter();
    rf.type = "lowpass";
    rf.frequency.value = 160;
    this.rumble = ctx.createGain();
    this.rumble.gain.value = this.files.ambience ? 0.02 : 0.09;
    this.loopNoise().connect(rf).connect(this.rumble).connect(this.master);

    // Market chatter: noise through vowel-like formants, fluttering at syllable rate
    this.chatter = ctx.createGain();
    this.chatter.gain.value = 0;
    const flutter = ctx.createGain();
    flutter.gain.value = 0.5;
    const chatterSrc = this.loopNoise();
    for (const [f, q] of [
      [550, 6],
      [1250, 8],
      [2400, 10],
    ]) {
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = f;
      bp.Q.value = q;
      chatterSrc.connect(bp).connect(flutter);
    }
    for (const rate of [3.3, 4.9, 6.7]) {
      const lfo = ctx.createOscillator();
      lfo.frequency.value = rate;
      const lg = ctx.createGain();
      lg.gain.value = 0.18;
      lfo.connect(lg).connect(flutter.gain);
      lfo.start();
    }
    flutter.connect(this.chatter).connect(this.master);

    if (this.vehicle === "motorcycle" && this.profile !== "bicycle") {
      const osc1 = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      osc1.type = "sawtooth";
      osc2.type = "square";
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = 420;
      filter.Q.value = 3;
      const am = ctx.createGain(); // "putt-putt" firing pulses
      am.gain.value = 0.6;
      const amOsc = ctx.createOscillator();
      amOsc.type = "square";
      const amDepth = ctx.createGain();
      amDepth.gain.value = ENGINE[this.profile].putt;
      amOsc.connect(amDepth).connect(am.gain);
      const gain = ctx.createGain();
      gain.gain.value = 0;
      osc1.connect(filter);
      osc2.connect(filter);
      filter.connect(am).connect(gain).connect(this.master);
      osc1.start();
      osc2.start();
      amOsc.start();
      this.engine = { osc1, osc2, filter, gain, am, amOsc };
    }

    if (this.files.ambience) {
      const a = new Audio(this.files.ambience);
      a.loop = true;
      a.volume = 0.35;
      void a.play().catch(() => {});
      this.recordings.ambience = a;
    }
    if (this.files.azan) this.recordings.azan = new Audio(this.files.azan);

    this.scheduleHorn();
  }

  private loopNoise(): AudioBufferSourceNode {
    const src = this.ctx!.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    src.loopStart = Math.random();
    src.start(0, Math.random() * 1.5);
    return src;
  }

  update(sc: SoundContext) {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running") return;
    const now = ctx.currentTime;
    const dt = Math.min(0.25, this.lastUpdate ? now - this.lastUpdate : 0.1);
    this.lastUpdate = now;
    const kmh = Math.abs(sc.v) * 3.6;

    if (this.engine && this.profile !== "bicycle") {
      const e = ENGINE[this.profile];
      const load = Math.max(0, Math.min(1, sc.a / 3));
      // Fake gearbox: rpm climbs within each gear band, then drops (scooters are CVT: smooth rise).
      const gearPos = e.gear ? (kmh % e.gear) / e.gear : 0;
      const f = e.idle + gearPos * e.idle * 1.3 + Math.min(kmh, 300) * e.perKmh;
      this.engine.osc1.frequency.setTargetAtTime(f, now, 0.07);
      this.engine.osc2.frequency.setTargetAtTime(f * 0.5, now, 0.07);
      this.engine.amOsc.frequency.setTargetAtTime(f / 2, now, 0.07);
      this.engine.filter.frequency.setTargetAtTime(260 + kmh * e.bright + load * 700, now, 0.08);
      this.engine.gain.gain.setTargetAtTime((0.045 + Math.min(kmh, 100) * 0.0008 + load * 0.045) * e.vol, now, 0.08);
    } else if (sc.v > 1 && sc.a <= 0.05) {
      // Bicycle coasting: freewheel pawl ticks, rate follows wheel speed.
      const rate = sc.v * 4.5; // ticks per second
      this.tickPhase += rate * dt;
      while (this.tickPhase >= 1) {
        this.tickPhase -= 1;
        this.click(now + Math.random() * dt, 0.05);
      }
    }

    this.wind.filter.frequency.setTargetAtTime(280 + kmh * 24, now, 0.2);
    this.wind.gain.gain.setTargetAtTime(Math.min(0.14, kmh * 0.0034), now, 0.2);
    const market = sc.marketDist < 160 ? 1 - sc.marketDist / 160 : 0;
    this.chatter.gain.setTargetAtTime(market * 0.22, now, 0.6);

    if (this.recordings.azan && !this.azanPlayed && sc.mosqueDist < 120) {
      this.azanPlayed = true;
      this.recordings.azan.volume = 0.6;
      void this.recordings.azan.play().catch(() => {});
    }
  }

  private click(at: number, gain: number) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 3500;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, at);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.012);
    src.connect(hp).connect(g).connect(this.master);
    src.start(at, Math.random());
    src.stop(at + 0.02);
  }

  /** A horn or bell somewhere around the listener every few seconds. */
  private scheduleHorn() {
    if (this.hornTimer) clearTimeout(this.hornTimer);
    const delay = 2200 + Math.random() * 6000;
    this.hornTimer = setTimeout(() => {
      if (!this.running || !this.ctx || this.ctx.state !== "running") return;
      const r = Math.random();
      if (r < 0.38) this.rickshawBell();
      else if (r < 0.62) this.horn([590, 470], [0.11, 0.11], 0.13, "square"); // CNG "pip-pip"
      else if (r < 0.82) this.horn([420, 520], [0.32], 0, "square"); // car
      else this.horn([185, 233], [0.7], 0, "sawtooth"); // bus
      this.scheduleHorn();
    }, delay);
  }

  private panner(value?: number): StereoPannerNode {
    const p = this.ctx!.createStereoPanner();
    p.pan.value = value ?? Math.random() * 1.8 - 0.9;
    return p;
  }

  private horn(freqs: number[], beeps: number[], gap: number, type: OscillatorType, panTo?: number, volume?: number) {
    const ctx = this.ctx!;
    const t0 = ctx.currentTime + 0.02;
    const vol = volume ?? 0.025 + Math.random() * 0.06; // distance
    const out = ctx.createGain();
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 1400 + vol * 8000;
    out.connect(lp).connect(this.panner(panTo)).connect(this.master);
    let t = t0;
    for (const len of beeps) {
      for (const f of freqs) {
        const o = ctx.createOscillator();
        o.type = type;
        o.frequency.value = f * (0.97 + Math.random() * 0.06);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(vol, t + 0.015);
        g.gain.setValueAtTime(vol, t + len - 0.03);
        g.gain.linearRampToValueAtTime(0, t + len);
        o.connect(g).connect(out);
        o.start(t);
        o.stop(t + len + 0.02);
      }
      t += len + gap;
    }
  }

  /** Crash: low thud, a few metallic clangs and a scraping slide that fades with speed. */
  crash(impactKmh: number) {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running" || !this.running) return;
    const t = ctx.currentTime + 0.01;
    const hard = Math.min(1, impactKmh / 60);
    // thud
    const thud = ctx.createOscillator();
    thud.type = "sine";
    thud.frequency.setValueAtTime(110, t);
    thud.frequency.exponentialRampToValueAtTime(40, t + 0.25);
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(0.35 * (0.4 + hard), t);
    tg.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    thud.connect(tg).connect(this.master);
    thud.start(t);
    thud.stop(t + 0.4);
    // clangs
    for (let i = 0; i < 4; i++) {
      const at = t + 0.03 + i * (0.06 + Math.random() * 0.08);
      const o = ctx.createOscillator();
      o.type = "triangle";
      o.frequency.value = 900 + Math.random() * 2600;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.06 + hard * 0.06, at);
      g.gain.exponentialRampToValueAtTime(0.0005, at + 0.25);
      o.connect(g).connect(this.master);
      o.start(at);
      o.stop(at + 0.3);
    }
    // scrape
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 1800;
    bp.Q.value = 0.8;
    const sg = ctx.createGain();
    const dur = 0.4 + hard * 1.4;
    sg.gain.setValueAtTime(0.14 * hard + 0.03, t + 0.05);
    sg.gain.exponentialRampToValueAtTime(0.0005, t + dur);
    src.connect(bp).connect(sg).connect(this.master);
    src.start(t + 0.05, Math.random());
    src.stop(t + dur + 0.05);
  }

  /** A honk from a real nearby vehicle (pan -1..1, distance in metres). */
  honk(kind: TrafficKind, pan: number, dist: number) {
    if (!this.ctx || this.ctx.state !== "running" || !this.running) return;
    const vol = Math.max(0.02, Math.min(0.16, 3 / Math.max(6, dist)));
    if (kind === "rickshaw") this.rickshawBell(pan, vol);
    else if (kind === "cng") this.horn([590, 470], [0.11, 0.11], 0.13, "square", pan, vol);
    else if (kind === "bus") this.horn([185, 233], [0.8], 0, "sawtooth", pan, vol);
    else if (kind === "motorbike") this.horn([620], [0.12, 0.12], 0.08, "square", pan, vol);
    else this.horn([420, 520], [0.3, 0.15], 0.1, "square", pan, vol);
  }

  /** Two quick metallic "tring" strikes (FM synthesis). */
  private rickshawBell(panTo?: number, volume?: number) {
    const ctx = this.ctx!;
    const vol = volume ?? 0.04 + Math.random() * 0.07;
    const pan = this.panner(panTo);
    pan.connect(this.master);
    const strikes = Math.random() < 0.5 ? 2 : 3;
    for (let k = 0; k < strikes; k++) {
      const t = ctx.currentTime + 0.02 + k * 0.16;
      const car = ctx.createOscillator();
      const mod = ctx.createOscillator();
      const modGain = ctx.createGain();
      car.frequency.value = 2350;
      mod.frequency.value = 2350 * 1.41;
      modGain.gain.setValueAtTime(1800, t);
      modGain.gain.exponentialRampToValueAtTime(40, t + 0.4);
      mod.connect(modGain).connect(car.frequency);
      const g = ctx.createGain();
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
      car.connect(g).connect(pan);
      car.start(t);
      mod.start(t);
      car.stop(t + 0.5);
      mod.stop(t + 0.5);
    }
  }

  stop() {
    this.running = false;
    if (this.hornTimer) clearTimeout(this.hornTimer);
    this.recordings.ambience?.pause();
    void this.ctx?.suspend();
  }

  dispose() {
    this.stop();
    this.recordings.azan?.pause();
    void this.ctx?.close();
    this.ctx = null;
  }
}
