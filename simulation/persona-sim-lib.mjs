// 가상 응답자 풀이의 순수 부분 — 문항 md 파싱 · 페르소나 정규화 · 배정 · 요청/답 파일 · 시드 샘플링 · 스냅샷 · 점검 리포트.
//
// 왜 CLI 와 나눴나: 규칙(배정·파싱·샘플링·내보내기)은 픽스처 테스트(persona-sim-lib.test.mjs)로 고정하고,
//   네트워크(HF)·파일·세션 에이전트는 persona-sim.mjs 가 맡는다. 같은 입력이면 같은 바이트(시각·Math.random 없음).
// 출력 형상 = snapshot-lib buildSnapshot(실응답과 같은 스냅샷 형식) + 분리 규칙(source=synthetic · syn_ 접두 · 별도 폴더).
// 의존성 0(node:crypto 만).

import { createHash } from 'node:crypto';
import { DEFAULT_RULES, RESPONDENT_COLUMNS, LONG_COLUMNS, buildSnapshot, toCsv } from './snapshot-lib.mjs';

export const STUDY = 'aig-assessment-pipeline';
export const SCRIPT_VERSION = '600.2';
export const HF_DATASET = 'nvidia/Nemotron-Personas-Korea';
export const REFERENCE_YEAR = 2026; // 페르소나 나이 → 출생연도 구간 환산 기준(표본 추출 연도)
export const PROFILE_PROMPT_VER = '600-profile-v2'; // v2: 수준은 통계 규칙이 정하고 에이전트는 지식 상태만 서술
export const SOLVE_PROMPT_VER = '600-solve-v4';     // v2: 정답 숨김 · 관찰자 예측 · 보기 셔플 · @expected 삭제 / v3: 정답 1순위가 기본값 아님 — 모르는 인물은 끌리는 오답을 1순위로(파일럿 v2 에서 never 인물도 97% 정답 1순위) / v4: 두 단계 분리 — 문항 파일에 인물·정해진 수준·동결된 지식 상태를 싣는다(풀이 에이전트는 서술을 쓴 에이전트와 다름)
// 5역량 판(전반 수준 하나로는 차원이 갈리지 않았다): 영역 관련성 평정 → 차원 수준 = 전반 + 관련성 + 개인 편차 → 영역별 지식 상태 → 풀이 v5
export const RATE_PROMPT_VER = '600-rate-v1';
export const PROFILE_DIMS_PROMPT_VER = '600-profile-dims-v1';
export const SOLVE_DIMS_PROMPT_VER = '600-solve-v5';  // v5: 영역별 수준·서술을 싣고 문제마다 필요한 영역에 맞춰 예측 · 착각 목록은 run 설정(misconceptions)일 때만
// general=false 판: 전반 AI 사용 수준을 지식 상태·풀이 요청에서 뺀다 — 차원 수준에 이미 바탕으로 들어 있어 두 번 반영되면
//   모든 차원에 공통 요인이 생긴다(r300b 실측: 차원 점수에 전반 수준이 따로 영향, 빼면 차원 점수 상관 .79 → .51).
export const dimsPromptVer = (general, official = false) => {
  const v = general ? { profile: PROFILE_DIMS_PROMPT_VER, solve: SOLVE_DIMS_PROMPT_VER } : { profile: '600-profile-dims-v2', solve: '600-solve-v6' };
  return official ? { profile: `${v.profile}+areas-official`, solve: `${v.solve}+areas-official` } : v;
};
export const OPTION_KEYS = Object.freeze(['a', 'b', 'c', 'd']);
export const AI_EXPERIENCE = Object.freeze(['never', 'tried', 'sometimes', 'often', 'daily']); // 앱 온보딩 설문의 AI 사용 경험 값과 같다
export const APP_PERSONAS = Object.freeze(['office_worker', 'marketer', 'developer', 'designer', 'student', 'owner', 'educator', 'general']);
export const EMPLOYMENT = Object.freeze(['emp_org', 'emp_freelance', 'emp_student', 'emp_none']);
// 풀이에 넣는 페르소나 필드 — 운동·여행·요리·예술 서술은 AI 활용과 멀어 뺀다(토큰 절약)
export const PERSONA_FIELDS = Object.freeze([
  'persona', 'professional_persona', 'family_persona', 'cultural_background', 'skills_and_expertise', 'hobbies_and_interests',
  'career_goals_and_ambitions', 'sex', 'age', 'marital_status', 'family_type', 'housing_type', 'education_level', 'bachelors_field',
  'occupation', 'district', 'province',
]);

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------- 결정적 난수 ----------
// 키(문자열) → [0,1). 순서와 무관하게 같은 키면 같은 값 — 흡수 순서·재시도와 상관없이 샘플이 고정된다.
export function unitHash(key) {
  return parseInt(sha256(key).slice(0, 13), 16) / 2 ** 52;
}
export function seededShuffle(list, key) {
  return list.map((v, i) => ({ v, k: unitHash(`${key}|${i}|${typeof v === 'string' ? v : JSON.stringify(v)}`) }))
    .sort((a, b) => a.k - b.k).map((x) => x.v);
}

// ---------- 문항 md (생성 로트 전체 · 검수 끝난 표본 반출본) ----------
// 머리 줄 두 형식: 생성 로트 `[생성 ← F-D1-01 · 값 변형]` / 검수 반출본 `[라벨 · …]` + `> 모형 F-D1-01 · … · 정답 b` 줄. 예시 = simulation/examples/demo-items.md
const HEADER_RE = /^### (D(\d)-(\d{2})s(\d{3})v(\d+)) · (\S+) · \[(.+)\]\s*$/;
const META_RE = /^> 모형 (F-D\d-\d{2}) · .*· 정답 ([a-e])\b/;
const OPTION_RE = /^- (\*\*)?([a-e])\) (.*?)(\*\*)?\s*$/;

export function parseLotMarkdown(text) {
  const items = [];
  const blocks = text.split(/\n(?=### D\d-)/);
  for (const block of blocks) {
    const lines = block.split('\n');
    const m = lines[0].match(HEADER_RE);
    if (!m) continue;
    const [, itemId, dim, , src, variant, fmt, label] = m;
    if (fmt.toLowerCase() !== 'mcq') throw new Error(`${itemId}: MCQ 만 지원 (${fmt})`);
    const gen = label.match(/^생성 ← (F-D\d-\d{2}) · (.+)$/);
    const meta = lines.map((l) => l.match(META_RE)).find(Boolean);
    const family = gen?.[1] ?? meta?.[1];
    if (!family) throw new Error(`${itemId}: 문항모형을 못 찾음(머리 줄 '생성 ←' 또는 '> 모형' 줄)`);
    // variant_kind = 생성 머리 줄 표기. 반출본엔 그 표기가 없어 '값 변형'을 기본으로 둔다.
    const kindLabel = gen?.[2] ?? '값 변형';
    const stem = [];
    const options = [];
    let key = null;
    for (const line of lines.slice(1)) {
      if (line.startsWith('**메모**') || line.startsWith('---')) break;
      const o = line.match(OPTION_RE);
      if (o) {
        const bold = Boolean(o[1]) && Boolean(o[4]);
        options.push({ key: o[2], text: o[3].trim() });
        if (bold) {
          if (key) throw new Error(`${itemId}: 정답 표시가 2개`);
          key = o[2];
        }
        continue;
      }
      if (options.length) continue;
      if (!line.trim() || line.startsWith('>')) continue;
      stem.push(line.trim());
    }
    if (!stem.length) throw new Error(`${itemId}: 줄기 없음`);
    if (options.length !== 4 || options.map((o) => o.key).join('') !== 'abcd') throw new Error(`${itemId}: 선지 a~d 4개가 아님`);
    if (!key) throw new Error(`${itemId}: 정답 표시 없음`);
    if (meta && meta[2] !== key) throw new Error(`${itemId}: 볼드 정답 ${key} ≠ '> 모형' 줄 정답 ${meta[2]}`);
    const content = { stem: stem.join('\n'), options, key };
    items.push({
      item_id: itemId, family_code: family, dimension: Number(dim), source_id: `s${src}`, variant_no: `v${variant}`,
      variant_kind: kindLabel.includes('값') ? 'value' : 'material', position_id: itemId.replace(/v\d+$/, ''),
      format: 'mcq_single', content_version: 1, ...content, content_hash: sha256(JSON.stringify(content)),
    });
  }
  return items;
}

// 생성로그 CSV 의 정답 열과 md 의 볼드 정답을 대조한다(한쪽만 고쳐진 수정후통과 사고 방지).
export function checkKeysAgainstLog(items, logText) {
  const lines = logText.split('\n').filter((l) => l.trim() && !l.startsWith('#'));
  const header = lines[0].split(',');
  const iId = header.indexOf('item_id');
  const iKey = header.indexOf('key');
  const keyOf = new Map(lines.slice(1).map((l) => { const f = l.split(','); return [f[iId], f[iKey]]; }));
  return items.filter((it) => keyOf.has(it.item_id) && keyOf.get(it.item_id) !== it.key).map((it) => it.item_id);
}

// 사람 검수 판정 CSV(append-only) — 문항별 마지막으로 채워진 판정. 표본에 올랐지만 아직 판정이 없으면 ''.
export function reviewStatus(csvText) {
  const lines = csvText.split('\n').filter((l) => l.trim() && !l.startsWith('#'));
  if (!lines.length) return new Map();
  const header = parseCsvLine(lines[0]);
  const iId = header.indexOf('item_id');
  const iVerdict = header.indexOf('판정');
  if (iId < 0 || iVerdict < 0) throw new Error('판정 CSV 에 item_id·판정 열이 없다');
  const status = new Map();
  for (const l of lines.slice(1)) {
    const f = parseCsvLine(l);
    status.set(f[iId], f[iVerdict]?.trim() || status.get(f[iId]) || '');
  }
  return status;
}

// 제외 목록 — 한 줄에 item_id(D1-01s001v1) · 위치(D1-01s001) · 문항모형(F-D1-01) 중 하나. # 주석.
export function parseExcludeList(text) {
  return new Set(text.split('\n').map((l) => l.replace(/#.*/, '').trim()).filter(Boolean));
}
export function applyExclusions(items, exclude) {
  const kept = [];
  const dropped = [];
  for (const it of items) {
    if (exclude.has(it.item_id) || exclude.has(it.position_id) || exclude.has(it.family_code)) dropped.push(it.item_id);
    else kept.push(it);
  }
  return { kept, dropped };
}

export function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i += 1; } else if (c === '"') q = false; else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out;
}

// ---------- 페르소나 ----------
export function personaOffsets({ seed, total, count }) {
  // 오프셋 후보열 — 필터 탈락을 대비해 count 개보다 많이 만들어 두고 앞에서부터 쓴다. 중복 없음.
  const seen = new Set();
  const out = [];
  for (let i = 0; out.length < count; i += 1) {
    const o = Math.floor(unitHash(`offset|${seed}|${i}`) * total);
    if (!seen.has(o)) { seen.add(o); out.push(o); }
  }
  return out;
}
// 나이 정원(2026-10-01 확정): 19~45세 70% · 46~63세 27% · 64~72세 3% · 73세 이상 제외.
// 나이대 안에서는 오프셋 시드 순서대로 선착 — 정원이 차면 그 나이대는 더 받지 않는다. 같은 시드면 같은 사람이 뽑힌다.
export const AGE_QUOTAS = Object.freeze([
  { from: 19, to: 45, share: 0.70 }, { from: 46, to: 63, share: 0.27 }, { from: 64, to: 72, share: 0.03 },
]);
export function ageBand(age, quotas = AGE_QUOTAS) {
  return quotas.findIndex((q) => Number.isFinite(age) && age >= q.from && age <= q.to);
}
// 정원 수 — 최대 나머지 방식(합이 정확히 n). 300 → 210·81·9.
export function quotaCounts(n, quotas = AGE_QUOTAS) {
  const raw = quotas.map((q) => q.share * n);
  const base = raw.map(Math.floor);
  let left = n - base.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) { if (left <= 0) break; base[i] += 1; left -= 1; }
  return base;
}

// 수준(AI 사용 경험) 규칙 — 에이전트가 아니라 공식 통계로 정한다(선행연구: LLM 이 인구통계에서 수준을 추정하면 모델 고정관념이 된다).
// ① 사용자 여부 = 나이대별 생성형 AI 경험률(과기정통부 「2025 인터넷이용실태조사」, 2026-03-31 발표, 기사 인용 수치).
//    50대는 공개 수치가 없어 40대·60대 선형 보간(추정). ② 사용자 안의 빈도 = 공식 구간표 부재 → 균등(사전 고정).
export const AI_USE_RATE_BY_AGE = Object.freeze([
  { from: 12, to: 19, rate: 0.597 }, { from: 20, to: 29, rate: 0.753 }, { from: 30, to: 39, rate: 0.711 }, { from: 40, to: 49, rate: 0.584 },
  { from: 50, to: 59, rate: 0.3635, estimated: true }, { from: 60, to: 69, rate: 0.143 }, { from: 70, to: 150, rate: 0.049 },
]);
export const USER_LEVEL_SPLIT = Object.freeze({ tried: 0.25, sometimes: 0.25, often: 0.25, daily: 0.25 });
export function assignLevel(age, key) {
  const band = AI_USE_RATE_BY_AGE.find((b) => age >= b.from && age <= b.to);
  if (!band) throw new Error(`나이 ${age} 에 해당하는 이용률 구간이 없다`);
  const u = unitHash(`level-use|${key}`);
  if (u >= band.rate) return 'never';
  const v = unitHash(`level-freq|${key}`);
  let acc = 0;
  for (const [lvl, share] of Object.entries(USER_LEVEL_SPLIT)) { acc += share; if (v < acc) return lvl; }
  return 'daily';
}
// 수준별 지식 상태(사전 고정 문구). 단일 수준 판은 5역량별로 나누지 않고 전반 수준 하나만 준다 — 역량별 주입은 CFA 순환 위험(선행연구).
export const LEVEL_TEXT = Object.freeze({
  never: '생성형 AI를 직접 써 본 적이 없다. 이름을 들어 봤거나 거의 모른다. AI가 어떻게 답을 만드는지, 무엇을 잘하고 못하는지 모른다. 이런 문제는 상식과 일상 경험, 문장의 느낌으로 고른다.',
  tried: '호기심에 한두 번 써 봤다. 검색창처럼 짧게 물어본 정도다. AI가 틀릴 수 있다는 말은 들었지만 어떤 식으로 틀리는지, 어떻게 확인하는지는 모른다.',
  sometimes: '한 달에 몇 번 글 다듬기·요약·정보 찾기에 쓴다. 그럴듯하게 틀린 답을 본 적은 있다. 구체적으로 지시하면 낫다는 건 알지만 요령은 부족하고, 결과 확인은 그때그때 다르다.',
  often: '일이나 공부에 일주일에 여러 번 쓴다. 조건과 맥락을 넣어 지시하는 요령이 있고, 중요한 결과는 사실이나 출처를 확인하는 편이다. 개인정보나 회사 자료를 넣을 때 조심해야 한다는 것도 안다.',
  daily: '매일 여러 AI 도구를 쓴다. AI에 맡길 일과 사람이 판단할 일을 가르고, 결과를 확인하는 습관이 있으며, 보안·저작권·편향 같은 한계를 안다.',
});

// ---------- 5역량 판 ----------
// 영역 = 문항 5차원과 같은 순서. 차원 수준은 'AI 를 써 본 정도'가 아니라 그 영역의 판단력·습관이다 — AI 를 안 써 본 사람도 결과 확인 습관은 강할 수 있다.
// 이 판은 차원 구조를 일부러 넣는다 — 논문·README 에 관련성 평정 기준·편차 크기·계산식을 그대로 밝힌다.
export const AREAS = Object.freeze([
  { dim: 1, name: '맡길 일 고르기', what: '어떤 일을 AI에 맡기고 어떤 일은 사람이 직접 판단·결정해야 하는지 가르는 것', plus: '결정·책임이 따르는 일(관리·기획·사업 운영·법무 등)을 한다', minus: '정해진 반복 작업만 하고 일을 나누거나 맡겨 본 적이 없다' },
  { dim: 2, name: '지시하기', what: '원하는 결과를 얻도록 목적·조건·맥락·형식을 넣어 요청하고 대화를 이어 가는 것', plus: '글쓰기·설명·교육·마케팅·상담처럼 남에게 일을 설명하거나 요청하는 일이 많다', minus: '말이나 글로 무언가를 지시·설명할 일이 거의 없다' },
  { dim: 3, name: '결과 확인', what: '받은 결과의 사실·숫자·출처를 원자료와 대조해 확인하는 것', plus: '숫자·문서를 대조하고 점검하는 일(경리·품질 관리·조사·검수 등)이나 꼼꼼한 확인 습관이 있다', minus: '확인 없이 넘기거나 대충 처리하는 성향이 보인다' },
  { dim: 4, name: '안전·윤리', what: '개인정보·회사 자료·저작권·편향·보안 위험을 알고 조심하는 것', plus: '개인정보·고객 정보·규정을 다루는 일(상담·인사·의료·금융·정보 시스템 등)을 한다', minus: '개인정보나 규정을 다룰 일이 거의 없다' },
  { dim: 5, name: '적당히 믿기', what: 'AI를 지나치게 믿지도 무조건 불신하지도 않고 상황에 맞게 의존 정도를 조절하는 것', plus: '신중하고 스스로 확인해 보는 성향이 드러난다', minus: '즉흥적이거나 남의 말·유행을 쉽게 따르는 성향이 드러난다' },
]);
// 공식 5차원 정의 — 지식 상태·풀이 요청에서 쓴다. 관련성 평정은 위 AREAS(+1/-1 예시 포함)로 이미 끝났다.
//   r300c 는 AREAS 의 풀어 쓴 설명(맡길 일 고르기·적당히 믿기 등)이 "얼마나 믿고 맡기나"로 겹쳐 읽혀 D1-D5 .95 — 설명이 결과를 바꾸는지 보는 판.
export const AREAS_OFFICIAL = Object.freeze([
  { dim: 1, name: '위임 판단', what: '어떤 작업을 AI에 맡기고, 어떤 작업은 직접 해야 하는지 판단하는 능력' },
  { dim: 2, name: '지시·소통(프롬프트)', what: '의도가 정확히 전달되도록 요청(프롬프트)을 설계하고 정제하는 능력' },
  { dim: 3, name: '산출물 비판적 검증', what: 'AI 산출물의 오류·환각을 의심하고 사실을 확인하는 능력' },
  { dim: 4, name: '안전·윤리', what: '기밀·개인정보·저작권 등 위험을 인지하고 안전하게 활용하는 능력' },
  { dim: 5, name: '적정 의존·주체성', what: '과잉 의존도 막연한 거부도 아닌, 판단의 주도권을 유지하는 태도' },
]);
const areaSet = (official) => (official ? AREAS_OFFICIAL : AREAS);
export const AREA_LEVELS = Object.freeze(['매우 낮음', '낮음', '보통', '높음', '매우 높음']);
export const AREA_LEVEL_TEXT = Object.freeze([
  '이 영역을 생각해 본 적이 거의 없고, 무엇을 조심해야 하는지 모른다.',
  '들어 본 적은 있지만 막연하고, 실제로는 지키지 못하거나 반대로 한다.',
  '기본은 알지만 상황에 따라 놓친다.',
  '대체로 알고 실천한다.',
  '잘 알고 습관이 되어 있으며 남에게 설명할 수 있다.',
]);
// 개인 편차 = 영역마다 시드로 -2/0/+2 중 하나(각 1/3) — 사전 지정. 결과(CFA 판별 기준)를 보고 바꾸지 않는다.
export const DIM_DEVIATION = Object.freeze([-2, 0, 2]);
export function dimLevels(level, ratings, key) {
  const base = AI_EXPERIENCE.indexOf(level);
  if (base < 0) throw new Error(`전반 수준 ${level}`);
  const noise = AREAS.map((a) => DIM_DEVIATION[Math.floor(unitHash(`dimdev|${key}|${a.dim}`) * DIM_DEVIATION.length)]);
  const levels = AREAS.map((a, i) => Math.max(0, Math.min(AREA_LEVELS.length - 1, base + ratings[i] + noise[i])));
  return { levels, noise };
}

export function normalizePersona(row, { offset, index, runTag }) {
  const p = { syn_id: `syn_${runTag}_${String(index + 1).padStart(4, '0')}`, hf_uuid: row.uuid, hf_offset: offset };
  for (const f of PERSONA_FIELDS) p[f] = row[f] ?? null;
  return p;
}
export function birthBand(age, ref = REFERENCE_YEAR) {
  if (!Number.isFinite(age)) return null;
  const b = Math.floor((ref - age) / 5) * 5;
  return `${b}-${b + 4}`;
}
export function genderCode(sex) {
  return sex === '남자' ? 'male' : sex === '여자' ? 'female' : 'unspecified';
}

// ---------- 배정 (앵커 + 회전) ----------
// 앵커 = 문항모형마다 위치 anchorsPerFamily 개(변형 1개 고정) — 전원이 푼다(CFA 조밀 지표).
// 회전 = 나머지 (위치×변형) 쌍을 문항모형별 줄로 섞어 응답자마다 rotatePerFamily 개씩(서로 다른 위치) 오래 안 나간 순으로 준다 — 노출이 고르게 퍼진다.
// 순서 = 응답자마다 시드 셔플(차원·모형이 뭉치지 않게 — 블록 순서가 차원 구조를 만들지 않도록).
export function buildAssignment(items, personaIds, { seed, anchorsPerFamily = 1, rotatePerFamily = 2 }) {
  const byFamily = new Map();
  for (const it of items) {
    if (!byFamily.has(it.family_code)) byFamily.set(it.family_code, new Map());
    const pos = byFamily.get(it.family_code);
    if (!pos.has(it.position_id)) pos.set(it.position_id, []);
    pos.get(it.position_id).push(it.item_id);
  }
  const families = [...byFamily.keys()].sort();
  const anchors = [];
  const decks = new Map();
  for (const fam of families) {
    const positions = [...byFamily.get(fam).keys()].sort();
    // 앵커 위치의 다른 변형은 아무에게도 안 나간다 — 변형이 하나뿐인 위치를 먼저 앵커로 써서 문항을 버리지 않는다(검수 표본처럼 위치당 1개가 대부분일 때).
    const single = positions.filter((p) => byFamily.get(fam).get(p).length === 1);
    const anchorPool = single.length >= anchorsPerFamily ? single : positions;
    const anchorPos = seededShuffle(anchorPool, `anchor|${seed}|${fam}`).slice(0, Math.min(anchorsPerFamily, positions.length));
    for (const p of anchorPos) {
      const variants = [...byFamily.get(fam).get(p)].sort();
      anchors.push(seededShuffle(variants, `anchor-variant|${seed}|${p}`)[0]);
    }
    const rest = positions.filter((p) => !anchorPos.includes(p));
    const pairs = rest.flatMap((p) => byFamily.get(fam).get(p).map((id) => ({ p, id })));
    decks.set(fam, { queue: seededShuffle(pairs.sort((a, b) => cmp(a.id, b.id)), `deck|${seed}|${fam}`), distinctPositions: rest.length });
  }
  const perPersona = {};
  for (const pid of personaIds) {
    const chosen = [...anchors];
    for (const fam of families) {
      const d = decks.get(fam);
      const want = Math.min(rotatePerFamily, d.distinctPositions);
      const usedPos = new Set();
      // 가장 오래 안 나간 쌍부터 — 같은 위치라 건너뛴 쌍은 줄 앞에 남아 다음 인물이 먼저 받는다(노출 편차 ≤ 1)
      while (usedPos.size < want) {
        const j = d.queue.findIndex((pair) => !usedPos.has(pair.p));
        const [pair] = d.queue.splice(j, 1);
        d.queue.push(pair);
        usedPos.add(pair.p);
        chosen.push(pair.id);
      }
    }
    perPersona[pid] = seededShuffle(chosen.sort(), `order|${seed}|${pid}`);
  }
  return { anchors: anchors.sort(), perPersona };
}

// ---------- 요청 파일 ----------
function personaBlock(p) {
  const L = [];
  L.push(`- 나이·성별: ${p.age}세 ${p.sex}`);
  L.push(`- 지역: ${p.province ?? ''} ${p.district ?? ''}`.trim());
  L.push(`- 학력: ${p.education_level ?? ''}${p.bachelors_field && p.bachelors_field !== '해당없음' ? ` (${p.bachelors_field})` : ''}`);
  L.push(`- 직업: ${p.occupation ?? ''}`);
  L.push(`- 혼인·가구: ${p.marital_status ?? ''} · ${p.family_type ?? ''} · ${p.housing_type ?? ''}`);
  L.push(`- 한 줄 소개: ${p.persona ?? ''}`);
  L.push(`- 일: ${p.professional_persona ?? ''}`);
  L.push(`- 가족: ${p.family_persona ?? ''}`);
  L.push(`- 배경: ${p.cultural_background ?? ''}`);
  L.push(`- 기술·전문성: ${p.skills_and_expertise ?? ''}`);
  L.push(`- 취미·관심: ${p.hobbies_and_interests ?? ''}`);
  L.push(`- 목표: ${p.career_goals_and_ambitions ?? ''}`);
  return L.join('\n');
}

// 한 인물 = 에이전트 1개. 에이전트는 ① 인물 파일만 읽고 수준 추정을 답 파일로 먼저 고정한 뒤 ② 문항 파일을 연다
//   (수준 추정이 문항 내용에 끌려가지 않게 — 워크플로 프롬프트가 순서를 강제하고, 흡수는 두 답 파일을 따로 검증한다).
export function renderPersonaRequest(persona, level) {
  const L = [];
  L.push(`# 가상 인물 지식 상태 서술 — ${persona.syn_id}`);
  L.push(`<!-- prompt ${PROFILE_PROMPT_VER} -->`);
  L.push('');
  L.push('아래 인물은 한국 인구 분포를 바탕으로 만든 가상 인물이다. 이 인물의 생성형 AI 사용 수준은 **이미 정해져 있다**(공식 통계 규칙으로 배정 — 바꾸지 않는다). 너는 이 수준을 이 인물의 삶에 맞게 구체적으로 풀어 쓴다.');
  L.push('');
  L.push(`## 정해진 수준: ${level}`);
  L.push(LEVEL_TEXT[level]);
  L.push('');
  L.push('규칙');
  L.push('1. 수준은 위에 정해진 것을 따른다. 인물의 나이·학력·직업을 이유로 더 높이거나 낮추지 않는다.');
  L.push('2. 인물의 일·취미·생활에 맞춰, 이 수준에서 그럴 법한 모습을 구체적으로 쓴다(AI를 어디에 써 봤거나 안 썼는지, 무엇을 알고 모르는지).');
  L.push('3. 정보에 없는 특별한 경력이나 전문성을 지어내지 않는다.');
  L.push('');
  L.push('답 형식 (다른 말 없이 이 형식만):');
  L.push('```');
  L.push(`@persona ${persona.syn_id}`);
  L.push(`app_persona: ${APP_PERSONAS.join('|')}`);
  L.push(`employment: ${EMPLOYMENT.join('|')}`);
  L.push('아는 것: <AI 에 대해 이 인물이 아는 것 한두 문장>');
  L.push('모르는 것: <이 인물이 모르는 것 한두 문장>');
  L.push('헷갈리기 쉬운 점: <이 인물이 흔히 가질 법한 오해나 습관 한두 문장>');
  L.push('문제 푸는 태도: <앱에서 문제를 볼 때 꼼꼼히 읽는지, 감으로 고르는지 한 문장>');
  L.push('@end');
  L.push('```');
  L.push('app_persona 기준: office_worker 회사 사무·기획·관리 · marketer 마케팅·콘텐츠·SNS · developer 개발·IT·데이터 · designer 디자인 · student 공부·연구 중 · owner 가게·사업 운영, 영업·고객 응대 · educator 가르치는 일 · general 위에 없음(구직·주부·은퇴·무직·농어업·생산직 등).');
  L.push('employment 기준: emp_org 회사·조직 소속 · emp_freelance 프리랜서·자영업 · emp_student 학생 · emp_none 지금 일하지 않음.');
  L.push('');
  L.push('## 인물');
  L.push(personaBlock(persona));
  L.push('');
  return L.join('\n');
}

const PROFILE_FIELDS = Object.freeze({ knows: '아는 것', unknown: '모르는 것', confusions: '헷갈리기 쉬운 점', attitude: '문제 푸는 태도' });
export function parseProfileAnswer(text, expectedIds) {
  const profiles = {};
  const errors = [];
  const blocks = text.split(/^@persona\s+/m).slice(1);
  for (const b of blocks) {
    const id = b.split('\n')[0].trim();
    const body = b.split(/^@end/m)[0];
    const get = (k) => { const m = body.match(new RegExp(`^${k}\\s*:\\s*(.+)$`, 'm')); return m ? m[1].trim() : null; };
    const pr = { app_persona: get('app_persona'), employment: get('employment') };
    for (const [k, label] of Object.entries(PROFILE_FIELDS)) pr[k] = get(label);
    const bad = [];
    if (!APP_PERSONAS.includes(pr.app_persona)) bad.push('app_persona');
    if (!EMPLOYMENT.includes(pr.employment)) bad.push('employment');
    for (const [k, label] of Object.entries(PROFILE_FIELDS)) if (!pr[k] || pr[k].length < 8) bad.push(label);
    if (!expectedIds.includes(id)) errors.push(`${id}: 요청에 없는 인물`);
    else if (bad.length) errors.push(`${id}: 형식 불량 ${bad.join(',')}`);
    else profiles[id] = pr;
  }
  for (const id of expectedIds) if (!profiles[id] && !errors.some((e) => e.startsWith(`${id}:`))) errors.push(`${id}: 답 없음`);
  return { profiles, errors };
}

// 영역 관련성 평정 — 인물 정보만 보고(문항 비노출) 영역마다 -1/0/+1. ±1 은 인물 정보 문장을 그대로 인용해야 통과(근거 없는 짐작 차단).
export function renderRateRequest(persona) {
  const L = [];
  L.push(`# 가상 인물 영역 관련성 평정 — ${persona.syn_id}`);
  L.push(`<!-- prompt ${RATE_PROMPT_VER} -->`);
  L.push('');
  L.push('아래 인물의 일·생활·성향을 보고, 다섯 영역마다 **평소 삶에서 이 능력을 쓰거나 기를 일이 평균보다 많은지**를 매긴다. AI 를 써 봤는지는 따지지 않는다(그건 따로 정해져 있다).');
  L.push('');
  L.push('## 영역');
  for (const a of AREAS) L.push(`- 영역${a.dim} ${a.name}: ${a.what}. +1 예: ${a.plus}. -1 예: ${a.minus}.`);
  L.push('');
  L.push('규칙');
  L.push('1. +1 = 평균보다 많다 · 0 = 보통이거나 근거가 없다 · -1 = 평균보다 적다.');
  L.push('2. +1 이나 -1 을 줄 때는 근거가 되는 인물 정보 문장의 일부(10~40자)를 큰따옴표 안에 **글자 그대로** 옮긴다. 옮길 문장이 없으면 0 을 주고 근거 칸에 "근거 없음" 이라 쓴다.');
  L.push('3. 정보에 없는 경력·성향을 지어내지 않는다. 다섯 영역을 서로 따로 판단한다.');
  L.push('');
  L.push('답 형식 (다른 말 없이 이 형식만):');
  L.push('```');
  L.push(`@persona ${persona.syn_id}`);
  for (const a of AREAS) L.push(`영역${a.dim} | +1 또는 0 또는 -1 | "인물 정보에서 옮긴 문장" 또는 근거 없음`);
  L.push('@end');
  L.push('```');
  L.push('');
  L.push('## 인물');
  L.push(personaBlock(persona));
  L.push('');
  return L.join('\n');
}
const squash = (t) => String(t ?? '').replace(/\s+/g, '');
export function parseRateAnswer(text, persona) {
  const errors = [];
  const head = text.match(/^@persona\s+(\S+)/m);
  if (!head || head[1] !== persona.syn_id) errors.push(`인물 id 불일치 (${head?.[1] ?? '없음'})`);
  const source = squash(personaBlock(persona));  // 요청 파일에 보인 그대로(항목 이름 포함)
  const ratings = []; const evidence = [];
  for (const a of AREAS) {
    const m = text.match(new RegExp(`^영역${a.dim}\\s*\\|\\s*([+-]?[01])\\s*\\|\\s*(.+)$`, 'm'));
    if (!m) { errors.push(`영역${a.dim}: 줄 없음`); continue; }
    const r = Number(m[1]);
    const quote = m[2].match(/["“”]([^"“”]{4,})["“”]/)?.[1];
    if (r !== 0 && !quote) errors.push(`영역${a.dim}: ${m[1]} 인데 인용 없음`);
    else if (r !== 0 && !source.includes(squash(quote))) errors.push(`영역${a.dim}: 인용이 인물 정보에 없음 (${quote.slice(0, 20)})`);
    ratings[a.dim - 1] = r; evidence[a.dim - 1] = quote ?? '';
  }
  return { ratings, evidence, errors };
}

export function renderPersonaDimsRequest(persona, level, dims, { general = true, official = false } = {}) {
  const areas = areaSet(official);
  const L = [];
  L.push(`# 가상 인물 지식 상태 서술 (영역별) — ${persona.syn_id}`);
  L.push(`<!-- prompt ${dimsPromptVer(general, official).profile} -->`);
  L.push('');
  L.push(general
    ? '아래 인물은 한국 인구 분포를 바탕으로 만든 가상 인물이다. 이 인물의 생성형 AI 사용 수준과 다섯 영역의 수준은 **이미 정해져 있다**(바꾸지 않는다). 너는 이 수준들을 이 인물의 삶에 맞게 구체적으로 풀어 쓴다.'
    : '아래 인물은 한국 인구 분포를 바탕으로 만든 가상 인물이다. 이 인물의 다섯 영역 수준은 **이미 정해져 있다**(바꾸지 않는다). 너는 이 수준들을 이 인물의 삶에 맞게 구체적으로 풀어 쓴다.');
  L.push('');
  if (general) {
    L.push(`## 생성형 AI 사용 수준: ${level}`);
    L.push(LEVEL_TEXT[level]);
    L.push('');
  }
  L.push('## 영역별 수준 (AI 를 써 본 정도가 아니라 그 영역의 판단력·습관이다)');
  areas.forEach((a, i) => L.push(`- 영역${a.dim} ${a.name} — ${AREA_LEVELS[dims[i]]}: ${AREA_LEVEL_TEXT[dims[i]]} (영역 뜻: ${a.what})`));
  L.push('');
  L.push('규칙');
  L.push('1. 수준은 위에 정해진 것을 따른다. 영역마다 수준이 다르면 다르게 쓴다 — AI 를 안 써 본 사람도 어떤 영역은 높을 수 있고, 매일 쓰는 사람도 어떤 영역은 낮을 수 있다.');
  if (!general) L.push('   AI 를 얼마나 써 봤는지는 따로 정하지 않았다. 영역마다 정해진 수준만 보고 쓰고, 모든 영역을 한꺼번에 끌어올리거나 끌어내리는 공통 사정(예: "AI 를 전혀 안 써 봐서 다 모른다")을 영역 서술에 반복해 넣지 않는다.');
  L.push('2. 영역마다 이 인물이 실제로 하는 행동·아는 것·모르는 것을 일상어로 한두 문장 쓴다. 영역 이름이나 정의를 되풀이하지 말고 구체 행동으로 쓴다.');
  L.push('3. 수준이 낮음 이하인 영역마다 이 인물이 실제로 믿고 있을 법한 **구체적인 착각**을 한 문장씩 쓴다(최대 3개, 낮은 영역이 없으면 "착각: 없음"). 착각은 그럴듯하지만 틀린 믿음이다(예: "AI가 자신 있게 말하면 맞는 말이다").');
  L.push('4. 정보에 없는 특별한 경력이나 전문성을 지어내지 않는다.');
  L.push('');
  L.push('답 형식 (다른 말 없이 이 형식만):');
  L.push('```');
  L.push(`@persona ${persona.syn_id}`);
  L.push(`app_persona: ${APP_PERSONAS.join('|')}`);
  L.push(`employment: ${EMPLOYMENT.join('|')}`);
  for (const a of AREAS) L.push(`영역${a.dim}: <이 영역에서 이 인물이 하는 행동·아는 것·모르는 것>`);
  L.push('착각(영역N): <낮은 영역의 착각 한 문장>   ← 낮은 영역마다 한 줄, 최대 3줄 · 없으면 "착각: 없음" 한 줄');
  L.push('문제 푸는 태도: <앱에서 문제를 볼 때 꼼꼼히 읽는지, 감으로 고르는지 한 문장>');
  L.push('@end');
  L.push('```');
  L.push('app_persona 기준: office_worker 회사 사무·기획·관리 · marketer 마케팅·콘텐츠·SNS · developer 개발·IT·데이터 · designer 디자인 · student 공부·연구 중 · owner 가게·사업 운영, 영업·고객 응대 · educator 가르치는 일 · general 위에 없음(구직·주부·은퇴·무직·농어업·생산직 등).');
  L.push('employment 기준: emp_org 회사·조직 소속 · emp_freelance 프리랜서·자영업 · emp_student 학생 · emp_none 지금 일하지 않음.');
  L.push('');
  L.push('## 인물');
  L.push(personaBlock(persona));
  L.push('');
  return L.join('\n');
}
export function parseDimProfileAnswer(text, id, dims) {
  const errors = [];
  const head = text.match(/^@persona\s+(\S+)/m);
  if (!head || head[1] !== id) errors.push(`인물 id 불일치 (${head?.[1] ?? '없음'})`);
  const body = text.split(/^@end/m)[0];
  const get = (k) => body.match(new RegExp(`^${k}\\s*:\\s*(.+)$`, 'm'))?.[1].trim() ?? null;
  const pr = { app_persona: get('app_persona'), employment: get('employment'), attitude: get('문제 푸는 태도'), areas: AREAS.map((a) => get(`영역${a.dim}`)), misconceptions: [] };
  if (!APP_PERSONAS.includes(pr.app_persona)) errors.push('app_persona');
  if (!EMPLOYMENT.includes(pr.employment)) errors.push('employment');
  if (!pr.attitude || pr.attitude.length < 8) errors.push('문제 푸는 태도');
  pr.areas.forEach((t, i) => { if (!t || t.length < 15) errors.push(`영역${i + 1} 서술`); });
  for (const m of body.matchAll(/^착각\(영역([1-5])\)\s*:\s*(.+)$/gm)) pr.misconceptions.push({ area: Number(m[1]), text: m[2].trim() });
  const weak = dims.map((d, i) => (d <= 1 ? i + 1 : null)).filter(Boolean);
  if (pr.misconceptions.length > 3) errors.push(`착각 ${pr.misconceptions.length}개(최대 3)`);
  if (weak.length && !pr.misconceptions.length) errors.push(`낮은 영역(${weak.join(',')})이 있는데 착각 없음`);
  for (const m of pr.misconceptions) if (!weak.includes(m.area)) errors.push(`착각(영역${m.area}) — 낮은 영역이 아님`);
  return { profile: pr, errors };
}

// 보기 순서 — 인물·문항마다 시드 셔플(위치 편향이 오답 매력도로 둔갑하지 않게). 제시 글자 i 는 원래 보기 order[i].
export function optionOrder(seed, personaId, itemId) {
  return seededShuffle([...OPTION_KEYS], `opt|${seed}|${personaId}|${itemId}`);
}

export function renderItemsRequest(persona, level, profile, items, { seed, misconceptions = false, general = true, official = false }) {
  if (profile.areas) return renderItemsRequestDims(persona, level, profile, items, { seed, misconceptions, general, official });
  const personaId = persona.syn_id;
  const L = [];
  L.push(`# 가상 인물 선택 예측 — ${personaId}`);
  L.push(`<!-- prompt ${SOLVE_PROMPT_VER} -->`);
  L.push('');
  L.push('너는 아래 인물을 오래 지켜봐 온 관찰자다. 이 인물이 스마트폰 학습 앱에서 아래 문제들을 **처음 볼 때 각 보기를 고를 확률**을 예측하라. 너 자신이 푸는 것이 아니다. 정답은 알려 주지 않는다.');
  L.push('');
  L.push('## 인물');
  L.push(personaBlock(persona));
  L.push('');
  L.push(`## 이 인물의 AI 사용 수준과 지식 상태 (미리 정해 둔 것 — 바꾸지 않는다)`);
  L.push(`- 수준: ${level} — ${LEVEL_TEXT[level]}`);
  L.push(`- 아는 것: ${profile.knows}`);
  L.push(`- 모르는 것: ${profile.unknown}`);
  L.push(`- 헷갈리기 쉬운 점: ${profile.confusions}`);
  L.push(`- 문제 푸는 태도: ${profile.attitude}`);
  L.push('');
  L.push('## 예측하는 방법');
  L.push('1. 위에 적힌 이 인물의 수준·아는 것·모르는 것·헷갈리기 쉬운 점·문제 푸는 태도를 그대로 따른다. 바꾸지 않는다.');
  L.push('2. 이 인물이 지문을 어떻게 읽을지(꼼꼼히/대충), 각 보기가 이 인물에게 얼마나 그럴듯해 보일지를 생각해 보기별 확률을 정수 %로 적는다(합 100).');
  L.push('3. **네가 생각하는 정답을 1순위에 두는 것이 기본값이 아니다.** 먼저 "이 인물이라면 어느 보기에 가장 끌릴까"를 정하고 그 보기에 가장 높은 확률을 준다. 그 보기는 정답일 수도, 오답일 수도 있다.');
  L.push('4. 이 인물이 모르는 것·헷갈리기 쉬운 점·문제 푸는 태도에 걸리는 보기가 있으면, 그 보기가 오답이어도 정답보다 높게 준다. AI 를 잘 모르는 인물일수록 네 판단과 다른 보기를 1순위로 두는 문제가 많은 것이 자연스럽다. 잘 아는 인물도 헷갈릴 만한 문제에서는 오답을 고를 수 있다.');
  L.push('5. 이 인물이 정말 확신할 만한 문제에서만 한 보기에 확률을 몰아준다. 몇 문제를 틀리게 할지 미리 정하지 말고, 문제마다 이 인물의 반응을 따라간다.');
  L.push('6. 문제마다 따로 판단한다. 앞 문제에서 고른 보기 글자를 따라가지 않는다.');
  L.push('7. 이유는 이 인물의 입장에서 한 줄(40자 안팎) — 왜 그 보기에 끌리는지.');
  L.push('');
  L.push('## 답 형식 (다른 말 없이 이 형식만)');
  L.push('```');
  L.push(`@persona ${personaId}`);
  L.push('q01 | a=10 b=70 c=15 d=5 | 인물 입장 이유 한 줄');
  L.push('...');
  L.push('@end');
  L.push('```');
  L.push('');
  L.push('## 문제');
  items.forEach((it, i) => {
    const order = optionOrder(seed, personaId, it.item_id);
    const textOf = new Map(it.options.map((o) => [o.key, o.text]));
    L.push(`### ${qid(i)}`);
    L.push(stripEmphasis(it.stem));
    order.forEach((orig, j) => L.push(`- ${OPTION_KEYS[j]}) ${stripEmphasis(textOf.get(orig))}`));
    L.push('');
  });
  return L.join('\n');
}
function renderItemsRequestDims(persona, level, profile, items, { seed, misconceptions, general, official }) {
  const personaId = persona.syn_id;
  const dims = profile.dims;
  const L = [];
  L.push(`# 가상 인물 선택 예측 — ${personaId}`);
  L.push(`<!-- prompt ${dimsPromptVer(general, official).solve}${misconceptions ? '+misconceptions' : ''} -->`);
  L.push('');
  L.push('너는 아래 인물을 오래 지켜봐 온 관찰자다. 이 인물이 스마트폰 학습 앱에서 아래 문제들을 **처음 볼 때 각 보기를 고를 확률**을 예측하라. 너 자신이 푸는 것이 아니다. 정답은 알려 주지 않는다.');
  L.push('');
  L.push('## 인물');
  L.push(personaBlock(persona));
  L.push('');
  L.push('## 이 인물의 상태 (미리 정해 둔 것 — 바꾸지 않는다)');
  if (general) L.push(`- 생성형 AI 사용 수준: ${level} — ${LEVEL_TEXT[level]}`);
  areaSet(official).forEach((a, i) => L.push(`- ${a.name}(${AREA_LEVELS[dims[i]]}): ${profile.areas[i]}`));
  L.push(`- 문제 푸는 태도: ${profile.attitude}`);
  if (misconceptions) {
    L.push('');
    L.push('## 이 인물의 착각 (이 인물은 이것을 사실로 믿는다)');
    if (profile.misconceptions.length) for (const m of profile.misconceptions) L.push(`- ${m.text}`);
    else L.push('- 없음');
  }
  L.push('');
  L.push('## 예측하는 방법');
  L.push('1. 위에 적힌 이 인물의 상태를 그대로 따른다. 바꾸지 않는다.');
  L.push('2. 문제마다 먼저 "이 문제를 풀려면 위 다섯 가지 중 어느 능력이 필요한가"를 생각하고, 그 능력의 수준과 서술에 맞춰 예측한다. 능력마다 수준이 다르므로 같은 인물이라도 어떤 문제는 잘 풀고 어떤 문제는 못 푼다.');
  L.push('3. **네가 생각하는 정답을 1순위에 두는 것이 기본값이 아니다.** 먼저 "이 인물이라면 어느 보기에 가장 끌릴까"를 정하고 그 보기에 가장 높은 확률을 준다. 그 보기는 정답일 수도, 오답일 수도 있다. 해당 능력이 낮음 이하면 네 판단과 다른 보기를 1순위로 두는 것이 자연스럽다.');
  let n = 4;
  if (misconceptions) L.push(`${n++}. 보기 중 이 인물의 착각과 맞아떨어지는 것이 있으면 이 인물은 그 보기를 믿고 고른다 — 그 보기를 1순위에 두고 50% 이상을 준다. 같은 착각에 걸리는 문제마다 같은 방향으로 고른다.`);
  L.push(`${n++}. 이 인물이 정말 확신할 만한 문제에서만 한 보기에 확률을 몰아준다. 몇 문제를 틀리게 할지 미리 정하지 말고, 문제마다 이 인물의 반응을 따라간다.`);
  L.push(`${n++}. 각 보기의 확률을 정수 %로 적는다(합 100). 문제마다 따로 판단하고, 앞 문제에서 고른 보기 글자를 따라가지 않는다.`);
  L.push(`${n++}. 이유는 이 인물의 입장에서 한 줄(40자 안팎) — 왜 그 보기에 끌리는지.`);
  L.push('');
  L.push('## 답 형식 (다른 말 없이 이 형식만)');
  L.push('```');
  L.push(`@persona ${personaId}`);
  L.push('q01 | a=10 b=70 c=15 d=5 | 인물 입장 이유 한 줄');
  L.push('...');
  L.push('@end');
  L.push('```');
  L.push('');
  L.push('## 문제');
  items.forEach((it, i) => {
    const order = optionOrder(seed, personaId, it.item_id);
    const textOf = new Map(it.options.map((o) => [o.key, o.text]));
    L.push(`### ${qid(i)}`);
    L.push(stripEmphasis(it.stem));
    order.forEach((orig, j) => L.push(`- ${OPTION_KEYS[j]}) ${stripEmphasis(textOf.get(orig))}`));
    L.push('');
  });
  return L.join('\n');
}
// 앱은 줄기의 ** 를 그대로 렌더하지 않는다 → 인물이 보는 화면에 맞춰 뺀다.
export const stripEmphasis = (s) => s.replace(/\*\*/g, '');
export const qid = (i) => `q${String(i + 1).padStart(2, '0')}`;

const DIST_RE = /^(q\d{2,3})\s*\|\s*a\s*=\s*(\d+)\s+b\s*=\s*(\d+)\s+c\s*=\s*(\d+)\s+d\s*=\s*(\d+)\s*\|\s*(.*)$/;
export function parseSolveAnswer(text, personaId, count) {
  const errors = [];
  const head = text.match(/^@persona\s+(\S+)/m);
  if (!head || head[1] !== personaId) errors.push(`인물 id 불일치 (${head?.[1] ?? '없음'})`);
  const dists = {};
  for (const line of text.split('\n')) {
    const m = line.trim().match(DIST_RE);
    if (!m) continue;
    const probs = m.slice(2, 6).map(Number);
    const sum = probs.reduce((a, b) => a + b, 0);
    if (sum < 95 || sum > 105) { errors.push(`${m[1]}: 확률 합 ${sum}`); continue; }
    dists[m[1]] = { a: probs[0] / sum, b: probs[1] / sum, c: probs[2] / sum, d: probs[3] / sum, reason: m[6].trim() };
  }
  for (let i = 0; i < count; i += 1) if (!dists[qid(i)] && !errors.some((e) => e.startsWith(`${qid(i)}:`))) errors.push(`${qid(i)}: 답 없음`);
  const extra = Object.keys(dists).filter((k) => Number(k.slice(1)) > count);
  if (extra.length) errors.push(`요청보다 많은 문항 ${extra.join(',')}`);
  return { dists, errors };
}

// 분포 → 선택 1개. 키 = 시드·인물·문항 — 재흡수·재실행해도 같은 선택.
export function sampleChoice(dist, key) {
  const u = unitHash(key);
  let acc = 0;
  for (const k of OPTION_KEYS) { acc += dist[k]; if (u < acc) return k; }
  return 'd';
}

// ---------- 스냅샷 (실응답과 같은 형식 + 합성 분리 표식) ----------
export const SYN_RESPONDENT_EXTRA = Object.freeze(['source', 'age', 'education_level', 'occupation', 'province', 'level_rule', 'sim_model', 'hf_uuid']);
export const DETAIL_COLUMNS = Object.freeze(['user_hash', 'analysis_item_id', 'item_id', 'position', 'is_anchor', 'key', 'selected', 'shown_as', 'key_shown_as', 'correct', 'p_a', 'p_b', 'p_c', 'p_d', 'p_key', 'source']);

// answers[pid].dists 는 제시 글자 기준 — optionOrder 로 원래 보기로 되돌린 뒤 샘플링한다(선택도 원래 보기 기준). levels[pid] = 규칙 배정 수준.
export function buildSyntheticSnapshot({ items, personas, profiles, answers, levels, assignment, asOfDate, seed }) {
  const itemById = new Map(items.map((it) => [it.item_id, it]));
  const anchorSet = new Set(assignment.anchors);
  const responses = [];
  const detail = [];
  const respondents = [];
  for (const p of personas) {
    const pr = profiles[p.syn_id];
    const ans = answers[p.syn_id];
    if (!pr || !ans) continue;
    const order = assignment.perPersona[p.syn_id];
    order.forEach((itemId, i) => {
      const it = itemById.get(itemId);
      const shownDist = ans.dists[qid(i)];
      if (!it || !shownDist) return;
      const order = optionOrder(seed, p.syn_id, itemId);
      const dist = Object.fromEntries(order.map((orig, j) => [orig, shownDist[OPTION_KEYS[j]]]));
      const selected = sampleChoice(dist, `choice|${seed}|${p.syn_id}|${itemId}`);
      const shownAs = OPTION_KEYS[order.indexOf(selected)];
      const correct = selected === it.key;
      responses.push({
        user_hash: p.syn_id, item_id: itemId, analysis_item_id: `${itemId}@v${it.content_version}`, pos: i + 1, position_id: it.position_id,
        attempt_no: 1, served_as: 'scored', lesson_completed: true, elapsed_ms: null, session_id: `${p.syn_id}-s1`, selected_key: shownAs, // F5 연속 같은 보기 = 화면 글자 기준
        order_in_lesson: i + 1, format: it.format, is_correct: correct, answered_date: asOfDate, app_version: null, platform: null,
        content_version: it.content_version, family_code: it.family_code, dimension: it.dimension, source_id: it.source_id,
        variant_no: it.variant_no, variant_kind: it.variant_kind, mission_id: '', mission_code: '', mission_slug: '', unit_slug: 'synthetic',
        lesson_order: '', content_hash: it.content_hash,
      });
      detail.push({
        user_hash: p.syn_id, analysis_item_id: `${itemId}@v${it.content_version}`, item_id: itemId, position: i + 1,
        is_anchor: anchorSet.has(itemId) ? 'true' : 'false', key: it.key, selected, shown_as: shownAs, key_shown_as: OPTION_KEYS[order.indexOf(it.key)], correct: correct ? 1 : 0,
        p_a: dist.a.toFixed(3), p_b: dist.b.toFixed(3), p_c: dist.c.toFixed(3), p_d: dist.d.toFixed(3), p_key: dist[it.key].toFixed(3), source: 'synthetic',
      });
    });
    respondents.push({
      user_hash: p.syn_id, birth_year_band: birthBand(p.age), gender: genderCode(p.sex), persona: pr.app_persona,
      employment_type: pr.employment, ai_experience: levels[p.syn_id], acquisition_channel: null, signup_date: null,
      first_completion_date: asOfDate, research_agreed: null, cohort_flag: 'campaign', completed_lessons: 1,
      // 아래는 합성 전용 열(respondents.csv 끝에 붙는다)
      source: 'synthetic', age: p.age, education_level: p.education_level, occupation: p.occupation, province: p.province,
      level_rule: 'msit2025-age', sim_model: ans.model ?? '', hf_uuid: p.hf_uuid,
    });
  }
  // 합성 응답자는 개인정보가 아니라 준식별자 셀 병합을 끈다 — 분석 축(persona·ai_experience)이 'other' 로 뭉개지지 않게.
  const rules = { ...DEFAULT_RULES, cellMin: 0 };
  const snap = buildSnapshot({ responses, respondents, recall: new Map(), excludeSessions: new Set(), rules });
  const extraOf = new Map(respondents.map((r) => [r.user_hash, r]));
  const respondentsOut = snap.respondents.map((r) => ({ ...extraOf.get(r.user_hash), ...r, cohort_flag: 'synthetic' }));
  const longOut = snap.long.map((r) => ({ ...r, source: 'synthetic' }));
  const keptUsers = new Set(snap.respondents.map((r) => r.user_hash));
  const files = {
    ...snap.files,
    'respondents.csv': toCsv(respondentsOut, [...RESPONDENT_COLUMNS, ...SYN_RESPONDENT_EXTRA]),
    'responses_long.csv': toCsv(longOut, [...LONG_COLUMNS, 'source']),
    'synthetic_detail.csv': toCsv(detail.filter((d) => keptUsers.has(d.user_hash))
      .sort((a, b) => cmp(a.user_hash, b.user_hash) || a.position - b.position), DETAIL_COLUMNS),
  };
  return { files, counts: snap.counts, long: snap.long, items: snap.items, respondents: respondentsOut, detail };
}

// ---------- 점검 리포트 ----------
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const sd = (xs) => { const m = mean(xs); return xs.length > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1)) : NaN; };
function pearson(x, y) {
  const mx = mean(x); const my = mean(y);
  let sxy = 0; let sxx = 0; let syy = 0;
  for (let i = 0; i < x.length; i += 1) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : NaN;
}
const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : 'NA');

// 기준값 — 선행연구·사전 판단. 넘으면 리포트 상단에 경고.
export const QUALITY_GATES = Object.freeze({ ceilingMean: 0.85, floorMean: 0.30, minPersonSd: 0.08, minItemRest: 0.10, keySuspectTopShare: 0.5 });

export function buildReport({ detail, respondents, items, anchors }) {
  const L = [];
  const byUser = new Map();
  for (const d of detail) { if (!byUser.has(d.user_hash)) byUser.set(d.user_hash, []); byUser.get(d.user_hash).push(d); }
  const score = new Map([...byUser].map(([u, ds]) => [u, mean(ds.map((d) => d.correct))]));
  const scores = [...score.values()];
  const itemDim = new Map(items.map((it) => [it.item_id, it.dimension]));
  const warn = [];
  const m = mean(scores);
  if (m > QUALITY_GATES.ceilingMean) warn.push(`평균 정답률 ${f2(m)} > ${QUALITY_GATES.ceilingMean} — 천장. 인물 수준이 풀이에 덜 반영됐다`);
  if (m < QUALITY_GATES.floorMean) warn.push(`평균 정답률 ${f2(m)} < ${QUALITY_GATES.floorMean} — 바닥`);
  if (sd(scores) < QUALITY_GATES.minPersonSd) warn.push(`응답자 점수 표준편차 ${f2(sd(scores))} < ${QUALITY_GATES.minPersonSd} — 분산 축소(선행연구의 대표 실패)`);

  L.push('# 가상 응답 점검 리포트');
  L.push('');
  L.push('> 가상 응답(source=synthetic). 실응답과 섞지 않고, 논문에는 가상 응답임·표본 수·수준 배정 방식을 실응답과 나눠 적는다.');
  L.push('');
  L.push('## 경고');
  L.push(warn.length ? warn.map((w) => `- ${w}`).join('\n') : '- 없음');
  L.push('');
  L.push('## 응답자');
  L.push(`- 인원 ${scores.length} · 1인 문항 ${f2(mean([...byUser.values()].map((d) => d.length)))} · 평균 정답률 ${f2(m)} · 표준편차 ${f2(sd(scores))} · 최소 ${f2(Math.min(...scores))} · 최대 ${f2(Math.max(...scores))}`);
  const bins = Array(10).fill(0);
  for (const s of scores) bins[Math.min(9, Math.floor(s * 10))] += 1;
  L.push(`- 분포(0.1 구간): ${bins.map((b, i) => `${i / 10}~${(i + 1) / 10}:${b}`).join(' · ')}`);
  const shown = { a: 0, b: 0, c: 0, d: 0 };
  const keyShown = { a: 0, b: 0, c: 0, d: 0 };
  for (const d of detail) { if (d.shown_as) shown[d.shown_as] += 1; if (d.key_shown_as) keyShown[d.key_shown_as] += 1; }
  L.push(`- 화면 위치별 선택률(보기 순서는 인물마다 섞음 — 한쪽이 크게 높으면 위치 편향): ${OPTION_KEYS.map((k) => `${k} ${f2(shown[k] / Math.max(1, detail.length))}`).join(' · ')} (정답이 놓인 위치 ${OPTION_KEYS.map((k) => `${k} ${f2(keyShown[k] / Math.max(1, detail.length))}`).join(' · ')})`);
  L.push('');
  const groupTable = (title, col) => {
    const g = new Map();
    for (const r of respondents) { const k = r[col] ?? 'NA'; if (!score.has(r.user_hash)) continue; if (!g.has(k)) g.set(k, []); g.get(k).push(score.get(r.user_hash)); }
    L.push(`### ${title}`);
    L.push('| 값 | n | 평균 정답률 | 표준편차 |');
    L.push('|---|---|---|---|');
    for (const [k, v] of [...g].sort(([a], [b]) => cmp(String(a), String(b)))) L.push(`| ${k} | ${v.length} | ${f2(mean(v))} | ${f2(sd(v))} |`);
    L.push('');
  };
  groupTable('배정 수준별 (조작 점검 — never < tried < sometimes < often < daily 오르막이어야 수준이 풀이에 반영된 것)', 'ai_experience');
  // 확률 분포에서 정답이 1순위인 비율 — 낮은 수준인데 거의 100% 면 "알되 자신 없는 사람"으로만 그린 것(오답에 끌리는 모습 없음)
  const levelOf = new Map(respondents.map((r) => [r.user_hash, r.ai_experience]));
  const modal = new Map();
  for (const d of detail) {
    if (d.p_a === undefined) continue;
    const ps = { a: Number(d.p_a), b: Number(d.p_b), c: Number(d.p_c), d: Number(d.p_d) };
    const top = Math.max(...Object.values(ps));
    const k = levelOf.get(d.user_hash) ?? 'NA';
    const m = modal.get(k) ?? { n: 0, keyTop: 0, pKey: 0 };
    m.n += 1; m.keyTop += ps[d.key] >= top ? 1 : 0; m.pKey += ps[d.key];
    modal.set(k, m);
  }
  if (modal.size) {
    L.push('### 배정 수준별 확률 분포 — 정답을 1순위로 둔 비율 (낮은 수준인데 100% 에 가까우면 오답에 끌리는 모습이 없는 것)');
    L.push('| 수준 | 문항 | 정답 1순위 | 오답 1순위 | 정답 확률 평균 |');
    L.push('|---|---|---|---|---|');
    for (const [k, m] of [...modal].sort(([a], [b]) => cmp(String(a), String(b)))) L.push(`| ${k} | ${m.n} | ${f2(m.keyTop / m.n)} | ${f2(1 - m.keyTop / m.n)} | ${f2(m.pKey / m.n)} |`);
    L.push('');
  }
  groupTable('학력별', 'education_level');
  groupTable('앱 페르소나별', 'persona');
  groupTable('풀이 모델별', 'sim_model');

  L.push('## 차원별 평균 정답률');
  L.push('| 차원 | 응답 수 | 평균 |');
  L.push('|---|---|---|');
  for (const dm of [1, 2, 3, 4, 5]) {
    const ds = detail.filter((d) => itemDim.get(d.item_id) === dm);
    L.push(`| D${dm} | ${ds.length} | ${f2(mean(ds.map((d) => d.correct)))} |`);
  }
  L.push('');

  // 문항 — 정답률 · 문항-나머지 상관(응답자 전체 점수에서 그 문항 제외) · 오답 매력도 · 상위 25% 가 오답을 더 고른 문항(정답 키 의심)
  const byItem = new Map();
  for (const d of detail) { if (!byItem.has(d.item_id)) byItem.set(d.item_id, []); byItem.get(d.item_id).push(d); }
  const sortedScores = [...scores].sort((a, b) => a - b);
  const q75 = sortedScores[Math.floor(sortedScores.length * 0.75)] ?? 1;
  const rows = [];
  for (const [itemId, ds] of byItem) {
    const p = mean(ds.map((d) => d.correct));
    const rest = ds.map((d) => { const all = byUser.get(d.user_hash); return (mean(all.map((x) => x.correct)) * all.length - d.correct) / Math.max(1, all.length - 1); });
    const r = pearson(ds.map((d) => d.correct), rest);
    const top = ds.filter((d) => score.get(d.user_hash) >= q75);
    const topDistractor = top.length ? Math.max(...['a', 'b', 'c', 'd'].filter((k) => k !== ds[0].key).map((k) => top.filter((d) => d.selected === k).length / top.length)) : 0;
    const topKey = top.length ? top.filter((d) => d.correct === 1).length / top.length : NaN;
    rows.push({ itemId, n: ds.length, p, r, topKey, topDistractor, anchor: anchors.includes(itemId) });
  }
  const suspect = rows.filter((x) => x.n >= 10 && x.topDistractor > x.topKey && x.topDistractor >= QUALITY_GATES.keySuspectTopShare);
  const lowDisc = rows.filter((x) => x.n >= 10 && Number.isFinite(x.r) && x.r < QUALITY_GATES.minItemRest);
  L.push('## 문항');
  L.push(`- 문항 ${rows.length} · 문항당 응답 평균 ${f2(mean(rows.map((x) => x.n)))} (앵커 ${anchors.length}개는 전원)`);
  L.push(`- 정답률 > .95: ${rows.filter((x) => x.p > 0.95).length} · < .20: ${rows.filter((x) => x.p < 0.2).length} · 문항-나머지 상관 < ${QUALITY_GATES.minItemRest}(n≥10): ${lowDisc.length}`);
  L.push(`- 정답 키 의심(상위 25% 가 한 오답을 정답보다 더, ${QUALITY_GATES.keySuspectTopShare} 이상 고름, n≥10): ${suspect.length}`);
  L.push('');
  if (suspect.length) {
    L.push('### 정답 키 의심 문항');
    L.push('| 문항 | n | 정답률 | 상위 정답 | 상위 최다 오답 |');
    L.push('|---|---|---|---|---|');
    for (const x of suspect.sort((a, b) => b.topDistractor - a.topDistractor)) L.push(`| ${x.itemId} | ${x.n} | ${f2(x.p)} | ${f2(x.topKey)} | ${f2(x.topDistractor)} |`);
    L.push('');
  }
  L.push('### 앵커 문항 (전원 응답)');
  L.push('| 문항 | n | 정답률 | 문항-나머지 상관 |');
  L.push('|---|---|---|---|');
  for (const x of rows.filter((y) => y.anchor).sort((a, b) => cmp(a.itemId, b.itemId))) L.push(`| ${x.itemId} | ${x.n} | ${f2(x.p)} | ${f2(x.r)} |`);
  L.push('');
  return { markdown: L.join('\n') + '\n', warnings: warn, itemRows: rows };
}
