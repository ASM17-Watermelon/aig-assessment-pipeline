// 응답 스냅샷의 순수 부분 — 품질 필터 F1~F11 · 문항/위치 집계 · 와이드 변환 · 셀 병합 · CSV · 매니페스트.
//
// 실응답(앱 응답 원장 추출)과 가상 응답(persona-sim emit)이 같은 함수로 같은 파일 형식을 만든다 — 그래서 CFA·IRT 스크립트가 둘을 구분 없이 읽는다.
//   규칙은 순수 함수로 두고 픽스처 테스트(snapshot-lib.test.mjs)가 11종을 각각 고정한다. 같은 입력이면 바이트까지 같은 출력을 낸다.
// 입력 행 형상 = 응답 원장 추출 함수의 반환 컬럼(pos = position).
// 출력 파일 형상 = validation/cfa/simulate-snapshot.mjs 와 동일(run-cfa.R·run-irt.R 가 합성·실데이터를 구분 없이 읽는다).
// 의존성 0(node:crypto 만).

import { createHash } from 'node:crypto';

export const SCRIPT_VERSION = '591.1';
export const SOURCE = 'ledger';
// F11: 선택형 포맷만 — 수행형(order_steps·match_pairs·compare_outputs)·free_writing 은 CFA 지표가 아니다.
export const CFA_FORMATS = Object.freeze(['mcq_single', 'mcq_multi', 'compare_two', 'fill_blank_choice', 'spot_the_bug']);
export const COHORT_KEEP = 'campaign';
export const DEFAULT_RULES = Object.freeze({
  elapsedMinMs: 3000,     // F4 — 미만이면 그 응답 제외(NULL 은 통과: 정보 없음 ≠ 부주의)
  straightRun: 8,         // F5 — 한 세션 연속 8문항 같은 selected_key → 세션 제외
  extremeMinN: 100,       // F8 — n ≥ 100 일 때만 극단 판정
  extremeLow: 0.10,
  extremeHigh: 0.90,
  cellMin: 5,             // 준식별자 셀 5 미만 → 'other' 병합(가명 처리 규칙)
  includePartial: false,  // F3 — true 면 미완주 세션도 남긴다(민감도 분석용, 매니페스트에 기록)
});

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const cmpKey = (...fns) => (a, b) => { for (const f of fns) { const c = cmp(f(a), f(b)); if (c) return c; } return 0; };

// F5 — 세션별로 order_in_lesson 순으로 훑어 연속 run 이상 같은 selected_key 가 나오면 그 세션 전체를 제외한다.
export function straightLineSessions(rows, run) {
  const bySession = new Map();
  for (const r of rows) {
    if (!bySession.has(r.session_id)) bySession.set(r.session_id, []);
    bySession.get(r.session_id).push(r);
  }
  const flagged = new Set();
  for (const [sid, list] of bySession) {
    list.sort(cmpKey((r) => r.order_in_lesson, (r) => r.analysis_item_id ?? ''));
    let streak = 0;
    let prev = null;
    for (const r of list) {
      const k = r.selected_key ?? null;
      streak = k !== null && k === prev ? streak + 1 : (k === null ? 0 : 1);
      prev = k;
      if (streak >= run) { flagged.add(sid); break; }
    }
  }
  return flagged;
}

// 필터를 번호 순서로 적용하고 단계별 탈락 수를 남긴다(순서가 바뀌면 집계가 바뀌므로 고정).
// F6 은 응답자 단위(cohort_flag ≠ campaign 제외 · 탈퇴자는 추출 단계에서 이미 제외), F8 은 문항 단위라 buildItems 에서, F10 은 미적용.
export function applyFilters(responses, respondents, { recall = new Map(), excludeSessions = new Set(), rules = DEFAULT_RULES } = {}) {
  const dropped = {
    no_lineage: 0, F1_attempt: 0, F2_served_as: 0, F3_incomplete: 0, F4_fast: 0,
    F5_straight_rows: 0, F5_straight_sessions: 0, F6_cohort: { internal: 0, pilot_friend: 0, pre_campaign: 0 }, F6_cohort_rows: 0,
    F7_recalled: 0, F9_excluded_rows: 0, F9_excluded_sessions: 0, F11_format: 0, ungraded: 0,
  };
  const cohortOf = new Map(respondents.map((u) => [u.user_hash, u.cohort_flag]));
  for (const u of respondents) if (u.cohort_flag !== COHORT_KEEP && u.cohort_flag in dropped.F6_cohort) dropped.F6_cohort[u.cohort_flag] += 1;

  const withLineage = [];
  for (const r of responses) {
    if (!r.item_id || !r.analysis_item_id || r.pos == null) { dropped.no_lineage += 1; continue; }
    withLineage.push(r);
  }
  let rows = withLineage.filter((r) => { if (r.attempt_no !== 1) { dropped.F1_attempt += 1; return false; } return true; });
  rows = rows.filter((r) => { if (r.served_as !== 'scored') { dropped.F2_served_as += 1; return false; } return true; });
  if (!rules.includePartial) rows = rows.filter((r) => { if (!r.lesson_completed) { dropped.F3_incomplete += 1; return false; } return true; });
  rows = rows.filter((r) => { if (r.elapsed_ms != null && r.elapsed_ms < rules.elapsedMinMs) { dropped.F4_fast += 1; return false; } return true; });
  const straight = straightLineSessions(rows, rules.straightRun);
  dropped.F5_straight_sessions = straight.size;
  rows = rows.filter((r) => { if (straight.has(r.session_id)) { dropped.F5_straight_rows += 1; return false; } return true; });
  rows = rows.filter((r) => { if (cohortOf.get(r.user_hash) !== COHORT_KEEP) { dropped.F6_cohort_rows += 1; return false; } return true; });
  rows = rows.filter((r) => { if (recall.has(r.item_id)) { dropped.F7_recalled += 1; return false; } return true; });
  const excludedSeen = new Set();
  rows = rows.filter((r) => { if (excludeSessions.has(r.session_id)) { dropped.F9_excluded_rows += 1; excludedSeen.add(r.session_id); return false; } return true; });
  dropped.F9_excluded_sessions = excludedSeen.size;
  rows = rows.filter((r) => { if (!CFA_FORMATS.includes(r.format)) { dropped.F11_format += 1; return false; } return true; });
  rows = rows.filter((r) => { if (r.is_correct !== true && r.is_correct !== false) { dropped.ungraded += 1; return false; } return true; });

  const long = rows.map((r) => ({
    user_hash: r.user_hash, analysis_item_id: r.analysis_item_id, position_id: r.position_id, correct: r.is_correct ? 1 : 0,
    served_as: r.served_as, session_id: r.session_id, position: r.pos, latency_ms: r.elapsed_ms ?? null,
    answered_date: r.answered_date, app_version: r.app_version ?? null, platform: r.platform ?? null,
  })).sort(cmpKey((r) => r.user_hash, (r) => r.position, (r) => r.analysis_item_id, (r) => r.session_id));
  const kept = new Set(long.map((r) => r.user_hash));
  const respondentsKept = respondents.filter((u) => kept.has(u.user_hash)).sort(cmpKey((u) => u.user_hash));
  return { long, withLineage, respondentsKept, dropped };
}

// 문항(변형) 표 — 계보가 있는 모든 문항(회수 포함)을 나열하고, 통계는 필터 후 long 으로 센다. F8 극단 판정도 여기서.
export function buildItems(withLineage, long, { recall = new Map(), rules = DEFAULT_RULES } = {}) {
  const meta = new Map();
  for (const r of withLineage) {
    if (meta.has(r.analysis_item_id)) continue;
    meta.set(r.analysis_item_id, {
      analysis_item_id: r.analysis_item_id, item_id: r.item_id, content_version: r.content_version, family_code: r.family_code,
      dimension: r.dimension, source_id: r.source_id ?? '', variant_no: r.variant_no ?? '', variant_kind: r.variant_kind ?? '',
      position_id: r.position_id, mission_id: r.mission_id, mission_code: r.mission_code, mission_slug: r.mission_slug,
      unit_slug: r.unit_slug, lesson_order: r.lesson_order, order_in_lesson: r.order_in_lesson, position: r.pos, format: r.format,
      content_hash: r.content_hash ?? '',
    });
  }
  const stats = new Map();
  for (const r of long) { const s = stats.get(r.analysis_item_id) ?? { n: 0, c: 0 }; s.n += 1; s.c += r.correct; stats.set(r.analysis_item_id, s); }
  const variantsPerPosition = new Map();
  for (const m of meta.values()) variantsPerPosition.set(m.position_id, (variantsPerPosition.get(m.position_id) ?? new Set()).add(m.item_id));
  const items = [...meta.values()].map((m) => {
    const s = stats.get(m.analysis_item_id) ?? { n: 0, c: 0 };
    const p = s.n ? s.c / s.n : null;
    const rec = recall.get(m.item_id);
    const extreme = s.n >= rules.extremeMinN && p != null && (p < rules.extremeLow || p > rules.extremeHigh);
    return {
      ...m,
      // 변형 회전 전엔 위치마다 변형 1개 = 전원 노출 = 앵커. 회전이 시작되면 형제 수 > 1 인 위치가 비앵커가 된다.
      is_anchor: variantsPerPosition.get(m.position_id).size === 1 ? 'true' : 'false',
      recalled_at: rec ? rec.recalled_at : '', p_correct: p == null ? '' : p.toFixed(4), n: s.n, extreme_p: extreme ? 'true' : 'false',
    };
  }).sort(cmpKey((m) => m.position, (m) => m.analysis_item_id));
  return items;
}

export const ITEM_COLUMNS = Object.freeze(['analysis_item_id', 'item_id', 'content_version', 'family_code', 'dimension', 'source_id', 'variant_no', 'variant_kind', 'position_id', 'mission_id', 'mission_code', 'mission_slug', 'unit_slug', 'lesson_order', 'order_in_lesson', 'position', 'format', 'content_hash', 'is_anchor', 'recalled_at', 'p_correct', 'n', 'extreme_p']);
export const POSITION_COLUMNS = Object.freeze(['position_id', 'family_code', 'dimension', 'source_id', 'lesson_order', 'order_in_lesson', 'position', 'is_anchor', 'variants', 'recalled_at', 'p_correct', 'n', 'extreme_p']);
export const LONG_COLUMNS = Object.freeze(['user_hash', 'analysis_item_id', 'correct', 'served_as', 'session_id', 'position', 'latency_ms', 'answered_date', 'app_version', 'platform']);
export const RESPONDENT_COLUMNS = Object.freeze(['user_hash', 'birth_year_band', 'gender', 'persona', 'employment_type', 'ai_experience', 'acquisition_channel', 'signup_date', 'first_completion_date', 'research_agreed', 'cohort_flag', 'completed_lessons']);
const MERGE_COLUMNS = Object.freeze(['birth_year_band', 'gender', 'persona', 'employment_type', 'ai_experience', 'acquisition_channel']);

// 위치(패밀리×소재) 표 — 형제 변형을 접은 행. 회수·극단은 "모든 변형이 그렇다"일 때만 위치 제외.
export function buildPositions(items) {
  const byPos = new Map();
  for (const it of items) {
    const p = byPos.get(it.position_id) ?? {
      position_id: it.position_id, family_code: it.family_code, dimension: it.dimension, source_id: it.source_id, lesson_order: it.lesson_order,
      order_in_lesson: it.order_in_lesson, position: it.position, is_anchor: it.is_anchor, variants: 0, n: 0, c: 0, allRecalled: true, allExtreme: true, recalled_at: '',
    };
    p.variants += 1; p.n += it.n; p.c += it.n && it.p_correct !== '' ? Math.round(Number(it.p_correct) * it.n) : 0;
    p.allRecalled = p.allRecalled && it.recalled_at !== '';
    p.allExtreme = p.allExtreme && it.extreme_p === 'true';
    if (it.recalled_at !== '' && (p.recalled_at === '' || it.recalled_at < p.recalled_at)) p.recalled_at = it.recalled_at;
    byPos.set(it.position_id, p);
  }
  return [...byPos.values()].map((p) => ({
    position_id: p.position_id, family_code: p.family_code, dimension: p.dimension, source_id: p.source_id, lesson_order: p.lesson_order,
    order_in_lesson: p.order_in_lesson, position: p.position, is_anchor: p.is_anchor, variants: p.variants,
    recalled_at: p.allRecalled ? p.recalled_at : '', p_correct: p.n ? (p.c / p.n).toFixed(4) : '', n: p.n, extreme_p: p.allExtreme && p.n > 0 ? 'true' : 'false',
  })).sort(cmpKey((p) => p.position, (p) => p.position_id));
}

// 와이드 — 행 = 응답자(user_hash 순), 열 = 지표(회수·극단·응답 0 제외), 셀 = 0/1/NA. lavaan ordered=TRUE 입력.
export function buildWide(long, respondents, columnsMeta, columnOf) {
  const columns = columnsMeta.filter((c) => c.recalled_at === '' && c.extreme_p !== 'true' && c.n > 0).map(columnOf.key);
  const byUser = new Map(respondents.map((u) => [u.user_hash, new Map()]));
  for (const r of long) {
    const cell = byUser.get(r.user_hash);
    if (!cell) continue;
    const k = columnOf.row(r);
    if (!cell.has(k)) cell.set(k, r.correct);   // 같은 위치를 두 변형으로 본 경우는 첫 변형(정렬순)만
  }
  const lines = [['user_hash', ...columns].join(',')];
  for (const u of respondents) {
    const cell = byUser.get(u.user_hash);
    lines.push([u.user_hash, ...columns.map((c) => (cell.has(c) ? cell.get(c) : 'NA'))].join(','));
  }
  return lines.join('\n') + '\n';
}

// 준식별자 셀 5 미만 → 'other'. NULL 은 세지 않고 그대로 둔다. 단일 패스 — 'other' 가 다시 5 미만이어도 더 접지 않는다(기록만).
export function mergeSmallCells(respondents, cellMin = DEFAULT_RULES.cellMin) {
  const out = respondents.map((u) => ({ ...u }));
  const merged = {};
  for (const col of MERGE_COLUMNS) {
    const counts = new Map();
    for (const u of out) if (u[col] != null && u[col] !== '') counts.set(u[col], (counts.get(u[col]) ?? 0) + 1);
    const small = [...counts].filter(([, n]) => n < cellMin).map(([v]) => v).sort();
    if (small.length) merged[col] = small;
    for (const u of out) if (small.includes(u[col])) u[col] = 'other';
  }
  return { respondents: out, merged };
}

export function toCsv(rows, columns) {
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.join(','), ...rows.map((r) => columns.map((c) => esc(r[c])).join(','))].join('\n') + '\n';
}

// 전체 조립 — 입력(함수 반환 행 + 보조 파일) → 파일 내용 문자열 map + 집계. 시각·난수 없음: 같은 입력 = 같은 바이트.
export function buildSnapshot({ responses, respondents, recall, excludeSessions, rules = DEFAULT_RULES }) {
  const { long, withLineage, respondentsKept, dropped } = applyFilters(responses, respondents, { recall, excludeSessions, rules });
  const items = buildItems(withLineage, long, { recall, rules });
  const positions = buildPositions(items);
  const { respondents: respondentsOut, merged } = mergeSmallCells(respondentsKept, rules.cellMin);
  const files = {
    'responses_long.csv': toCsv(long, LONG_COLUMNS),
    'responses_wide.csv': buildWide(long, respondentsOut, items, { key: (c) => c.analysis_item_id, row: (r) => r.analysis_item_id }),
    'responses_wide_family.csv': buildWide(long, respondentsOut, positions, { key: (c) => c.position_id, row: (r) => r.position_id }),
    'items.csv': toCsv(items, ITEM_COLUMNS),
    'positions.csv': toCsv(positions, POSITION_COLUMNS),
    'respondents.csv': toCsv(respondentsOut, RESPONDENT_COLUMNS),
  };
  const perDim = [1, 2, 3, 4, 5].map((d) => ({
    dimension: d,
    items: items.filter((i) => Number(i.dimension) === d && i.recalled_at === '' && i.extreme_p !== 'true' && i.n > 0).length,
    positions: positions.filter((p) => Number(p.dimension) === d && p.recalled_at === '' && p.extreme_p !== 'true' && p.n > 0).length,
  }));
  const counts = {
    input: { responses: responses.length, respondents: respondents.length },
    dropped,
    output: {
      responses: long.length, respondents: respondentsOut.length, items: items.length, positions: positions.length,
      items_excluded: { recalled: items.filter((i) => i.recalled_at !== '').length, extreme_p: items.filter((i) => i.extreme_p === 'true').length, no_response: items.filter((i) => i.n === 0).length },
      per_dimension: perDim,
      completed_lessons_histogram: histogram(respondentsOut.map((u) => u.completed_lessons)),
    },
    cells_merged: merged,
  };
  return { files, counts, long, items, positions, respondents: respondentsOut };
}

function histogram(values) {
  const h = {};
  for (const v of values) h[v] = (h[v] ?? 0) + 1;
  return Object.fromEntries(Object.keys(h).sort((a, b) => Number(a) - Number(b)).map((k) => [k, h[k]]));
}

export function buildManifest({ asOf, campaignStart, gitSha, rules, inputs, counts, files }) {
  const fileMeta = Object.fromEntries(Object.entries(files).sort(([a], [b]) => cmp(a, b)).map(([name, content]) => [
    name, { rows: content.split('\n').length - 2, bytes: Buffer.byteLength(content), sha256: sha256(content) },
  ]));
  const manifest = {
    study: 'aig-assessment-pipeline', script_version: SCRIPT_VERSION, source: SOURCE, as_of: asOf, campaign_start: campaignStart, git_sha: gitSha,
    content_freeze: { recall_file_sha256: inputs.recall_file_sha256 ?? null, recalled_items: inputs.recalled_items ?? 0 },
    filters: {
      F1: 'attempt_no = 1', F2: "served_as = 'scored'", F3: rules.includePartial ? 'OFF (include_partial — 민감도 분석용)' : 'lesson_completed = true',
      F4: `elapsed_ms >= ${rules.elapsedMinMs} (NULL 통과)`, F5: `한 세션 연속 ${rules.straightRun}문항 같은 selected_key → 세션 제외`,
      F6: `cohort_flag = '${COHORT_KEEP}' (internal·pilot_friend·pre_campaign 제외 · deleted_at IS NULL 은 DB 함수)`,
      F7: '회수 목록 item_id 응답 전부 제외', F8: `n >= ${rules.extremeMinN} 이고 p < ${rules.extremeLow} 또는 p > ${rules.extremeHigh} → 와이드에서 열 제외(items.csv extreme_p)`,
      F9: inputs.exclude_sessions_sha256 ? '세션 목록 파일 적용' : 'OFF (반응왜곡 마커 미확정 — 훅만)', F10: 'NOT APPLIED (기기 식별 부재)',
      F11: `format in (${CFA_FORMATS.join(', ')})`, cell_min: rules.cellMin,
    },
    inputs: { cohort_file_sha256: inputs.cohort_file_sha256 ?? null, recall_file_sha256: inputs.recall_file_sha256 ?? null, exclude_sessions_sha256: inputs.exclude_sessions_sha256 ?? null, internal_ids: inputs.internal_ids ?? 0, pilot_ids: inputs.pilot_ids ?? 0 },
    counts,
    files: fileMeta,
    notes: [
      'research_agreed 는 선택 동의 기능 전이라 전부 NA',
      'is_anchor = 위치의 변형 수 1 (변형 회전 전엔 전부 true)',
      '같은 as_of + 같은 코드(git_sha) + 같은 보조 파일 = 바이트 동일',
    ],
  };
  return JSON.stringify(sortKeys(manifest), null, 2) + '\n';
}

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}

// 보조 파일 파서 — 헤더 유무 무관, 공백·주석(#) 무시.
export function parseRecallFile(text) {
  const m = new Map();
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#') || /^item_id\s*,/i.test(t)) continue;
    const [item_id, recalled_at = '', ...rest] = t.split(',').map((s) => s.trim());
    if (item_id) m.set(item_id, { recalled_at, reason: rest.join(',') });
  }
  return m;
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function parseCohortFile(text) {
  const internal = [];
  const pilot = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#') || /^user_id\s*,/i.test(t)) continue;
    const [id, flag = 'internal'] = t.split(',').map((s) => s.trim());
    if (!UUID_RE.test(id)) throw new Error(`cohort file: UUID 아님 — ${id}`);
    if (flag === 'internal') internal.push(id.toLowerCase());
    else if (flag === 'pilot_friend') pilot.push(id.toLowerCase());
    else throw new Error(`cohort file: flag 는 internal|pilot_friend — ${flag}`);
  }
  return { internal: [...new Set(internal)].sort(), pilot: [...new Set(pilot)].sort() };
}
export function parseSessionsFile(text) {
  return new Set(text.split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('#') && !/^session_id$/i.test(s)));
}
