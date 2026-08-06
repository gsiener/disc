---
title: 'PART.FOREARM and PART.SHIN are declared in the rig but never written, so isPart(P_FOREARM) is identically zero'
severity: 'minor'
---

`src/entities/rig/Types.ts` declares 18 part ids including `FOREARM: 8` and `SHIN: 12`. The body builder never writes either:

- `buildArms` (`src/entities/rig/Body.ts:610`) lofts the WHOLE arm — humerus and forearm, `q` from -0.34 to 1.99 — as one loft with `part: PART.UPPER_ARM`.
- `buildLegs` (`Body.ts:735`) lofts thigh AND shin as one loft with `part: PART.THIGH`.

```sh
grep -n 'PART\.' src/entities/rig/Body.ts src/entities/rig/Hands.ts src/entities/rig/Head.ts src/entities/rig/Cloth.ts
# TORSO NECK HEAD EAR EYE HAIR UPPER_ARM HAND FINGER THIGH FOOT JERSEY SHORTS SOCK SHOE
# no FOREARM, no SHIN
```

So in `src/entities/material/Skin.ts` `float pFore = isPart(P_FOREARM);` is a compile-time-unknowable zero, and so is `isPart(P_SHIN)` anywhere it is used.

This has already cost a round. The expo block in Skin.ts carries a long comment asserting that a previous seam — "the forearm was not in the sum AT ALL, so it sat at 0.0 while the hand it runs into sat at 1.0" — was fixed by adding `+ pFore` to the sum. That term cannot add anything to anything. (The seam does not in fact exist, because the `pArm` ramp reaches 1.0 by the wrist, but nobody could have known that from the code.)

Cost: about 25 minutes, and it would have cost the same again to any agent who trusted the comment.

Fix, cheapest first: delete FOREARM and SHIN from `PART` so a shader author cannot reference a part that is never written; or write them from the arm/leg lofts at the elbow/knee ring. Either is fine — having them declared and unwritten is what is expensive. A one-line assertion in `tools/test-move.ts` that every declared PART id appears in a built rig's `aPart` buffer would have caught it.
