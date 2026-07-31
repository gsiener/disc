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
import { AudioGraph, TIERS } from '../src/audio/Graph.ts';
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

  ok(sys.debug().voices >= 0, 'debug() reports a voice count');
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
