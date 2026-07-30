import * as THREE from 'three';
import type { Ctx, System } from '../core/Ctx.ts';
import { buildRig, randomBodyParams } from './PlayerRig.ts';
import type { BodyParams, PlayerRig } from './PlayerRig.ts';
import { PlayerMaterialLibrary } from './PlayerMaterial.ts';
import type { WornPlayer } from './PlayerMaterial.ts';
import { Animator } from './Animator.ts';
import type { AnimHandle, LocoLike } from './Animator.ts';

/**
 * ============================================================================
 *  PLAYERS — the fourteen athletes on the pitch
 * ============================================================================
 *
 * This is the integration point for the three character modules that were built
 * in isolation and, until now, had never been in a rendered frame:
 *
 *   PlayerRig.ts        geometry — a ~60-bone procedural humanoid per athlete,
 *                       unique per parameter vector, three LODs, seven submesh
 *                       groups (skin/jersey/shorts/socks/shoes/hair/eyes).
 *   PlayerMaterial.ts   look — procedural skin with SSS, woven kit with heat
 *                       pressed numerals, anisotropic hair, parallax eyes.
 *                       One shared detail atlas for the whole roster.
 *   Animator.ts         motion — reads `sim/Locomotion`'s per-player state and
 *                       writes 60 bone quaternions: gait, two-bone foot IK,
 *                       throws, catches, layouts, gaze, breath.
 *
 * WHERE THE NUMBERS COME FROM. This system owns no simulation. Bodies come from
 * `ctx.sys.game.roster` (each entry carries the `LocoPlayer` that `Locomotion`
 * integrates); the disc's held/flight state comes from `ctx.sys.game.discRuntime`;
 * the ground comes from `ctx.sys.field.heightAt`. Every one of those is optional
 * — with no game system present the roster falls back to fourteen stand-in
 * bodies in a 7v7 line so the rig, the kit and the pose code can still be judged.
 *
 * ----------------------------------------------------------------------------
 * PUBLIC API (read off `ctx.sys.players`; nothing here mutates the simulation)
 * ----------------------------------------------------------------------------
 *   players : readonly PlayerView[]        the roster, index-ordered
 *   get(id) : PlayerView | undefined       per-id lookup
 *   handBone(id, side?)                    THREE.Bone — the hand the disc hangs
 *                                          off. `side` omitted = throwing hand.
 *   handWorld(id, side, out) : boolean     that bone's world position
 *   discAnchor(id, pos, normal) : boolean  THE contract `sim/Game.ts` probes for
 *                                          (`carryFromRig`): fills `pos` with the
 *                                          world point the disc sits at in the
 *                                          grip and `normal` with its face
 *                                          direction. Returns false for unknown
 *                                          ids, which is the game's signal to
 *                                          fall back to a hip offset.
 *   report() : string                      one measured line for the boot log
 *
 * A `PlayerView` carries `{ id, team, number, name, rig, handle, worn, loco }`,
 * so a caller that wants a bone, a material or an animation intent has it
 * without reaching through three modules.
 *
 * ----------------------------------------------------------------------------
 * FRAME ORDER
 * ----------------------------------------------------------------------------
 * `update()` does nothing — the pose is a display concern and running it on the
 * 120 Hz fixed step doubles its cost for nothing a display can see. Everything
 * happens in `lateUpdate()`, after the game has stepped every body:
 *
 *   1  read the disc (held / in flight / dead) and publish the gaze target
 *   2  per athlete: carrying, marking, reach-for — the four intent fields
 *   3  Animator.update  — 60 bones × 14 athletes, two FK passes each
 *   4  re-anchor a held disc onto the hand the animator actually produced
 *   5  PlayerMaterialLibrary.update — sun uniforms + sweat off stamina
 *
 * Step 4 matters more than it looks. `Game.carryDisc()` only runs on a simulated
 * frame; the capture rig latches a tableau and then advances 150 frames with the
 * game frozen, so without this the disc would sit where the hand was on the
 * frame the tableau was applied and the athlete would breathe out from under it.
 *
 * SCALE. `randomBodyParams` generates the physique, but `height` is overwritten
 * from the simulation's `attr.height` for that player — Locomotion derives hip
 * height, stride and standing reach from it, and a rig that disagrees puts the
 * feet through the turf. The rig root is at the FEET and is driven to
 * `loco.groundY`, which is `ctx.sys.field.heightAt` under that body.
 *
 * DETERMINISM. Everything is forked from `ctx.rand`: body parameters, kit slot
 * salt, handedness. Same seed, same fourteen humans, same frame.
 *
 * COST at `high` (charDetail 1.0), measured in the capture rig and reported by
 * `report()`: geometry build is a one-off at init; per frame the roster is
 * 7 draw calls per visible LOD per athlete, times the shadow cascade count.
 * `ctx.quality.charDetail` drives both the mesh density and the LOD count (2
 * levels below 0.6, 3 at and above it), so `low` pays roughly a third.
 */

/* ------------------------------------------------------- peer shapes (duck) */

/** `ctx.sys.field` — the turf. */
interface FieldLike {
  heightAt?(x: number, z: number): number;
  normalAt?(x: number, z: number, out?: THREE.Vector3): THREE.Vector3;
}

/** One `sim/Game.ts` roster entry, structurally. */
interface RosterEntryLike {
  id: number;
  team: number;
  number?: number;
  name?: string;
  loco: LocoLike & { attr?: { height: number } };
}

/** `ctx.sys.game.discRuntime` — enough of it to place a held disc. */
interface DiscRuntimeLike {
  mode: string;
  holderId: number;
  state: { pos: THREE.Vector3; vel: THREE.Vector3 };
  hold?(id: number, pos: THREE.Vector3, normal: THREE.Vector3, spinPhase?: number): void;
}

/** `ctx.sys.game` — every field optional; absent means "run standalone". */
interface GameLike {
  roster?: ReadonlyArray<RosterEntryLike>;
  discRuntime?: DiscRuntimeLike;
  gs?: { thrower?: number | null; marker?: number | null };
}

/* --------------------------------------------------------------- the view */

export interface PlayerView {
  id: number;
  team: 0 | 1;
  /** Squad number as printed on the jersey (from the kit, not the sim). */
  number: number;
  /** Surname as printed on the back. */
  name: string;
  rig: PlayerRig;
  handle: AnimHandle;
  worn: WornPlayer;
  loco: LocoLike;
  /** The throwing hand. `handBone(id)` returns this. */
  throwHand: THREE.Bone;
}

/* -------------------------------------------------------------- constants */

/** Marking range: a defender this close to the thrower is on the mark. */
const MARK_RADIUS = 3.2;
/** The force. Both AI teams are configured 'forehand', so the mark is too. */
const FORCE: -1 | 1 = -1;
/** Reach for a disc in flight inside this radius (standing). */
const REACH_RADIUS = 1.9;
/** …and this one when already committed to the air. */
const REACH_RADIUS_AIR = 3.4;

/* ---------------------------------------------------------------- scratch */

const _pos = new THREE.Vector3();
const _norm = new THREE.Vector3();
const _gaze = { x: 0, y: 0, z: 0 };

/* ----------------------------------------------------------------- system */

export class PlayersSystem implements System {
  readonly name = 'players';
  readonly order = 6;

  readonly players: PlayerView[] = [];
  private byId = new Map<number, PlayerView>();

  private anim = new Animator();
  private kits: PlayerMaterialLibrary | null = null;
  private game: GameLike | undefined;
  private disc: DiscRuntimeLike | undefined;
  private offs: Array<() => void> = [];

  /* measured, for report() */
  private buildMs = 0;
  private triangles = 0;

  /* ------------------------------------------------------------------ init */

  init(ctx: Ctx): void {
    const t0 = now();

    this.game = ctx.sys['game'] as unknown as GameLike | undefined;
    this.disc = this.game?.discRuntime;

    const bodies = this.collectBodies(ctx);

    this.kits = new PlayerMaterialLibrary(ctx, { teams: ['home', 'away'], squad: 7 });

    this.anim.detail = ctx.quality.charDetail;
    this.anim.field = (ctx.sys['field'] as unknown as FieldLike | undefined) ?? null;

    const levels = ctx.quality.charDetail < 0.6 ? 2 : 3;

    for (let i = 0; i < bodies.length; i++) {
      const e = bodies[i];
      const loco = e.loco;
      const team = (e.team === 1 ? 1 : 0) as 0 | 1;
      const slot = i % 7;

      // Physique. Forked per id so adding a system upstream cannot reshuffle
      // the roster, and heights are pinned to what the sim already believes.
      const params: BodyParams = randomBodyParams(ctx.rand.fork(e.id * 7919 + 13));
      const simH = loco.attr?.height;
      if (typeof simH === 'number' && simH > 1.3 && simH < 2.3) params.height = simH;

      const rig = buildRig(params, { charDetail: ctx.quality.charDetail, levels });
      this.triangles += rig.triangles;

      // Kit, skin, hair, eyes. Writes straight into rig.materials, which every
      // LOD shares, so one call clothes all three levels.
      const worn = this.kits.dress(rig, { team, slot, playerId: e.id, seed: params.seed });

      rig.root.name = `player.${e.id}`;
      rig.root.position.set(loco.pos.x, loco.groundY, loco.pos.z);
      rig.root.rotation.y = loco.facing;
      for (const l of rig.lods) { l.mesh.castShadow = true; l.mesh.receiveShadow = true; }
      ctx.scene.add(rig.root);

      const handle = this.anim.add(rig, loco, { id: e.id });
      // Right-handed athletes throw off rig -X; `handed` is +1 for a lefty.
      const throwHand = handle.handed === 1 ? rig.bones.hand_L : rig.bones.hand_R;

      const view: PlayerView = {
        id: e.id, team,
        number: worn.number,
        name: worn.name,
        rig, handle, worn, loco, throwHand,
      };
      this.players.push(view);
      this.byId.set(e.id, view);
    }

    // Throws, catches and turnovers arrive off the bus for free.
    this.offs.push(this.anim.bindEvents(ctx.events));
    // A tableau teleports every body across the pitch. The foot solver pins the
    // ankle to a world plant point, so without re-seeding the stance the legs
    // reach back toward wherever the athlete used to be standing.
    this.offs.push(ctx.events.on('shot:applied', () => this.resync()));

    this.buildMs = now() - t0;
    this.resync();
    // Pose once at init so the very first rendered frame is athletes and not a
    // roster of bind-pose mannequins.
    this.lateUpdate(1 / 60, ctx);
  }

  /**
   * Fourteen bodies. Preferred source is the game's roster (those are the ones
   * Locomotion actually integrates); absent that, stand-ins so the character
   * work is still judgeable on its own.
   */
  private collectBodies(ctx: Ctx): RosterEntryLike[] {
    const roster = this.game?.roster;
    if (roster && roster.length) return roster.slice(0, 14);

    const field = ctx.sys['field'] as unknown as FieldLike | undefined;
    const out: RosterEntryLike[] = [];
    for (let i = 0; i < 14; i++) {
      const team = i < 7 ? 0 : 1;
      const x = (i % 7 - 3) * 3.4;
      const z = team === 0 ? -4 : 4;
      const y = typeof field?.heightAt === 'function' ? field.heightAt(x, z) : 0;
      out.push({
        id: i, team, number: i % 7 + 1, name: `P${i}`,
        loco: standIn(i, x, z, y, team === 0 ? 0 : Math.PI),
      });
    }
    return out;
  }

  /* --------------------------------------------------------------- per frame */

  lateUpdate(dt: number, ctx: Ctx): void {
    if (!this.players.length) return;

    /* 1 — the disc, and what everyone is looking at ------------------------- */
    const disc = this.disc;
    const held = disc ? disc.mode === 'held' && disc.holderId >= 0 : false;
    const flying = disc ? disc.mode === 'flight' : false;
    if (disc && (held || flying)) {
      _gaze.x = disc.state.pos.x; _gaze.y = disc.state.pos.y; _gaze.z = disc.state.pos.z;
      this.anim.gaze = _gaze;
    } else {
      // A dead disc on the far side of the pitch is not what anyone is looking
      // at; null falls back to the animator's own "look where you are going".
      this.anim.gaze = null;
    }

    /* 2 — intent, four fields per athlete ----------------------------------- */
    const thrower = held && disc ? disc.holderId : -1;
    const throwerView = thrower >= 0 ? this.byId.get(thrower) : undefined;

    for (let i = 0; i < this.players.length; i++) {
      const p = this.players[i];
      const h = p.handle;
      const loco = p.loco;

      h.carrying = p.id === thrower;

      // The mark: a defender inside disc-space range of the thrower.
      let mark: 0 | 1 | -1 = 0;
      if (throwerView && throwerView.team !== p.team) {
        const t = throwerView.loco.pos;
        const dx = loco.pos.x - t.x, dz = loco.pos.z - t.z;
        if (dx * dx + dz * dz < MARK_RADIUS * MARK_RADIUS) mark = FORCE;
      }
      h.marking = mark;

      // Hands onto a disc that is actually catchable. `reachFor` classifies the
      // catch (pancake / rim / sky / scoop / trail) from the athlete's own
      // shoulder and eye height, so a tall player skies what a short one jumps.
      if (flying && disc) {
        const airborne = loco.air.airborne || loco.state === 'layout' || loco.state === 'jump';
        const r = airborne ? REACH_RADIUS_AIR : REACH_RADIUS;
        const dx = disc.state.pos.x - loco.pos.x;
        const dy = disc.state.pos.y - loco.pos.y;
        const dz = disc.state.pos.z - loco.pos.z;
        if (dx * dx + dy * dy + dz * dz < r * r) h.reachFor(disc.state.pos, disc.state.vel);
        else if (h.reachPos) h.releaseReach();
      } else if (h.reachPos && !held) {
        h.releaseReach();
      }
    }

    /* 3 — pose ------------------------------------------------------------- */
    this.anim.update(dt, ctx);

    /* 4 — put the disc back in the hand the animator just produced ---------- */
    if (held && disc?.hold && thrower >= 0 && this.byId.has(thrower)) {
      if (this.anim.discAnchor(thrower, _pos, _norm)
        && Number.isFinite(_pos.x) && _norm.lengthSq() > 1e-6) {
        // The roll about the face normal is a property of the grip, not of the
        // clock: a held disc must not twirl while the athlete stands still.
        disc.hold(thrower, _pos, _norm.normalize(), 0.35 + thrower * 0.41);
      }
    }

    /* 5 — materials -------------------------------------------------------- */
    this.kits?.update(ctx);
  }

  /**
   * Re-seed everything that remembers a world position. Called after a shot
   * teleports the roster.
   */
  private resync(): void {
    for (const p of this.players) {
      const f = p.handle.feet;
      f.seeded = false;
      f.wasMoving = false;
      f.wasFree = false;
      f.seenPlantT = p.loco.foot.t;
      p.handle.releaseReach();
    }
  }

  /* ------------------------------------------------------------------ peers */

  get(id: number): PlayerView | undefined { return this.byId.get(id); }

  /**
   * `sim/Game.ts` probes `ctx.sys.players.discAnchor` before falling back to a
   * hip offset — see `carryFromRig`. Fills `pos` with the world point the disc
   * centre occupies in the grip and `normal` with its face direction.
   */
  discAnchor = (id: number, pos: THREE.Vector3, normal: THREE.Vector3): boolean =>
    this.anim.discAnchor(id, pos, normal);

  /** The bone the disc hangs off. `side` omitted picks the throwing hand. */
  handBone(id: number, side?: 1 | -1): THREE.Bone | null {
    const p = this.byId.get(id);
    if (!p) return null;
    if (side === undefined) return p.throwHand;
    return side === 1 ? p.rig.bones.hand_L : p.rig.bones.hand_R;
  }

  /** World position of a hand. `side` +1 is the athlete's left. */
  handWorld(id: number, side: 1 | -1, out: THREE.Vector3): boolean {
    return this.anim.handWorld(id, side, out);
  }

  /** One line for the boot log. Measured, not estimated. */
  report(): string {
    const lods = this.players[0]?.rig.lods.map((l) => l.triangles).join('/') ?? '-';
    return `players ${this.players.length} · ${(this.triangles / 1000).toFixed(1)}k tris`
      + ` (lod ${lods}) · build ${this.buildMs.toFixed(0)} ms`
      + ` · pose ${this.anim.msAvg.toFixed(2)} ms/frame`
      + (this.kits ? ` · ${this.kits.report()}` : '');
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
    for (const p of this.players) {
      p.rig.root.removeFromParent();
      p.rig.dispose();
    }
    this.players.length = 0;
    this.byId.clear();
    this.anim.clear();
    this.kits?.dispose();
    this.kits = null;
  }
}

/* ------------------------------------------------------------------ utils */

const now = (): number =>
  (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * A body the animator can drive when there is no simulation present. Same shape
 * `Locomotion` publishes; static, upright, feet on the deck.
 */
function standIn(
  id: number, x: number, z: number, groundY: number, facing: number,
): LocoLike & { attr: { height: number } } {
  const height = 1.72 + ((id * 37) % 23) * 0.012;
  const hipHeight = 0.53 * height;
  return {
    id,
    pos: { x, y: groundY + hipHeight, z },
    vel: { x: 0, y: 0, z: 0 },
    facing,
    state: 'idle',
    stateT: 1,
    stateDur: 0,
    prone: false,
    stamina: 88,
    foot: {
      planted: 'R', pos: { x, y: groundY, z }, t: 0, contact: true,
      phase: ((id * 97) % 100) / 100, stride: 0, hard: false, speed: 0,
    },
    air: {
      airborne: false, tTakeoff: 0, tApex: 0, apexY: 0,
      takeoffY: 0, tLand: 0, vy0: 0,
    },
    groundY,
    groundN: { x: 0, y: 1, z: 0 },
    hipHeight,
    cutDir: { x: 0, y: 0, z: 0 },
    cutEntrySpeed: 0,
    cutAngle: 0,
    t: 0,
    attr: { height },
    derived: { topSpeed: 8 },
  };
}
