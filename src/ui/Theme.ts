/**
 * The HUD's design system, as one injected stylesheet.
 *
 * Written against the art-direction brief: the frame is a summer-evening club
 * final with a first TV deal, and **only the two kits and the disc are allowed
 * to be saturated**. So the graphics package is achromatic — cold near-black
 * glass, one warm live-accent, and type in four weights of the same off-white.
 * Team colour appears exactly twice per club: a 3 px chip and the possession
 * disc. That restraint is the difference between a broadcast package and a
 * scoreboard someone printed to the DOM.
 *
 * Typography: no binary assets means no webfont, so the stack is the platform
 * grotesque with `tabular-nums lining-nums` forced everywhere. Every number in
 * the package sits on the same advance width, which is why the score does not
 * jitter when it rolls from 9 to 10 and the stall count does not shuffle the
 * cells beside it.
 *
 * Sizing: every dimension is in `em` off a single root font-size that the HUD
 * sets from viewport width, so the package holds its proportions from 1280 to
 * 2560 without a media query, and stays vector-crisp at any DPR.
 */

export const HUD_CSS = `
#ug{
  position:absolute; inset:0; pointer-events:none; overflow:hidden;
  font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  font-size:16px; line-height:1; color:var(--ug-ink);
  -webkit-font-smoothing:antialiased; -moz-osx-font-smoothing:grayscale;
  --ug-ink:#eef4fc;
  --ug-ink2:rgba(199,216,238,.72);
  --ug-ink3:rgba(146,169,197,.55);
  --ug-edge:rgba(178,208,248,.15);
  --ug-hair:rgba(178,208,248,.10);
  --ug-glass:linear-gradient(177deg,rgba(14,19,27,.90) 0%,rgba(8,11,16,.90) 62%,rgba(6,9,13,.92) 100%);
  --ug-shade:0 1.15em 2.7em -1.15em rgba(0,0,0,.85),0 .18em .55em -.24em rgba(0,0,0,.55);
  --ug-live:#f4c657;
  --ug-hot:#ff5f45;
  --ug-warn:#ffab3d;
  --ug-good:#5fe0a0;
  --ug-home:#3f7ac9;
  --ug-away:#f2f2ee;
}
/* NB: no margin/padding reset here. \`#ug *\` carries an id in its selector, so it
   outranks every class rule in this file — a reset written here would silently
   flatten the whole package's spacing. index.html already zeroes both globally. */
#ug *{box-sizing:border-box;font-variant-numeric:tabular-nums lining-nums;
  font-feature-settings:"tnum" 1,"lnum" 1;}

.ug-panel{
  position:absolute;
  background:var(--ug-glass);
  border:1px solid var(--ug-edge);
  box-shadow:var(--ug-shade),inset 0 1px 0 rgba(255,255,255,.055);
  -webkit-backdrop-filter:blur(15px) saturate(1.15);
  backdrop-filter:blur(15px) saturate(1.15);
  will-change:transform,opacity;
}
.ug-lbl{
  font-size:.5em; font-weight:700; letter-spacing:.22em; color:var(--ug-ink3);
  text-transform:uppercase; white-space:nowrap;
}
.ug-hair{width:1px;align-self:stretch;flex:none;
  background:linear-gradient(180deg,transparent,var(--ug-hair) 22%,var(--ug-hair) 78%,transparent);}

/* ============================================================== scorebug == */

.ug-bug{
  top:1.3em; left:1.5em; height:3.75em;
  display:flex; align-items:stretch; border-radius:.46em; overflow:hidden;
  transform-origin:0 0;
}
.ug-bug .tm{
  display:flex; align-items:center; gap:.72em; padding:0 1.05em; position:relative;
}
/* The team in possession lifts out of the bar by a hair — the same trick a
   broadcast package uses instead of colouring the whole cell in. */
.ug-bug .tm::before{
  content:''; position:absolute; inset:0; opacity:0;
  background:linear-gradient(180deg,rgba(255,255,255,.08),rgba(255,255,255,.012));
}
.ug-bug .tm.on::before{opacity:1;}
/* Kit colour as a keyline along the foot of the cell, not a bar in the middle
   of the run of glyphs — a vertical chip sitting next to a vertical hairline
   reads as two dividers, which is exactly the confusion this avoids. */
.ug-bug .chip{
  position:absolute;left:0;right:0;bottom:0;height:.2em;background:var(--c);opacity:.48;
}
.ug-bug .tm.on .chip{opacity:1;box-shadow:0 -.3em .85em -.25em var(--c);}
/* Code over timeouts, score to the right: two reading columns instead of one
   long run of glyphs, so the pips never get mistaken for part of the number.
   The pips are taken *out of flow* so the column's height is the code row alone
   and the code therefore centres against the score digit rather than riding
   half a pip-row above it. */
.ug-bug .idc{position:relative;display:flex;align-items:center;}
.ug-bug .idr{display:flex;align-items:center;gap:.42em;height:.86em;}
.ug-bug .code{
  font-size:.82em; font-weight:700; letter-spacing:.155em;
  color:rgba(233,243,255,.70); white-space:nowrap; line-height:1;
}
.ug-bug .tm.on .code{color:#fff;}
/* A disc, seen edge-on. Reads as "these seven have it" at thumbnail size. */
.ug-bug .poss{
  width:.68em; height:.36em; border-radius:50%; flex:none; opacity:0;
  background:var(--c); box-shadow:0 0 .55em .02em var(--c),inset 0 .06em 0 rgba(255,255,255,.6);
}
/* Timeouts as upright tally ticks, not lozenges.

   They were horizontal bars at text weight sitting on the code's baseline, and
   two of those read as "--" — which in every sports graphic on earth is the
   glyph for "no data". Standing them up removes the typographic reading
   entirely: a tick is a tally, and a spent tick is its ghost.

   Indented past the possession disc so they hang under the *code* rather than
   under the glyph; at left:0 they orphaned in the corner of the cell. The disc
   keeps its box when possession is elsewhere (it fades, it does not un-lay-out),
   so this offset holds for both clubs at all times. */
.ug-bug .tos{
  position:absolute;top:calc(100% + .28em);left:1.1em;display:flex;gap:.26em;
}
.ug-bug .tos i{
  display:block;width:.185em;height:.48em;border-radius:.09em;
  background:rgba(232,242,255,.95);
}
.ug-bug .tos i.spent{background:rgba(232,242,255,.13);box-shadow:inset 0 0 0 1px rgba(232,242,255,.10);}

.ug-bug .num{
  font-size:1.9em; height:1.16em; line-height:1.16em; overflow:hidden;
  position:relative; flex:none; margin-left:.02em;
}
.ug-bug .num .col{display:block;will-change:transform;}
.ug-bug .num b{
  display:block; height:1.16em; line-height:1.16em; text-align:right; min-width:.72em;
  font-weight:600; letter-spacing:-.035em; color:#fff;
  text-shadow:0 .03em .1em rgba(0,0,0,.55);
}

.ug-bug .cell{
  display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.46em;
  padding:0 1.0em;min-width:4.3em;
}
.ug-bug .cell .v{
  font-size:.9em;font-weight:600;letter-spacing:.01em;color:rgba(230,240,252,.95);
  white-space:nowrap;line-height:1;
}

/* Stall: an arc gauge, because a bare integer is the one element on a sports
   bug that has to be readable in peripheral vision.

   It is deliberately the second-largest number in the package — the score is
   1.9em, this is 1.62em, and everything else is under 1em. That ordering is the
   whole argument: the score is what the match is, but the stall count is the
   only number on the bar that is *running out*, and it is the one a viewer
   tracks without moving their eyes off the disc. It carries no label because it
   is the only ringed element and it counts in front of you; a static label would
   cost the ring the diameter that makes it legible. */
.ug-bug .stall{
  display:flex;align-items:center;justify-content:center;padding:0 .78em;
  background:linear-gradient(180deg,rgba(255,255,255,.05),rgba(255,255,255,.012));
  position:relative;
}
/* Warm/hot wash the whole terminal cell, so 8+ is visible in the corner of the
   eye before the digit itself is resolved. */
.ug-bug .stall::after{
  content:'';position:absolute;inset:0;opacity:0;
  background:radial-gradient(120% 120% at 50% 50%,rgba(255,95,69,.30),rgba(255,95,69,0) 70%);
}
.ug-bug .stall.hot::after{opacity:1;}
.ug-bug .stall.warn::after{
  opacity:.55;
  background:radial-gradient(120% 120% at 50% 50%,rgba(244,198,87,.26),rgba(244,198,87,0) 70%);
}
.ug-bug .stall .gwrap{position:relative;width:3.06em;height:3.06em;will-change:transform;}
.ug-bug .stall .gauge{width:100%;height:100%;display:block;overflow:visible;}
.ug-bug .stall .gn{
  position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
  font-size:1.62em;font-weight:700;color:var(--ug-ink);letter-spacing:-.05em;
  text-shadow:0 .03em .12em rgba(0,0,0,.55);
}
.ug-bug .stall.warn .gn{color:var(--ug-live);}
.ug-bug .stall.hot .gn{color:var(--ug-hot);}

/* =========================================================== lower third == */

.ug-l3{
  left:1.6em; bottom:8.6em; border-radius:.5em; overflow:hidden;
  display:flex; align-items:stretch; height:4.55em; transform-origin:0 100%;
}
.ug-l3 .rail{width:.26em;flex:none;background:var(--c);box-shadow:0 0 1.2em -.1em var(--c);
  position:relative;z-index:3;}
.ug-l3 .plate{
  width:3.95em;flex:none;display:flex;align-items:center;justify-content:center;
  background:linear-gradient(160deg,var(--cRaw),rgba(0,0,0,.42)),var(--cRaw);
  position:relative;z-index:2;
  /* The rail carries the kit colour and sits immediately left of this plate. For
     a white kit the two are the same value and the rail disappears into it, so
     the plate keeps a hairline of its own to divide them. */
  box-shadow:.5em 0 1.1em -.55em rgba(0,0,0,.8),inset 1px 0 0 rgba(0,0,0,.3);
}
.ug-l3 .plate::after{
  content:'';position:absolute;inset:0;
  background:linear-gradient(180deg,rgba(255,255,255,.14),rgba(255,255,255,0) 45%);
}
.ug-l3 .plate span{
  font-size:1.85em;font-weight:700;letter-spacing:-.045em;color:var(--cInk);
  text-shadow:0 .03em .1em rgba(0,0,0,.35);position:relative;
}
.ug-l3 .body{display:flex;align-items:center;gap:1.05em;padding:0 1.05em 0 .95em;
  will-change:transform;position:relative;z-index:1;}
.ug-l3 .who{display:flex;flex-direction:column;gap:.42em;min-width:7.4em;}
.ug-l3 .who .nm{font-size:1.12em;font-weight:650;letter-spacing:.005em;color:#fff;white-space:nowrap;}
.ug-l3 .who .sub{font-size:.55em;font-weight:600;letter-spacing:.17em;color:var(--ug-ink2);text-transform:uppercase;white-space:nowrap;}
.ug-l3 .tag{
  align-self:center;padding:.46em .66em .4em;border-radius:.24em;
  font-size:.58em;font-weight:800;letter-spacing:.19em;white-space:nowrap;text-transform:uppercase;
  color:#0b0e13;background:var(--ug-live);box-shadow:0 .2em .8em -.3em var(--ug-live);
}
.ug-l3 .tag.d{background:var(--ug-good);box-shadow:0 .2em .8em -.3em var(--ug-good);}
/* Three single-digit stats set side by side in tabular figures do not read as
   three stats — "1 0 0" reads as one hundred, and the key row underneath is too
   small and too far away to break the run. So each column is boxed by a hairline
   and its own value/key pair is tightened until the pair binds more strongly to
   itself than the values bind to each other. */
.ug-l3 .stats{display:flex;align-items:stretch;gap:0;}
.ug-l3 .st{
  display:flex;flex-direction:column;align-items:center;justify-content:center;
  gap:.26em;padding:0 .56em;min-width:2.16em;position:relative;
}
/* The rule has to be strong enough to actually cut the run of digits. At the
   panel's own hairline alpha it was invisible and "1 0 0" still read as one
   hundred, so this one is roughly twice that — it is doing work, not edging. */
.ug-l3 .st + .st::before{
  content:'';position:absolute;left:0;top:.1em;bottom:.1em;width:1px;
  background:linear-gradient(180deg,transparent,rgba(178,208,248,.24) 26%,rgba(178,208,248,.24) 74%,transparent);
}
.ug-l3 .st:last-child{padding-right:0;}
.ug-l3 .st .v{font-size:1.02em;font-weight:650;color:#fff;line-height:1;}
/* Keys carry the disambiguation, so they stay at body-text contrast rather than
   dropping to the faintest ink in the palette. */
.ug-l3 .st .k{font-size:.53em;font-weight:700;letter-spacing:.2em;color:var(--ug-ink2);}

/* ============================================================== summary === */

.ug-sum{
  right:1.6em; top:50%; width:22.5em; border-radius:.6em; padding:1.15em 1.25em 1.05em;
  transform-origin:100% 50%;
}
.ug-sum .hd{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:.9em;}
.ug-sum .hd .t{font-size:.58em;font-weight:800;letter-spacing:.24em;color:var(--ug-live);text-transform:uppercase;}
.ug-sum .hd .p{font-size:.58em;font-weight:700;letter-spacing:.16em;color:var(--ug-ink2);}
.ug-sum .line{
  display:grid;grid-template-columns:1fr auto auto;align-items:center;
  gap:.5em;padding:.46em 0;border-top:1px solid var(--ug-hair);
}
.ug-sum .line:first-of-type{border-top:0;}
.ug-sum .line .k{font-size:.56em;font-weight:700;letter-spacing:.15em;color:var(--ug-ink2);text-transform:uppercase;}
.ug-sum .line .a,.ug-sum .line .b{
  font-size:.78em;font-weight:600;min-width:3.7em;text-align:right;color:rgba(228,239,252,.92);
}
.ug-sum .line .a.win,.ug-sum .line .b.win{color:#fff;}
.ug-sum .line .a.lose,.ug-sum .line .b.lose{color:var(--ug-ink3);}
.ug-sum .teamrow{
  display:grid;grid-template-columns:1fr auto auto;gap:.5em;align-items:center;
  padding-bottom:.55em;margin-bottom:.35em;
}
.ug-sum .teamrow .k{font-size:.52em;font-weight:700;letter-spacing:.22em;color:var(--ug-ink3);text-transform:uppercase;}
.ug-sum .teamrow .a,.ug-sum .teamrow .b{
  font-size:.62em;font-weight:800;letter-spacing:.12em;min-width:3.7em;text-align:right;
}
.ug-sum .ft{margin-top:.9em;padding-top:.7em;border-top:1px solid var(--ug-hair);
  display:flex;align-items:center;gap:.6em;}
.ug-sum .ft .badge{
  font-size:.5em;font-weight:800;letter-spacing:.2em;color:#0b0e13;background:var(--ug-ink2);
  padding:.4em .55em .34em;border-radius:.22em;
}
.ug-sum .ft .txt{font-size:.7em;font-weight:600;color:rgba(228,239,252,.9);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}

/* =============================================================== badges === */

.ug-badges{
  position:absolute;top:1.4em;right:1.6em;display:flex;flex-direction:column;align-items:flex-end;gap:.5em;
}
.ug-badge{
  position:relative;display:flex;align-items:center;gap:.5em;height:2.05em;padding:0 .82em;
  border-radius:.34em;background:var(--ug-glass);border:1px solid var(--ug-edge);
  box-shadow:var(--ug-shade);transform-origin:100% 50%;will-change:transform,opacity;
  -webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);
}
.ug-badge .t{font-size:.58em;font-weight:800;letter-spacing:.22em;color:var(--ug-ink);white-space:nowrap;text-transform:uppercase;}
.ug-badge .dot{width:.42em;height:.42em;border-radius:50%;background:var(--ug-hot);
  box-shadow:0 0 .7em .04em var(--ug-hot);flex:none;}
.ug-badge.slow{border-color:rgba(244,198,87,.28);}
.ug-badge.slow .t{color:var(--ug-live);}

/* ========================================================== throw meter === */

.ug-meter{
  left:50%; bottom:2.3em; width:20.5em; padding:.85em 1em .8em; border-radius:.44em;
  transform-origin:50% 100%;
}
.ug-meter .hd{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:.62em;}
.ug-meter .hd .ty{font-size:.58em;font-weight:800;letter-spacing:.22em;color:var(--ug-ink);text-transform:uppercase;}
.ug-meter .hd .q{font-size:.58em;font-weight:800;letter-spacing:.19em;color:var(--ug-ink3);text-transform:uppercase;}
/* The window marker lives above the track so it never sits on top of the fill. */
.ug-meter .gut{position:relative;height:.36em;}
.ug-meter .caret{
  position:absolute;bottom:0;width:0;height:0;margin-left:-.3em;
  border-left:.3em solid transparent;border-right:.3em solid transparent;
  border-top:.32em solid rgba(95,224,160,.92);
}
.ug-meter .track{
  position:relative;height:.72em;border-radius:.36em;overflow:hidden;
  background:rgba(9,13,19,.72);
  background-image:repeating-linear-gradient(90deg,transparent 0 24.75%,rgba(178,208,248,.11) 24.75% 25%);
  box-shadow:inset 0 1px 2px rgba(0,0,0,.65),inset 0 0 0 1px rgba(178,208,248,.11);
}
.ug-meter .band{
  position:absolute;top:0;bottom:0;background:rgba(95,224,160,.22);
  box-shadow:inset 1px 0 0 rgba(95,224,160,.75),inset -1px 0 0 rgba(95,224,160,.75);
}
.ug-meter .fill{
  position:absolute;left:0;top:0;bottom:0;width:100%;transform-origin:0 50%;
  background:linear-gradient(90deg,var(--f0),var(--f1));will-change:transform;
}
/* Outside the track's clip, so the play-head overhangs the rail and stays
   legible against a bright fill instead of vanishing into it. */
.ug-meter .tw{position:relative;}
.ug-meter .head{
  position:absolute;left:0;top:-.18em;bottom:-.18em;width:2px;margin-left:-1px;border-radius:1px;
  background:#fff;box-shadow:0 0 .35em rgba(255,255,255,.9),0 0 0 1px rgba(4,7,11,.75);
  will-change:transform;
}
.ug-meter .ft{display:flex;align-items:center;justify-content:space-between;margin-top:.62em;}
.ug-meter .ft .k{font-size:.52em;font-weight:700;letter-spacing:.2em;color:var(--ug-ink3);text-transform:uppercase;}
.ug-meter .ft .v{font-size:.68em;font-weight:700;letter-spacing:.04em;color:var(--ug-ink2);}

/* ============================================================ svg layer === */

.ug-svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible;}
.ug-svg text{
  font-family:inherit;font-weight:700;letter-spacing:.16em;
  font-variant-numeric:tabular-nums lining-nums;
}
`;

let mounted: HTMLStyleElement | null = null;

/** Idempotent — a second HudSystem (hot reload) reuses the same tag. */
export function mountStyle(): HTMLStyleElement {
  const existing = document.getElementById('ug-style') as HTMLStyleElement | null;
  if (existing) { mounted = existing; existing.textContent = HUD_CSS; return existing; }
  const s = document.createElement('style');
  s.id = 'ug-style';
  s.textContent = HUD_CSS;
  document.head.appendChild(s);
  mounted = s;
  return s;
}

export function unmountStyle(): void {
  mounted?.remove();
  mounted = null;
}
