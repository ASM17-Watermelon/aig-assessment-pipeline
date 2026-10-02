// persona-sim-lib 규칙 고정 — node --test simulation/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AGE_QUOTAS, AI_USE_RATE_BY_AGE, LEVEL_TEXT, OPTION_KEYS, ageBand, applyExclusions, quotaCounts, assignLevel, birthBand, optionOrder, buildAssignment, buildReport, buildSyntheticSnapshot, checkKeysAgainstLog, genderCode, parseExcludeList,
  parseLotMarkdown, parseProfileAnswer, parseSolveAnswer, personaOffsets, qid, reviewStatus, renderItemsRequest,
  renderPersonaRequest, sampleChoice, unitHash, AREAS, DIM_DEVIATION, dimLevels, parseRateAnswer, parseDimProfileAnswer, renderPersonaDimsRequest, renderRateRequest, AREAS_OFFICIAL,
} from './persona-sim-lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const itemMd = (id, fam, key = 'b', stem = '다음 중 **가장** 알맞은 것은?') => {
  const opts = ['a', 'b', 'c', 'd'].map((k) => (k === key ? `- **${k}) 보기 ${k} 핵심**` : `- ${k}) 보기 ${k}`)).join('\n');
  return `### ${id} · MCQ · [생성 ← ${fam} · 값 변형]\n\n> 계보: ${fam} · s001 (소재) · 545-gen-v1 · attempt 1\n> 슬롯: x=y\n\n${stem}\n\n${opts}\n\n**메모** — 차원: ① 위임 판단 · 오답: a) {over-delegation}\n\n---\n`;
};

// 2 차원 × 문항모형 2개씩 × 위치 3개 × 변형 3개 = 36문항 픽스처
function fixtureItems() {
  const parts = ['# 헤더\n\n> 설명\n'];
  for (const d of [1, 2]) for (const m of ['01', '02']) for (const s of ['001', '002', '003']) for (const v of [1, 2, 3]) {
    parts.push(itemMd(`D${d}-${m}s${s}v${v}`, `F-D${d}-${m}`, ['a', 'b', 'c', 'd'][(Number(s) + v) % 4]));
  }
  return parseLotMarkdown(parts.join('\n'));
}

test('로트 md 파싱 — 계보·정답·줄기·위치 id', () => {
  const items = fixtureItems();
  assert.equal(items.length, 36);
  const it = items.find((x) => x.item_id === 'D2-01s003v2');
  assert.equal(it.family_code, 'F-D2-01');
  assert.equal(it.dimension, 2);
  assert.equal(it.source_id, 's003');
  assert.equal(it.variant_no, 'v2');
  assert.equal(it.variant_kind, 'value');
  assert.equal(it.position_id, 'D2-01s003');
  assert.equal(it.format, 'mcq_single');
  assert.equal(it.stem, '다음 중 **가장** 알맞은 것은?');
  assert.equal(it.key, 'b');
  assert.equal(it.options.find((o) => o.key === 'b').text, '보기 b 핵심');
  assert.equal(it.options.length, 4);
  assert.match(it.content_hash, /^[0-9a-f]{64}$/);
});

test('로트 md 파싱 — 정답 2개·선지 부족은 오류', () => {
  const two = itemMd('D1-01s001v1', 'F-D1-01').replace('- a) 보기 a', '- **a) 보기 a**');
  assert.throws(() => parseLotMarkdown(two), /정답 표시가 2개/);
  const three = itemMd('D1-01s001v1', 'F-D1-01').replace(/- d\) 보기 d\n/, '');
  assert.throws(() => parseLotMarkdown(three), /4개가 아님/);
});

test('데모 문항 md(examples/demo-items.md) 3문항이 파싱되고 정답·문항모형이 맞다', () => {
  const items = parseLotMarkdown(readFileSync(join(ROOT, 'simulation/examples/demo-items.md'), 'utf8'));
  assert.equal(items.length, 3);
  assert.deepEqual(items.map((i) => [i.item_id, i.family_code, i.dimension, i.key]), [
    ['D1-99s001v1', 'F-D1-99', 1, 'b'], ['D3-99s001v1', 'F-D3-99', 3, 'c'], ['D4-99s001v1', 'F-D4-99', 4, 'b'],
  ]);
  for (const it of items) assert.match(it.stem, /^\[데모\]/);
});

test('검수 판정 CSV — 문항별 마지막 판정 (append-only 번복) · 빈 판정은 미판정', () => {
  const csv = [
    '# 주석',
    'item_id,model_id,판정,사유코드',
    'D1-01s001v1,F-D1-01,기각,R-KEY',
    'D1-01s001v1,F-D1-01,통과,',
    'D1-01s002v1,F-D1-01,통과,',
    'D1-01s002v1,F-D1-01,기각,R-FACT',
    'D1-01s002v1,F-D1-01,,',
    'D1-01s003v1,F-D1-01,,',
  ].join('\n');
  assert.deepEqual([...reviewStatus(csv)], [['D1-01s001v1', '통과'], ['D1-01s002v1', '기각'], ['D1-01s003v1', '']]);
});

test('검수 반출본 머리 줄 — 문항모형은 \'> 모형\' 줄에서, 볼드 정답과 그 줄 정답이 다르면 멈춘다', () => {
  const block = (key, metaKey) => `### D1-99s003v3 · MCQ · [데모 · 형식 예시]\n\n> 모형 F-D1-99 · 변형 v3 · 소재 s003 (데모) · 정답 ${metaKey} · 정답 길이 순위 4/4\n> 슬롯: x=y\n> 검수 지적: 데모\n\n데모 질문입니다?\n\n`
    + ['a', 'b', 'c', 'd'].map((k) => (k === key ? `- **${k}) 보기 ${k}**` : `- ${k}) 보기 ${k}`)).join('\n') + '\n\n**메모** — 차원: ① · 오답: a) {x}\n\n---\n';
  const [it] = parseLotMarkdown(`## ① 위임 판단\n\n${block('c', 'c')}`);
  assert.equal(it.family_code, 'F-D1-99');
  assert.equal(it.position_id, 'D1-99s003');
  assert.equal(it.key, 'c');
  assert.equal(it.variant_kind, 'value');
  assert.equal(it.stem, '데모 질문입니다?');
  assert.throws(() => parseLotMarkdown(block('c', 'a')), /볼드 정답 c ≠/);
});

test('제외 목록 — 문항·위치·문항모형 단위', () => {
  const items = fixtureItems();
  const ex = parseExcludeList('D1-01s001v1\nD1-02s002 # 위치\nF-D2-02\n');
  const { kept, dropped } = applyExclusions(items, ex);
  assert.equal(dropped.length, 1 + 3 + 9);
  assert.ok(!kept.some((i) => i.family_code === 'F-D2-02' || i.position_id === 'D1-02s002' || i.item_id === 'D1-01s001v1'));
});

test('배정 — 앵커는 전원·회전은 서로 다른 위치·노출은 고르게·결정적', () => {
  const items = fixtureItems();
  const ids = Array.from({ length: 40 }, (_, i) => `syn_t_${String(i + 1).padStart(4, '0')}`);
  const a = buildAssignment(items, ids, { seed: 7, anchorsPerFamily: 1, rotatePerFamily: 2 });
  const b = buildAssignment(items, ids, { seed: 7, anchorsPerFamily: 1, rotatePerFamily: 2 });
  assert.deepEqual(a, b);
  assert.equal(a.anchors.length, 4); // 문항모형 4개 × 1
  const byId = new Map(items.map((i) => [i.item_id, i]));
  const anchorPositions = new Set(a.anchors.map((x) => byId.get(x).position_id));
  const exposure = new Map();
  for (const pid of ids) {
    const list = a.perPersona[pid];
    assert.equal(list.length, 4 + 4 * 2);
    for (const anc of a.anchors) assert.ok(list.includes(anc));
    const positions = list.map((x) => byId.get(x).position_id);
    assert.equal(new Set(positions).size, positions.length, '한 인물이 같은 위치의 형제 변형을 두 번 보지 않는다');
    for (const x of list) if (!a.anchors.includes(x)) {
      assert.ok(!anchorPositions.has(byId.get(x).position_id), '회전은 앵커 위치의 다른 변형을 쓰지 않는다');
      exposure.set(x, (exposure.get(x) ?? 0) + 1);
    }
  }
  // 문항모형당 회전 쌍 = 비앵커 위치 2 × 변형 3 = 6, 인물 40 × 2 = 80 회 → 쌍당 13~14
  const counts = [...exposure.values()];
  assert.equal(exposure.size, 4 * 6);
  assert.ok(Math.max(...counts) - Math.min(...counts) <= 1, `노출 편차 ${Math.min(...counts)}~${Math.max(...counts)}`);
  // 순서는 인물마다 섞인다 — 차원 블록으로 뭉치지 않는다
  const dims = a.perPersona[ids[0]].map((x) => byId.get(x).dimension).join('');
  assert.notEqual(dims, [...dims].sort().join(''));
  const c = buildAssignment(items, ids, { seed: 8, anchorsPerFamily: 1, rotatePerFamily: 2 });
  assert.notDeepEqual(a.perPersona[ids[0]], c.perPersona[ids[0]]);
});

test('배정 — 비앵커 위치가 모자란 문항모형은 가능한 만큼만', () => {
  const items = fixtureItems().filter((i) => !(i.family_code === 'F-D1-01' && i.source_id === 's003'));
  const a = buildAssignment(items, ['syn_t_0001'], { seed: 1, anchorsPerFamily: 1, rotatePerFamily: 2 });
  const byId = new Map(items.map((i) => [i.item_id, i]));
  assert.equal(a.perPersona.syn_t_0001.filter((x) => byId.get(x).family_code === 'F-D1-01').length, 2); // 앵커 1 + 남은 위치 1
});

test('배정 — 검수 표본 모양(위치당 변형 1개 + 한 위치에 형제 2개): 앵커는 단일 변형 위치, 형제는 나눠 받고 버려지는 문항 없음', () => {
  const md = ['D4-07s008v1', 'D4-07s009v2', 'D4-07s009v3', 'D4-08s001v1', 'D4-08s002v1', 'D4-08s003v1', 'D4-08s004v2']
    .map((id) => itemMd(id, `F-${id.slice(0, 5)}`)).join('\n');
  const items = parseLotMarkdown(md);
  const ids = Array.from({ length: 10 }, (_, i) => `syn_t_${String(i + 1).padStart(4, '0')}`);
  for (const seed of [1, 2, 3, 4, 5, 600]) {
    const a = buildAssignment(items, ids, { seed, anchorsPerFamily: 1, rotatePerFamily: 3 });
    assert.ok(a.anchors.includes('D4-07s008v1'), `seed ${seed}: 형제가 있는 위치를 앵커로 쓰면 형제 하나가 버려진다`);
    const exposure = new Map(items.map((i) => [i.item_id, 0]));
    for (const list of Object.values(a.perPersona)) for (const x of list) exposure.set(x, exposure.get(x) + 1);
    assert.deepEqual([...exposure].filter(([, n]) => n === 0), [], `seed ${seed}: 안 나간 문항 없음`);
    assert.equal(exposure.get('D4-07s009v2') + exposure.get('D4-07s009v3'), 10); // 한 인물은 형제 중 하나만
    assert.equal(a.perPersona[ids[0]].length, 2 + 4); // F-D4-07 위치 2 + F-D4-08 위치 4
  }
});

const persona = {
  syn_id: 'syn_t_0001', hf_uuid: 'u', hf_offset: 3, persona: '한 줄', professional_persona: '일', family_persona: '가족', cultural_background: '배경',
  skills_and_expertise: '기술', hobbies_and_interests: '취미', career_goals_and_ambitions: '목표', sex: '여자', age: 60, marital_status: '배우자있음',
  family_type: '배우자와 거주', housing_type: '아파트', education_level: '초등학교', bachelors_field: '해당없음', occupation: '무직', district: '상주시', province: '경상북',
};

test('요청 파일 — 인물 파일엔 정해진 수준·문항 없음, 문항 파일엔 정답·계보·차원·메모가 새지 않는다', () => {
  const items = fixtureItems().slice(0, 5);
  const pr = renderPersonaRequest(persona, 'tried');
  assert.match(pr, /@persona syn_t_0001/);
  assert.match(pr, /정해진 수준: tried/);
  assert.ok(pr.includes(LEVEL_TEXT.tried));
  assert.ok(!pr.includes('보기 a'));
  const prof = { knows: '이름만 들었다', unknown: '틀릴 수 있다는 것', confusions: '기계는 정확하다고 믿는다', attitude: '감으로 고른다' };
  const full = renderItemsRequest(persona, 'never', prof, items, { seed: 9 });
  assert.ok(full.includes(LEVEL_TEXT.never) && full.includes('기계는 정확하다고 믿는다') && full.includes('@persona syn_t_0001'));
  const req = full.split('## 문제')[1];
  for (const leak of ['F-D', 'D1-', 's001', '메모', '차원', 'over-delegation', '계보', '**', '★', '정답']) assert.ok(!req.includes(leak), `문항 파일에 '${leak}' 노출`);
  assert.match(req, /### q05/);
  // 제시 순서 = optionOrder — 원래 b 보기 문장이 제시 글자 order.indexOf('b') 자리에 있다
  const order = optionOrder(9, 'syn_t_0001', items[0].item_id);
  const block = req.split('### q01')[1].split('### q02')[0];
  assert.ok(block.includes(`- ${OPTION_KEYS[order.indexOf('b')]}) 보기 b`));
});

test('보기 순서 — 인물·문항마다 결정적 셔플, 위치가 고르게 퍼진다', () => {
  assert.deepEqual(optionOrder(1, 'p', 'i'), optionOrder(1, 'p', 'i'));
  const firstAt = { a: 0, b: 0, c: 0, d: 0 };
  for (let i = 0; i < 2000; i += 1) firstAt[OPTION_KEYS[optionOrder(1, `p${i}`, 'i').indexOf('a')]] += 1;
  for (const k of OPTION_KEYS) assert.ok(Math.abs(firstAt[k] / 2000 - 0.25) < 0.04, `원래 a 가 ${k} 자리에 ${firstAt[k] / 2000}`);
});

test('수준 배정 — 나이대 이용률을 따르고 사용자 안은 균등, 결정적', () => {
  const trial = (age, n = 4000) => { const c = {}; for (let i = 0; i < n; i += 1) { const l = assignLevel(age, `k${i}`); c[l] = (c[l] ?? 0) + 1; } return c; };
  const c25 = trial(25);
  assert.ok(Math.abs(1 - c25.never / 4000 - 0.753) < 0.03, `20대 사용자 ${1 - c25.never / 4000}`);
  for (const l of ['tried', 'sometimes', 'often', 'daily']) assert.ok(Math.abs(c25[l] / (4000 - c25.never) - 0.25) < 0.04, `${l} ${c25[l]}`);
  const c75 = trial(75);
  assert.ok(Math.abs(1 - c75.never / 4000 - 0.049) < 0.015, `70대 사용자 ${1 - c75.never / 4000}`);
  assert.equal(assignLevel(40, 'x'), assignLevel(40, 'x'));
  assert.ok(AI_USE_RATE_BY_AGE.find((b) => b.from === 50).estimated);
  assert.throws(() => assignLevel(5, 'x'), /이용률 구간/);
});

test('수준 추정 답 파싱 — 형식·허용값', () => {
  const good = '@persona syn_t_0001\napp_persona: general\nemployment: emp_none\n아는 것: 뉴스에서 챗GPT 라는 이름을 들었다.\n모르는 것: AI 가 틀린 답을 지어낼 수 있다는 것을 모른다.\n헷갈리기 쉬운 점: 기계가 낸 답은 사람보다 정확하다고 믿는다.\n문제 푸는 태도: 긴 지문은 끝까지 안 읽고 익숙한 단어로 고른다.\n@end\n';
  const { profiles, errors } = parseProfileAnswer(good, ['syn_t_0001']);
  assert.deepEqual(errors, []);
  assert.equal(profiles.syn_t_0001.app_persona, 'general');
  assert.match(profiles.syn_t_0001.confusions, /정확하다고/);
  const bad = good.replace('general', 'retired').replace(/^모르는 것:.*$/m, '');
  assert.match(parseProfileAnswer(bad, ['syn_t_0001']).errors[0], /app_persona,모르는 것/);
  assert.match(parseProfileAnswer('', ['syn_t_0001']).errors[0], /답 없음/);
});

test('풀이 답 파싱 — 합 정규화·누락·초과·인물 불일치', () => {
  const lines = ['@persona syn_t_0001'];
  for (let i = 0; i < 3; i += 1) lines.push(`${qid(i)} | a=10 b=60 c=20 d=${i === 2 ? 12 : 10} | 이유`);
  lines.push('@end');
  const r = parseSolveAnswer(lines.join('\n'), 'syn_t_0001', 3);
  assert.deepEqual(r.errors, []);
  assert.ok(Math.abs(r.dists.q03.b - 60 / 102) < 1e-9);
  assert.match(parseSolveAnswer(lines.join('\n'), 'syn_t_0001', 4).errors.join(), /q04: 답 없음/);
  assert.match(parseSolveAnswer(lines.join('\n'), 'syn_t_0002', 3).errors.join(), /인물 id 불일치/);
  assert.match(parseSolveAnswer(lines.join('\n').replace('d=10 | 이유', 'd=50 | 이유'), 'syn_t_0001', 3).errors.join(), /확률 합/);
  assert.match(parseSolveAnswer(lines.join('\n'), 'syn_t_0001', 2).errors.join(), /요청보다 많은 문항/);
});

test('샘플링 — 결정적이고 분포를 따른다', () => {
  const dist = { a: 0.1, b: 0.6, c: 0.2, d: 0.1 };
  assert.equal(sampleChoice(dist, 'k1'), sampleChoice(dist, 'k1'));
  const n = 4000;
  const c = { a: 0, b: 0, c: 0, d: 0 };
  for (let i = 0; i < n; i += 1) c[sampleChoice(dist, `k${i}`)] += 1;
  assert.ok(Math.abs(c.b / n - 0.6) < 0.03, `b ${c.b / n}`);
  assert.ok(Math.abs(c.a / n - 0.1) < 0.02, `a ${c.a / n}`);
});

test('오프셋·나이 환산 — 중복 없음·결정적', () => {
  const o = personaOffsets({ seed: 600, total: 1000, count: 500 });
  assert.equal(new Set(o).size, 500);
  assert.deepEqual(o, personaOffsets({ seed: 600, total: 1000, count: 500 }));
  assert.equal(birthBand(60), '1965-1969');
  assert.equal(birthBand(31), '1995-1999');
  assert.equal(genderCode('남자'), 'male');
  assert.ok(unitHash('x') >= 0 && unitHash('x') < 1);
});

test('합성 스냅샷 — 스냅샷 파일 형식 + 합성 분리 표식, 정답 판정', () => {
  const items = fixtureItems();
  const ids = ['syn_t_0001', 'syn_t_0002', 'syn_t_0003'];
  const personas = ids.map((id, i) => ({ ...persona, syn_id: id, age: 30 + i * 10 }));
  const assignment = buildAssignment(items, ids, { seed: 3, anchorsPerFamily: 1, rotatePerFamily: 1 });
  const byId = new Map(items.map((i) => [i.item_id, i]));
  const profiles = {};
  const answers = {};
  const levels = {};
  ids.forEach((id, n) => {
    levels[id] = ['never', 'sometimes', 'daily'][n];
    profiles[id] = { app_persona: 'general', employment: 'emp_none' };
    const dists = {};
    assignment.perPersona[id].forEach((itemId, i) => {
      // 답은 제시 글자 기준 — 정답이 제시된 글자에 확률을 준다. 인물 3 은 항상 정답, 인물 1 은 항상 오답
      const keyShown = OPTION_KEYS[optionOrder(3, id, itemId).indexOf(byId.get(itemId).key)];
      dists[qid(i)] = Object.fromEntries(OPTION_KEYS.map((k) => [k, n === 2 ? (k === keyShown ? 1 : 0) : n === 0 ? (k === keyShown ? 0 : 1 / 3) : 0.25]));
    });
    answers[id] = { dists, model: 'sonnet' };
  });
  const snap = buildSyntheticSnapshot({ items, personas, profiles, answers, levels, assignment, asOfDate: '2026-10-15', seed: 3 });
  for (const f of ['responses_long.csv', 'responses_wide.csv', 'responses_wide_family.csv', 'items.csv', 'positions.csv', 'respondents.csv', 'synthetic_detail.csv']) assert.ok(snap.files[f], f);
  const long = snap.files['responses_long.csv'].trim().split('\n');
  assert.ok(long[0].endsWith(',source'));
  assert.ok(long.slice(1).every((l) => l.startsWith('syn_') && l.endsWith(',synthetic')));
  const resp = snap.files['respondents.csv'].trim().split('\n');
  assert.equal(resp.length, 4);
  assert.ok(resp.slice(1).every((l) => l.includes(',synthetic,')));
  const detail = snap.detail;
  assert.ok(detail.filter((d) => d.user_hash === 'syn_t_0003').every((d) => d.correct === 1 && d.selected === d.key && d.shown_as === d.key_shown_as));
  assert.match(snap.files['respondents.csv'], /syn_t_0003,[^\n]*,daily,/);
  assert.ok(detail.filter((d) => d.user_hash === 'syn_t_0001').every((d) => d.correct === 0));
  // 앵커 위치는 전원 응답 → 와이드 가족 열에 NA 없음
  const wideFam = snap.files['responses_wide_family.csv'].trim().split('\n');
  const header = wideFam[0].split(',');
  const anchorPos = assignment.anchors.map((x) => byId.get(x).position_id);
  for (const pos of anchorPos) {
    const col = header.indexOf(pos);
    assert.ok(col > 0, pos);
    assert.ok(wideFam.slice(1).every((l) => l.split(',')[col] !== 'NA'));
  }
  const rep = buildReport({ detail, respondents: snap.respondents, items, anchors: assignment.anchors });
  assert.match(rep.markdown, /배정 수준별/);
  assert.match(rep.markdown, /화면 위치별 선택률/);
  assert.ok(Array.isArray(rep.warnings));
});

test('리포트 — 천장이면 경고', () => {
  const detail = [];
  for (const u of ['syn_a', 'syn_b', 'syn_c']) for (let i = 0; i < 20; i += 1) detail.push({ user_hash: u, item_id: `I${i}`, correct: 1, selected: 'a', key: 'a' });
  const rep = buildReport({ detail, respondents: [], items: [], anchors: [] });
  assert.ok(rep.warnings.some((w) => w.includes('천장')));
  assert.ok(rep.warnings.some((w) => w.includes('분산 축소')));
});

test('나이 정원 — 19~45 70% · 46~63 27% · 64~72 3%, 합이 정확히 n', () => {
  assert.deepEqual(quotaCounts(300), [210, 81, 9]);
  assert.deepEqual(quotaCounts(12), [9, 3, 0]); // 8.4·3.24·0.36 → 최대 나머지가 19~45 에
  for (const n of [1, 7, 100, 301, 1000]) assert.equal(quotaCounts(n).reduce((a, b) => a + b, 0), n);
  assert.equal(ageBand(19), 0);
  assert.equal(ageBand(45), 0);
  assert.equal(ageBand(46), 1);
  assert.equal(ageBand(63), 1);
  assert.equal(ageBand(64), 2);
  assert.equal(ageBand(72), 2);
  assert.equal(ageBand(73), -1);
  assert.equal(ageBand(18), -1);
  assert.equal(AGE_QUOTAS.reduce((a, q) => a + q.share, 0).toFixed(2), '1.00');
});

test('5역량 판 — 관련성 평정: ±1 은 인물 정보 인용이 있어야 통과', () => {
  const ok = `@persona syn_t_0001\n영역1 | 0 | 근거 없음\n영역2 | +1 | "한 줄 소개"\n영역3 | -1 | "꼼꼼한  기술"\n영역4 | 0 | 근거 없음\n영역5 | +1 | "목표가 있다"\n@end\n`;
  assert.ok(renderRateRequest(persona).includes('영역5'));
  const r = parseRateAnswer(ok, { ...persona, persona: '한 줄 소개입니다', skills_and_expertise: '꼼꼼한 기술', career_goals_and_ambitions: '목표가 있다' });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.ratings, [0, 1, -1, 0, 1]);
  const bad = parseRateAnswer(ok.replace('"목표가 있다"', '"지어낸 말이다"').replace('영역1 | 0 | 근거 없음', '영역1 | +1 | 근거 없음'), persona);
  assert.ok(bad.errors.some((e) => e.startsWith('영역5: 인용이 인물 정보에 없음')));
  assert.ok(bad.errors.some((e) => e.startsWith('영역1: +1 인데 인용 없음')));
});

test('5역량 판 — 차원 수준 = 전반 + 관련성 + 시드 편차(-2/0/+2), 0~4 로 자르고 결정적', () => {
  assert.deepEqual([...DIM_DEVIATION], [-2, 0, 2]);
  const a = dimLevels('sometimes', [1, 0, -1, 0, 0], 'k1');
  assert.deepEqual(a, dimLevels('sometimes', [1, 0, -1, 0, 0], 'k1'));
  a.levels.forEach((l, i) => assert.equal(l, Math.max(0, Math.min(4, 2 + [1, 0, -1, 0, 0][i] + a.noise[i]))));
  const noises = new Set(Array.from({ length: 60 }, (_, i) => dimLevels('never', [0, 0, 0, 0, 0], `k${i}`).noise).flat());
  assert.deepEqual([...noises].sort(), [-2, 0, 2]);
});

test('5역량 판 — 영역별 지식 상태: 낮은 영역에만 착각, 풀이 요청은 착각 설정일 때만 착각을 싣는다', () => {
  const dims = [0, 2, 4, 1, 3];
  assert.ok(renderPersonaDimsRequest(persona, 'never', dims).includes('영역1 맡길 일 고르기 — 매우 낮음'));
  const ans = (mis) => `@persona syn_t_0001\napp_persona: general\nemployment: emp_none\n${AREAS.map((a) => `영역${a.dim}: 이 영역에서 이 인물이 하는 구체적인 행동 서술`).join('\n')}\n${mis}\n문제 푸는 태도: 감으로 빠르게 고른다\n@end\n`;
  const good = parseDimProfileAnswer(ans('착각(영역1): AI가 자신 있게 말하면 맞는 말이다\n착각(영역4): 회사 자료를 넣어도 괜찮다'), 'syn_t_0001', dims);
  assert.deepEqual(good.errors, []);
  assert.equal(good.profile.misconceptions.length, 2);
  assert.ok(parseDimProfileAnswer(ans('착각: 없음'), 'syn_t_0001', dims).errors.some((e) => e.includes('착각 없음')));
  assert.ok(parseDimProfileAnswer(ans('착각(영역3): 높은 영역 착각'), 'syn_t_0001', dims).errors.some((e) => e.includes('낮은 영역이 아님')));
  const items = fixtureItems().slice(0, 3);
  const profile = { ...good.profile, dims };
  const withMis = renderItemsRequest(persona, 'never', profile, items, { seed: 1, misconceptions: true });
  const noMis = renderItemsRequest(persona, 'never', profile, items, { seed: 1 });
  assert.ok(withMis.includes('회사 자료를 넣어도 괜찮다') && withMis.includes('600-solve-v5+misconceptions'));
  assert.ok(!noMis.includes('회사 자료를 넣어도 괜찮다') && !noMis.includes('착각'));
  assert.ok(noMis.includes('결과 확인(매우 높음)'));
});

test('5역량 판 general=false — 지식 상태·풀이 요청에서 전반 AI 사용 수준을 뺀다', () => {
  const dims = [0, 2, 4, 1, 3];
  const withG = renderPersonaDimsRequest(persona, 'never', dims);
  const noG = renderPersonaDimsRequest(persona, 'never', dims, { general: false });
  assert.ok(withG.includes('## 생성형 AI 사용 수준: never') && withG.includes('600-profile-dims-v1'));
  assert.ok(!noG.includes('생성형 AI 사용 수준') && noG.includes('600-profile-dims-v2') && noG.includes('공통 사정'));
  const profile = { app_persona: 'general', employment: 'emp_none', attitude: '감으로 고른다', areas: AREAS.map(() => '구체적인 행동 서술입니다 열다섯자'), misconceptions: [], dims };
  const items = fixtureItems().slice(0, 2);
  const solveG = renderItemsRequest(persona, 'never', profile, items, { seed: 1 });
  const solveNoG = renderItemsRequest(persona, 'never', profile, items, { seed: 1, general: false });
  assert.ok(solveG.includes('생성형 AI 사용 수준: never') && solveG.includes('600-solve-v5'));
  assert.ok(!solveNoG.includes('생성형 AI 사용 수준') && solveNoG.includes('600-solve-v6'));
});

test('5역량 판 공식 영역 정의 — 지식 상태·풀이 요청에만 공식 이름·뜻', () => {
  const dims = [0, 2, 4, 1, 3];
  const req = renderPersonaDimsRequest(persona, 'never', dims, { general: false, official: true });
  assert.ok(req.includes('영역5 적정 의존·주체성') && req.includes('판단의 주도권을 유지하는 태도') && !req.includes('적당히 믿기'));
  assert.ok(req.includes('600-profile-dims-v2+areas-official'));
  const profile = { app_persona: 'general', employment: 'emp_none', attitude: '감으로 고른다', areas: AREAS_OFFICIAL.map(() => '구체적인 행동 서술입니다 열다섯자'), misconceptions: [], dims };
  const solve = renderItemsRequest(persona, 'never', profile, fixtureItems().slice(0, 2), { seed: 1, general: false, official: true });
  assert.ok(solve.includes('- 위임 판단(매우 낮음)') && solve.includes('600-solve-v6+areas-official') && !solve.includes('맡길 일 고르기'));
  assert.ok(renderRateRequest(persona).includes('맡길 일 고르기'));
});
