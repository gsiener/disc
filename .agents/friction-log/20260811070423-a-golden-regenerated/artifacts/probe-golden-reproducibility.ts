/** Probe: which committed goldens differ from a fresh regeneration on this tree? */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { coeffGoldens } from './goldens/coeffs.ts';
import { aiMathGoldens } from './goldens/aimath.ts';
import { discRuntimeGoldens } from './goldens/discruntime.ts';
import { catchBandGoldens } from './goldens/catchband.ts';
import { divergenceGoldens } from './goldens/divergences.ts';
import { flightGoldens } from './goldens/flight.ts';
import { teamAIGoldens } from './goldens/teamai.ts';
import { humanReleaseGoldens } from './goldens/humanrelease.ts';
import { gameStateGoldens } from './goldens/gamestate.ts';
import { locomotionGoldens } from './goldens/locomotion.ts';
import { moveGoldens } from './goldens/move.ts';
import { playbookGoldens } from './goldens/playbook.ts';
import { rngGoldens } from './goldens/rng.ts';
import { rulesGoldens } from './goldens/rules.ts';
import { simMathGoldens } from './goldens/simmath.ts';
import { throwGoldens } from './goldens/throws.ts';
import { throwSolverGoldens } from './goldens/throwsolver.ts';
import { tryCatchGoldens } from './goldens/trycatch.ts';

const OUT = join(import.meta.dirname, '..', 'swift', 'Sources', 'SimChecks', 'Goldens');
const GEN: Record<string, () => unknown> = {
  'rng.json': rngGoldens, 'coeffs.json': coeffGoldens, 'simmath.json': simMathGoldens,
  'flight.json': flightGoldens, 'throws.json': throwGoldens, 'rules.json': rulesGoldens,
  'gamestate.json': gameStateGoldens, 'move.json': moveGoldens,
  'locomotion.json': locomotionGoldens, 'playbook.json': playbookGoldens,
  'aimath.json': aiMathGoldens, 'humanrelease.json': humanReleaseGoldens,
  'discruntime.json': discRuntimeGoldens, 'teamai.json': teamAIGoldens,
  'throwsolver.json': throwSolverGoldens, 'trycatch.json': tryCatchGoldens,
  'catchband.json': catchBandGoldens, 'divergences.json': divergenceGoldens,
};

for (const [name, gen] of Object.entries(GEN)) {
  const fresh = JSON.stringify(gen(), null, 2) + '\n';
  const have = readFileSync(join(OUT, name), 'utf8');
  console.log(`${fresh === have ? 'same  ' : 'MOVED '} ${name}`);
}
