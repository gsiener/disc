#!/usr/bin/env node
/**
 * The syntax gate — "is the tree green?" in a fraction of a second.
 *
 *   node tools/gate.mjs            # parse every src/**\/*.ts, exit 1 on the first failure
 *   npm run gate                   # the same thing
 *   node tools/gate.mjs --quiet    # print nothing unless something is broken
 *
 * ## Why this exists
 *
 * A backtick inside a GLSL comment closes the shader template literal. The GLSL
 * after it is then parsed as TypeScript, and `tsc` reports a cascade of `TS1005:
 * ',' expected` at lines that have nothing to do with it — so the error reads as
 * an unrelated broken object literal. It has been logged six times in
 * `.agents/friction-log/`, every time by an agent who had just read the entry
 * warning about it (`20260805193609`, `20260805234124`, `20260806014822`,
 * `20260806025919`). It is a habit collision, not a knowledge gap: backticks
 * round identifiers are correct in every other comment in this repo. Six
 * recurrences is the proof that a warning cannot compete with a parser.
 *
 * The blast radius is worse than the papercut. Both capture rigs boot vite and
 * wait on `window.__READY__`. If ANY file under `src/` fails to parse — including
 * a peer agent's, mid-save, in a file you do not import — vite's transform fails,
 * the module graph never completes, and the run dies after 180 s with a
 * `TimeoutError` whose top frame is the capture rig. Three separate entries
 * record paying that (`20260805193950`, `20260805220550`, `20260805221042`).
 * So this gate runs before the rigs spend three minutes finding out.
 *
 * ## Why rolldown and not esbuild
 *
 * The friction log proposes `node_modules/.bin/esbuild`. **esbuild is not
 * installed on this tree** and has not been since vite 8 — `20260806014822`
 * caught that and was right; `node_modules/.bin` holds rolldown, not esbuild.
 * Vite 8 transforms with rolldown/oxc, and `rolldown/parseAst` is that exact
 * parser exposed directly. That makes this gate strictly better than the
 * proposed one: it does not approximate the question "will vite 500 on this?",
 * it asks the component that would do the 500-ing. No new dependency — rolldown
 * arrives with vite.
 *
 * Syntax only, deliberately. Every recorded instance of this failure has been a
 * parse error; a type error does not stop vite serving a module, and typechecking
 * costs ~40 s and reports a peer's half-finished work as your problem.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');

let parseAst;
try {
  ({ parseAst } = await import('rolldown/parseAst'));
} catch (e) {
  // Loud, not masked. A gate that cannot run has no verdict to give, and
  // ADR-0005's companion rule is that a masked job is worse than a red one.
  console.error('gate: cannot load rolldown/parseAst — run `npm install` first.');
  console.error('gate: rolldown ships with vite 8; if vite is installed and this');
  console.error('gate: still fails, the parser moved and tools/gate.mjs needs an update.');
  console.error(String(e?.message ?? e));
  process.exit(2);
}

const quiet = process.argv.includes('--quiet');

/** Every .ts under src/, sorted so the report order is stable run to run. */
function tsFiles(dir, out = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) tsFiles(p, out);
    else if (/\.[cm]?tsx?$/.test(ent.name)) out.push(p);
  }
  return out;
}

/** rolldown reports a UTF-16 offset into the source; turn it into line/column. */
function lineCol(src, pos) {
  const upto = src.slice(0, Math.max(0, Math.min(pos, src.length)));
  const line = upto.split('\n').length;
  const col = pos - (upto.lastIndexOf('\n') + 1) + 1;
  return { line, col };
}

/**
 * A backtick in a comment is only ever *reported* here, never used to decide.
 * The parser is the gate; this is the explanation printed after it has already
 * failed. That ordering matters — `20260806014822` correctly refused to ship a
 * backtick regex as a hard gate, because this codebase legitimately nests
 * `${cond ? `…` : ''}` inside its shader strings and the regex flags those. As
 * a hint on a file that demonstrably does not parse, it cannot false-positive.
 */
function backtickHint(lines, errLine) {
  const isCommentWithBacktick = (s) => /^\s*(\/\/|\*|\/\*)/.test(s) && s.includes('`');
  if (errLine >= 1 && errLine <= lines.length && isCommentWithBacktick(lines[errLine - 1])) {
    return errLine;
  }
  // The parser re-syncs a token or two late often enough to be worth a short look back.
  for (let i = errLine - 1; i >= Math.max(1, errLine - 12); i--) {
    if (isCommentWithBacktick(lines[i - 1])) return i;
  }
  return 0;
}

const t0 = performance.now();
const files = tsFiles(SRC);
const failures = [];

for (const file of files) {
  const src = readFileSync(file, 'utf8');
  try {
    parseAst(src, { lang: /\.tsx$/.test(file) ? 'tsx' : 'ts' });
  } catch (e) {
    const rel = path.relative(ROOT, file);
    const { line, col } = lineCol(src, e?.pos ?? 0);
    failures.push({ rel, line, col, src, message: String(e?.message ?? e) });
  }
}

const secs = ((performance.now() - t0) / 1000).toFixed(2);

if (!failures.length) {
  if (!quiet) console.log(`gate: ${files.length} files under src/ parse — ${secs}s`);
  process.exit(0);
}

const bar = '='.repeat(72);
console.error(`\n${bar}`);
console.error(`SYNTAX GATE FAILED — ${failures.length} file(s) under src/ do not parse  (${secs}s)`);
console.error(bar);

for (const f of failures) {
  const lines = f.src.split('\n');
  console.error(`\n${f.rel}:${f.line}:${f.col}`);
  // The parser's own rendering: first error first, and the rest is the parser
  // re-syncing. Read error one and ignore the tail.
  for (const l of f.message.split('\n')) console.error('  ' + l);

  const hint = backtickHint(lines, f.line);
  if (hint) {
    console.error('');
    console.error(`  LIKELY CAUSE: a backtick inside a comment, ${f.rel}:${hint}`);
    console.error(`    ${hint}: ${lines[hint - 1].trim()}`);
    console.error('  If that comment sits inside a /* glsl */ `…` template literal, the');
    console.error('  backtick CLOSES the literal and everything after it is parsed as');
    console.error("  TypeScript. Write the identifier plain — uCrossCut, not `uCrossCut`.");
    console.error('  Six recurrences; see .agents/friction-log/20260806025919-backtick-in-a.');
  }
}

console.error(`\n${bar}`);
console.error('THE BROKEN FILE MAY NOT BE YOURS.');
console.error(bar);
console.error('Several agents edit src/ at once, and a peer mid-save fails this gate');
console.error('exactly like your own mistake would. Before you audit your own diff, run');
console.error(`  git status -- ${path.relative(ROOT, SRC)}    # is the named file even one you touched?`);
console.error('A peer\'s transient parse error usually heals within a minute or two — just');
console.error('re-run the gate. What it must never do is send you looking in your own diff');
console.error('for a fault that is not there.');
console.error('');
console.error('Until src/ parses, vite cannot finish the module graph, so tools/capture.mjs');
console.error('and tools/capture-live.mjs would hang and report a 180 s puppeteer');
console.error('TimeoutError pointing at the capture rig instead of this message.');
process.exit(1);
