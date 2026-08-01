import * as THREE from 'three';
import type { Ctx, QualityTier } from '../core/Ctx.ts';
import type { PlayerRig, BodyParams } from './PlayerRig.ts';
import { measureBody } from './PlayerRig.ts';
import { headFrame } from './rig/Head.ts';
import { DetailTextures } from './material/Detail.ts';
import { SharedUniforms, detailForTier } from './material/Shared.ts';
import type { MatDetail } from './material/Shared.ts';
import {
  COLOURWAYS, colourwayById, randomSkin, randomHair, randomIris, skinTones,
} from './material/Tone.ts';
import type { Colourway, SkinBio } from './material/Tone.ts';
import {
  bakeKitAtlas, bakeNameStrip, ROSTER, squadNumbers, NAME_ROW_V, NAME_ROWS,
} from './material/Kit.ts';
import type { KitAtlas } from './material/Kit.ts';
import { makeSkinMaterial } from './material/Skin.ts';
import { makeClothMaterials } from './material/Cloth.ts';
import { makeGearMaterials } from './material/Gear.ts';
import { makeHairMaterial } from './material/Hair.ts';
import { makeEyeMaterial } from './material/Eyes.ts';
import { texBytes } from './material/Glsl.ts';

/**
 * ============================================================================
 *  PLAYER MATERIAL LIBRARY — the public face of src/entities/material/*
 * ============================================================================
 *
 *   const kits = new PlayerMaterialLibrary(ctx, { teams: ['home', 'away'] });
 *   const rig  = buildRig(params, ctx.quality);
 *   const worn = kits.dress(rig, { team: 0, slot: i, playerId: p.id });
 *   ctx.scene.add(rig.root);
 *   …
 *   kits.update(ctx);          // once per frame, before render
 *
 * `dress` writes straight into `rig.materials`, which every LOD shares, so one
 * call clothes all three levels of one athlete.
 *
 * WHAT IS SHARED AND WHAT IS NOT — this is the whole memory story.
 *
 *   shared by the WHOLE ROSTER   five tiling detail maps: skin micro-relief,
 *                                complexion aux, knit weave, grunge, hair
 *                                strand. A pore is a pore. ~11 MB at `high`,
 *                                paid once, whatever the squad size.
 *   shared by a TEAM             one 512² SDF atlas of numerals + club mark,
 *                                and one name strip carrying every squad
 *                                member's surname as its own row.
 *   per PLAYER                   nothing but uniforms. Skin tone, hair pigment,
 *                                iris melanin, squad number, name row, sweat
 *                                and wear are all scalars and colours.
 *
 * So the marginal texture cost of the fifteenth athlete is zero bytes, and the
 * marginal cost of a third team is one atlas plus one strip. `textureBytes` and
 * `report()` state the measured totals; do not estimate them from this comment.
 *
 * PROGRAMS. Seven materials per athlete, but every one of them declares a
 * `customProgramCacheKey` that depends only on the quality tier, so fourteen
 * athletes compile seven programs between them and the rest is uniform upload.
 */

export type TeamId = number;

export interface LibraryOptions {
  /** Colourway ids, one per team. Defaults to the art-directed home/away pair. */
  teams?: readonly string[];
  /** Squad size per team — decides how many names each team strip carries. */
  squad?: number;
  /** Override the material detail tier (defaults to ctx.quality.tier). */
  detail?: MatDetail;
}

export interface DressOptions {
  /** Index into the library's team list. */
  team: TeamId;
  /** Index within that squad. Picks the number and the name. */
  slot: number;
  /** Locomotion player id, if there is one — drives sweat off stamina. */
  playerId?: number;
  /** Extra salt; defaults to the rig's own `params.seed`. */
  seed?: number;
}

export interface WornPlayer {
  team: TeamId;
  slot: number;
  playerId?: number;
  number: number;
  name: string;
  /** 0 dry, 1 soaked. Driven by `update()` unless you set it yourself. */
  sweat: number;
  setSweat(v: number): void;
  setWear(v: number): void;
  setDilation(v: number): void;
  dispose(): void;
}

interface TeamKit {
  colourway: Colourway;
  atlas: KitAtlas;
  names: THREE.DataTexture;
  numbers: number[];
  surnames: string[];
  /** Given names, index-aligned with `surnames` and `numbers`. */
  given: string[];
}

const DEFAULT_TEAMS = ['home', 'away'] as const;

/**
 * Kit typography resolution per tier. The atlas is a distance field, so halving
 * it costs edge precision rather than legibility — a 256² field still resolves a
 * chest number cleanly at closeup range, and it takes the whole per-team cost on
 * a low-tier device from 4.7 MB to 1.2 MB.
 */
const KIT_SIZE: Record<QualityTier, number> = {
  low: 256, medium: 384, high: 512, ultra: 512,
};

export class PlayerMaterialLibrary {
  readonly detail: DetailTextures;
  readonly shared = new SharedUniforms();
  readonly tier: QualityTier;
  readonly quality: MatDetail;

  private teams: TeamKit[] = [];
  private worn: WornPlayer[] = [];
  private unbind: (() => void) | null = null;
  private squad: number;
  private bakeMs: number;
  /** Squad-list rows already dealt, so the two teams never share a name. */
  private readonly usedRows = new Set<number>();
  /** Night materials dilate the pupil; set from the sun elevation. */
  private dilation = 0;
  private nightMix = 0;

  constructor(ctx: Ctx, opts: LibraryOptions = {}) {
    const t0 = now();
    this.tier = ctx.quality.tier;
    this.quality = opts.detail ?? detailForTier(this.tier);
    this.squad = Math.max(1, Math.min(NAME_ROWS, opts.squad ?? 7));
    this.detail = new DetailTextures(this.tier, ctx.quality.anisotropy);

    const ids = opts.teams ?? DEFAULT_TEAMS;
    for (let t = 0; t < ids.length; t++) {
      const colourway = colourwayById(ids[t]);
      const rand = ctx.rand.fork(0x11713 + t * 7919);
      const numbers = squadNumbers(this.squad, rand);

      /**
       * Draw a ROW of the squad list, not a surname. The row carries the given
       * name too, so `given[i]`, `surnames[i]` and `numbers[i]` describe one
       * person and the broadcast card can never name someone the shirt does not.
       * Rows already taken by the other team are skipped, so no two athletes on
       * the pitch share a name.
       */
      const surnames: string[] = [];
      const given: string[] = [];
      while (surnames.length < this.squad) {
        const row = Math.floor(rand.next() * ROSTER.length);
        if (this.usedRows.has(row)) continue;
        this.usedRows.add(row);
        given.push(ROSTER[row][0]);
        surnames.push(ROSTER[row][1]);
      }
      this.teams.push({
        colourway,
        atlas: bakeKitAtlas(colourway, KIT_SIZE[this.tier]),
        names: bakeNameStrip(surnames, KIT_SIZE[this.tier]),
        numbers,
        surnames,
        given,
      });
    }

    this.unbind = this.shared.bind(ctx);
    // The sun event carries the hour; a floodlit pitch needs dilated pupils and
    // slightly hotter kit sheen, and there is no other signal for it.
    this.unbind = chain(this.unbind, ctx.events.on('sun:changed', (p: any) => {
      const h = typeof p?.hour === 'number' ? p.hour : 17;
      this.nightMix = h < 5.5 || h > 20.2 ? 1 : h > 19.0 ? (h - 19.0) / 1.2 : 0;
      this.dilation = this.nightMix;
      for (const w of this.worn) w.setDilation(this.dilation);
    }));
    this.bakeMs = now() - t0;
  }

  /* --------------------------------------------------------------- dress */

  /** Build and assign all seven materials for one athlete. */
  dress(rig: PlayerRig, o: DressOptions): WornPlayer {
    const kit = this.teams[Math.min(this.teams.length - 1, Math.max(0, o.team))];
    const slot = ((o.slot % this.squad) + this.squad) % this.squad;
    const params = rig.params as BodyParams;
    const seed = o.seed ?? params.seed ?? slot;
    const rand = forkFrom(seed);

    /* ---- biology ---------------------------------------------------- */
    const bio: SkinBio = randomSkin(rand);
    const hairCol = randomHair(rand, bio);
    const iris = randomIris(rand, bio);
    const tones = skinTones(bio);

    // A men's-side roster is mostly stubbled by the second half of an evening;
    // the generator's `frame` parameter is the rig's own androgyny axis, so
    // reuse it rather than inventing a second, contradictory one.
    const masc = 1 - Math.min(1, Math.max(0, params.frame));
    const stubble = masc > 0.45 ? 0.30 + rand.next() * 0.55 * masc : rand.next() * 0.10;
    const freckle = rand.next() < 0.24 && bio.melanin < 0.075
      ? 0.72 + rand.next() * 0.14 : 1.0;
    const bodyHair = masc * (0.25 + rand.next() * 0.6);

    /* ---- face geometry, straight off the rig's own sculpt ------------- */
    // Every mask in the skin shader — brow, lash, vermilion, stubble line — is
    // placed in the head's own sculpt coordinates. Reading the landmarks off
    // `headFrame` rather than repeating the numbers is what keeps a lip on the
    // lip of a 1.62 m athlete with a wide mouth and a 2.03 m one with a narrow
    // one, instead of on whichever face the constants were tuned against.
    const hf = headFrame(measureBody(params));
    const fp = params.face;

    const skin = makeSkinMaterial({
      tones, hair: hairCol, detail: this.detail, shared: this.shared,
      quality: this.quality,
      eye: { n: hf.eyeN, apW: hf.apW, apU: hf.apU, apD: hf.apD },
      face: {
        mouthW: (0.278 + 0.050 * fp.lips) * hf.vr.mouth,
        noseTip: -0.325 + hf.vr.noseY,
        ala: -0.372 + hf.vr.noseY,
        brow: fp.brow,
        hood: hf.vr.hood,
      },
      height: params.height, seed, stubble, freckle, bodyHair,
    });

    const cloth = makeClothMaterials({
      colourway: kit.colourway, atlas: kit.atlas, nameStrip: kit.names,
      nameRow: NAME_ROW_V(slot),
      detail: this.detail, shared: this.shared, quality: this.quality,
      number: kit.numbers[slot], height: params.height, seed,
    });

    const wear = 0.35 + rand.next() * 0.45;
    const gear = makeGearMaterials({
      colourway: kit.colourway, detail: this.detail, shared: this.shared,
      quality: this.quality, height: params.height, seed, wear,
    });

    const hair = makeHairMaterial({
      colour: hairCol, detail: this.detail, shared: this.shared,
      quality: this.quality, style: params.hair, bulk: params.hairBulk, seed,
    });

    const eyes = makeEyeMaterial({
      iris, shared: this.shared, quality: this.quality,
      // Iris 11.7 mm across a 24 mm globe is 0.49 of the globe RADIUS. The
      // first pass had it at 0.43 and every athlete looked startled. 0.455 was
      // the same mistake at half the size, and it was compounding with a globe
      // that was itself 1 mm under: the pair rendered a 10.4 mm iris. Real
      // irides run 10.2–13.0 mm, so this spans that and nothing wider.
      irisR: 0.478 + rand.next() * 0.050,
      pupilR: 0.135 + rand.next() * 0.030,
      seed,
    });

    const g = rig.groups;
    const old = rig.materials.slice();
    rig.materials[g.skin] = skin.material;
    rig.materials[g.jersey] = cloth.jersey;
    rig.materials[g.shorts] = cloth.shorts;
    rig.materials[g.socks] = gear.socks;
    rig.materials[g.shoes] = gear.shoes;
    rig.materials[g.hair] = hair.material;
    rig.materials[g.eyes] = eyes.material;
    // buildRig hands every LOD the SAME array instance, but a caller may have
    // reassigned one; re-point them so a partial rebuild cannot leave a level
    // wearing the placeholder grey.
    for (const l of rig.lods) l.mesh.material = rig.materials;
    for (const m of old) m.dispose();

    // Deterministic starting exertion so a still capture is never a frame of
    // fourteen dry athletes standing in a July evening.
    const base = 0.30 + rand.next() * 0.30;
    const worn: WornPlayer = {
      team: o.team, slot, playerId: o.playerId,
      number: kit.numbers[slot], name: kit.surnames[slot],
      sweat: base,
      setSweat(v: number) {
        const s = Math.max(0, Math.min(1, v));
        this.sweat = s;
        skin.setSweat(s);
        cloth.setSweat(s);
        gear.setSweat(s);
        hair.setWet(s * 0.55);
      },
      setWear(v: number) { gear.setWear(Math.max(0, Math.min(1, v))); },
      setDilation(v: number) { eyes.setDilation(Math.max(0, Math.min(1, v))); },
      dispose() {
        skin.material.dispose(); cloth.dispose(); gear.dispose();
        hair.material.dispose(); eyes.material.dispose();
      },
    };
    worn.setSweat(base);
    worn.setDilation(this.dilation);
    this.worn.push(worn);
    return worn;
  }

  /* -------------------------------------------------------------- update */

  /**
   * Per frame. Two jobs: refresh the shared sun uniforms against the current
   * camera, and pull exertion off Locomotion if it is present. Both are cheap —
   * three writes and one map lookup per athlete — because every athlete shares
   * one uniform object for everything that is not personal.
   */
  update(ctx: Ctx): void {
    this.shared.update(ctx.camera, ctx.time);
    const loco = ctx.sys.locomotion as unknown as
      { get?(id: number): { stamina?: number } | undefined } | undefined;
    if (!loco || typeof loco.get !== 'function') return;
    for (const w of this.worn) {
      if (w.playerId === undefined) continue;
      const p = loco.get(w.playerId);
      const st = p && typeof p.stamina === 'number' ? p.stamina : undefined;
      if (st === undefined) continue;
      // Sweat is a slow integral of effort, not an instantaneous readout, so it
      // is chased rather than set — a hard cut on a cut-back would flicker.
      const target = Math.max(0.22, Math.min(1, (100 - st) / 62));
      w.setSweat(w.sweat + (target - w.sweat) * Math.min(1, ctx.dt * 0.35));
    }
  }

  /* -------------------------------------------------------------- report */

  get textureBytes(): number {
    let b = this.detail.bytes;
    for (const t of this.teams) b += t.atlas.bytes + texBytes(t.names);
    return b;
  }

  /** One line, for the boot log. Measured, not estimated. */
  /**
   * Who a team's slots actually are. The kit bake is the single source of truth
   * for identity because the name strip is a TEXTURE — the row is fixed when it
   * is baked, and slot `i` samples row `i`. Anything that wants to name a player
   * (the broadcast card, the roster, a commentary line) reads it from here
   * rather than deriving its own, which is how the card and the shirt stay in
   * agreement.
   */
  squadOf(team: TeamId): { numbers: number[]; surnames: string[]; given: string[] } | null {
    const k = this.teams[team];
    return k ? { numbers: k.numbers, surnames: k.surnames, given: k.given } : null;
  }

  report(): string {
    const mb = (n: number) => `${(n / 1048576).toFixed(2)} MB`;
    let team = 0;
    for (const t of this.teams) team += t.atlas.bytes + texBytes(t.names);
    return `players/material ${this.tier} · shared ${mb(this.detail.bytes)}`
      + ` + ${this.teams.length} team kits ${mb(team)}`
      + ` = ${mb(this.textureBytes)} for ${this.worn.length} dressed`
      + ` · bake ${this.bakeMs.toFixed(0)} ms`;
  }

  teamColourway(team: TeamId): Colourway {
    return this.teams[Math.min(this.teams.length - 1, Math.max(0, team))].colourway;
  }

  dispose(): void {
    for (const w of this.worn) w.dispose();
    this.worn.length = 0;
    for (const t of this.teams) { t.atlas.texture.dispose(); t.names.dispose(); }
    this.teams.length = 0;
    this.detail.dispose();
    this.unbind?.();
    this.unbind = null;
  }
}

/* ------------------------------------------------------------------ utils */

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function chain(a: (() => void) | null, b: () => void): () => void {
  return () => { a?.(); b(); };
}

/** A local xorshift so `dress` is reproducible from the seed alone. */
function forkFrom(seed: number) {
  let a = (seed * 0x9e3779b9) >>> 0 || 0x1234567;
  let b = (a ^ 0x85ebca6b) >>> 0, c = (a ^ 0xc2b2ae35) >>> 0, d = (a ^ 0x27d4eb2f) >>> 0;
  const next = () => {
    let t = d; const s = a;
    d = c; c = b; b = s;
    t ^= t << 11; t ^= t >>> 8;
    a = (t ^ s ^ (s >>> 19)) >>> 0;
    return a / 4294967296;
  };
  for (let i = 0; i < 16; i++) next();
  return {
    next,
    range: (lo: number, hi: number) => lo + (hi - lo) * next(),
    gauss: () => {
      const u = Math.max(1e-7, next());
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
    },
  };
}

export { COLOURWAYS };
