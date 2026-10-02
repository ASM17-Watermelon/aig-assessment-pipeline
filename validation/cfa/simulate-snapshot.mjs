#!/usr/bin/env node
// 게이트 보정용 합성 스냅샷 생성기 — "정답을 아는" 5차원 응답을 스냅샷 파일 형식으로 만든다.
//
// 왜: 실데이터 전에 추출→CFA 파이프라인이 심어 둔 구조를 복원하는지(그리고 틀린 모형을 떨어뜨리는지) 증명해야 한다.
//     같은 생성기로 표본 크기·앵커 수·변형 회전·이탈 결측을 바꿔 가며 수집 설계(n·앵커·결측 처리)를 시뮬레이션으로 뒷받침한다.
// 의존성 0(node:crypto 만) — 로컬에 R·Docker·numpy 가 없어도 돈다. 결정적(시드).
//
// 모형: η ~ N(0, Φ) (5요인, Φ 비대각 = --corr 범위), 위치(패밀리×소재)마다 부하 λ·역치 τ,
//       y* = λ·η_d + γ·ξ_family + sqrt(1-λ²-γ²)·ε, 응답 = 1[y* > τ]. γ = --family-residual (같은 문항모형 형제의 국소 의존).
//       변형 회전: 앵커가 아닌 위치는 k 형제(v1..vk, λ·τ 소폭 차이) 중 사용자별 1개만 노출. 앵커는 전원 노출.
//       이탈: 레슨 l 완주 후 다음 레슨으로 갈 확률 1-dropout (단조 결측).
//
// 사용: node validation/cfa/simulate-snapshot.mjs --out <dir> [--n 300 --lessons 6 --per-lesson 3,1,3,2,1 --models 6,3,6,4,2
//        --loading 0.5,0.7 --corr 0.3,0.5 --threshold -0.8,0.8 --anchors all|<k> --variants 1 --dropout 0 --dropout-ability 0
//        --family-residual 0.2 --seed 592]
// 출력(스냅샷 파일 + 진값): responses_long.csv · responses_wide.csv(변형 열) · responses_wide_family.csv(위치 열 = 패밀리×소재)
//        · items.csv(변형 행) · positions.csv(위치 행) · respondents.csv · manifest.json · truth.json

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULTS = Object.freeze({
  n: 300,
  lessons: 6,
  perLesson: [3, 1, 3, 2, 1], // 레슨당 차원 배치 비율 D1..D5
  models: [6, 3, 6, 4, 2], // 차원별 문항모형 수 — 위치 수 / 모형 수 = 모형당 소재 슬롯
  loading: [0.5, 0.7],
  corr: [0.3, 0.5],
  threshold: [-0.8, 0.8],
  anchors: 'all', // 'all' 또는 차원당 앵커 위치 수
  variants: 1,
  dropout: 0,
  dropoutAbility: 0, // >0 이면 능력(η 평균)이 낮을수록 이탈 확률↑ (MNAR)
  familyResidual: 0.2,
  seed: 592,
});

export function parseArgs(argv) {
  const o = { ...DEFAULTS, perLesson: [...DEFAULTS.perLesson], models: [...DEFAULTS.models] };
  const num = (v) => Number(v);
  const pair = (v) => v.split(',').map(Number);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const v = argv[i + 1];
    switch (k) {
      case 'out': o.out = v; i += 1; break;
      case 'n': o.n = num(v); i += 1; break;
      case 'lessons': o.lessons = num(v); i += 1; break;
      case 'per-lesson': o.perLesson = pair(v); i += 1; break;
      case 'models': o.models = pair(v); i += 1; break;
      case 'loading': o.loading = pair(v); i += 1; break;
      case 'corr': o.corr = pair(v); i += 1; break;
      case 'threshold': o.threshold = pair(v); i += 1; break;
      case 'anchors': o.anchors = v === 'all' ? 'all' : num(v); i += 1; break;
      case 'variants': o.variants = num(v); i += 1; break;
      case 'dropout': o.dropout = num(v); i += 1; break;
      case 'dropout-ability': o.dropoutAbility = num(v); i += 1; break;
      case 'family-residual': o.familyResidual = num(v); i += 1; break;
      case 'seed': o.seed = num(v); i += 1; break;
      default: throw new Error(`unknown option --${k}`);
    }
  }
  if (o.perLesson.length !== 5 || o.models.length !== 5) throw new Error('--per-lesson / --models 는 5개 값');
  return o;
}

// mulberry32 — 32비트 시드 결정적 난수. Box–Muller 로 정규.
export function makeRng(seed) {
  let a = (seed >>> 0) || 1;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    uniform: (lo = 0, hi = 1) => lo + (hi - lo) * next(),
    normal: () => {
      let u = 0;
      let v = 0;
      while (u === 0) u = next();
      while (v === 0) v = next();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
    int: (n) => Math.floor(next() * n),
  };
}

export function cholesky(A) {
  const n = A.length;
  const L = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j <= i; j += 1) {
      let s = A[i][j];
      for (let k = 0; k < j; k += 1) s -= L[i][k] * L[j][k];
      if (i === j) {
        if (s <= 0) return null;
        L[i][i] = Math.sqrt(s);
      } else {
        L[i][j] = s / L[j][j];
      }
    }
  }
  return L;
}

// 요인 상관 행렬: 비대각을 범위에서 뽑고 양정치가 아니면 0 쪽으로 줄인다.
export function buildCorr(dims, range, rng) {
  const M = Array.from({ length: dims }, (_, i) => Array.from({ length: dims }, (_, j) => (i === j ? 1 : 0)));
  for (let i = 0; i < dims; i += 1) for (let j = i + 1; j < dims; j += 1) { const r = rng.uniform(range[0], range[1]); M[i][j] = r; M[j][i] = r; }
  let L = cholesky(M);
  let shrink = 0;
  while (!L && shrink < 20) {
    for (let i = 0; i < dims; i += 1) for (let j = 0; j < dims; j += 1) if (i !== j) M[i][j] *= 0.9;
    L = cholesky(M);
    shrink += 1;
  }
  if (!L) throw new Error('correlation matrix not positive definite');
  return { phi: M, L };
}

const pad2 = (n) => String(n).padStart(2, '0');
const pad3 = (n) => String(n).padStart(3, '0');
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
// 표준정규 CDF (Abramowitz–Stegun 7.1.26) — p_correct 진값 계산용
function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-x * x / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

// 위치(패밀리×소재) 배치: 레슨마다 per-lesson 비율대로, 같은 모형은 레슨당 1개 — 모형을 라운드로빈.
export function layoutPositions(o, rng) {
  const positions = [];
  const nextSource = Array.from({ length: 5 }, (_, d) => new Array(o.models[d]).fill(0));
  const modelCursor = new Array(5).fill(0);
  const baseLoading = Array.from({ length: 5 }, (_, d) => Array.from({ length: o.models[d] }, () => rng.uniform(o.loading[0], o.loading[1])));
  for (let lesson = 1; lesson <= o.lessons; lesson += 1) {
    let order = 0;
    // 레슨 안에서 차원을 섞어 배치(D1 D3 D4 D2 D5 순 반복) — 순서 효과 없이 비율만 지킨다
    const slots = [];
    for (let d = 0; d < 5; d += 1) for (let s = 0; s < o.perLesson[d]; s += 1) slots.push(d);
    // 결정적 셔플
    for (let i = slots.length - 1; i > 0; i -= 1) { const j = rng.int(i + 1); [slots[i], slots[j]] = [slots[j], slots[i]]; }
    for (const d of slots) {
      const m = modelCursor[d] % o.models[d];
      modelCursor[d] += 1;
      nextSource[d][m] += 1;
      order += 1;
      const familyCode = `F-D${d + 1}-${pad2(m + 1)}`;
      const sourceId = `s${pad3(nextSource[d][m])}`;
      const tau = rng.uniform(o.threshold[0], o.threshold[1]);
      positions.push({
        positionId: `D${d + 1}-${pad2(m + 1)}${sourceId}`,
        familyCode,
        dimension: d + 1,
        modelIndex: m,
        sourceId,
        lesson,
        orderInLesson: order,
        position: positions.length + 1,
        loading: clamp(baseLoading[d][m] + rng.uniform(-0.05, 0.05), 0.2, 0.9),
        threshold: tau,
      });
    }
  }
  return positions;
}

export function simulate(opts) {
  const o = { ...DEFAULTS, ...opts };
  const rng = makeRng(o.seed);
  const { phi, L } = buildCorr(5, o.corr, rng);
  const positions = layoutPositions(o, rng);
  // 앵커: 차원별 앞에서 k 위치(전원 노출·회전 없음). 'all' = 전부 앵커(창 A 형제 1개 상황).
  const perDimSeen = new Array(5).fill(0);
  for (const p of positions) {
    perDimSeen[p.dimension - 1] += 1;
    p.isAnchor = o.anchors === 'all' || perDimSeen[p.dimension - 1] <= o.anchors;
    const k = p.isAnchor ? 1 : Math.max(1, o.variants);
    p.variants = Array.from({ length: k }, (_, v) => ({
      itemId: `${p.positionId}v${v + 1}`,
      loading: k === 1 ? p.loading : clamp(p.loading + rng.uniform(-0.05, 0.05), 0.2, 0.9),
      threshold: k === 1 ? p.threshold : p.threshold + rng.uniform(-0.15, 0.15),
    }));
  }
  const familyKeys = [...new Set(positions.map((p) => p.familyCode))];
  const gamma = o.familyResidual;

  const users = [];
  const long = [];
  const asOf = '2026-10-20';
  for (let i = 0; i < o.n; i += 1) {
    const z = Array.from({ length: 5 }, () => rng.normal());
    const eta = Array.from({ length: 5 }, (_, r) => L[r].reduce((acc, l, c) => acc + l * z[c], 0));
    const xi = Object.fromEntries(familyKeys.map((f) => [f, rng.normal()]));
    // 이탈: 레슨 1은 반드시 완주, 이후 매 레슨 1-dropout 확률로 계속
    const etaMean = eta.reduce((a, b) => a + b, 0) / 5;
    const hazard = clamp(o.dropout * Math.exp(-o.dropoutAbility * etaMean), 0, 0.95);
    let completed = 1;
    while (completed < o.lessons && rng.uniform() >= hazard) completed += 1;
    const userHash = sha256(`synthetic:${o.seed}:${i}`);
    const persona = ['office_worker', 'marketer', 'developer', 'designer', 'student', 'owner', 'educator', 'general'][rng.int(8)];
    users.push({
      user_hash: userHash,
      birth_year_band: ['1980-1984', '1985-1989', '1990-1994', '1995-1999', '2000-2004'][rng.int(5)],
      gender: ['male', 'female', 'unspecified'][rng.int(3)],
      persona,
      employment_type: ['employed', 'freelance', 'student', 'none'][rng.int(4)],
      ai_experience: ['none', 'light', 'regular'][rng.int(3)],
      acquisition_channel: 'synthetic',
      signup_date: '2026-10-14',
      first_completion_date: '2026-10-14',
      research_agreed: rng.uniform() < 0.5 ? 'true' : 'false',
      cohort_flag: 'campaign',
      completed_lessons: completed,
      true_eta_mean: etaMean.toFixed(4),
    });
    for (const p of positions) {
      if (p.lesson > completed) continue; // 단조 결측
      const k = p.variants.length;
      const vIdx = k === 1 ? 0 : parseInt(sha256(`${userHash}:${p.positionId}`).slice(0, 8), 16) % k;
      const v = p.variants[vIdx];
      const lam = v.loading;
      const g = p.dimension === 5 || gamma === 0 ? gamma : gamma; // 전 차원 동일 γ (형제 국소 의존)
      const resid = Math.sqrt(Math.max(0, 1 - lam * lam - g * g));
      const ystar = lam * eta[p.dimension - 1] + g * xi[p.familyCode] + resid * rng.normal();
      const correct = ystar > v.threshold ? 1 : 0;
      long.push({
        user_hash: userHash,
        analysis_item_id: `${v.itemId}@v1`,
        position_id: p.positionId,
        correct,
        served_as: 'scored',
        session_id: `s-${i}-${p.lesson}`,
        position: p.position,
        latency_ms: Math.round(4000 + Math.abs(rng.normal()) * 6000),
        answered_date: asOf,
        app_version: '1.1.0',
        platform: rng.uniform() < 0.7 ? 'ios' : 'android',
      });
    }
  }

  // 문항·위치 메타 + 관측 정답률
  const stats = {};
  for (const r of long) {
    const s = (stats[r.analysis_item_id] ||= { n: 0, c: 0 });
    s.n += 1; s.c += r.correct;
  }
  const items = [];
  const positionRows = [];
  for (const p of positions) {
    let pn = 0; let pc = 0;
    for (const v of p.variants) {
      const id = `${v.itemId}@v1`;
      const s = stats[id] || { n: 0, c: 0 };
      pn += s.n; pc += s.c;
      items.push({
        analysis_item_id: id, item_id: v.itemId, content_version: 1, family_code: p.familyCode, dimension: p.dimension,
        source_id: p.sourceId, variant_no: Number(v.itemId.slice(-1)), variant_kind: 'value', position_id: p.positionId,
        mission_id: sha256(`mission:${v.itemId}`).slice(0, 36), mission_code: `main-syn-l${p.lesson}-${p.orderInLesson}`,
        mission_slug: v.itemId.toLowerCase(), unit_slug: 'synthetic-unit-1', lesson_order: p.lesson, order_in_lesson: p.orderInLesson,
        position: p.position, format: 'mcq_single', content_hash: sha256(`content:${v.itemId}`), is_anchor: p.isAnchor ? 'true' : 'false',
        recalled_at: '', p_correct: s.n ? (s.c / s.n).toFixed(4) : '', n: s.n,
        true_loading: v.loading.toFixed(4), true_threshold: v.threshold.toFixed(4), true_p_correct: (1 - normCdf(v.threshold)).toFixed(4),
      });
    }
    positionRows.push({
      position_id: p.positionId, family_code: p.familyCode, dimension: p.dimension, source_id: p.sourceId, lesson_order: p.lesson,
      order_in_lesson: p.orderInLesson, position: p.position, is_anchor: p.isAnchor ? 'true' : 'false', variants: p.variants.length,
      recalled_at: '', p_correct: pn ? (pc / pn).toFixed(4) : '', n: pn, true_loading: p.loading.toFixed(4), true_threshold: p.threshold.toFixed(4),
    });
  }

  return { o, phi, positions, items, positionRows, users, long, asOf };
}

function toCsv(rows, columns) {
  const esc = (v) => (v === null || v === undefined ? '' : String(v));
  return [columns.join(','), ...rows.map((r) => columns.map((c) => esc(r[c])).join(','))].join('\n') + '\n';
}

function wideFrom(long, users, columnOf, columns) {
  const byUser = new Map(users.map((u) => [u.user_hash, {}]));
  for (const r of long) byUser.get(r.user_hash)[columnOf(r)] = r.correct;
  const lines = [['user_hash', ...columns].join(',')];
  for (const u of users) {
    const row = byUser.get(u.user_hash);
    lines.push([u.user_hash, ...columns.map((c) => (c in row ? row[c] : 'NA'))].join(','));
  }
  return lines.join('\n') + '\n';
}

export function writeSnapshot(dir, sim) {
  mkdirSync(dir, { recursive: true });
  const { o, phi, positions, items, positionRows, users, long, asOf } = sim;
  const files = {};
  const put = (name, content) => { writeFileSync(join(dir, name), content); files[name] = { sha256: sha256(content), bytes: Buffer.byteLength(content) }; };
  put('responses_long.csv', toCsv(long, ['user_hash', 'analysis_item_id', 'correct', 'served_as', 'session_id', 'position', 'latency_ms', 'answered_date', 'app_version', 'platform']));
  put('responses_wide.csv', wideFrom(long, users, (r) => r.analysis_item_id, items.map((it) => it.analysis_item_id)));
  put('responses_wide_family.csv', wideFrom(long, users, (r) => r.position_id, positionRows.map((p) => p.position_id)));
  put('items.csv', toCsv(items, Object.keys(items[0])));
  put('positions.csv', toCsv(positionRows, Object.keys(positionRows[0])));
  put('respondents.csv', toCsv(users, ['user_hash', 'birth_year_band', 'gender', 'persona', 'employment_type', 'ai_experience', 'acquisition_channel', 'signup_date', 'first_completion_date', 'research_agreed', 'cohort_flag', 'completed_lessons', 'true_eta_mean']));
  const truth = {
    seed: o.seed, phi, family_residual: o.familyResidual,
    positions: positions.map((p) => ({ position_id: p.positionId, family_code: p.familyCode, dimension: p.dimension, is_anchor: p.isAnchor, loading: p.loading, threshold: p.threshold, variants: p.variants })),
  };
  put('truth.json', JSON.stringify(truth, null, 2));
  const perDim = [1, 2, 3, 4, 5].map((d) => positionRows.filter((p) => p.dimension === d).length);
  const manifest = {
    as_of: asOf, generator: 'validation/cfa/simulate-snapshot.mjs', synthetic: true, params: { ...o, out: undefined },
    counts: { respondents: users.length, responses: long.length, positions: positionRows.length, items: items.length, per_dimension: perDim },
    files,
  };
  put('manifest.json', JSON.stringify(manifest, null, 2));
  return manifest;
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const o = parseArgs(process.argv.slice(2));
  if (!o.out) { console.error('--out <dir> 필수'); process.exit(2); }
  const sim = simulate(o);
  const m = writeSnapshot(o.out, sim);
  console.log(`snapshot → ${o.out} | respondents=${m.counts.respondents} responses=${m.counts.responses} positions=${m.counts.positions} items=${m.counts.items} per_dim=${m.counts.per_dimension.join('/')}`);
}
