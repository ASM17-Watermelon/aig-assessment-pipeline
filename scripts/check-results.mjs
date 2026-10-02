#!/usr/bin/env node
// 다시 돌린 결과(results/ 또는 OUT)에서 논문 핵심 수치를 뽑아 results/expected.json 과 대조한다.
//   node scripts/check-results.mjs [<results dir>]                  대조 (허용 오차 = expected.tolerance)
//   node scripts/check-results.mjs <dir> --write-expected <file>     기준값 파일을 만든다(원 산출물에서 한 번)
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const dir = args[0] && !args[0].startsWith('--') ? args[0] : join(ROOT, 'results');
const writeTo = args.includes('--write-expected') ? args[args.indexOf('--write-expected') + 1] : null;

const CFA_FILES = ['r300/cfa_five.json', 'r300b/cfa_five.json', 'r300c/cfa_five.json', 'r300d/cfa_five.json', 'r300d/cfa_g15-2-3-4.json'];
const IRT_FILES = ['r300d/irt/irt_summary.json', 'r300d/irt5/irt_summary.json'];
const r4 = (x) => (x == null ? null : Math.round(x * 1e4) / 1e4);

function cfaKey(j) {
  const corr = j.factor_corr.map((c) => c.est);
  const loads = j.loadings.map((l) => l.est).sort((a, b) => a - b);
  const median = loads.length % 2 ? loads[(loads.length - 1) / 2] : (loads[loads.length / 2 - 1] + loads[loads.length / 2]) / 2;
  const cmp = Object.fromEntries(Object.entries(j.comparison ?? {}).map(([k, c]) => [k, { chisq_diff: r4(c.chisq_diff), df_diff: c.df_diff, rejected: c.rejected }]));
  return {
    n_used: j.verdict.n_used, items_used: j.items_used,
    cfi: r4(j.fit.cfi), tli: r4(j.fit.tli), rmsea: r4(j.fit.rmsea), srmr: r4(j.fit.srmr),
    loading_median: r4(median), loadings_below_40: loads.filter((x) => x < 0.4).length,
    corr_min: r4(Math.min(...corr)), corr_max: r4(Math.max(...corr)),
    corr_pairs: corr.length, corr_below_85: corr.filter((x) => Math.abs(x) < 0.85).length,
    status: j.verdict.status, comparison: cmp,
  };
}
function irtKey(j) {
  return Object.fromEntries(Object.entries(j.groups_result).map(([g, s]) => [g, {
    n: s.n, items: s.items, marginal_rxx: r4(s.marginal_rxx), flagged: s.flagged, sx2_misfit: s.sx2_misfit,
    aic_winner: s.lrt_rasch_vs_2pl.aic_2pl < s.lrt_rasch_vs_2pl.aic_rasch ? '2PL' : 'Rasch',
    lrt_chisq: r4(s.lrt_rasch_vs_2pl.chisq), info_peak_theta: r4(s.info_peak_theta),
    precise_range: s.precise_range ?? null, b_max: r4(s.b['Max.']),
  }]));
}
const read = (f) => JSON.parse(readFileSync(join(dir, f), 'utf8'));
const got = {
  cfa: Object.fromEntries(CFA_FILES.filter((f) => existsSync(join(dir, f))).map((f) => [f, cfaKey(read(f))])),
  irt: Object.fromEntries(IRT_FILES.filter((f) => existsSync(join(dir, f))).map((f) => [f, irtKey(read(f))])),
};

if (writeTo) {
  writeFileSync(writeTo, JSON.stringify({ tolerance: 0.001, ...got }, null, 2) + '\n');
  console.log(`기준값 → ${writeTo}`);
  process.exit(0);
}

const expected = JSON.parse(readFileSync(join(ROOT, 'results/expected.json'), 'utf8'));
const tol = expected.tolerance;
const bad = [];
function same(path, e, g) {
  if (typeof e === 'number' && typeof g === 'number') { if (Math.abs(e - g) > tol) bad.push(`${path}: 기대 ${e} · 결과 ${g}`); return; }
  if (Array.isArray(e) || (e && typeof e === 'object')) {
    if (g == null || typeof g !== 'object') { bad.push(`${path}: 결과 없음`); return; }
    for (const k of Object.keys(e)) same(`${path}.${k}`, e[k], g[k]);
    return;
  }
  if (e !== g) bad.push(`${path}: 기대 ${JSON.stringify(e)} · 결과 ${JSON.stringify(g)}`);
}
for (const kind of ['cfa', 'irt']) for (const f of Object.keys(expected[kind])) same(`${kind}:${f}`, expected[kind][f], got[kind][f]);

const fmt = (x) => (x == null ? '-' : String(x));
console.log('| 결과 파일 | CFI | 요인 상관 | 판별 통과(< .85) | 판정 |');
console.log('|---|---|---|---|---|');
for (const [f, k] of Object.entries(got.cfa)) console.log(`| ${f} | ${fmt(k.cfi)} | ${fmt(k.corr_min)} ~ ${fmt(k.corr_max)} | ${k.corr_below_85}/${k.corr_pairs} | ${k.status} |`);
console.log('');
console.log('| 결과 파일 | 역량 | 주변 신뢰도 | AIC 선택 | 플래그 | S-X2 미흡 |');
console.log('|---|---|---|---|---|---|');
for (const [f, groups] of Object.entries(got.irt)) for (const [g, s] of Object.entries(groups)) console.log(`| ${f} | ${g} | ${fmt(s.marginal_rxx)} | ${s.aic_winner} | ${s.flagged} | ${s.sx2_misfit} |`);
if (bad.length) { console.error(`\n불일치 ${bad.length}건:\n${bad.join('\n')}`); process.exit(1); }
console.log(`\n논문 수치와 일치 (CFA ${Object.keys(expected.cfa).length}개 · IRT ${Object.keys(expected.irt).length}개 파일, 허용 오차 ${tol})`);
