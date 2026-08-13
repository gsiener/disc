/**
 * tools/test-audio.ts — structural verification of src/audio/*.
 *
 *   node tools/test-audio.ts             run everything
 *   node tools/test-audio.ts --verbose   also dump the graph topology
 *
 * Audio cannot be screenshotted, so this file is the equivalent of the capture
 * rig: it builds the entire graph against a fake `AudioContext`, fires every
 * event the simulation can emit, advances time, and then asserts on what the
 * code actually did — which nodes exist, what they are connected to, and every
 * value ever written to an AudioParam.
 *
 * The fake is deliberately *stricter* than a browser in the two places the spec
 * throws and everybody forgets:
 *
 *   - a non-finite value or a negative time is a TypeError/RangeError;
 *   - `exponentialRampToValueAtTime(0)` is a RangeError.
 *
 * That inversion is the point. Rather than inspecting curves after the fact and
 * hoping the assertions cover the bad case, any code path that would have thrown
 * in Chrome throws here too, and shows up as a failed test with a stack. The
 * "nothing throws with no user gesture" requirement is then not a claim, it is
 * an executed path.
 *
 * Node has no WebAudio and never will. It also strips types rather than
 * compiling them, so nothing in src/audio/ may use a TypeScript parameter
 * property — that is enforced implicitly by this file importing those modules.
 */

import { EventBus, QUALITY_PRESETS, Rng, type QualityTier } from '../src/core/Ctx.ts';
import { AudioGraph, TIERS, TOUCHLINE, touchlineGain } from '../src/audio/Graph.ts';
import { AudioSystem } from '../src/audio/Audio.ts';
import { CrowdLayer } from '../src/audio/Crowd.ts';

const argv = process.argv.slice(2);
const VERBOSE = argv.includes('--verbose');

/* =========================================================== the fake context */

let NODE_ID = 0;

interface Edge { from: FakeNode; to: FakeNode | FakeParam; }

interface ParamEvent {
  kind: string;
  value: number;
  time: number;
  tau?: number;
}

class FakeParam {
  name: string;
  owner: string;
  value: number;
  defaultValue: number;
  events: ParamEvent[] = [];
  /** Nodes modulating this param. */
  inputs: FakeNode[] = [];

  constructor(owner: string, name: string, value: number) {
    this.owner = owner;
    this.name = name;
    this.value = value;
    this.defaultValue = value;
  }

  get label(): string { return `${this.owner}.${this.name}`; }

  private v(x: number, kind: string): number {
    if (typeof x !== 'number' || !Number.isFinite(x)) {
      throw new TypeError(`${this.label}: ${kind} value must be finite, got ${x}`);
    }
    return x;
  }

  private t(x: number, kind: string): number {
    if (typeof x !== 'number' || !Number.isFinite(x) || x < 0) {
      throw new RangeError(`${this.label}: ${kind} time must be finite and >= 0, got ${x}`);
    }
    return x;
  }

  setValueAtTime(value: number, time: number): FakeParam {
    this.events.push({ kind: 'set', value: this.v(value, 'setValueAtTime'), time: this.t(time, 'setValueAtTime') });
    this.value = value;
    return this;
  }

  linearRampToValueAtTime(value: number, time: number): FakeParam {
    this.events.push({ kind: 'lin', value: this.v(value, 'linearRamp'), time: this.t(time, 'linearRamp') });
    this.value = value;
    return this;
  }

  exponentialRampToValueAtTime(value: number, time: number): FakeParam {
    const v = this.v(value, 'exponentialRamp');
    if (v <= 0) throw new RangeError(`${this.label}: exponentialRampToValueAtTime target must be > 0, got ${v}`);
    this.events.push({ kind: 'exp', value: v, time: this.t(time, 'exponentialRamp') });
    this.value = v;
    return this;
  }

  setTargetAtTime(value: number, time: number, tau: number): FakeParam {
    const v = this.v(value, 'setTargetAtTime');
    const t = this.t(time, 'setTargetAtTime');
    if (typeof tau !== 'number' || !Number.isFinite(tau) || tau < 0) {
      throw new RangeError(`${this.label}: setTargetAtTime timeConstant must be finite and >= 0, got ${tau}`);
    }
    this.events.push({ kind: 'target', value: v, time: t, tau });
    this.value = v;
    return this;
  }

  cancelScheduledValues(time: number): FakeParam {
    this.t(time, 'cancelScheduledValues');
    return this;
  }

  /** Last value the code asked this param to reach. */
  get target(): number { return this.events.length ? this.events[this.events.length - 1].value : this.value; }
}

class FakeNode {
  ctx: FakeContext;
  kind: string;
  id: number;
  out: Array<FakeNode | FakeParam> = [];
  disconnected = false;
  params = new Map<string, FakeParam>();

  constructor(ctx: FakeContext, kind: string) {
    this.ctx = ctx;
    this.kind = kind;
    this.id = ++NODE_ID;
    ctx.nodes.push(this);
  }

  get label(): string { return `${this.kind}#${this.id}`; }

  protected param(name: string, value: number): FakeParam {
    const p = new FakeParam(this.label, name, value);
    this.params.set(name, p);
    this.ctx.params.push(p);
    return p;
  }

  connect(dest: FakeNode | FakeParam): FakeNode | FakeParam {
    if (!dest) throw new TypeError(`${this.label}.connect(undefined)`);
    if (dest instanceof FakeParam) dest.inputs.push(this);
    this.out.push(dest);
    this.ctx.edges.push({ from: this, to: dest });
    return dest;
  }

  disconnect(): void {
    this.disconnected = true;
    this.out.length = 0;
  }
}

class FakeSource extends FakeNode {
  started = -1;
  stopped = -1;
  startCount = 0;

  start(when = 0, offset = 0): void {
    if (this.startCount > 0) throw new Error(`${this.label}: start() called twice`);
    if (!Number.isFinite(when) || when < 0) throw new RangeError(`${this.label}: start(${when})`);
    if (!Number.isFinite(offset) || offset < 0) throw new RangeError(`${this.label}: start offset ${offset}`);
    this.startCount++;
    this.started = when;
    this.ctx.starts++;
  }

  stop(when = 0): void {
    if (this.startCount === 0) throw new Error(`${this.label}: stop() before start()`);
    if (!Number.isFinite(when) || when < 0) throw new RangeError(`${this.label}: stop(${when})`);
    this.stopped = when;
  }
}

class FakeBufferSource extends FakeSource {
  buffer: FakeBuffer | null = null;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  playbackRate: FakeParam;
  detune: FakeParam;

  constructor(ctx: FakeContext) {
    super(ctx, 'BufferSource');
    this.playbackRate = this.param('playbackRate', 1);
    this.detune = this.param('detune', 0);
  }

  start(when = 0, offset = 0): void {
    if (!this.buffer) throw new Error(`${this.label}: start() with no buffer`);
    if (this.buffer.duration > 0 && offset > this.buffer.duration) {
      throw new RangeError(`${this.label}: offset ${offset} past buffer end ${this.buffer.duration}`);
    }
    super.start(when, offset);
  }
}

class FakeOscillator extends FakeSource {
  type = 'sine';
  frequency: FakeParam;
  detune: FakeParam;

  constructor(ctx: FakeContext) {
    super(ctx, 'Oscillator');
    this.frequency = this.param('frequency', 440);
    this.detune = this.param('detune', 0);
  }
}

class FakeGain extends FakeNode {
  gain: FakeParam;
  constructor(ctx: FakeContext) { super(ctx, 'Gain'); this.gain = this.param('gain', 1); }
}

const BIQUAD_TYPES = new Set([
  'lowpass', 'highpass', 'bandpass', 'lowshelf', 'highshelf', 'peaking', 'notch', 'allpass',
]);

class FakeBiquad extends FakeNode {
  private _type = 'lowpass';
  frequency: FakeParam;
  Q: FakeParam;
  gain: FakeParam;
  detune: FakeParam;

  constructor(ctx: FakeContext) {
    super(ctx, 'Biquad');
    this.frequency = this.param('frequency', 350);
    this.Q = this.param('Q', 1);
    this.gain = this.param('gain', 0);
    this.detune = this.param('detune', 0);
  }

  set type(v: string) {
    if (!BIQUAD_TYPES.has(v)) throw new TypeError(`${this.label}: bad filter type "${v}"`);
    this._type = v;
  }

  get type(): string { return this._type; }
}

class FakeCompressor extends FakeNode {
  threshold: FakeParam;
  knee: FakeParam;
  ratio: FakeParam;
  attack: FakeParam;
  release: FakeParam;
  constructor(ctx: FakeContext) {
    super(ctx, 'Compressor');
    this.threshold = this.param('threshold', -24);
    this.knee = this.param('knee', 30);
    this.ratio = this.param('ratio', 12);
    this.attack = this.param('attack', 0.003);
    this.release = this.param('release', 0.25);
  }
}

class FakeConvolver extends FakeNode {
  normalize = true;
  buffer: FakeBuffer | null = null;
  constructor(ctx: FakeContext) { super(ctx, 'Convolver'); }
}

class FakeStereoPanner extends FakeNode {
  pan: FakeParam;
  constructor(ctx: FakeContext) { super(ctx, 'StereoPanner'); this.pan = this.param('pan', 0); }
}

const PANNING_MODELS = new Set(['equalpower', 'HRTF']);
const DISTANCE_MODELS = new Set(['linear', 'inverse', 'exponential']);

class FakePanner extends FakeNode {
  private _panningModel = 'equalpower';
  private _distanceModel = 'inverse';
  private _refDistance = 1;
  private _rolloffFactor = 1;
  private _maxDistance = 10000;
  positionX: FakeParam;
  positionY: FakeParam;
  positionZ: FakeParam;

  constructor(ctx: FakeContext) {
    super(ctx, 'Panner');
    this.positionX = this.param('positionX', 0);
    this.positionY = this.param('positionY', 0);
    this.positionZ = this.param('positionZ', 0);
  }

  set panningModel(v: string) {
    if (!PANNING_MODELS.has(v)) throw new TypeError(`${this.label}: bad panningModel "${v}"`);
    this._panningModel = v;
  }
  get panningModel(): string { return this._panningModel; }

  set distanceModel(v: string) {
    if (!DISTANCE_MODELS.has(v)) throw new TypeError(`${this.label}: bad distanceModel "${v}"`);
    this._distanceModel = v;
  }
  get distanceModel(): string { return this._distanceModel; }

  set refDistance(v: number) {
    if (!Number.isFinite(v) || v < 0) throw new RangeError(`${this.label}: refDistance ${v}`);
    this._refDistance = v;
  }
  get refDistance(): number { return this._refDistance; }

  set rolloffFactor(v: number) {
    if (!Number.isFinite(v) || v < 0) throw new RangeError(`${this.label}: rolloffFactor ${v}`);
    this._rolloffFactor = v;
  }
  get rolloffFactor(): number { return this._rolloffFactor; }

  set maxDistance(v: number) {
    if (!Number.isFinite(v) || v <= 0) throw new RangeError(`${this.label}: maxDistance ${v}`);
    this._maxDistance = v;
  }
  get maxDistance(): number { return this._maxDistance; }
}

class FakeBuffer {
  numberOfChannels: number;
  length: number;
  sampleRate: number;
  private data: Float32Array[];

  constructor(channels: number, length: number, sampleRate: number) {
    if (!Number.isInteger(channels) || channels < 1) throw new RangeError(`createBuffer channels ${channels}`);
    if (!Number.isInteger(length) || length < 1) throw new RangeError(`createBuffer length ${length}`);
    if (!Number.isFinite(sampleRate) || sampleRate < 3000) throw new RangeError(`createBuffer sampleRate ${sampleRate}`);
    this.numberOfChannels = channels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.data = [];
    for (let i = 0; i < channels; i++) this.data.push(new Float32Array(length));
  }

  get duration(): number { return this.length / this.sampleRate; }
  getChannelData(i: number): Float32Array { return this.data[i]; }
}

class FakeListener {
  positionX: FakeParam;
  positionY: FakeParam;
  positionZ: FakeParam;
  forwardX: FakeParam;
  forwardY: FakeParam;
  forwardZ: FakeParam;
  upX: FakeParam;
  upY: FakeParam;
  upZ: FakeParam;

  constructor(ctx: FakeContext) {
    const p = (n: string, v: number): FakeParam => {
      const fp = new FakeParam('Listener', n, v);
      ctx.params.push(fp);
      return fp;
    };
    this.positionX = p('positionX', 0);
    this.positionY = p('positionY', 0);
    this.positionZ = p('positionZ', 0);
    this.forwardX = p('forwardX', 0);
    this.forwardY = p('forwardY', 0);
    this.forwardZ = p('forwardZ', -1);
    this.upX = p('upX', 0);
    this.upY = p('upY', 1);
    this.upZ = p('upZ', 0);
  }
}

class FakeContext {
  sampleRate = 48000;
  currentTime = 0;
  state: 'suspended' | 'running' | 'closed' = 'suspended';
  destination: FakeNode;
  listener: FakeListener;

  nodes: FakeNode[] = [];
  params: FakeParam[] = [];
  edges: Edge[] = [];
  starts = 0;
  resumes = 0;

  constructor() {
    this.destination = new FakeNode(this, 'Destination');
    this.listener = new FakeListener(this);
  }

  createGain(): FakeGain { return new FakeGain(this); }
  createBiquadFilter(): FakeBiquad { return new FakeBiquad(this); }
  createDynamicsCompressor(): FakeCompressor { return new FakeCompressor(this); }
  createConvolver(): FakeConvolver { return new FakeConvolver(this); }
  createPanner(): FakePanner { return new FakePanner(this); }
  createStereoPanner(): FakeStereoPanner { return new FakeStereoPanner(this); }
  createBufferSource(): FakeBufferSource { return new FakeBufferSource(this); }
  createOscillator(): FakeOscillator { return new FakeOscillator(this); }
  createBuffer(c: number, n: number, sr: number): FakeBuffer { return new FakeBuffer(c, n, sr); }

  resume(): Promise<void> { this.resumes++; this.state = 'running'; return Promise.resolve(); }
  suspend(): Promise<void> { this.state = 'suspended'; return Promise.resolve(); }
  close(): Promise<void> { this.state = 'closed'; return Promise.resolve(); }

  /** Advance the audio clock the way a real device would. */
  advance(seconds: number): void { this.currentTime += seconds; }

  /** Which nodes can the destination actually hear? */
  reachable(): Set<FakeNode> {
    const rev = new Map<FakeNode, FakeNode[]>();
    for (const e of this.edges) {
      const to = e.to instanceof FakeParam ? null : e.to;
      const target = to ?? null;
      if (target) {
        const arr = rev.get(target) ?? [];
        arr.push(e.from);
        rev.set(target, arr);
      }
    }
    const seen = new Set<FakeNode>();
    const stack: FakeNode[] = [this.destination];
    while (stack.length) {
      const n = stack.pop()!;
      if (seen.has(n)) continue;
      seen.add(n);
      for (const src of rev.get(n) ?? []) stack.push(src);
    }
    return seen;
  }
}

/* ==================================================================== harness */

let pass = 0;
let fail = 0;
const failures: string[] = [];

function ok(cond: boolean, label: string, detail = ''): void {
  if (cond) { pass++; return; }
  fail++;
  failures.push(label + (detail ? `  (${detail})` : ''));
}

function noThrow(label: string, fn: () => void): void {
  try { fn(); pass++; } catch (e) {
    fail++;
    failures.push(`${label}  (threw: ${(e as Error).message})`);
  }
}

function section(name: string): void {
  if (VERBOSE) console.log(`\n\x1b[1m— ${name}\x1b[0m`);
}

/* ------------------------------------------------------------- fake engine ctx */

function makeCtx(opts: { capture?: boolean; tier?: QualityTier } = {}): any {
  const q = QUALITY_PRESETS[opts.tier ?? 'high'];
  return {
    renderer: null,
    scene: null,
    camera: {
      // Identity-ish view matrix parked on the sideline looking at the middle.
      matrixWorld: { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -26, 6, 22, 1] },
    },
    composer: null,
    time: 0, dt: 1 / 60, rawDt: 1 / 60, timeScale: 1, frame: 0,
    width: 1920, height: 1080, dpr: 1,
    quality: q,
    events: new EventBus(),
    rand: new Rng(20260729),
    sys: Object.create(null),
    debug: false,
    capture: opts.capture ?? false,
  };
}

function makePlayers(n = 14): any[] {
  const rng = new Rng(0xb0d1e5);
  const out: any[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: i,
      team: (i < n / 2 ? 0 : 1) as 0 | 1,
      pos: { x: rng.range(-25, 25), y: 0.95, z: rng.range(-40, 40) },
      vel: { x: 0, y: 0, z: 0 },
      state: 'run',
      stamina: 100 - i * 6,
      cutEntrySpeed: 6,
      attr: { height: 1.72 + i * 0.01 },
    });
  }
  return out;
}

function makeDisc(): any {
  return {
    mode: 'flight',
    holderId: -1,
    wind: { x: 1.2, y: 0, z: -0.8 },
    state: {
      pos: { x: 2, y: 1.7, z: -6 },
      airspeed: 18,
      spin: -42,
      atRest: false,
    },
  };
}

/** Fire every event the simulation can emit, with plausible payloads. */
function fireAll(ctx: any): void {
  const E = ctx.events;
  E.emit('state:changed', { from: 'PRE_PULL', to: 'PULL_IN_FLIGHT', clock: 3, point: 1, possession: 0, score: [0, 0] });
  E.emit('disc:released', { pos: { x: 0, y: 1.4, z: 44 }, vel: { x: 2, y: 6, z: -24 }, spin: 40, throwType: 'pull', playerId: 3, team: 1 });
  E.emit('disc:caught', { playerId: 8, pos: { x: 1, y: 1.2, z: 6 }, team: 0, outcome: 'pull' });
  E.emit('state:changed', { from: 'PULL_IN_FLIGHT', to: 'LIVE_POSSESSION', clock: 8, point: 1, possession: 0, score: [0, 0] });
  for (let i = 1; i <= 10; i++) E.emit('stall:tick', { count: i, max: 10, playerId: 8, team: 0, markerId: 2 });
  E.emit('disc:released', { pos: { x: 1, y: 1.3, z: 6 }, vel: { x: 12, y: 1, z: -18 }, spin: 46, throwType: 'backhand', playerId: 8, team: 0, stall: 4 });
  E.emit('disc:caught', { playerId: 5, pos: { x: 8, y: 1.6, z: -14 }, team: 0, outcome: 'completion' });
  E.emit('disc:caught', { playerId: 11, pos: { x: -3, y: 1.9, z: -22 }, team: 1, outcome: 'interception' });
  E.emit('disc:grounded', { pos: { x: 4, y: 0.02, z: -19 }, reason: 'drop' });
  E.emit('disc:grounded', { pos: { x: -2, y: 0.02, z: 12 }, reason: 'block' });
  E.emit('disc:grounded', { pos: { x: 0, y: 0.02, z: 30 }, reason: 'throwaway' });
  E.emit('turnover', { reason: 'drop', from: 0, to: 1, playerId: 5, pos: { x: 4, y: 0, z: -19 }, point: 1, score: [0, 0] });
  E.emit('turnover', { reason: 'block', from: 1, to: 0, playerId: 2, pos: { x: -2, y: 0, z: 12 }, point: 1, score: [0, 0] });
  E.emit('turnover', { reason: 'stall-out', from: 0, to: 1, playerId: 8, pos: { x: 0, y: 0, z: 4 }, point: 1, score: [0, 0] });
  E.emit('player:footstep', { id: 4, pos: { x: 3, y: 0.02, z: -5 }, foot: 'L', speed: 7.4, hard: true });
  E.emit('player:footstep', { id: 4, pos: { x: 3.6, y: 0.02, z: -5.8 }, foot: 'R', speed: 5.1, hard: false });
  E.emit('player:land', { id: 6, pos: { x: 9, y: 0.1, z: -12 }, impact: 4.2, layout: false });
  E.emit('player:land', { id: 6, pos: { x: 9, y: 0.1, z: -12 }, impact: 7.8, layout: true });
  E.emit('player:contact', { a: 4, b: 9, impact: 3.1, foulOn: 4, called: false });
  E.emit('score', { team: 0, playerId: 5, assistId: 8, score: [1, 0], scoreline: 'A 1 - 0 B', point: 1 });
  E.emit('state:changed', { from: 'DISC_IN_FLIGHT', to: 'POINT_SCORED', clock: 60, point: 1, possession: 0, score: [1, 0] });
  E.emit('half', { half: 1, score: [1, 0] });
  E.emit('game:over', { score: [15, 11], winner: 0, teamName: 'A' });
  E.emit('shot:apply', { name: 'broadcast', shot: { tableau: 'flow' } });
}

/** The same events with values that would poison a naive parameter write. */
function fireHostile(ctx: any): void {
  const E = ctx.events;
  const NAN = Number.NaN;
  E.emit('disc:released', { pos: { x: NAN, y: NAN, z: NAN }, vel: { x: Infinity, y: NAN, z: 0 }, spin: NAN, throwType: null, playerId: NAN });
  E.emit('disc:caught', { playerId: NAN, pos: null, outcome: undefined });
  E.emit('disc:caught', {});
  E.emit('disc:caught', undefined);
  E.emit('disc:grounded', { pos: { x: -Infinity, y: NAN, z: 1e30 }, reason: 42 });
  E.emit('disc:grounded', null);
  E.emit('player:footstep', { id: 'x', pos: undefined, foot: 7, speed: NAN, hard: 'yes' });
  E.emit('player:footstep', { pos: { x: NAN, y: 0, z: NAN }, speed: -Infinity, hard: true, foot: 'L' });
  E.emit('player:land', { pos: { x: 0, y: NAN, z: 0 }, impact: Infinity, layout: true });
  E.emit('player:contact', { a: NAN, b: NAN, impact: NAN });
  E.emit('stall:tick', { count: NAN, max: 0 });
  E.emit('turnover', {});
  E.emit('turnover', null);
  E.emit('score', null);
  E.emit('state:changed', { to: null });
  E.emit('state:changed', { to: 'NOT_A_PHASE' });
}

function stepSystem(sys: AudioSystem, ctx: any, ac: FakeContext | null, frames: number, dt = 1 / 60): void {
  for (let i = 0; i < frames; i++) {
    ctx.frame++;
    ctx.time += dt;
    if (ac) ac.advance(dt);
    sys.lateUpdate(dt, ctx);
  }
}

/* ================================================================ 1. the bakes */

section('bakes');
{
  const ac = new FakeContext();
  const g = new AudioGraph(ac as unknown as AudioContext, 'high', new Rng(1234));
  const beds = g.beds;

  const stats = (b: any, c = 0): { peak: number; rms: number; finite: boolean } => {
    const d: Float32Array = b.getChannelData(c);
    let peak = 0; let sum = 0; let finite = true;
    for (let i = 0; i < d.length; i++) {
      const v = d[i];
      if (!Number.isFinite(v)) { finite = false; break; }
      const a = Math.abs(v);
      if (a > peak) peak = a;
      sum += v * v;
    }
    return { peak, rms: Math.sqrt(sum / d.length), finite };
  };

  const w = stats(beds.white);
  ok(beds.white.numberOfChannels === 1, 'white bed is mono');
  ok(w.finite, 'white bed is finite');
  ok(w.peak > 0.5 && w.peak <= 1.0001, 'white bed peaks near full scale', `peak ${w.peak.toFixed(3)}`);

  const p0 = stats(beds.pink, 0);
  const p1 = stats(beds.pink, 1);
  ok(beds.pink.numberOfChannels === 2, 'pink bed is stereo');
  ok(p0.finite && p1.finite, 'pink bed is finite');
  ok(p0.rms > 0.02, 'pink bed has energy', `rms ${p0.rms.toFixed(4)}`);
  {
    // Decorrelated channels: correlation near zero is what gives wind width.
    const a = beds.pink.getChannelData(0);
    const b = beds.pink.getChannelData(1);
    let dot = 0;
    for (let i = 0; i < 20000; i++) dot += a[i] * b[i];
    const corr = dot / (20000 * p0.rms * p1.rms);
    ok(Math.abs(corr) < 0.25, 'pink channels are decorrelated', `corr ${corr.toFixed(3)}`);
  }

  const m = stats(beds.murmur);
  ok(beds.murmur.numberOfChannels === 2, 'murmur bed is stereo');
  ok(m.finite, 'murmur bed is finite');
  ok(m.peak > 0.5 && m.peak <= 1.0001, 'murmur bed is normalised', `peak ${m.peak.toFixed(3)}`);
  ok(Math.abs(beds.murmur.duration - TIERS.high.bedSeconds) < 0.01, 'murmur honours the tier loop length');
  {
    // The syllable rate is the whole point of the murmur: its envelope must
    // modulate, not sit flat like filtered noise.
    const d = beds.murmur.getChannelData(0);
    const win = Math.round(0.02 * ac.sampleRate);
    const env: number[] = [];
    for (let i = 0; i + win < d.length && env.length < 300; i += win) {
      let s = 0;
      for (let j = 0; j < win; j++) s += d[i + j] * d[i + j];
      env.push(Math.sqrt(s / win));
    }
    const mean = env.reduce((a, b) => a + b, 0) / env.length;
    let varr = 0;
    for (const e of env) varr += (e - mean) * (e - mean);
    const cv = Math.sqrt(varr / env.length) / mean;
    ok(cv > 0.08, 'murmur has a syllabic envelope, not flat noise', `cv ${cv.toFixed(3)}`);
  }

  const ap = stats(beds.applause);
  ok(ap.finite && ap.peak > 0.5, 'applause bed is finite and normalised');

  ok(beds.impulse !== null, 'high tier bakes an impulse response');
  if (beds.impulse) {
    const d = beds.impulse.getChannelData(0);
    const n = d.length;
    const energy = (a: number, b: number): number => {
      let s = 0;
      for (let i = a; i < b; i++) s += d[i] * d[i];
      return s / (b - a);
    };
    const head = energy(0, Math.floor(n * 0.1));
    const tail = energy(Math.floor(n * 0.85), n);
    ok(head > tail * 20, 'impulse response decays', `head ${head.toExponential(2)} tail ${tail.toExponential(2)}`);
    ok(beds.impulse.duration > 1.2 && beds.impulse.duration < 2.5, 'IR length matches the bowl RT60', `${beds.impulse.duration.toFixed(2)}s`);
  }
}

/* -------------------------------------------------------------- determinism */
{
  const bake = (seed: number): Float32Array => {
    const ac = new FakeContext();
    const g = new AudioGraph(ac as unknown as AudioContext, 'medium', new Rng(seed));
    return g.beds.murmur.getChannelData(0).slice(0, 40000) as Float32Array;
  };
  const a = bake(777);
  const b = bake(777);
  const c = bake(778);
  let sameAB = true;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { sameAB = false; break; }
  let sameAC = true;
  for (let i = 0; i < a.length; i++) if (a[i] !== c[i]) { sameAC = false; break; }
  ok(sameAB, 'same seed bakes byte-identical PCM');
  ok(!sameAC, 'a different seed bakes different PCM');
}

/* ============================================================== 2. topology */

section('topology');
{
  const ac = new FakeContext();
  const g = new AudioGraph(ac as unknown as AudioContext, 'high', new Rng(9));

  const goesTo = (from: FakeNode, to: FakeNode): boolean => from.out.includes(to);
  const L = g.limiter as unknown as FakeNode;
  const M = g.master as unknown as FakeNode;

  ok(goesTo(L, ac.destination), 'limiter feeds the destination');
  ok(goesTo(M, L), 'master feeds the limiter');
  ok(goesTo(g.crowd as unknown as FakeNode, M), 'crowd stem feeds master');
  ok(goesTo(g.field as unknown as FakeNode, M), 'field stem feeds master');
  ok(goesTo(g.amb as unknown as FakeNode, M), 'ambience stem feeds master');
  ok(goesTo(g.verbOut as unknown as FakeNode, M), 'reverb return feeds master');
  ok(g.convolver !== null, 'high tier builds a convolver');
  ok((g.convolver as unknown as FakeConvolver | null)?.buffer != null, 'convolver is loaded with the baked IR');

  const reach = ac.reachable();
  ok(reach.has(g.verbIn as unknown as FakeNode), 'the reverb send reaches the destination');

  // Build every layer on top and re-check reachability: not one persistent node
  // may be left dangling, because a dangling node is a silent feature.
  const rng = new Rng(4242);
  const crowd = new CrowdLayer(g, rng.fork(1));
  const beforeEvents = ac.nodes.length;
  const reach2 = ac.reachable();
  const orphans = ac.nodes.filter((n) => !reach2.has(n) && n.out.length === 0 && n.kind !== 'Destination');
  ok(orphans.length === 0, 'no persistent node is orphaned', orphans.map((o) => o.label).join(', '));
  ok(beforeEvents > 12, 'the crowd builds a real graph', `${beforeEvents} nodes`);
  crowd.dispose();
}

/* ------------------------------------------------------------- tier budgets */
{
  const build = (tier: 'low' | 'medium' | 'high' | 'ultra'): { ac: FakeContext; g: AudioGraph } => {
    const ac = new FakeContext();
    return { ac, g: new AudioGraph(ac as unknown as AudioContext, tier, new Rng(5)) };
  };
  const lo = build('low');
  const hi = build('ultra');
  ok(lo.g.convolver === null, 'low tier skips convolution reverb');
  ok(hi.g.convolver !== null, 'ultra tier has convolution reverb');
  ok(lo.g.budget.voices < hi.g.budget.voices, 'low tier caps voices harder');
  ok(lo.g.budget.cull < hi.g.budget.cull, 'low tier culls distant sources sooner');
  ok(!lo.g.budget.hrtf && hi.g.budget.hrtf, 'HRTF only at the top tiers');

  const nLo = new CrowdLayer(lo.g, new Rng(1));
  const nHi = new CrowdLayer(hi.g, new Rng(1));
  const panners = (c: FakeContext): number => c.nodes.filter((n) => n.kind === 'BufferSource').length;
  ok(panners(lo.ac) < panners(hi.ac), 'fewer crowd sections at low tier',
    `${panners(lo.ac)} vs ${panners(hi.ac)}`);
  nLo.dispose(); nHi.dispose();
}

/* ================================================= 3. autoplay / capture rig */

section('autoplay policy');
{
  // The capture rig: no gesture, no context, ever.
  const ctx = makeCtx({ capture: true, tier: 'high' });
  ctx.sys.game = { gs: { phase: 'LIVE_POSSESSION' }, discRuntime: makeDisc() };
  ctx.sys.disc = { rt: ctx.sys.game.discRuntime };
  ctx.sys.locomotion = { players: makePlayers() };

  let built = 0;
  const sys = new AudioSystem({ createContext: () => { built++; return new FakeContext() as unknown as AudioContext; } });

  noThrow('capture: init() does not throw', () => sys.init(ctx));
  ok(built === 0, 'capture: no AudioContext is constructed');
  noThrow('capture: every event fires without throwing', () => fireAll(ctx));
  noThrow('capture: hostile payloads do not throw', () => fireHostile(ctx));
  noThrow('capture: 300 frames of lateUpdate do not throw', () => stepSystem(sys, ctx, null, 300));
  ok(built === 0, 'capture: still no AudioContext after events and frames');
  ok(sys.available === false && sys.running === false, 'capture: system reports itself inert');
  ok(sys.graph === null, 'capture: no graph exists');
  noThrow('capture: dispose() on an inert system does not throw', () => sys.dispose());
}

{
  // Live page, gesture has not happened yet.
  const ctx = makeCtx({ tier: 'high' });
  ctx.sys.locomotion = { players: makePlayers() };
  let built = 0;
  const sys = new AudioSystem({ createContext: () => { built++; return new FakeContext() as unknown as AudioContext; } });
  sys.init(ctx);
  ok(built === 0, 'no gesture: no AudioContext is constructed');
  noThrow('no gesture: events are inert but safe', () => { fireAll(ctx); fireHostile(ctx); });
  noThrow('no gesture: frames are inert but safe', () => stepSystem(sys, ctx, null, 120));
  ok(sys.running === false, 'no gesture: not running');

  // …and the gesture arrives.
  ok(sys.start() === true, 'start() builds the graph on demand');
  ok(built === 1, 'exactly one AudioContext is constructed');
  ok(sys.running && sys.available, 'system reports itself live');
  ok(sys.start() === true, 'start() is idempotent');
  ok(built === 1, 'start() does not build a second context');
}

/* ================================================== 4. live system behaviour */

section('live system');

function liveSystem(tier: QualityTier = 'high'): { sys: AudioSystem; ctx: any; ac: FakeContext } {
  const ctx = makeCtx({ tier });
  const disc = makeDisc();
  ctx.sys.game = { gs: { phase: 'LIVE_POSSESSION' }, discRuntime: disc };
  ctx.sys.disc = { rt: disc };
  ctx.sys.locomotion = { players: makePlayers() };
  let ac: FakeContext | null = null;
  const sys = new AudioSystem({
    autostart: true,
    createContext: () => { ac = new FakeContext(); return ac as unknown as AudioContext; },
  });
  sys.init(ctx);
  return { sys, ctx, ac: ac! };
}

{
  const { sys, ctx, ac } = liveSystem();
  ok(sys.running, 'autostart builds the graph during init');
  ok(ac.resumes >= 1, 'the context is resumed');
  ok(sys.crowd !== null && sys.ambience !== null && sys.flight !== null && sys.body !== null,
    'all four layers exist');

  const masterEvents = (sys.graph!.master as unknown as FakeGain).gain.events;
  ok(masterEvents.length >= 2, 'master gain is automated');
  ok(masterEvents[0].value <= 0.001, 'master starts silent', `${masterEvents[0].value}`);
  ok((sys.graph!.master as unknown as FakeGain).gain.target > 0.4, 'master fades up to a real level');

  noThrow('live: every event fires without throwing', () => fireAll(ctx));
  noThrow('live: 600 frames do not throw', () => stepSystem(sys, ctx, ac, 600));
  noThrow('live: hostile payloads do not throw', () => fireHostile(ctx));
  noThrow('live: 200 more frames after hostile payloads', () => stepSystem(sys, ctx, ac, 200));

  // Every automation event ever recorded, checked in bulk.
  let bad = 0;
  let total = 0;
  for (const p of ac.params) {
    for (const e of p.events) {
      total++;
      if (!Number.isFinite(e.value) || !Number.isFinite(e.time) || e.time < 0) bad++;
      if (e.kind === 'exp' && e.value <= 0) bad++;
      if (e.kind === 'target' && (e.tau === undefined || e.tau <= 0)) bad++;
    }
  }
  ok(total > 2000, 'the mix is actually being automated', `${total} param events`);
  ok(bad === 0, 'no parameter write is non-finite, negative-time or an exponential to zero', `${bad} bad`);

  // Listener tracking.
  const lx = ac.listener.positionX;
  ok(lx.events.length > 100, 'the listener is updated every frame');
  ok(Math.abs(lx.target - (-26)) < 1e-6, 'the listener sits at the camera', `${lx.target}`);
  ok(Math.abs(ac.listener.forwardZ.target - (-1)) < 1e-6, 'the listener faces the camera forward axis');

  ok((sys.debug().voices as number) >= 0, 'debug() reports a voice count');
  sys.dispose();
  ok(!sys.running && sys.graph === null, 'dispose() tears the graph down');
}

/* ------------------------------------------------------------- voice budget */

section('voice pool');
{
  const { sys, ctx, ac } = liveSystem('medium');
  const cap = sys.graph!.budget.voices;
  for (let i = 0; i < 600; i++) {
    ctx.events.emit('player:footstep', {
      id: i % 14, pos: { x: -26 + (i % 5), y: 0.02, z: 22 - (i % 7) },
      foot: i % 2 ? 'L' : 'R', speed: 6, hard: i % 3 === 0,
    });
  }
  ok(sys.graph!.voiceCount <= cap, 'the voice pool never exceeds its budget',
    `${sys.graph!.voiceCount} > ${cap}`);
  ok(sys.graph!.voiceCount > 0, 'footsteps actually make voices');

  const before = sys.graph!.voiceCount;
  ac.advance(4);
  sys.graph!.reap(ac.currentTime);
  ok(sys.graph!.voiceCount === 0, 'voices are reaped once their tails pass', `${before} -> ${sys.graph!.voiceCount}`);

  // Distance culling: the far touchline is beyond the medium-tier cull radius.
  const nodesBefore = ac.nodes.length;
  for (let i = 0; i < 40; i++) {
    ctx.events.emit('player:footstep', { id: 1, pos: { x: 900, y: 0.02, z: 900 }, foot: 'L', speed: 7, hard: true });
  }
  ok(ac.nodes.length === nodesBefore, 'footsteps beyond the cull radius allocate nothing');
  sys.dispose();
}

/* ---------------------------------------------------------- crowd behaviour */

section('crowd');
{
  const { sys, ctx, ac } = liveSystem();
  const crowd = sys.crowd!;
  const roarGain = () => {
    // The roar layer is the murmur source at 1.52x; find its gain by walking
    // the recorded graph rather than by reaching into private state.
    return crowd.debug().roar;
  };

  // A score must build and then decay over several seconds — not a one-shot.
  ctx.events.emit('score', { team: 0, playerId: 5, score: [1, 0] });
  stepSystem(sys, ctx, ac, 30);            // 0.5 s
  const at05 = roarGain();
  stepSystem(sys, ctx, ac, 90);            // 2.0 s
  const at20 = roarGain();
  stepSystem(sys, ctx, ac, 60);            // 3.0 s
  const at30 = roarGain();
  stepSystem(sys, ctx, ac, 300);           // 8.0 s
  const at80 = roarGain();
  stepSystem(sys, ctx, ac, 600);           // 18.0 s
  const at180 = roarGain();

  ok(at05 > 0.45, 'a score erupts within half a second', `roar ${at05.toFixed(3)}`);
  ok(at20 > at05 * 0.4, 'the roar is still near peak at two seconds', `roar ${at20.toFixed(3)}`);
  ok(at30 > 0.2, 'the roar is still clearly audible at three seconds', `roar ${at30.toFixed(3)}`);
  ok(at80 < at30, 'the roar decays');
  ok(at180 < 0.05, 'the roar returns to the bed after ~18 s', `roar ${at180.toFixed(3)}`);

  // Reactions stack rather than replace.
  const base = crowd.debug().surge;
  crowd.react('catch');
  const one = crowd.debug().surge;
  crowd.react('catch');
  const two = crowd.debug().surge;
  ok(one > base && two > one, 'reactions accumulate instead of retriggering', `${base.toFixed(3)} ${one.toFixed(3)} ${two.toFixed(3)}`);

  // A drop is a groan: dark, not bright.
  const fresh = liveSystem();
  fresh.ctx.events.emit('turnover', { reason: 'drop', from: 0, to: 1, playerId: 2, pos: { x: 0, y: 0, z: 0 } });
  stepSystem(fresh.sys, fresh.ctx, fresh.ac, 30);
  ok(fresh.sys.crowd!.debug().val < 0.5, 'a drop pulls crowd valence toward a groan',
    `val ${fresh.sys.crowd!.debug().val.toFixed(3)}`);
  fresh.sys.dispose();

  // Phase drives the resting level.
  const p = liveSystem();
  p.ctx.events.emit('state:changed', { to: 'PRE_PULL' });
  stepSystem(p.sys, p.ctx, p.ac, 400);
  const quiet = p.sys.crowd!.debug().bed;
  p.ctx.events.emit('state:changed', { to: 'DISC_IN_FLIGHT' });
  stepSystem(p.sys, p.ctx, p.ac, 400);
  const loud = p.sys.crowd!.debug().bed;
  ok(loud > quiet + 0.1, 'the bed rises with the rules phase', `${quiet.toFixed(3)} -> ${loud.toFixed(3)}`);
  p.sys.dispose();

  sys.dispose();
}

/* ============================================================= 4b. the drama
 *
 * Everything above proves the graph exists and is legal. This section proves it
 * is *about the match* — that the crowd is louder after a catch than before it,
 * quieter at stall 8 than at stall 2, and loudest of all on a block.
 *
 * The measurement is not `crowd.debug()`. Reading the model's own variables and
 * asserting they moved is circular: it would pass just as happily if nothing
 * downstream were connected to them. What is measured instead is the automation
 * the crowd's gain nodes actually received — every `setTargetAtTime`,
 * `linearRamp` and `setValueAtTime` recorded by the fake — evaluated back into a
 * level envelope with the same first-order and ramp semantics the spec defines.
 * That is one step short of PCM, and it is a step the browser probe
 * (`tools/_audioprobe.mjs`) covers with a real OfflineAudioContext render.
 */

section('drama');

/**
 * Evaluate a recorded AudioParam onto a uniform grid, honouring the four
 * automation kinds the audio code emits. One pass over the events.
 */
function sampleParam(p: FakeParam, t0: number, t1: number, step: number): Float64Array {
  const n = Math.max(1, Math.ceil((t1 - t0) / step));
  const out = new Float64Array(n);
  const evs = p.events.slice().sort((a, b) => a.time - b.time);
  let ei = 0;
  /** The event governing the segment we are in, and the value it started from. */
  let seg: ParamEvent | null = null;
  let segStart = p.defaultValue;

  const at = (t: number): number => {
    if (!seg) return segStart;
    const next = ei < evs.length ? evs[ei] : null;
    if (seg.kind === 'target') {
      const tau = Math.max(1e-4, seg.tau ?? 0.05);
      return seg.value + (segStart - seg.value) * Math.exp(-Math.max(0, t - seg.time) / tau);
    }
    // A `set` holds, and a ramp holds its endpoint — unless the next event is
    // itself a ramp, which begins interpolating from here immediately.
    if (next && (next.kind === 'lin' || next.kind === 'exp')) {
      return rampAt(seg.value, seg.time, next, t);
    }
    return seg.value;
  };

  for (let i = 0; i < n; i++) {
    const t = t0 + i * step;
    while (ei < evs.length && evs[ei].time <= t) {
      const e = evs[ei];
      // The value handed to the new segment is whatever the old one had reached.
      const carried = at(e.time);
      ei++;
      seg = e;
      segStart = carried;
    }
    out[i] = at(t);
  }
  return out;
}

function rampAt(fromV: number, fromT: number, to: ParamEvent, t: number): number {
  const span = Math.max(1e-6, to.time - fromT);
  const k = Math.min(1, Math.max(0, (t - fromT) / span));
  if (to.kind === 'exp') {
    const a = Math.max(1e-9, fromV);
    const b = Math.max(1e-9, to.value);
    return a * Math.pow(b / a, k);
  }
  return fromV + (to.value - fromV) * k;
}

/**
 * Every Gain that feeds the crowd stem, taken off the permanent edge log rather
 * than off live `out` arrays — a reaped one-shot has been disconnected by the
 * time the envelope is evaluated, and it still made noise.
 */
function crowdFeeders(ac: FakeContext, crowd: FakeNode): FakeNode[] {
  const pans = new Set<FakeNode>();
  for (const e of ac.edges) {
    if (e.to === crowd && e.from.kind === 'StereoPanner') pans.add(e.from);
  }
  const seen = new Set<FakeNode>();
  for (const e of ac.edges) {
    const to = e.to;
    if (to instanceof FakeParam) continue;
    if ((to === crowd || pans.has(to)) && e.from.kind === 'Gain') seen.add(e.from);
  }
  return [...seen];
}

/**
 * Sum the crowd stem's sources in power, which is the right way to add
 * uncorrelated noise beds and is proportional to what a meter would read.
 */
function crowdEnvelope(
  ac: FakeContext, crowd: FakeNode, t0: number, dur: number, step: number,
): Float64Array {
  const feeders = crowdFeeders(ac, crowd);
  const n = Math.max(1, Math.ceil(dur / step));
  const out = new Float64Array(n);
  for (const f of feeders) {
    const p = f.params.get('gain');
    if (!p) continue;
    const s = sampleParam(p, t0, t0 + dur, step);
    // A transient voice built at t = 13.5 s contributed nothing at t = 2 s, and
    // its param's *default* value would otherwise read as full scale for the
    // whole window before it existed.
    const born = p.events.length ? p.events[0].time : 0;
    for (let i = 0; i < n; i++) {
      if (t0 + i * step < born) continue;
      const v = Math.max(0, s[i]);
      out[i] += v * v;
    }
  }
  for (let i = 0; i < n; i++) out[i] = Math.sqrt(out[i]);
  return out;
}

/**
 * The envelope of one named bed, so a groan can be told apart from a cheer by
 * something other than its level. Every crowd bed is the same murmur PCM at a
 * different playback rate — 0.70 groan, 0.86 chatter, 1.52 roar — plus the
 * separately baked applause, so the rate (or the buffer) identifies the layer.
 */
function bedEnvelope(
  ac: FakeContext, crowd: FakeNode, pick: (s: FakeBufferSource) => boolean,
  t0: number, dur: number, step: number,
): Float64Array {
  const n = Math.max(1, Math.ceil(dur / step));
  const out = new Float64Array(n);
  const src = ac.nodes.find((x) => x instanceof FakeBufferSource && pick(x)) as FakeBufferSource | undefined;
  if (!src) return out;
  // Walk downstream until a Gain that reaches the crowd stem.
  const pans = new Set<FakeNode>();
  for (const e of ac.edges) if (e.to === crowd && e.from.kind === 'StereoPanner') pans.add(e.from);
  const from = new Map<FakeNode, Array<FakeNode | FakeParam>>();
  for (const e of ac.edges) {
    const arr = from.get(e.from) ?? [];
    arr.push(e.to);
    from.set(e.from, arr);
  }
  let found: FakeNode | null = null;
  const stack: FakeNode[] = [src];
  const seen = new Set<FakeNode>();
  while (stack.length && !found) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const to of from.get(cur) ?? []) {
      if (to instanceof FakeParam) continue;
      if (cur.kind === 'Gain' && (to === crowd || pans.has(to))) { found = cur; break; }
      stack.push(to);
    }
  }
  if (!found) return out;
  const p = found.params.get('gain');
  if (!p) return out;
  const s = sampleParam(p, t0, t0 + dur, step);
  for (let i = 0; i < n; i++) out[i] = Math.max(0, s[i]);
  return out;
}

const winMean = (e: Float64Array, step: number, a: number, b: number): number => {
  const i0 = Math.max(0, Math.floor(a / step));
  const i1 = Math.min(e.length, Math.ceil(b / step));
  let s = 0;
  for (let i = i0; i < i1; i++) s += e[i];
  return i1 > i0 ? s / (i1 - i0) : 0;
};
const winPeak = (e: Float64Array, step: number, a: number, b: number): number => {
  const i0 = Math.max(0, Math.floor(a / step));
  const i1 = Math.min(e.length, Math.ceil(b / step));
  let m = 0;
  for (let i = i0; i < i1; i++) if (e[i] > m) m = e[i];
  return m;
};

/**
 * One scripted point, driven frame by frame with the disc actually moving, so
 * the anticipation model has a real closing distance to work with.
 *
 * Timeline (seconds):
 *   0.00  live possession, disc held
 *   0.25→2.25  the stall count climbs 1→9
 *   3.00  a 26 m/s huck                 4.50  taken on the run
 *   6.00  a throwaway                   7.60  it lands, nobody near it
 *   9.00  a swing                       9.90  blocked
 *  13.50  a layout bid                 13.90  the landing
 *  16.00  the goal
 */
function scriptedPoint(tier: QualityTier = 'high'): {
  sys: AudioSystem; ac: FakeContext; env: Float64Array; step: number; log: string[];
  groan: Float64Array; applause: Float64Array; chatter: Float64Array;
} {
  const { sys, ctx, ac } = liveSystem(tier);
  const E = ctx.events;
  const disc = ctx.sys.disc.rt;
  const players: any[] = ctx.sys.locomotion.players;
  const log: string[] = [];

  // Park everyone off the map so `nearestBody` is a controlled quantity, then
  // nominate one receiver whose position the script drives.
  for (const p of players) { p.pos = { x: 300, y: 0.95, z: 300 }; p.state = 'run'; p.stamina = 100; }
  const rx = players[1];
  rx.pos = { x: 5, y: 0.95, z: -20 };

  const setDisc = (x: number, y: number, z: number, vx: number, vy: number, vz: number, flight: boolean): void => {
    disc.state.pos = { x, y, z };
    disc.state.vel = { x: vx, y: vy, z: vz };
    disc.state.groundY = 0;
    disc.state.atRest = !flight;
    disc.state.airspeed = flight ? Math.hypot(vx, vy, vz) : 0;
    disc.state.spin = flight ? -46 : 0;
    disc.mode = flight ? 'flight' : 'held';
  };

  const dt = 1 / 60;
  const DUR = 20;
  const N = Math.round(DUR / dt);
  setDisc(0, 1.3, 10, 0, 0, 0, false);
  E.emit('state:changed', { to: 'LIVE_POSSESSION' });

  // Let the beds reach their resting level before the clock starts. Without
  // this the first second of the point is the graph fading up from silence, and
  // every comparison against "the start of the possession" is measuring a
  // startup ramp rather than a crowd.
  for (let i = 0; i < 150; i++) { ac.advance(dt); sys.lateUpdate(dt, ctx); }
  const t0 = ac.currentTime;

  // A flight leg: from → to over `secs`, straight line, constant velocity.
  let leg: { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number; t0: number; secs: number } | null = null;

  for (let i = 0; i < N; i++) {
    const t = i * dt;
    const at = (s: number): boolean => Math.abs(t - s) < dt * 0.5;

    /* the stall */
    for (let c = 1; c <= 9; c++) {
      if (at(0.25 * c)) {
        ctx.sys.game.gs.stallCount = c;
        E.emit('stall:tick', { count: c, max: 10, playerId: 3, team: 0, markerId: 2 });
      }
    }

    /* throw one — the huck */
    if (at(3.0)) {
      ctx.sys.game.gs.stallCount = 0;
      E.emit('disc:released', {
        pos: { x: 0, y: 1.3, z: 10 }, vel: { x: 3.3, y: 1.2, z: -20 },
        spin: 52, throwType: 'backhand', playerId: 3, team: 0, stall: 9,
      });
      E.emit('state:changed', { to: 'DISC_IN_FLIGHT' });
      leg = { x0: 0, y0: 1.3, z0: 10, x1: 5, y1: 1.8, z1: -20, t0: 3.0, secs: 1.5 };
      log.push('3.00 huck');
    }
    if (at(4.5)) {
      leg = null;
      setDisc(5, 1.8, -20, 0, 0, 0, false);
      E.emit('disc:caught', { playerId: rx.id, pos: { x: 5, y: 1.8, z: -20 }, team: 0, outcome: 'completion' });
      E.emit('state:changed', { to: 'LIVE_POSSESSION' });
      log.push('4.50 catch');
    }

    /* throw two — the throwaway */
    if (at(6.0)) {
      E.emit('disc:released', {
        pos: { x: 5, y: 1.5, z: -20 }, vel: { x: -10, y: 1.0, z: 12 },
        spin: 40, throwType: 'forehand', playerId: rx.id, team: 0, stall: 2,
      });
      E.emit('state:changed', { to: 'DISC_IN_FLIGHT' });
      leg = { x0: 5, y0: 1.5, z0: -20, x1: -18, y1: 0.05, z1: 8, t0: 6.0, secs: 1.6 };
      log.push('6.00 throwaway');
    }
    if (at(7.6)) {
      leg = null;
      setDisc(-18, 0.05, 8, 0, 0, 0, false);
      E.emit('disc:grounded', { pos: { x: -18, y: 0.05, z: 8 }, reason: 'throwaway' });
      E.emit('turnover', { reason: 'throwaway', from: 0, to: 1, playerId: rx.id });
      E.emit('state:changed', { to: 'TURNOVER_DEAD' });
      log.push('7.60 ground');
    }

    /* throw three — the block */
    if (at(9.0)) {
      E.emit('state:changed', { to: 'LIVE_POSSESSION' });
      E.emit('disc:released', {
        pos: { x: -18, y: 1.4, z: 8 }, vel: { x: 9, y: 0.6, z: 8 },
        spin: 38, throwType: 'backhand', playerId: 9, team: 1, stall: 1,
      });
      E.emit('state:changed', { to: 'DISC_IN_FLIGHT' });
      leg = { x0: -18, y0: 1.4, z0: 8, x1: -10, y1: 1.2, z1: 15, t0: 9.0, secs: 0.9 };
      // A defender is right there, which is why this one is not a groan.
      players[2].pos = { x: -10, y: 0.95, z: 15 };
      log.push('9.00 swing');
    }
    if (at(9.9)) {
      leg = null;
      setDisc(-10, 0.05, 15, 0, 0, 0, false);
      E.emit('disc:grounded', { pos: { x: -10, y: 0.05, z: 15 }, reason: 'block' });
      E.emit('turnover', { reason: 'block', from: 1, to: 0, playerId: 2 });
      E.emit('state:changed', { to: 'TURNOVER_DEAD' });
      log.push('9.90 BLOCK');
    }

    /* the bid */
    if (at(13.5)) { players[2].state = 'layout'; log.push('13.50 layout'); }
    if (at(13.9)) {
      players[2].state = 'landing';
      E.emit('player:land', { id: 2, pos: { x: -10, y: 0.1, z: 15 }, impact: 8.2, layout: true });
    }
    if (at(14.6)) players[2].state = 'run';

    /* the goal */
    if (at(16.0)) {
      E.emit('score', { team: 0, playerId: 4, assistId: 3, score: [1, 0], point: 1 });
      E.emit('state:changed', { to: 'POINT_SCORED' });
      log.push('16.00 GOAL');
    }

    /* fly the disc */
    if (leg) {
      const k = Math.min(1, (t - leg.t0) / leg.secs);
      const x = leg.x0 + (leg.x1 - leg.x0) * k;
      const y = leg.y0 + (leg.y1 - leg.y0) * k;
      const z = leg.z0 + (leg.z1 - leg.z0) * k;
      setDisc(x, y, z,
        (leg.x1 - leg.x0) / leg.secs, (leg.y1 - leg.y0) / leg.secs, (leg.z1 - leg.z0) / leg.secs, true);
    }

    ctx.frame++;
    ctx.time += dt;
    ac.advance(dt);
    sys.lateUpdate(dt, ctx);
  }

  const step = 0.02;
  const crowdNode = sys.graph!.crowd as unknown as FakeNode;
  const env = crowdEnvelope(ac, crowdNode, t0, DUR, step);
  const rate = (s: FakeBufferSource, r: number): boolean =>
    Math.abs(s.playbackRate.events[0]?.value - r) < 0.02;
  const beds = sys.graph!.beds as unknown as { applause: FakeBuffer };
  return {
    sys, ac, env, step, log,
    groan: bedEnvelope(ac, crowdNode, (s) => rate(s, 0.70), t0, DUR, step),
    chatter: bedEnvelope(ac, crowdNode, (s) => rate(s, 0.86), t0, DUR, step),
    applause: bedEnvelope(ac, crowdNode, (s) => s.buffer === beds.applause, t0, DUR, step),
  };
}

{
  const { sys, env, step, log } = scriptedPoint();
  const mean = (a: number, b: number): number => winMean(env, step, a, b);
  const peak = (a: number, b: number): number => winPeak(env, step, a, b);

  if (VERBOSE) {
    const db = (v: number): string => (20 * Math.log10(Math.max(1e-6, v))).toFixed(1).padStart(6);
    console.log(`  script: ${log.join('  ')}`);
    let line = '  crowd stem, dB rel. full scale, 0.5 s means:';
    for (let s = 0; s < 20; s += 0.5) {
      if ((s * 2) % 8 === 0) line += `\n  ${s.toFixed(0).padStart(2)}s |`;
      line += ` ${db(winMean(env, step, s, s + 0.5))}`;
    }
    console.log(line);
  }

  // The envelope has to be a real signal before any comparison on it means
  // anything: flat or zero would pass half the tests below by accident.
  let lo = Infinity; let hi = 0;
  for (const v of env) { if (v < lo) lo = v; if (v > hi) hi = v; }
  ok(hi > lo * 3 && lo > 0, 'the crowd envelope is a live signal, not a constant',
    `min ${lo.toFixed(4)} max ${hi.toFixed(4)}`);

  /* 1. the catch is the peak, not the aftermath */
  const before = mean(2.5, 4.5);
  const after = mean(4.5, 5.0);
  ok(after > before, 'crowd energy 0.5 s after a catch exceeds the 2 s before it',
    `${before.toFixed(4)} -> ${after.toFixed(4)}  (+${(20 * Math.log10(after / before)).toFixed(1)} dB)`);

  /* 2. the swell happens during the flight, not after the catch */
  const atRelease = mean(3.0, 3.2);
  const midFlight = mean(4.1, 4.5);
  ok(midFlight > atRelease * 1.15, 'the crowd swells while the disc is still in the air',
    `${atRelease.toFixed(4)} -> ${midFlight.toFixed(4)}`);

  /* 3. tension is the absence of noise */
  const possession = mean(0.05, 2.95);
  const stalled = mean(1.85, 2.95);          // stall 7, 8, 9
  const early = mean(0.05, 1.0);             // stall 0-3
  ok(stalled < possession, 'crowd energy at stall 7+ is below the possession mean',
    `${stalled.toFixed(4)} < ${possession.toFixed(4)}`);
  ok(stalled < early * 0.8, 'a high stall is quieter than the start of the same possession',
    `${stalled.toFixed(4)} vs ${early.toFixed(4)}  (${(20 * Math.log10(stalled / early)).toFixed(1)} dB)`);

  /* 4. and it breaks on the throw */
  const broke = mean(3.0, 3.6);
  ok(broke > stalled * 1.4, 'the hush breaks when the throw finally goes',
    `${stalled.toFixed(4)} -> ${broke.toFixed(4)}`);

  /* 5. a block is the loudest thing in the point bar the goal */
  const pBlock = peak(9.9, 12.9);
  const pCatch = peak(4.5, 5.9);
  const pDrop = peak(7.6, 9.0);
  const pLayout = peak(13.5, 15.9);
  const pGoal = peak(16.0, 19.9);
  ok(pBlock > pCatch && pBlock > pDrop && pBlock > pLayout,
    'a block is the loudest single reaction of the point',
    `block ${pBlock.toFixed(4)} catch ${pCatch.toFixed(4)} drop ${pDrop.toFixed(4)} layout ${pLayout.toFixed(4)}`);
  ok(pGoal > pBlock, 'the goal still tops the block', `${pGoal.toFixed(4)} vs ${pBlock.toFixed(4)}`);

  /* 6. between points is a wash, not silence */
  const betweenPoints = mean(17.5, 19.9);
  ok(betweenPoints > possession * 0.9, 'the stands are not silent between points',
    `${betweenPoints.toFixed(4)} vs possession ${possession.toFixed(4)}`);

  sys.dispose();
}

{
  // The groan has to start before the disc lands. The throwaway leaves the hand
  // at 6.00 and reaches the turf at 7.60; the crowd must have turned by then.
  const { sys, ctx, ac } = liveSystem();
  const disc = ctx.sys.disc.rt;
  const players: any[] = ctx.sys.locomotion.players;
  for (const p of players) { p.pos = { x: 300, y: 0.95, z: 300 }; p.state = 'run'; }
  ctx.events.emit('state:changed', { to: 'LIVE_POSSESSION' });

  const dt = 1 / 60;
  ctx.events.emit('disc:released', {
    pos: { x: 5, y: 1.5, z: -20 }, vel: { x: -14, y: 1, z: 17 },
    spin: 40, throwType: 'forehand', playerId: 1, team: 0, stall: 2,
  });
  ctx.events.emit('state:changed', { to: 'DISC_IN_FLIGHT' });

  const valAt: number[] = [];
  let preAt = -1;
  const SECS = 1.6;
  for (let i = 0; i < Math.round(SECS / dt); i++) {
    const k = i * dt / SECS;
    disc.mode = 'flight';
    disc.state.atRest = false;
    disc.state.pos = { x: 5 - 23 * k, y: 1.5 + 1.6 * k - 3.1 * k * k, z: -20 + 28 * k };
    disc.state.vel = { x: -14, y: 1.6 - 6.2 * k, z: 17 };
    disc.state.groundY = 0;
    disc.state.airspeed = 22;
    disc.state.spin = -40;
    ctx.time += dt; ac.advance(dt);
    sys.lateUpdate(dt, ctx);
    valAt.push(sys.crowd!.debug().val);
    if (preAt < 0 && (sys.debug().drama as any)?.pre) preAt = i * dt;
  }
  ok(preAt >= 0, 'the groan starts before the disc lands', preAt >= 0 ? `at +${preAt.toFixed(2)}s of a 1.60s flight` : 'never fired');
  ok(preAt > 0 && preAt < SECS - 0.12, 'and it starts early enough to be an anticipation, not a report',
    `+${preAt.toFixed(2)}s`);
  ok(valAt[valAt.length - 1] < 0.55, 'valence is a groan by the time it lands',
    `val ${valAt[valAt.length - 1].toFixed(3)}`);
  // The swell must collapse rather than keep climbing into a cheer.
  const anticAtGroan = (sys.debug().drama as any).antic;
  ok(anticAtGroan < 0.25, 'anticipation collapses when the drop becomes obvious', `antic ${anticAtGroan.toFixed(3)}`);
  sys.dispose();
}

{
  // A bid gasps on the takeoff frame, not on the landing.
  const { sys, ctx, ac } = liveSystem();
  const players: any[] = ctx.sys.locomotion.players;
  const crowdNode = sys.graph!.crowd as unknown as FakeNode;
  // Count sources arriving at the crowd stem, not nodes in general: a gassed
  // player breathing next to the camera allocates too, and it is not the crowd.
  const intoCrowd = (): number => ac.edges.filter((e) => e.to === crowdNode).length;
  stepSystem(sys, ctx, ac, 8);
  const n0 = intoCrowd();
  players[3].state = 'layout';
  stepSystem(sys, ctx, ac, 2);
  ok(intoCrowd() === n0 + 1, 'a layout takeoff allocates a gasp voice into the crowd stem',
    `+${intoCrowd() - n0}`);
  const n1 = intoCrowd();
  stepSystem(sys, ctx, ac, 30);
  ok(intoCrowd() === n1, 'and it fires exactly once while the body is down', `+${intoCrowd() - n1}`);
  players[3].state = 'run';
  stepSystem(sys, ctx, ac, 2);
  players[3].state = 'layout';
  stepSystem(sys, ctx, ac, 2);
  ok(intoCrowd() === n1 + 1, 'a second bid gasps again', `+${intoCrowd() - n1}`);
  sys.dispose();
}

{
  // Doppler: the same disc, same speed, closing and receding past the camera.
  const { sys, ctx, ac } = liveSystem();
  const disc = ctx.sys.disc.rt;
  const cam = ctx.camera.matrixWorld.elements;   // (-26, 6, 22)
  const set = (x: number, z: number, vx: number, vz: number): void => {
    disc.mode = 'flight';
    disc.state.atRest = false;
    disc.state.pos = { x, y: 2, z };
    disc.state.vel = { x: vx, y: 0, z: vz };
    disc.state.airspeed = Math.hypot(vx, vz);
    disc.state.spin = -46;
  };
  set(cam[12] + 24, cam[14], -24, 0);            // 24 m/s straight at the camera
  stepSystem(sys, ctx, ac, 3);
  const closing = sys.flight!.lastDoppler;
  set(cam[12] - 24, cam[14], -24, 0);            // same velocity, now going away
  stepSystem(sys, ctx, ac, 3);
  const receding = sys.flight!.lastDoppler;
  ok(closing > 1.05, 'a disc closing on the camera is pitched up', `x${closing.toFixed(3)}`);
  ok(receding < 0.95, 'and pitched down once it is past', `x${receding.toFixed(3)}`);
  ok(closing / receding > 1.15, 'the flypast is a real shift, not a rounding error',
    `${(1200 * Math.log2(closing / receding)).toFixed(0)} cents across the pass`);

  disc.mode = 'held';
  disc.state.atRest = true;
  disc.state.airspeed = 0;
  stepSystem(sys, ctx, ac, 3);
  ok(sys.flight!.lastDoppler === 1, 'a held disc has no doppler at all');
  sys.dispose();
}

/* ========================================================= 4c. the broadcast
 *
 * These four claims are proved on real PCM by `tools/test-audio-render.mjs`,
 * which needs a browser. They are restated here against the fake because that
 * file takes two minutes and this one takes two seconds, and a regression that
 * is only caught by the slow test is a regression that ships.
 */

section('broadcast');
{
  // 1. THE PITCH IS NOT MIC'D FROM THE LENS.
  //
  // Measured on PCM before the touchline law: with a physical distance model the
  // whole field stem sat 45 dB under the crowd from the tele camera, a footstep
  // 50 m out rendered at -53 dBFS against a -30 dBFS bed, and the disc's own
  // release snap was 12 dB *below* the murmur. Every one of those sounds was
  // correct, and none of them could be heard. This asserts the law, not the
  // level, because the law is the thing a future edit would quietly undo.
  const { sys, ctx, ac } = liveSystem();
  ctx.events.emit('player:footstep', {
    id: 0, pos: { x: 2, y: 0.02, z: 4 }, foot: 'R', speed: 7, hard: true,
  });
  ctx.events.emit('disc:released', {
    pos: { x: 0, y: 1.4, z: 6 }, vel: { x: 0, y: 1, z: -20 },
    spin: 46, throwType: 'backhand', playerId: 1, team: 0,
  });
  const panners = ac.nodes.filter((n) => n instanceof FakePanner) as FakePanner[];
  ok(panners.length >= 3, 'the field layers built spatial voices', `${panners.length}`);
  const physical = panners.filter((p) => p.refDistance < 6 || p.rolloffFactor > 0.9);
  ok(physical.length === 0, 'every field voice is on the touchline law, not a physical one',
    physical.length ? `${physical.length} of ${panners.length} still physical` : `ref ${TOUCHLINE.ref} rolloff ${TOUCHLINE.rolloff}`);
  // 50 m is the tele camera. A broadcast is about 10 dB down out there; a
  // physical model is about 27, and 27 is inaudible under a stadium.
  const far = touchlineGain(50);
  ok(far > 0.24 && far < 0.55, 'and that law leaves the far side of the pitch present',
    `${(20 * Math.log10(far)).toFixed(1)} dB at 50 m`);
  sys.dispose();
}

{
  // 2. THE HUSH HAS A CEILING THE MATCH CAN REACH.
  //
  // The stall ramp used to hit 1.0 only at `stallMax`, which is the count that
  // turns the disc over — so the deepest tension in the model belonged to a
  // state the match left on the same frame it entered, and the quietest the
  // stands ever actually got was two thirds of the way there.
  const { sys, ctx, ac } = liveSystem();
  ctx.events.emit('state:changed', { to: 'LIVE_POSSESSION' });
  for (let c = 1; c <= 9; c++) {
    ctx.sys.game.gs.stallCount = c;
    ctx.events.emit('stall:tick', { count: c, max: 10, playerId: 3, team: 0 });
    stepSystem(sys, ctx, ac, 60);          // one second a count, as the rules tick
  }
  const deep = (sys.debug().drama as any).hush;
  ok(deep > 0.9, 'the hush reaches full depth at the count before the stall-out',
    `hush ${deep.toFixed(3)} at stall 9 of 10`);
  ctx.events.emit('disc:released', {
    pos: { x: 0, y: 1.4, z: 6 }, vel: { x: 0, y: 1, z: -18 },
    spin: 44, throwType: 'forehand', playerId: 3, team: 0, stall: 9,
  });
  ok((sys.debug().drama as any).hush === 0, 'and it lets go on the frame the throw goes');
  sys.dispose();
}

{
  // 3. A BID THAT CAME OFF IS NOT A BID THAT CAME UP EMPTY.
  //
  // Both are a body leaving the ground and arriving on the turf, and the mix
  // used to fire the same reaction for each — which told the audience a dive at
  // nothing was the play of the point.
  const surgeAfterBid = (paid: boolean): number => {
    const { sys, ctx, ac } = liveSystem();
    const players: any[] = ctx.sys.locomotion.players;
    for (const p of players) { p.pos = { x: 300, y: 0.95, z: 300 }; p.state = 'run'; }
    ctx.events.emit('state:changed', { to: 'DISC_IN_FLIGHT' });
    stepSystem(sys, ctx, ac, 6);
    players[2].pos = { x: 4, y: 0.95, z: 4 };
    players[2].state = 'layout';
    stepSystem(sys, ctx, ac, 6);
    const base = sys.crowd!.debug().surge;
    if (paid) {
      ctx.events.emit('disc:grounded', { pos: { x: 4, y: 0.05, z: 4 }, reason: 'block' });
      ctx.events.emit('turnover', { reason: 'block', from: 1, to: 0, playerId: 2 });
    }
    stepSystem(sys, ctx, ac, 6);
    players[2].state = 'landing';
    ctx.events.emit('player:land', { id: 2, pos: { x: 4, y: 0.1, z: 4 }, impact: 8.4, layout: true });
    stepSystem(sys, ctx, ac, 2);
    // What the whole sequence was worth, gasp included, less nothing: `base` is
    // reported only so a failure says which half moved.
    const out = sys.crowd!.debug().surge;
    if (VERBOSE) console.log(`    ${paid ? 'paid' : 'empty'} bid: gasp ${base.toFixed(3)} -> total ${out.toFixed(3)}`);
    sys.dispose();
    return out;
  };
  const paid = surgeAfterBid(true);
  const empty = surgeAfterBid(false);
  ok(paid > empty * 1.8, 'a bid that produced a block is far bigger than one that produced nothing',
    `surge ${paid.toFixed(3)} vs ${empty.toFixed(3)}`);
  ok(empty > 0.2, 'and the empty one is still a noise, because a dive is worth something',
    `surge ${empty.toFixed(3)}`);
}

{
  // 4. A FOREHAND DOES NOT SOUND LIKE A BACKHAND.
  //
  // `throwType` has been on `disc:released` since the rules machine was written
  // and the audio ignored it. A flick leaves two fingers over two centimetres
  // and a backhand peels off a whole hand; they are not the same contact.
  const centre = (kind: string): number => {
    const { sys, ctx, ac } = liveSystem();
    const before = ac.nodes.length;
    ctx.events.emit('disc:released', {
      pos: { x: 0, y: 1.4, z: 6 }, vel: { x: 0, y: 1, z: -22 },
      spin: 46, throwType: kind, playerId: 1, team: 0,
    });
    // The snap's bandpass is the first biquad built by the handler.
    const bp = ac.nodes.slice(before).find((n) => n.kind === 'Biquad');
    const f = bp?.params.get('frequency');
    const v = f?.events.length ? f.events[0].value : 0;
    sys.dispose();
    return v;
  };
  const fh = centre('forehand');
  const bh = centre('backhand');
  const ham = centre('hammer');
  ok(fh > bh * 1.15, 'a forehand release is a higher, harder snap than a backhand',
    `${fh.toFixed(0)} Hz vs ${bh.toFixed(0)} Hz`);
  ok(ham < bh * 0.9, 'and an overhead is a whoosh, not a snap',
    `${ham.toFixed(0)} Hz vs ${bh.toFixed(0)} Hz`);
}

/* ----------------------------------------------------------- disc behaviour */

section('disc');
{
  const { sys, ctx, ac } = liveSystem();
  const disc = ctx.sys.disc.rt;

  // Find the flight voice's VCA and AM oscillator by their signature: the only
  // persistent Gain fed by a Biquad chain off the white loop, and the only
  // Oscillator connected to an AudioParam.
  const ownerOf = (p: FakeParam): FakeNode | undefined =>
    ac.nodes.find((m) => m.params.get('gain') === p);
  // The flight VCA is the one gain param that is (a) modulated by another node
  // and (b) owned by a gain feeding a spatial panner.
  const vca = ac.params.find((p) => p.name === 'gain' && p.inputs.length > 0
    && ownerOf(p)?.out.some((q) => q instanceof FakeNode && q.kind === 'Panner')) ?? null;
  ok(vca !== null, 'the flight VCA is amplitude-modulated');
  if (!vca) throw new Error('cannot continue disc assertions without the flight VCA');
  const amDepth = vca.inputs[0];
  const amOsc = ac.nodes.find((n) => n.kind === 'Oscillator' && n.out.includes(amDepth)) as FakeOscillator | undefined;
  ok(amOsc !== undefined, 'the flight voice has a rotational AM oscillator');
  if (!amOsc) throw new Error('cannot continue disc assertions without the AM oscillator');

  disc.state.airspeed = 4;
  disc.state.spin = -20;
  stepSystem(sys, ctx, ac, 5);
  const slowFreq = amOsc.frequency.target;

  disc.state.airspeed = 30;
  disc.state.spin = -60;
  stepSystem(sys, ctx, ac, 5);
  const fastFreq = amOsc.frequency.target;

  ok(fastFreq > slowFreq * 2, 'the flutter rate tracks spin', `${slowFreq.toFixed(2)} -> ${fastFreq.toFixed(2)}`);
  // Two rim passes per revolution: 60 rad/s -> ~19.1 Hz.
  ok(Math.abs(fastFreq - (60 / Math.PI)) < 0.5, 'flutter is two passes per revolution', `${fastFreq.toFixed(2)} Hz`);

  // Level tracks airspeed.
  {
    disc.state.airspeed = 6;
    stepSystem(sys, ctx, ac, 4);
    const quiet = vca.target;
    disc.state.airspeed = 34;
    stepSystem(sys, ctx, ac, 4);
    const loud = vca.target;
    ok(loud > quiet * 4, 'flight level goes as roughly the square of airspeed', `${quiet.toExponential(2)} -> ${loud.toExponential(2)}`);

    disc.mode = 'held';
    disc.state.airspeed = 0;
    stepSystem(sys, ctx, ac, 20);
    ok(vca.target <= 1e-3, 'a held disc is silent', `${vca.target}`);
  }

  // The three impacts each build a voice.
  disc.mode = 'flight';
  disc.state.airspeed = 20;
  stepSystem(sys, ctx, ac, 2);
  ac.advance(3); sys.graph!.reap(ac.currentTime);
  const n0 = ac.nodes.length;
  ctx.events.emit('disc:caught', { playerId: 3, pos: { x: -25, y: 1.4, z: 21 }, outcome: 'completion' });
  ok(ac.nodes.length > n0 + 3, 'a catch allocates a voice');
  const n1 = ac.nodes.length;
  ctx.events.emit('disc:grounded', { pos: { x: -25, y: 0.02, z: 21 }, reason: 'drop' });
  ok(ac.nodes.length > n1 + 5, 'a dropped disc makes both a rim graze and a ground slap');
  sys.dispose();
}

/* ------------------------------------------------------------ wind and horn */

section('ambience');
{
  const { sys, ctx, ac } = liveSystem();
  const disc = ctx.sys.disc.rt;

  disc.wind = { x: 0, y: 0, z: 0 };
  stepSystem(sys, ctx, ac, 400);
  const calm = sys.ambience!.windSpeed;
  disc.wind = { x: 9, y: 0, z: -6 };
  stepSystem(sys, ctx, ac, 400);
  const gale = sys.ambience!.windSpeed;
  ok(gale > calm * 3, 'wind level tracks the simulated wind vector', `${calm.toFixed(2)} -> ${gale.toFixed(2)} m/s`);
  ok(Number.isFinite(calm) && Number.isFinite(gale), 'wind speed stays finite');

  ac.advance(5); sys.graph!.reap(ac.currentTime);
  const oscBefore = ac.nodes.filter((n) => n.kind === 'Oscillator').length;
  ctx.events.emit('score', { team: 1, playerId: 2, score: [1, 1] });
  const oscAfter = ac.nodes.filter((n) => n.kind === 'Oscillator').length;
  ok(oscAfter >= oscBefore + 4, 'the goal horn is a detuned oscillator stack', `+${oscAfter - oscBefore}`);

  const paBefore = ac.nodes.length;
  sys.ambience!.announce(6);
  ok(ac.nodes.length > paBefore + 4, 'the PA builds a formant voice');
  sys.dispose();
}

/* --------------------------------------------------------- bodies and calls */

section('bodies');
{
  const { sys, ctx, ac } = liveSystem();
  const players: any[] = ctx.sys.locomotion.players;

  // Park a player right on top of the camera so nothing is culled.
  players[0].pos = { x: -26, y: 0.95, z: 21 };
  players[0].stamina = 8;
  players[0].state = 'sprint';
  ctx.sys.disc.rt.holderId = 3;
  ctx.events.emit('state:changed', { to: 'LIVE_POSSESSION' });

  // Let the layer see the roster at rest first, so the transition below is a
  // real transition rather than the frame the player was first observed.
  stepSystem(sys, ctx, ac, 4);
  ac.advance(4); sys.graph!.reap(ac.currentTime);
  const n0 = ac.nodes.length;
  // A cut is a state transition, not an event — the layer must notice it.
  players[0].state = 'cut';
  players[0].cutEntrySpeed = 8;
  stepSystem(sys, ctx, ac, 2);
  ok(ac.nodes.length > n0 + 4, 'entering a cut fires a cleat scuff', `+${ac.nodes.length - n0}`);

  // Breathing: an exhausted player next to the camera must breathe.
  ac.advance(4); sys.graph!.reap(ac.currentTime);
  const n1 = ac.nodes.length;
  stepSystem(sys, ctx, ac, 600);           // 10 s
  ok(ac.nodes.length > n1 + 6, 'a gassed player near the camera breathes', `+${ac.nodes.length - n1}`);

  // Calls: over a long stretch with the disc live, somebody shouts for it.
  const oscBefore = ac.nodes.filter((n) => n.kind === 'Oscillator').length;
  for (const p of players) { p.state = 'sprint'; p.pos.x = -24 + (p.id % 4); p.pos.z = 20; }
  stepSystem(sys, ctx, ac, 3600);          // 60 s
  const oscAfter = ac.nodes.filter((n) => n.kind === 'Oscillator').length;
  ok(oscAfter > oscBefore, 'cutters occasionally call for the disc', `+${oscAfter - oscBefore} voiced sources`);

  // A layout is the loudest thing a body does, and it is more than a thump.
  ac.advance(4); sys.graph!.reap(ac.currentTime);
  const n2 = ac.nodes.length;
  ctx.events.emit('player:land', { id: 0, pos: { x: -26, y: 0.1, z: 21 }, impact: 8.5, layout: true });
  ok(ac.nodes.length > n2 + 8, 'a layout allocates impact, slide and grunt', `+${ac.nodes.length - n2}`);
  sys.dispose();
}

/* ------------------------------------------------------- failure containment */

section('failure containment');
{
  const { sys, ctx } = liveSystem();
  // A peer that has gone feral mid-frame must not take the frame down.
  ctx.sys.locomotion = {
    get players(): never { throw new Error('peer exploded'); },
  };
  noThrow('a throwing peer does not escape lateUpdate', () => stepSystem(sys, ctx, null, 8));
  ctx.sys.locomotion = { players: makePlayers() };
  noThrow('a throwing peer does not escape an event handler', () => fireAll(ctx));
  sys.dispose();
}

{
  // No AudioContext anywhere (a very old browser, or a locked-down embed).
  const ctx = makeCtx();
  const sys = new AudioSystem({ createContext: () => null as unknown as AudioContext });
  noThrow('a null context factory is survivable', () => { sys.init(ctx); sys.start(); });
  ok(sys.running === false, 'no context means no running audio');
  noThrow('inert system still swallows every event', () => { fireAll(ctx); fireHostile(ctx); });
}

{
  // A factory that throws outright.
  const ctx = makeCtx();
  const sys = new AudioSystem({ createContext: () => { throw new Error('blocked by policy'); } });
  noThrow('a throwing context factory is survivable', () => { sys.init(ctx); sys.start(); });
  ok(sys.running === false, 'a blocked context leaves the system inert');
}

/* -------------------------------------------------------------- mute + tiers */

section('mixing');
{
  const { sys } = liveSystem();
  const g = (sys.graph!.master as unknown as FakeGain).gain;
  sys.setMuted(true);
  ok(g.target === 0, 'setMuted(true) takes the master to zero');
  sys.setMuted(false);
  ok(g.target > 0.4, 'setMuted(false) restores it');
  sys.dispose();
}

for (const tier of ['low', 'medium', 'high', 'ultra'] as QualityTier[]) {
  const { sys, ctx, ac } = liveSystem(tier);
  noThrow(`${tier}: full event sweep + 300 frames`, () => {
    fireAll(ctx);
    stepSystem(sys, ctx, ac, 300);
    fireHostile(ctx);
    stepSystem(sys, ctx, ac, 100);
  });
  ok(sys.graph!.voiceCount <= sys.graph!.budget.voices, `${tier}: voice budget respected`);
  if (VERBOSE) {
    console.log(`  ${tier.padEnd(7)} ${String(ac.nodes.length).padStart(4)} nodes  `
      + `${String(ac.params.reduce((a, p) => a + p.events.length, 0)).padStart(6)} param events  `
      + `${String(ac.starts).padStart(4)} sources started`);
  }
  sys.dispose();
}

/* ==================================================================== summary */

console.log(`\n\x1b[1m${'='.repeat(64)}\x1b[0m`);
if (fail === 0) {
  console.log(`\x1b[32m\x1b[1mPASS\x1b[0m  ${pass} assertions, 0 failures`);
} else {
  console.log(`\x1b[31m\x1b[1mFAIL\x1b[0m  ${pass} passed, ${fail} failed`);
  for (const f of failures) console.log(`  \x1b[31m·\x1b[0m ${f}`);
}
console.log(`\x1b[1m${'='.repeat(64)}\x1b[0m`);
process.exit(fail === 0 ? 0 : 1);
