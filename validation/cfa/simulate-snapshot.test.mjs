// node --test validation/cfa/*.test.mjs  — 생성기의 형식·결정성·앵커/회전·이탈 규칙 고정
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULTS, buildCorr, cholesky, makeRng, parseArgs, simulate, writeSnapshot } from './simulate-snapshot.mjs';

test('기본 배치 = 차원 비율(3:1:3:2:1) × 6 레슨 → 차원별 18/6/18/12/6 위치, 모형은 레슨당 1개', () => {
  const sim = simulate({ n: 20, seed: 1 });
  const perDim = [1, 2, 3, 4, 5].map((d) => sim.positionRows.filter((p) => p.dimension === d).length);
  assert.deepEqual(perDim, [18, 6, 18, 12, 6]);
  for (let lesson = 1; lesson <= 6; lesson += 1) {
    const fams = sim.positions.filter((p) => p.lesson === lesson).map((p) => p.familyCode);
    assert.equal(new Set(fams).size, fams.length, `lesson ${lesson} 에 같은 모형 2개`);
  }
});

test('같은 시드는 바이트 동일, 다른 시드는 다르다', () => {
  const a = simulate({ n: 30, seed: 7 });
  const b = simulate({ n: 30, seed: 7 });
  const c = simulate({ n: 30, seed: 8 });
  assert.deepEqual(a.long, b.long);
  assert.notDeepEqual(a.long, c.long);
});

test('앵커는 전원 응답, 비앵커는 사용자마다 변형 1개(k=3)만 응답', () => {
  const sim = simulate({ n: 60, seed: 3, variants: 3, anchors: 4 });
  const anchorPositions = sim.positions.filter((p) => p.isAnchor);
  assert.equal(anchorPositions.filter((p) => p.dimension === 2).length, 4);
  const rotating = sim.positions.find((p) => !p.isAnchor);
  assert.equal(rotating.variants.length, 3);
  const byUser = new Map();
  for (const r of sim.long) {
    if (r.position_id !== rotating.positionId) continue;
    byUser.set(r.user_hash, (byUser.get(r.user_hash) ?? 0) + 1);
  }
  assert.ok([...byUser.values()].every((v) => v === 1), '한 사용자가 같은 위치에 2개 변형 응답');
  const seen = new Set(sim.long.filter((r) => r.position_id === rotating.positionId).map((r) => r.analysis_item_id));
  assert.equal(seen.size, 3, '3 변형이 모두 노출돼야 한다');
  const anchorId = anchorPositions[0].positionId;
  assert.equal(sim.long.filter((r) => r.position_id === anchorId).length, 60);
});

test('dropout>0 이면 뒤 레슨이 단조로 빈다, dropout=0 이면 전원 완주', () => {
  const full = simulate({ n: 40, seed: 5, dropout: 0 });
  assert.ok(full.users.every((u) => u.completed_lessons === 6));
  const drop = simulate({ n: 200, seed: 5, dropout: 0.3 });
  const counts = drop.users.map((u) => u.completed_lessons);
  assert.ok(Math.min(...counts) === 1 && Math.max(...counts) <= 6);
  assert.ok(counts.filter((c) => c === 6).length < 200);
  for (const u of drop.users) {
    const lessons = new Set(drop.long.filter((r) => r.user_hash === u.user_hash).map((r) => sim(r)));
    assert.ok([...lessons].every((l) => l <= u.completed_lessons));
  }
  function sim(r) { return Number(r.session_id.split('-')[2]); }
});

test('파일 6종 + manifest·truth 를 쓰고 wide 의 셀은 0/1/NA 만', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfa-snap-'));
  const m = writeSnapshot(dir, simulate({ n: 25, seed: 11, variants: 2, anchors: 3 }));
  assert.deepEqual(Object.keys(m.files).sort(), ['items.csv', 'manifest.json', 'positions.csv', 'respondents.csv', 'responses_long.csv', 'responses_wide.csv', 'responses_wide_family.csv', 'truth.json']);
  const wide = readFileSync(join(dir, 'responses_wide_family.csv'), 'utf8').trim().split('\n');
  assert.equal(wide.length, 26);
  const cells = wide.slice(1).flatMap((l) => l.split(',').slice(1));
  assert.ok(cells.every((c) => c === '0' || c === '1' || c === 'NA'));
  const items = readFileSync(join(dir, 'items.csv'), 'utf8').trim().split('\n');
  assert.ok(items[0].startsWith('analysis_item_id,item_id,content_version,family_code,dimension'));
  assert.equal(m.counts.per_dimension.reduce((a, b) => a + b, 0), 60);
});

test('요인 상관 행렬은 양정치, cholesky 는 재구성 가능', () => {
  const rng = makeRng(42);
  const { phi, L } = buildCorr(5, [0.3, 0.5], rng);
  for (let i = 0; i < 5; i += 1) for (let j = 0; j < 5; j += 1) {
    let s = 0;
    for (let k = 0; k < 5; k += 1) s += L[i][k] * L[j][k];
    assert.ok(Math.abs(s - phi[i][j]) < 1e-9);
  }
  assert.equal(cholesky([[1, 2], [2, 1]]), null);
});

test('parseArgs 기본값·범위 파싱', () => {
  const o = parseArgs(['--n', '150', '--corr', '0.2,0.4', '--anchors', '4', '--variants', '3', '--out', 'x']);
  assert.equal(o.n, 150);
  assert.deepEqual(o.corr, [0.2, 0.4]);
  assert.equal(o.anchors, 4);
  assert.equal(o.variants, 3);
  assert.equal(o.lessons, DEFAULTS.lessons);
  assert.throws(() => parseArgs(['--bogus', '1']));
});

test('dropout-ability>0 이면 능력이 낮은 쪽이 덜 완주한다 (MNAR)', () => {
  const sim = simulate({ n: 600, seed: 9, dropout: 0.2, dropoutAbility: 1.5 });
  const sorted = [...sim.users].sort((a, b) => Number(a.true_eta_mean) - Number(b.true_eta_mean));
  const low = sorted.slice(0, 300).reduce((s, u) => s + u.completed_lessons, 0) / 300;
  const high = sorted.slice(300).reduce((s, u) => s + u.completed_lessons, 0) / 300;
  assert.ok(high - low > 0.5, `high ${high} vs low ${low}`);
});
