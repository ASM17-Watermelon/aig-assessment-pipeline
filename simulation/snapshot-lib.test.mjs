// 필터 F1~F11 픽스처 테스트 + 재현성. 실행: node --test simulation/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyFilters, buildItems, buildManifest, buildPositions, buildSnapshot, mergeSmallCells, parseCohortFile, parseRecallFile,
  parseSessionsFile, straightLineSessions, DEFAULT_RULES,
} from './snapshot-lib.mjs';

// 픽스처 — 응답 원장 추출 함수의 반환 형상. 기본값은 전부 "통과"하는 응답이고, 케이스마다 하나만 바꾼다.
const H1 = 'a'.repeat(64);
const H2 = 'b'.repeat(64);
const H3 = 'c'.repeat(64);
let seq = 0;
const row = (over = {}) => ({
  rn: ++seq, user_hash: H1, analysis_item_id: 'D1-01s001v1@v1', item_id: 'D1-01s001v1', content_version: 1, position_id: 'D1-01s001',
  family_code: 'F-D1-01', dimension: 1, source_id: 's001', variant_no: 1, variant_kind: 'value', mission_id: 'm1', mission_code: 'M1',
  mission_slug: 'd1-01s001v1', unit_slug: 'u1', unit_order: 1, lesson_order: 1, order_in_lesson: 1, pos: 1, format: 'mcq_single',
  content_hash: 'h', served_as: 'scored', session_id: 's1', attempt_no: 1, is_correct: true, score: 1, elapsed_ms: 5000,
  selected_key: '1', answered_date: '2026-10-02', app_version: '1.1.0', platform: 'ios', bundle_id: 'embedded', lesson_completed: true, ...over,
});
const user = (over = {}) => ({
  rn: 1, user_hash: H1, birth_year_band: '1990-1994', gender: 'male', persona: 'developer', employment_type: 'emp_org', ai_experience: 'often',
  acquisition_channel: 'ad', signup_date: '2026-10-01', first_completion_date: '2026-10-02', research_agreed: null, cohort_flag: 'campaign',
  completed_lessons: 1, ledger_responses: 1, ...over,
});
const items3 = (over = {}) => [
  row({ analysis_item_id: 'D1-01s001v1@v1', item_id: 'D1-01s001v1', position_id: 'D1-01s001', pos: 1, order_in_lesson: 1, ...over }),
  row({ analysis_item_id: 'D3-01s001v1@v1', item_id: 'D3-01s001v1', position_id: 'D3-01s001', family_code: 'F-D3-01', dimension: 3, pos: 2, order_in_lesson: 2, ...over }),
  row({ analysis_item_id: 'D2-01s001v1@v1', item_id: 'D2-01s001v1', position_id: 'D2-01s001', family_code: 'F-D2-01', dimension: 2, pos: 3, order_in_lesson: 3, ...over }),
];
const kept = (responses, respondents = [user()], extra = {}) => applyFilters(responses, respondents, extra);

test('통과 기준선 — 기본 픽스처는 전부 남는다', () => {
  const r = kept(items3());
  assert.equal(r.long.length, 3);
  assert.deepEqual(r.long.map((x) => x.position), [1, 2, 3]);
  assert.equal(r.respondentsKept.length, 1);
});

test('계보 없음(item_id NULL) → no_lineage', () => {
  const r = kept([row(), row({ analysis_item_id: null, item_id: null, position_id: null, pos: null })]);
  assert.equal(r.long.length, 1);
  assert.equal(r.dropped.no_lineage, 1);
});

test('F1 첫 시도만 — attempt_no 2 제외', () => {
  const r = kept([row(), row({ attempt_no: 2, session_id: 's2' })]);
  assert.equal(r.long.length, 1);
  assert.equal(r.dropped.F1_attempt, 1);
});

test("F2 채점 응답만 — served_as 'seed' 제외", () => {
  const r = kept([row(), row({ served_as: 'seed', analysis_item_id: 'D1-02s001v1@v1', item_id: 'D1-02s001v1', position_id: 'D1-02s001' })]);
  assert.equal(r.long.length, 1);
  assert.equal(r.dropped.F2_served_as, 1);
});

test('F3 완주 세션만 — lesson_completed=false 제외, include_partial 이면 유지', () => {
  const rows = [row(), row({ lesson_completed: false, session_id: 's2', pos: 2, analysis_item_id: 'D1-02s001v1@v1', item_id: 'D1-02s001v1', position_id: 'D1-02s001' })];
  assert.equal(kept(rows).dropped.F3_incomplete, 1);
  assert.equal(kept(rows).long.length, 1);
  assert.equal(kept(rows, [user()], { rules: { ...DEFAULT_RULES, includePartial: true } }).long.length, 2);
});

test('F4 응답 시간 하한 — 3000ms 미만 제외, NULL 은 통과', () => {
  const rows = items3();
  rows[0].elapsed_ms = 2999;
  rows[1].elapsed_ms = null;
  const r = kept(rows);
  assert.equal(r.dropped.F4_fast, 1);
  assert.equal(r.long.length, 2);
  assert.equal(r.long.find((x) => x.analysis_item_id === 'D3-01s001v1@v1').latency_ms, null);
});

test('F5 일렬 찍기 — 한 세션 연속 8문항 같은 selected_key 면 세션 전체 제외, 7 이면 유지', () => {
  const session = (n, sid) => Array.from({ length: 10 }, (_, i) => row({
    session_id: sid, pos: i + 1, order_in_lesson: i + 1, analysis_item_id: `D1-${String(i + 1).padStart(2, '0')}s001v1@v1`, item_id: `D1-${String(i + 1).padStart(2, '0')}s001v1`,
    position_id: `D1-${String(i + 1).padStart(2, '0')}s001`, selected_key: i < n ? '0' : String(i),
  }));
  assert.deepEqual([...straightLineSessions(session(8, 'sA'), 8)], ['sA']);
  assert.deepEqual([...straightLineSessions(session(7, 'sB'), 8)], []);
  const r = kept([...session(8, 'sA'), ...session(7, 'sB').map((x) => ({ ...x, user_hash: H2 }))], [user(), user({ user_hash: H2 })]);
  assert.equal(r.dropped.F5_straight_sessions, 1);
  assert.equal(r.dropped.F5_straight_rows, 10);
  assert.equal(r.long.length, 10);
  assert.ok(r.long.every((x) => x.user_hash === H2));
});

test('F6 코호트 — internal·pilot_friend·pre_campaign 응답자는 응답째 제외', () => {
  const rows = [row(), row({ user_hash: H2, session_id: 's2' }), row({ user_hash: H3, session_id: 's3' })];
  const r = kept(rows, [user(), user({ user_hash: H2, cohort_flag: 'internal' }), user({ user_hash: H3, cohort_flag: 'pre_campaign' })]);
  assert.equal(r.long.length, 1);
  assert.equal(r.dropped.F6_cohort_rows, 2);
  assert.deepEqual(r.dropped.F6_cohort, { internal: 1, pilot_friend: 0, pre_campaign: 1 });
  assert.equal(r.respondentsKept.length, 1);
});

test('F7 회수 문항 — 회수 목록 item_id 의 응답 제외, items.csv 엔 recalled_at 으로 남는다', () => {
  const recall = parseRecallFile('item_id,recalled_at,reason\nD3-01s001v1,2026-10-05,정답 오류\n');
  const r = kept(items3(), [user()], { recall });
  assert.equal(r.dropped.F7_recalled, 1);
  assert.equal(r.long.length, 2);
  const items = buildItems(r.withLineage, r.long, { recall });
  const recalled = items.find((i) => i.item_id === 'D3-01s001v1');
  assert.equal(recalled.recalled_at, '2026-10-05');
  assert.equal(recalled.n, 0);
});

test('F8 극단 문항 — n ≥ 100 이고 p > .90 이면 extreme_p, 와이드에서 열 제외 (n < 100 은 판정 안 함)', () => {
  const many = (n, correctRatio, id, h0) => Array.from({ length: n }, (_, i) => row({
    user_hash: `${h0}${String(i).padStart(63 - h0.length + 1, '0')}`.slice(0, 64), session_id: `s-${h0}-${i}`,
    analysis_item_id: `${id}@v1`, item_id: id, position_id: id.replace(/v1$/, ''), is_correct: i < Math.round(n * correctRatio),
  }));
  const rowsA = many(120, 0.95, 'D1-01s001v1', 'a');
  const rowsB = many(50, 0.95, 'D1-02s001v1', 'a').map((x) => ({ ...x, pos: 2, order_in_lesson: 2 }));
  const users = [...new Set([...rowsA, ...rowsB].map((x) => x.user_hash))].map((h) => user({ user_hash: h }));
  const snap = buildSnapshot({ responses: [...rowsA, ...rowsB], respondents: users, recall: new Map(), excludeSessions: new Set() });
  const a = snap.items.find((i) => i.item_id === 'D1-01s001v1');
  const b = snap.items.find((i) => i.item_id === 'D1-02s001v1');
  assert.equal(a.extreme_p, 'true');
  assert.equal(b.extreme_p, 'false');
  assert.equal(snap.files['responses_wide.csv'].split('\n')[0], 'user_hash,D1-02s001v1@v1');
  assert.equal(snap.counts.output.items_excluded.extreme_p, 1);
});

test('F9 세션 제외 훅 — 목록의 session_id 만 제외, 기본은 off', () => {
  const r = kept(items3().map((x, i) => ({ ...x, session_id: i === 2 ? 's9' : 's1' })), [user()], { excludeSessions: parseSessionsFile('session_id\ns9\n') });
  assert.equal(r.dropped.F9_excluded_sessions, 1);
  assert.equal(r.long.length, 2);
});

test('F11 형식 — order_steps·match_pairs·free_writing 제외, 채점 NULL 도 제외', () => {
  const r = kept([row(), row({ format: 'order_steps', session_id: 's2' }), row({ format: 'free_writing', is_correct: null, session_id: 's3' }), row({ format: 'compare_two', is_correct: null, session_id: 's4' })]);
  assert.equal(r.dropped.F11_format, 2);
  assert.equal(r.dropped.ungraded, 1);
  assert.equal(r.long.length, 1);
});

test('위치(패밀리) 접기 — 형제 변형 2개는 같은 위치, 앵커 아님; 변형 1개는 앵커', () => {
  const rows = [
    row({ user_hash: H1, analysis_item_id: 'D1-01s001v1@v1', item_id: 'D1-01s001v1' }),
    row({ user_hash: H2, session_id: 's2', analysis_item_id: 'D1-01s001v2@v1', item_id: 'D1-01s001v2', variant_no: 2, is_correct: false }),
    row({ user_hash: H1, analysis_item_id: 'D3-01s001v1@v1', item_id: 'D3-01s001v1', position_id: 'D3-01s001', dimension: 3, pos: 2, order_in_lesson: 2 }),
  ];
  const snap = buildSnapshot({ responses: rows, respondents: [user(), user({ user_hash: H2 })], recall: new Map(), excludeSessions: new Set() });
  const pos = buildPositions(snap.items);
  assert.equal(pos.length, 2);
  assert.equal(pos[0].variants, 2);
  assert.equal(pos[0].is_anchor, 'false');
  assert.equal(pos[1].is_anchor, 'true');
  const fam = snap.files['responses_wide_family.csv'].split('\n');
  assert.equal(fam[0], 'user_hash,D1-01s001,D3-01s001');
  assert.equal(fam[1], `${H1},1,1`);
  assert.equal(fam[2], `${H2},0,NA`);
});

test('셀 5 미만 병합 — 준식별자 값이 5명 미만이면 other, NULL 은 그대로', () => {
  const users = [
    ...Array.from({ length: 5 }, (_, i) => user({ user_hash: `${i}`.padStart(64, 'a'), persona: 'developer' })),
    user({ user_hash: 'x'.repeat(64), persona: 'educator', gender: null }),
  ];
  const { respondents, merged } = mergeSmallCells(users, 5);
  assert.equal(respondents[5].persona, 'other');
  assert.equal(respondents[5].gender, null);
  assert.equal(respondents[0].persona, 'developer');
  assert.deepEqual(merged.persona, ['educator']);
});

test('재현성 — 같은 입력이면 파일 바이트와 매니페스트가 동일하고, 입력 순서를 섞어도 같다', () => {
  const rows = items3();
  const build = (rs) => buildSnapshot({ responses: rs, respondents: [user()], recall: new Map(), excludeSessions: new Set() });
  const a = build(rows);
  const b = build([...rows].reverse());
  for (const k of Object.keys(a.files)) assert.equal(a.files[k], b.files[k], k);
  const mf = (s) => buildManifest({ asOf: '2026-10-20T00:00:00+09:00', campaignStart: '2026-09-29T00:00:00+09:00', gitSha: 'x', rules: DEFAULT_RULES, inputs: {}, counts: s.counts, files: s.files });
  assert.equal(mf(a), mf(b));
  assert.ok(!/generated|timestamp/.test(mf(a)));
});

test('보조 파일 파서 — 코호트 UUID 검증·flag 제한, 회수 목록 헤더 무시', () => {
  const c = parseCohortFile('user_id,flag\n00000000-0000-4000-8000-000000000001,internal\n00000000-0000-4000-8000-000000000002,pilot_friend\n# comment\n');
  assert.deepEqual(c, { internal: ['00000000-0000-4000-8000-000000000001'], pilot: ['00000000-0000-4000-8000-000000000002'] });
  assert.throws(() => parseCohortFile('not-a-uuid,internal'));
  assert.throws(() => parseCohortFile('00000000-0000-4000-8000-000000000001,bogus'));
  assert.equal(parseRecallFile('item_id,recalled_at,reason\nD1-01s001v1,2026-10-05,x, y\n').get('D1-01s001v1').reason, 'x,y');
});

// CFA 하네스(run-cfa.R) 입력 계약 — 실데이터 스냅샷의 헤더가 합성 생성기(simulate-snapshot.mjs)의 헤더를 덮어야 한다.
// R 없이도 돌도록 열 이름으로 계약을 고정한다(진값 열 true_* 은 합성 전용이라 제외).
test('합성 생성기 파일 헤더 ⊆ 스냅샷 출력 헤더 (run-cfa.R 호환)', async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { simulate, writeSnapshot } = await import('../validation/cfa/simulate-snapshot.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'cfa591-'));
  try {
    writeSnapshot(dir, simulate({ n: 12, lessons: 2, seed: 1 }));
    const header = (f) => readFileSync(join(dir, f), 'utf8').split('\n')[0].split(',').filter((c) => !c.startsWith('true_'));
    const { ITEM_COLUMNS, POSITION_COLUMNS, LONG_COLUMNS, RESPONDENT_COLUMNS } = await import('./snapshot-lib.mjs');
    const covers = (ours, theirs) => theirs.filter((c) => !ours.includes(c));
    assert.deepEqual(covers(ITEM_COLUMNS, header('items.csv')), []);
    assert.deepEqual(covers(POSITION_COLUMNS, header('positions.csv')), []);
    assert.deepEqual(covers(LONG_COLUMNS, header('responses_long.csv').filter((c) => c !== 'position_id')), []);
    assert.deepEqual(covers([...RESPONDENT_COLUMNS, 'completed_lessons'], header('respondents.csv').filter((c) => c !== 'true_eta_mean')), []);
    assert.equal(header('responses_wide.csv')[0], 'user_hash');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
