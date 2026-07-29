#!/usr/bin/env node
/**
 * Local token accounting.
 *
 *   node tools/usage.mjs            # totals by workflow, plus this session
 *   node tools/usage.mjs --detail   # per-agent breakdown
 *
 * There is no CLI that reports the ORG's monthly spend limit — that lives behind
 * the in-session `/usage` and `/cost` slash commands. What this can do is sum
 * what has actually been spent locally, which is enough to see the burn rate and
 * estimate how much runway a planned round needs.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const detail = process.argv.includes('--detail');
const PROJ = join(homedir(), '.claude/projects');

function findSessionDirs() {
  if (!existsSync(PROJ)) return [];
  const out = [];
  for (const p of readdirSync(PROJ)) {
    const dir = join(PROJ, p);
    if (!statSync(dir).isDirectory()) continue;
    for (const s of readdirSync(dir)) {
      const wf = join(dir, s, 'subagents/workflows');
      if (existsSync(wf)) out.push({ project: p, session: s, wf });
    }
  }
  return out;
}

const fmt = (n) => n.toLocaleString('en-US');
const M = (n) => (n / 1e6).toFixed(2) + 'M';
const fmtShort = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n));

let grand = 0;
const rows = [];

for (const { project, wf } of findSessionDirs()) {
  for (const run of readdirSync(wf)) {
    const dir = join(wf, run);
    if (!statSync(dir).isDirectory()) continue;
    let total = 0, agents = 0, name = run;
    const perAgent = [];
    // Usage is recorded per assistant message inside each agent's transcript.
    // Output tokens are what actually costs; cache reads are near-free, so they
    // are tracked separately rather than folded into one misleading number.
    for (const f of readdirSync(dir)) {
      if (!f.startsWith('agent-') || !f.endsWith('.jsonl')) continue;
      let out = 0, inp = 0, cacheW = 0, cacheR = 0;
      try {
        for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
          if (!line.trim()) continue;
          let o; try { o = JSON.parse(line); } catch { continue; }
          const u = o.message?.usage;
          if (!u) continue;
          out += u.output_tokens ?? 0;
          inp += u.input_tokens ?? 0;
          cacheW += u.cache_creation_input_tokens ?? 0;
          cacheR += u.cache_read_input_tokens ?? 0;
        }
      } catch { /* mid-write */ }
      const billable = out + inp + cacheW;
      if (billable) {
        total += billable; agents++;
        perAgent.push([f.slice(6, 14), billable, `out ${fmtShort(out)}`]);
      }
    }
    // Workflow name from any journal line that carries it.
    const j = join(dir, 'journal.jsonl');
    if (existsSync(j)) {
      for (const line of readFileSync(j, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { const o = JSON.parse(line); if (o.workflowName || o.name) { name = o.workflowName ?? o.name; break; } } catch {}
      }
    }
    if (total) {
      grand += total;
      rows.push({ project, run, name, total, agents, perAgent, mtime: statSync(dir).mtimeMs });
    }
  }
}

rows.sort((a, b) => a.mtime - b.mtime);

console.log('\n  workflow                                  agents      tokens');
console.log('  ' + '-'.repeat(64));
for (const r of rows) {
  console.log(`  ${String(r.name).slice(0, 38).padEnd(38)}  ${String(r.agents).padStart(6)}  ${fmt(r.total).padStart(11)}`);
  if (detail) {
    for (const [label, t, state] of r.perAgent.sort((a, b) => b[1] - a[1])) {
      console.log(`      ${String(label).slice(0, 30).padEnd(30)} ${String(state ?? '').padEnd(8)} ${fmt(t).padStart(11)}`);
    }
  }
}
console.log('  ' + '-'.repeat(64));
console.log(`  ${'TOTAL subagent tokens'.padEnd(38)}  ${String(rows.reduce((s, r) => s + r.agents, 0)).padStart(6)}  ${fmt(grand).padStart(11)}`);
console.log(`\n  ${M(grand)} tokens across ${rows.length} workflow run(s).`);
console.log('  Org monthly limits are not exposed to any CLI — check with /usage or /cost in-session.\n');
