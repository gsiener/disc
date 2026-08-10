# Friction log index

Generated from each entry's frontmatter. **Scan this before starting a task** —
a diagnosis in here has twice been reconstructed from scratch days later at a cost
of hours, because writing entries worked and reading them did not.

| severity | entry | title |
|---|---|---|
| major | `20260804165649-tools-capture-mjs` | tools/capture.mjs freezes the world, so it cannot verify anything that moves |
| minor | `20260805180039-capture-live-mjs` | capture-live.mjs dies mid-run with TargetCloseError and leaves a short series |
| minor | `20260805180841-capture-live-mjs` | capture-live.mjs wedges on Page.captureScreenshot at 1280x720 too, not just 1080p |
| minor | `20260805185419-turf-mow-lay` | Turf mow lay double-counts: normal tilt and albedo term can cancel, and whether they do depends on sun azimuth vs lay axis |
| minor | `20260805185508-the-mow-lay` | The mow LAY DIRECTION is duplicated in the turf shader and the grass system with nothing shared but a width constant |
| minor | `20260805192110-npx-tsc-noemit` | npx tsc --noEmit cannot verify your own work while peers are mid-edit |
| minor | `20260805193609-a-backtick-in` | A backtick in a GLSL comment silently ends the shader template literal, and tsc blames the wrong line |
| minor | `20260805193950-a-peer-agent` | A peer agent saving any src/ file full-reloads the capture page and kills the run mid-series |
| minor | `20260805210418-boardprobe-mjs-measures` | _boardprobe.mjs measures only one of the venue''s three board surfaces, so a repeat that moves between them reads as fixed |
| major | `20260805213329-capture-live-mjs` | capture-live.mjs has no input driver, so the human player is a statue and stalls every possession he starts |
| minor | `20260805215755-part-forearm-and` | PART.FOREARM and PART.SHIN are declared in the rig but never written, so isPart(P_FOREARM) is identically zero |
| minor | `20260805220550-a-peer-s` | A peer''s transient syntax error in ANY src/ file fails your capture as a 180 s puppeteer timeout, not as a compile error |
| minor | `20260805220847-the-head-mesh` | The head mesh is tessellated at ~5 mm at the mouth, but every mouth feature in faceSurface is a 1.5-4 mm Gaussian |
| minor | `20260805221042-a-peer-s` | A peer''s syntax error takes down every other agent''s capture rig for 3 minutes and reports it as a puppeteer timeout |
| minor | `20260805221218-skin-ts-was` | Skin.ts was handed over in a state that cannot compile: three backtick pairs inside GLSL comments, added after the reference screenshot was taken |
| minor | `20260805230939-the-hair-cap` | The hair cap''s value is 95% one un-occluded halo term, so six rounds of albedo and fibre work could not move it |
| minor | `20260805231009-section-4-is` | Section 4 is countable only with a per-material mask pass, and capture.mjs has none — so every round has hand-boxed its own numbers |
| minor | `20260805234124-a-backtick-in` | A backtick in a GLSL comment is now on its third recurrence, and reading the existing entry does not prevent it |
| minor | `20260805234533-an-autocorrelation-threshold` | An autocorrelation threshold reports a clean hair cap as 55% corduroy, because smoothness autocorrelates and periodicity is a LOCAL MAXIMUM |
| minor | `20260805235315-six-rounds-measured` | Six rounds measured the vermilion against a box sitting on the underside of the nose, so the mouth could not be fixed by fixing the mouth |
| minor | `20260805235345-a-debug-albedo` | A debug albedo cannot be read as an absolute value: the tone curve makes ''is the albedo load-bearing'' answerable only as a ratio against a flat pass |
| minor | `20260805235727-the-cheap-is` | The cheap ''is the tree green'' gate the peer-syntax-error entries ask for already ships in node_modules: esbuild, 0.2 s for all of src/ |
| minor | `20260806003039-the-offlineaudiocontext-probe` | The OfflineAudioContext probe measures the graph''s startup ramp, not the match |
| minor | `20260806003414-a-bright-ground` | A bright ground hemisphere in an env map silently costs you the whole map, because three''s irradiance lookup is a GGX convolution |
| minor | `20260806003547-the-hair-cap` | The hair cap is 1.34x lit-over-shadow where the face under it is 1.84x, so the hairline step changes SIGN across the head |
| minor | `20260806004345-graph-reap-deletes` | Graph.reap() deletes every transient from an OfflineAudioContext render before it makes a sample |
| minor | `20260806010144-blocking-vite-client` | Blocking /@vite/client makes a browser probe immune to peer agents saving files |
| minor | `20260806011515-measured-numbers-in` | Measured numbers in comments do not say which camera they were measured on, and the camera moved |
| minor | `20260806011527-task-brief-said` | Task brief said the file was untouched ground; the whole feature was already in HEAD with six probes for it |
| minor | `20260806014721-section-4-7` | Section 4.7''s bright-scalp clause is unsatisfiable from Hair.ts: it fails on the very comb it also demands |
| minor | `20260806014754-a-lit-shadow` | A lit/shadow split is still too coarse for a hair cap: the front and the temple of the SAME half fail in opposite directions, through different terms |
| minor | `20260806014822-backtick-in-a` | Backtick in a GLSL comment, fourth recurrence — I hit it 20 minutes after reading the entry that warns about it |
| major | `20260806025711-three-s-clearcoat` | three''s clearcoat bypasses reflectedLight entirely, so every socket occlusion written against reflectedLight.* misses the brightest term on the material |
| major | `20260806025738-docs-face-direction` | docs/face-direction.md quotes luminance in sRGB-ENCODED space, but tools/_eyelum.mjs gamma-decodes before it ratios, so the shipped tool disagrees with the acceptance test |
| major | `20260806025805-three-rounds-blamed` | Three rounds blamed the sclera albedo for a brightness that was three fifths one un-occluded additive glow, because nobody had ever ablated a single term |
| minor | `20260806025828-every-level-change` | Every level change in a shader is diluted about 2.4x by the tone curve, so tuning a linear constant ''by 25 percent'' moves the graded pixel by 10 |
| minor | `20260806025853-a-debug-mask` | A DEBUG_MASK hatch capture blooms about a pixel past the geometry, so a stencil taken from it counts lid-margin skin as aperture and over-reports every hot-pixel test |
| minor | `20260806025919-backtick-in-a` | Backtick in a GLSL comment, fifth and sixth recurrence: I hit it twice in one session having read the entry that warns about it, and esbuild takes 0.05 s to catch it |
| minor | `20260806025952-the-cheek-reference` | The cheek reference box the whole brief ratios against swings 0.24 to 0.55 across 40 px of this face, so a hand-placed box moves the sclera verdict from fail to pass with no shader change |
| minor | `20260806102822-a-thrower-still` | A thrower drifts ~2.4 m from his pivot — limit cycle EXPLAINED (hard contact), residual is steering slack |
| major | `20260806171847-a-layout-s` | A layout''s reach is modelled three different ways in three files and none of them agree |
| major | `20260806171905-ai-predictcatchpoint-aimed` | AI.predictCatchPoint aimed at a height Game.tryCatch will not award a catch at |
| blocker | `20260806173727-boundaryroom-caps-total` | boundaryRoom caps TOTAL speed, so a body standing on the sideline is frozen in every direction |
| minor | `20260806220000-control-sticks-to` | Control sticks to a diving player while a team-mate holds the disc, because a catch cannot outrank an unavailable body |
| major | `20260809-git-stash-in-a` | `git stash` is not usable in this repo — the working tree belongs to every agent at once |
| minor | `20260809162502-no-launch-argument` | No launch argument shortens a match, so verifying anything at full time costs ~10 minutes of Simulator wall time |
| minor | `20260809174419-swift-build-c` | swift build -c release cannot verify your own work while a peer is mid-edit in another target |
| major | `20260809174439-a-locomotion-replaced` | A Locomotion replaced at each point silently drops its LocoHost, and nothing in the suite notices |
| major | `20260810015209-xcuitest-gestures-are` | XCUITest: gestures are main-thread-only, and one accessibility read costs as long as a HUD plate lives |
| minor | `20260809175052-registering-a-simchecks` | Registering a SimChecks suite means committing Harness.swift, which peers add lines to at the same time |
