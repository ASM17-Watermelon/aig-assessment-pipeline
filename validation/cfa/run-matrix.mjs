#!/usr/bin/env node
// 게이트 보정(합성 통과 시험) 매트릭스 — 시나리오 × 반복 × 모형을 돌려 summary.json / summary.md 로 모은다.
// 생성은 simulate-snapshot.mjs, 적합은 run-cfa.R(Rscript 필요). 결과는 수집 설계(n·앵커·결측 처리)의 수치 근거가 된다.
//
// 사용: node validation/cfa/run-matrix.mjs --out out/cfa [--seed 592] [--reps 3] [--only base,n200] [--rscript Rscript]
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const OUT = arg('out', 'out/cfa');
const SEED = Number(arg('seed', '592'));
const REPS = Number(arg('reps', '3'));
const ONLY = (arg('only', '') || '').split(',').filter(Boolean);
const RSCRIPT = arg('rscript', 'Rscript');

// 시나리오 = 설계 주장 하나씩: base(판정·복원) · n-곡선 · 앵커·회전 · 이탈
export const SCENARIOS = [
  { name: 'base', gen: { n: 300 }, runs: [['five', 'position', 'all', 'listwise', true], ['four', 'position', 'all', 'listwise'], ['one', 'position', 'all', 'listwise']] },
  { name: 'n150', gen: { n: 150 }, runs: [['five', 'position', 'all', 'listwise']] },
  { name: 'n200', gen: { n: 200 }, runs: [['five', 'position', 'all', 'listwise']] },
  { name: 'n500', gen: { n: 500 }, runs: [['five', 'position', 'all', 'listwise', true]] },
  { name: 'rot3-a3', gen: { n: 300, variants: 3, anchors: 3 }, runs: [['five', 'position', 'all', 'listwise'], ['five', 'variant', 'anchors', 'listwise']] },
  { name: 'rot3-a4', gen: { n: 300, variants: 3, anchors: 4 }, runs: [['five', 'position', 'all', 'listwise'], ['five', 'variant', 'anchors', 'listwise']] },
  { name: 'rot3-a5', gen: { n: 300, variants: 3, anchors: 5 }, runs: [['five', 'position', 'all', 'listwise'], ['five', 'variant', 'anchors', 'listwise']] },
  { name: 'dropout15', gen: { n: 600, dropout: 0.15 }, runs: [['five', 'position', 'all', 'listwise'], ['five', 'position', 'all', 'pairwise']] },
  { name: 'dropout15-mnar', gen: { n: 600, dropout: 0.15, dropoutAbility: 1.0 }, runs: [['five', 'position', 'all', 'listwise'], ['five', 'position', 'all', 'pairwise']] },
];

function genArgs(gen, seed, dir) {
  const a = ['--out', dir, '--seed', String(seed)];
  for (const [k, v] of Object.entries(gen)) a.push(`--${k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())}`, String(v));
  return a;
}

const results = [];
const scenarios = ONLY.length ? SCENARIOS.filter((s) => ONLY.includes(s.name)) : SCENARIOS;
for (const s of scenarios) {
  for (let rep = 1; rep <= REPS; rep += 1) {
    const seed = SEED * 1000 + rep;
    const dir = join(OUT, s.name, `rep${rep}`);
    mkdirSync(dir, { recursive: true });
    execFileSync(process.execPath, [join(here, 'simulate-snapshot.mjs'), ...genArgs(s.gen, seed, dir)], { stdio: 'inherit' });
    for (const [model, level, subset, missing, compare] of s.runs) {
      const out = join(dir, `cfa_${model}_${level}_${subset}_${missing}.json`);
      try {
        execFileSync(RSCRIPT, [join(here, 'run-cfa.R'), '--snapshot', dir, '--model', model, '--level', level, '--subset', subset, '--missing', missing, '--out', out, '--compare', compare ? 'true' : 'false'], { stdio: 'inherit' });
        const r = JSON.parse(readFileSync(out, 'utf8'));
        results.push({ scenario: s.name, rep, seed, model, level, subset, missing, status: r.verdict?.status ?? 'error', n_used: r.verdict?.n_used ?? null,
          items: r.items_used, cfi: r.fit?.cfi ?? null, tli: r.fit?.tli ?? null, rmsea: r.fit?.rmsea ?? null, srmr: r.fit?.srmr ?? null, wrmr: r.fit?.wrmr ?? null,
          core_ok: r.verdict?.fit_ok_core ?? null, srmr_ok: r.verdict?.srmr_ok ?? null,
          cmp_four_p: r.comparison?.four?.pvalue ?? null, cmp_four_dcfi: r.comparison?.four?.delta_cfi ?? null, cmp_four_rejected: r.comparison?.four?.rejected ?? null,
          cmp_one_p: r.comparison?.one?.pvalue ?? null, cmp_one_dcfi: r.comparison?.one?.delta_cfi ?? null,
          loading_mae: r.recovery?.loading_mae ?? null, loading_max: r.recovery?.loading_max_abs_err ?? null, corr_mae: r.recovery?.corr_mae ?? null,
          weak: r.verdict?.weak_items?.length ?? null, converged: r.verdict?.converged ?? null, error: r.error ?? null, elapsed: r.elapsed_sec ?? null });
      } catch (e) {
        results.push({ scenario: s.name, rep, seed, model, level, subset, missing, status: 'error', error: String(e.message).slice(0, 200) });
      }
    }
  }
}

// 집계: 시나리오×런 조건별 평균·합격률
const key = (r) => `${r.scenario}|${r.model}|${r.level}|${r.subset}|${r.missing}`;
const groups = new Map();
for (const r of results) (groups.get(key(r)) ?? groups.set(key(r), []).get(key(r))).push(r);
const mean = (xs) => { const v = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
const fmt = (x, d = 3) => (x === null || x === undefined ? '—' : Number(x).toFixed(d));
const rows = [...groups.entries()].map(([k, rs]) => {
  const [scenario, model, level, subset, missing] = k.split('|');
  return { scenario, model, level, subset, missing, reps: rs.length, pass: rs.filter((r) => r.status === 'pass').length, fail: rs.filter((r) => r.status === 'fail').length,
    hold: rs.filter((r) => r.status === 'hold').length, error: rs.filter((r) => r.status === 'error').length, n_used: mean(rs.map((r) => r.n_used)), items: mean(rs.map((r) => r.items)),
    cfi: mean(rs.map((r) => r.cfi)), tli: mean(rs.map((r) => r.tli)), rmsea: mean(rs.map((r) => r.rmsea)), srmr: mean(rs.map((r) => r.srmr)), wrmr: mean(rs.map((r) => r.wrmr)),
    core_pass: rs.filter((r) => r.core_ok === true).length, srmr_pass: rs.filter((r) => r.srmr_ok === true).length,
    cmp_four_rejected: rs.filter((r) => r.cmp_four_rejected === true).length, cmp_four_dcfi: mean(rs.map((r) => r.cmp_four_dcfi)), cmp_one_dcfi: mean(rs.map((r) => r.cmp_one_dcfi)),
    loading_mae: mean(rs.map((r) => r.loading_mae)), loading_max: mean(rs.map((r) => r.loading_max)), corr_mae: mean(rs.map((r) => r.corr_mae)), elapsed: mean(rs.map((r) => r.elapsed)) };
});
const md = [
  `# CFA 게이트 합성 통과 시험 — seed ${SEED} · reps ${REPS} · ${new Date().toISOString()}`, '',
  '| 시나리오 | 모형 | 수준 | 부분 | 결측 | 합격/불합격/보류/오류 | 핵심(CFI·TLI·RMSEA) 통과 | SRMR 통과 | n | 문항 | CFI | TLI | RMSEA | SRMR | WRMR | 부하 MAE | 부하 최대오차 | 상관 MAE | 4요인 기각(Δχ²·ΔCFI) | ΔCFI(4) | ΔCFI(1) | 초/런 |',
  '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ...rows.map((r) => `| ${r.scenario} | ${r.model} | ${r.level} | ${r.subset} | ${r.missing} | ${r.pass}/${r.fail}/${r.hold}/${r.error} | ${r.core_pass}/${r.reps} | ${r.srmr_pass}/${r.reps} | ${fmt(r.n_used, 0)} | ${fmt(r.items, 0)} | ${fmt(r.cfi)} | ${fmt(r.tli)} | ${fmt(r.rmsea)} | ${fmt(r.srmr)} | ${fmt(r.wrmr)} | ${fmt(r.loading_mae)} | ${fmt(r.loading_max)} | ${fmt(r.corr_mae)} | ${r.cmp_four_dcfi === null ? '—' : `${r.cmp_four_rejected}/${r.reps}`} | ${fmt(r.cmp_four_dcfi)} | ${fmt(r.cmp_one_dcfi)} | ${fmt(r.elapsed, 1)} |`),
  '', '판정 게이트 = CFI/TLI ≥ .90 · RMSEA ≤ .08 · 요인 상관 추정치 < .85 · 차원당 ≥4 · n ≥ 200. SRMR(n<500 .10 / ≥500 .08)·WRMR(<1.0)·4요인 비교(Δχ²·ΔCFI ≥ .01)는 보고. 기대: base five 합격·one 불합격(four 는 절대 적합으론 안 걸러짐 — 판별 규칙·내포 비교로), n150 보류, 앵커 ≥4 에서 variant/anchors 성립, MNAR 이탈에서 listwise 상관 편향 > pairwise.',
].join('\n');
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'summary.json'), JSON.stringify({ seed: SEED, reps: REPS, generated_at: new Date().toISOString(), rows, results }, null, 2));
writeFileSync(join(OUT, 'summary.md'), md + '\n');
console.log(md);
const errors = results.filter((r) => r.status === 'error');
if (errors.length) {
  console.error(`\n${errors.length}/${results.length} 런이 error — 첫 오류: ${errors[0].scenario}/${errors[0].model}: ${errors[0].error ?? '(cfa_result 에 error 없음)'}`);
  process.exit(1); // 적합이 아예 안 돈 하네스는 초록불이면 안 된다(CI 실측 2026-09-29)
}
