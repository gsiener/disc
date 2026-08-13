import * as THREE from 'three';
import { EventBus, QUALITY_PRESETS, Rng, type Ctx } from '../../src/core/Ctx.ts';
import { GameSystem } from '../../src/sim/Game.ts';

/**
 * `Game.doPull`, captured directly. Issue #48/#2: `Engine.autoPull` used to be an
 * independently invented pull rather than a port of this method, and every property
 * test written against it (`EngineSeamTests.thePullIsSolvedForThePitchItIsThrownOn`)
 * proved a *distribution* — carries a plausible distance, stays in bounds — which
 * cannot see "the aim, the speed, the bank and the nose are each the wrong formula but
 * happen to still land somewhere on the pitch". This fixture pins the actual numbers
 * `doPull` computes: the release origin, the constructed aim vector, and the throw
 * parameters that override `power`, for a handful of deterministic seeds.
 *
 * `GameSystem.init(ctx)` runs `buildRoster`, `startGame` and `lineUpForPull` in that
 * order and leaves the machine sitting in `PRE_PULL` with nobody moved a tick — so
 * `doPull()` is called directly, with no `update()` loop in between, exactly as
 * `regulationPull` is on the Swift side straight out of `Engine.init`. Both engines are
 * therefore comparing the *first* draw either one takes from its match-local `rng`
 * stream, which is what makes the seeded jitter term line up without hand-steering it.
 *
 * `doPull` and `discRuntime.release` are both private; `doPull` is reached via a cast
 * (the same escape hatch `tools/test-game.ts` already uses throughout for
 * `InputHost`-shaped internals) and the exact `ThrowRequest` it builds is captured by
 * wrapping `release` for the duration of one call, then restoring it — nothing here
 * reimplements `doPull`'s arithmetic, it only observes what the real method does.
 *
 * **The puller's `pos`/`facing`/`groundY`/`hipHeight` are exported too, and the Swift
 * side sets them explicitly before calling `autoPull()` rather than trusting its own
 * pre-pull formation to land in the same place.** `lineUpForPull`'s x/z formula (hard
 * against the sideline, `i/6` across the line) and `Engine.stagePoint`'s own opening
 * shape (`(slot/span - 0.5) * width * 0.6`) are different formulas — measured, they
 * disagree by the 0.6/0.95 scale factors baked into each — and reconciling them is a
 * separate concern from `doPull`'s own arithmetic, which is the one this fixture exists
 * to pin. Engineering the position directly means this fixture is exactly as broad as
 * the bug it was written for.
 */

function makeCtx(seed: number): Ctx {
  return {
    renderer: null as unknown as THREE.WebGLRenderer,
    scene: null as unknown as THREE.Scene,
    camera: null as unknown as THREE.PerspectiveCamera,
    composer: null,
    time: 0, dt: 0, rawDt: 0, timeScale: 1, frame: 0,
    width: 1920, height: 1080, dpr: 1,
    quality: { ...QUALITY_PRESETS.high },
    events: new EventBus(),
    rand: new Rng(seed),
    sys: Object.create(null),
    debug: false,
    capture: false,
  };
}

/** Seeds chosen only for spread across puller/handedness/throwPower — nothing tuned. */
const SEEDS = [11, 22, 33, 44, 55, 66, 77, 88];

function runOnePull(seed: number) {
  const ctx = makeCtx(seed);
  const game = new GameSystem() as unknown as {
    init(ctx: Ctx): void;
    roster: {
      id: number; team: number;
      ai: { handed: 'left' | 'right'; attr: { throwPower: number } };
      loco: {
        pos: { x: number; y: number; z: number }; facing: number;
        groundY: number; hipHeight: number;
      };
    }[];
    gs: { pullingTeam: number; attackDir: [number, number] };
    discRuntime: { release(req: unknown): THREE.Vector3 };
    doPull(): void;
  };

  let captured: { team: number; playerId: number; from: THREE.Vector3; vel?: THREE.Vector3 } | null = null;
  ctx.events.on('pull', (p: any) => { captured = p; });

  let capturedReq: any = null;
  game.init(ctx);

  const originalRelease = game.discRuntime.release.bind(game.discRuntime);
  game.discRuntime.release = (req: any) => {
    capturedReq = req;
    return originalRelease(req);
  };

  game.doPull();
  // Restore, so nothing about this generator's spying survives past the one call.
  game.discRuntime.release = originalRelease;

  if (!captured) throw new Error(`seed ${seed}: doPull did not emit a 'pull' event`);
  const c = captured as { team: number; playerId: number; from: THREE.Vector3; vel?: THREE.Vector3 };
  const puller = game.roster.find((r) => r.id === c.playerId)!;

  return {
    seed,
    pullingTeam: game.gs.pullingTeam,
    attackDir: game.gs.attackDir[game.gs.pullingTeam],
    puller: {
      id: puller.id,
      team: puller.team,
      handed: puller.ai.handed,
      throwPower: puller.ai.attr.throwPower,
      pos: { x: puller.loco.pos.x, y: puller.loco.pos.y, z: puller.loco.pos.z },
      facing: puller.loco.facing,
      groundY: puller.loco.groundY,
      hipHeight: puller.loco.hipHeight,
    },
    request: {
      type: capturedReq.type,
      from: { x: capturedReq.from.x, y: capturedReq.from.y, z: capturedReq.from.z },
      aim: { x: capturedReq.aim.x, y: capturedReq.aim.y, z: capturedReq.aim.z },
      power: capturedReq.power,
      angle: capturedReq.angle,
      spin: capturedReq.spin,
      bank: capturedReq.bank,
      nose: capturedReq.nose,
      speed: capturedReq.speed,
      hand: capturedReq.hand,
    },
    from: { x: c.from.x, y: c.from.y, z: c.from.z },
    vel: c.vel ? { x: c.vel.x, y: c.vel.y, z: c.vel.z } : null,
  };
}

export function pullGoldens() {
  const cases = SEEDS.map(runOnePull);
  return {
    note:
      "Generated by tools/gen-goldens.ts from src/sim/Game.ts's doPull(), captured " +
      "directly (see tools/goldens/pull.ts) rather than reimplemented — issue #48/#2. " +
      "Each case is one seed's GameSystem straight out of init(), with doPull() called " +
      "before any update() tick, so `request` is the exact ThrowRequest doPull hands " +
      "discRuntime.release and `vel` is that release's own output. The Swift side " +
      "(PullTests.swift) builds Engine(format: .sevens, seed:) with a matching " +
      "startingPullTeam and calls autoPull() the same way, straight out of init.",
    cases,
  };
}
