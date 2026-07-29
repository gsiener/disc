import type { System } from './core/Ctx';

import { SkySystem } from './render/Sky';
import { LightingSystem } from './render/Lighting';
import { FieldSystem } from './world/Field';
import { GrassSystem } from './world/Grass';
import { StadiumSystem } from './world/Stadium';
import { CrowdSystem } from './world/Crowd';
import { PlayersSystem } from './entities/Players';
import { DiscSystem } from './entities/Disc';
import { GameSystem } from './sim/Game';
import { InputSystem } from './input/Input';
import { CameraDirector } from './camera/Director';
import { HudSystem } from './ui/Hud';
import { AudioSystem } from './audio/Audio';
import { PostFXSystem } from './render/PostFX';

/**
 * The engine's system list, in construction order. `order` on each class decides
 * init and update sequencing; PostFX is pinned last because it must wrap the
 * final scene and camera.
 */
export function buildSystems(): System[] {
  return [
    new SkySystem(),
    new LightingSystem(),
    new FieldSystem(),
    new GrassSystem(),
    new StadiumSystem(),
    new CrowdSystem(),
    new PlayersSystem(),
    new DiscSystem(),
    new GameSystem(),
    new InputSystem(),
    new CameraDirector(),
    new HudSystem(),
    new AudioSystem(),
    new PostFXSystem(),
  ];
}
