---
title: 'A backtick in a GLSL comment silently ends the shader template literal, and tsc blames the wrong line'
severity: 'minor'
---

Every shader in this repo is authored as a JS template literal
(`const PRELUDE = /* glsl */\`…\`` in `src/world/field/TurfMaterial.ts`,
`src/world/grass/shader.ts`, `src/render/sky/SkyMaterial.ts`, …). Those files
are also, by house style, extremely prose-heavy: TurfMaterial.ts is 41 KB of
which well over half is comment, and the comments cite uniform and function
names constantly.

Writing one of those citations the way you would in Markdown —

    Two numbers to know before re-tuning this, both measured through
    `uCrossCut` A/B at 47 m …

— terminates the template literal at the first backtick. What tsc then says is:

    src/world/field/TurfMaterial.ts(469,7): error TS1005: ',' expected.
    src/world/field/TurfMaterial.ts(469,16): error TS1005: ',' expected.

Line 469 is the *comment line*, and the message is a comma complaint, so the
first read is "I broke some object literal". The actual fault is a character
that is legal in every other comment in the codebase and that an editor's GLSL
highlighting does not flag, because as far as the editor is concerned it is
inside a comment.

It costs a minute once you know. It is worth knowing because the failure mode
scales with how good the comments are, and this repo asks for good comments.

Avoid backticks in shader-source comments; use plain identifiers or single
quotes, which is what the rest of TurfMaterial.ts already does ('layGain',
'stripeFade', 'uStripeStrength'). A cheap guard if it recurs:

    rg -n '/\* glsl \*/' -A99999 src | rg '^\s*(//|\s\*|/\*).*`'
