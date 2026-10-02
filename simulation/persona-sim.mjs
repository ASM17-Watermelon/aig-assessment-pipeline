#!/usr/bin/env node
// 가상 응답자 풀이(virtual respondent simulation) — 검수 끝난 문항(md)을 Nemotron-Personas-Korea 가상 인물들에게 풀려 합성 응답 스냅샷을 만든다.
//
// 앱·DB 와 무관하다: 문항은 md 파일을 그대로 읽고, 결과는 별도 폴더의 CSV 로만 낸다(실응답 파일과 합치지 않는다).
// 풀이 LLM 은 이 스크립트가 직접 부르지 않는다. 스크립트가 요청 파일(req/)을 쓰면 에이전트가 답 파일(ans/)을 쓰고, 스크립트가 형식을 검증해 흡수한다.
//   에이전트 실행은 Claude Code 워크플로 simulation/workflow/persona-sim.js 가 한다(스크립트와 실행기의 접점은 요청·답 파일 형식뿐이다).
// 인물 1명 = 에이전트 1개: ① 인물 정보만 보고 지식 상태를 서술해 고정(profile) ② 그 뒤 문항 파일로 보기별 선택 확률을 예측(solve) → 결정적 해시로 선택 1개 표집.
//
// 사용 (작업 폴더 기본 = runs/<run>, gitignored):
//   node simulation/persona-sim.mjs fetch-parquet          (원본 parquet 9개 ≈2GB → runs/_hf/<revision>/, LFS sha256 대조 — 한 번만)
//   node simulation/persona-sim.mjs personas --run r1 --n 300 [--seed 600] [--parquet-dir runs/_hf/<revision>]
//        (나이 정원 = lib AGE_QUOTAS: 19~45 70% · 46~63 27% · 64~72 3%. --parquet-dir 없으면 HF 조회 API — 수백 건이면 429 로 막힌다)
//   node simulation/persona-sim.mjs prep --run r1 [--dims --no-general --areas official]
//   (세션) Workflow persona-sim  args {run:'r1', stage:'profile'}  → absorb-profiles
//   node simulation/persona-sim.mjs items --run r1 --md <문항 md>[,<md> …] [--lot <라벨>] [--log <생성로그 csv>] [--exclude <file>] [--review-csv <판정 csv>]
//   node simulation/persona-sim.mjs plan --run r1 [--anchors 1 --rotate 2]   (위치마다 변형 1개인 표본은 --rotate 를 문항모형당 위치 수에 맞춘다)
//   (세션) Workflow persona-sim  args {run:'r1', stage:'solve', limit:200}   ← 대기 인물을 한꺼번에 병렬로 풀고 흡수까지
//   node simulation/persona-sim.mjs absorb --run r1          (워크플로가 마지막에 부른다 — 손으로 다시 불러도 안전)
//   node simulation/persona-sim.mjs emit --run r1 --as-of 2026-10-15 --out <dir> --write
//   node simulation/persona-sim.mjs status --run r1 [--json --limit 200]
// 5역량 판: fork --run p5 --from r300 --n 30 → prep --dims → (세션) stage rate → absorb-rates → (세션) stage profile → absorb-profiles
//   → fork --run p5c --from p5 [--misconceptions] → items → plan → (세션) solve → absorb → emit
//   prep --dims --areas official: 지식 상태·풀이 요청의 영역 이름·뜻을 공식 5차원 정의로(평정은 AREAS 그대로)
//   prep --dims --no-general: 전반 AI 사용 수준을 지식 상태·풀이 요청에서 뺀다(차원 수준에 이미 들어 있음 — 이중 반영 방지)
// 재실행 안전: 각 단계는 이미 끝난 것을 건드리지 않고, 흡수에서 형식 불량이면 답 파일을 rejected/ 로 옮겨 다음 워크플로가 다시 푼다(최대 3회).

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  AGE_QUOTAS, HF_DATASET, PROFILE_PROMPT_VER, ageBand, quotaCounts, SOLVE_PROMPT_VER, SCRIPT_VERSION, applyExclusions, buildAssignment, buildReport,
  buildSyntheticSnapshot, checkKeysAgainstLog, normalizePersona, parseExcludeList, parseLotMarkdown, parseProfileAnswer,
  parseSolveAnswer, personaOffsets, reviewStatus, renderItemsRequest, renderPersonaRequest, sha256, unitHash, assignLevel,
  AI_USE_RATE_BY_AGE, USER_LEVEL_SPLIT, AREAS, DIM_DEVIATION, RATE_PROMPT_VER, dimsPromptVer, STUDY,
  dimLevels, parseDimProfileAnswer, parseRateAnswer, renderPersonaDimsRequest, renderRateRequest,
} from './persona-sim-lib.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const MAX_ATTEMPTS = 3;
const MODELS = ['sonnet', 'opus', 'haiku', 'fable'];

const [stage, ...rest] = process.argv.slice(2);
const opt = {};
for (let i = 0; i < rest.length; i += 1) {
  if (!rest[i].startsWith('--')) throw new Error(`알 수 없는 인자 ${rest[i]}`);
  const k = rest[i].slice(2);
  const v = rest[i + 1];
  if (v === undefined || v.startsWith('--')) opt[k] = true; else { opt[k] = v; i += 1; }
}
const run = opt.run ?? 'r1';
if (!/^[a-z0-9-]{1,16}$/.test(run)) throw new Error('--run 은 영소문자·숫자·- 16자 이내');
const WORK = resolve(opt.work ?? join(ROOT, 'runs', run));
const W = (...p) => join(WORK, ...p);
const readJson = (f) => JSON.parse(readFileSync(W(f), 'utf8'));
const writeJson = (f, v) => { mkdirSync(dirname(W(f)), { recursive: true }); writeFileSync(W(f), JSON.stringify(v, null, 1) + '\n'); };
const readJsonl = (f) => readFileSync(W(f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const config = () => (existsSync(W('config.json')) ? readJson('config.json') : { study: STUDY, script_version: SCRIPT_VERSION, run });
const saveConfig = (patch) => writeJson('config.json', { ...config(), ...patch });
const need = (f, hint) => { if (!existsSync(W(f))) { console.error(`${f} 없음 — 먼저 ${hint}`); process.exit(2); } };
const rel = (p) => relative(ROOT, p);

async function fetchJson(url, tries = 7) {
  for (let t = 1; ; t += 1) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
      if (t >= tries || (r.status < 500 && r.status !== 429)) throw new Error(`${r.status} ${url}`);
    } catch (e) { if (t >= tries) throw e; }
    await new Promise((res) => setTimeout(res, Math.min(120000, 1000 * 2 ** t)));
  }
}

// ---------- 원본 parquet (조회 API 429 회피 · 판본 고정) ----------
// 판본을 sha 로 고정해 받는다 — 같은 오프셋이 같은 행이어야 같은 시드로 같은 인물이 뽑힌다.
async function fetchParquetStage() {
  const meta = await fetchJson(`https://huggingface.co/api/datasets/${HF_DATASET}`);
  const tree = await fetchJson(`https://huggingface.co/api/datasets/${HF_DATASET}/tree/${meta.sha}/data`);
  const files = tree.filter((f) => f.type === 'file' && /^data\/train-\d+-of-\d+\.parquet$/.test(f.path));
  const dir = resolve(opt.dir ?? join(ROOT, 'runs/_hf', meta.sha));
  mkdirSync(dir, { recursive: true });
  for (const f of files) {
    const dest = join(dir, f.path.split('/').pop());
    const want = f.lfs?.oid;
    const hashOf = async (p) => { const h = createHash('sha256'); await pipeline(createReadStream(p), h); return h.digest('hex'); };
    if (existsSync(dest) && (!want || (await hashOf(dest)) === want)) { console.log(`  있음 ${f.path}`); continue; }
    const r = await fetch(`https://huggingface.co/datasets/${HF_DATASET}/resolve/${meta.sha}/${f.path}`);
    if (!r.ok) throw new Error(`${r.status} ${f.path}`);
    await pipeline(Readable.fromWeb(r.body), createWriteStream(dest));
    if (want && (await hashOf(dest)) !== want) throw new Error(`${f.path} sha256 불일치`);
    console.log(`  받음 ${f.path} ${(f.size / 1e6).toFixed(0)}MB`);
  }
  console.log(`→ ${rel(dir)} (revision ${meta.sha.slice(0, 12)}, 파일 ${files.length}개). personas 에 --parquet-dir ${rel(dir)}`);
}

function rowsFromParquet(dir, offsets) {
  const outp = execFileSync('python3', [join(__dirname, 'persona-parquet.py'), '--dir', dir], { input: JSON.stringify(offsets), maxBuffer: 1 << 30 }).toString();
  return outp.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// ---------- personas ----------
async function personasStage() {
  if (existsSync(W('personas.jsonl')) && !opt.force) { console.log(`personas.jsonl 이미 있음(${readJsonl('personas.jsonl').length}명) — 다시 뽑으려면 --force`); return; }
  const n = Number(opt.n ?? 300);
  const seed = Number(opt.seed ?? 600);
  const meta = await fetchJson(`https://huggingface.co/api/datasets/${HF_DATASET}`);
  const parquetDir = opt['parquet-dir'] ? resolve(opt['parquet-dir']) : null;
  if (parquetDir && !parquetDir.includes(meta.sha)) console.warn(`경고: --parquet-dir 경로에 현재 판본 ${meta.sha.slice(0, 12)} 가 없다 — 받은 판본과 HF 현재 판본이 다를 수 있다`);
  const total = parquetDir
    ? JSON.parse(execFileSync('python3', ['-c', 'import sys,glob,pyarrow.parquet as pq;print(sum(pq.ParquetFile(f).metadata.num_rows for f in glob.glob(sys.argv[1]+"/train-*.parquet")))', parquetDir]).toString())
    : (await fetchJson(`https://datasets-server.huggingface.co/info?dataset=${encodeURIComponent(HF_DATASET)}`)).dataset_info.default.splits.train.num_examples;
  const candidates = personaOffsets({ seed, total, count: n * 20 });
  const quota = quotaCounts(n);
  const filled = quota.map(() => 0);
  const out = [];
  const rejected = [];
  let cursor = 0;
  while (out.length < n) {
    if (cursor >= candidates.length) throw new Error('후보 오프셋 소진');
    const batch = candidates.slice(cursor, cursor + (parquetDir ? 2000 : 4));
    cursor += batch.length;
    const rows = parquetDir
      ? rowsFromParquet(parquetDir, batch).map((x) => ({ o: x.offset, row: x.row }))
      : await Promise.all(batch.map((o) => fetchJson(`https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(HF_DATASET)}&config=default&split=train&offset=${o}&length=1`)
        .then((j) => ({ o, row: j.rows[0].row }))));
    for (const { o, row } of rows) {
      if (out.length >= n) break;
      const b = ageBand(row.age);
      if (b >= 0 && filled[b] < quota[b]) { filled[b] += 1; out.push(normalizePersona(row, { offset: o, index: out.length, runTag: run })); }
      else rejected.push({ offset: o, age: row.age });
    }
    process.stdout.write(`\r${out.length}/${n}`);
  }
  process.stdout.write('\n');
  mkdirSync(WORK, { recursive: true });
  writeFileSync(W('personas.jsonl'), out.map((p) => JSON.stringify(p)).join('\n') + '\n');
  saveConfig({
    personas: {
      dataset: HF_DATASET, revision: parquetDir ? (parquetDir.split('/').pop()) : meta.sha, source: parquetDir ? 'parquet' : 'datasets-server', license: meta.cardData?.license ?? 'cc-by-4.0', total_rows: total, seed, n, age_quotas: AGE_QUOTAS.map((q, i) => ({ ...q, count: quota[i] })),
      offsets_tried: cursor, skipped_by_age_quota: rejected.length, file_sha256: sha256(readFileSync(W('personas.jsonl'), 'utf8')),
    },
  });
  console.log(`personas.jsonl ${out.length}명 · 나이 정원 ${AGE_QUOTAS.map((q, i) => `${q.from}~${q.to}세 ${filled[i]}`).join(' · ')} (정원 밖·초과 건너뜀 ${rejected.length}) · revision ${meta.sha.slice(0, 12)}`);
}

// ---------- items ----------
// --md: 검수 끝난 문항 md(쉼표로 여러 개). 형식은 simulation/examples/demo-items.md 참고. --log 를 주면 생성로그 CSV 의 정답 열과 md 의 볼드 정답을 대조한다.
// --review-csv: 사람 검수 판정 CSV(item_id·판정 열, append-only). '기각' 판정 문항은 제외한다. 주지 않으면 판정 필터 없음.
function itemsStage() {
  if (!opt.md) throw new Error('--md <문항 md>[,<md> …] 필수 (예: simulation/examples/demo-items.md)');
  const lot = String(opt.lot ?? 'custom');
  const mdFiles = String(opt.md).split(',').map((f) => resolve(f.trim()));
  for (const f of mdFiles) if (!existsSync(f)) throw new Error(`${rel(f)} 없음`);
  const all = mdFiles.flatMap((f) => parseLotMarkdown(readFileSync(f, 'utf8')));
  if (!all.length) throw new Error(`${mdFiles.map(rel).join(', ')} 에서 문항을 못 읽었다`);
  const logPath = opt.log ? resolve(opt.log) : null;
  const keyMismatch = logPath && existsSync(logPath) ? checkKeysAgainstLog(all, readFileSync(logPath, 'utf8')) : [];
  if (keyMismatch.length) throw new Error(`md 정답 ≠ 생성로그 정답: ${keyMismatch.join(', ')} — 한쪽만 고쳐졌다`);
  if (!logPath) console.log("참고: --log 없음 — 생성로그 정답 대조 생략(md 안 볼드 정답과 '> 모형' 줄 정답 대조만)");
  const exclude = opt.exclude ? parseExcludeList(readFileSync(resolve(opt.exclude), 'utf8')) : new Set();
  const reviewPath = !opt['review-csv'] || opt['review-csv'] === 'none' ? null : resolve(opt['review-csv']);
  const review = reviewPath && existsSync(reviewPath) ? reviewStatus(readFileSync(reviewPath, 'utf8')) : new Map();
  const rejectedIds = new Set([...review].filter(([, v]) => v === '기각').map(([id]) => id));
  for (const id of rejectedIds) exclude.add(id);
  if (review.size) {
    const ids = new Set(all.map((i) => i.item_id));
    const onlyCsv = [...review.keys()].filter((id) => !ids.has(id));
    const onlyMd = [...ids].filter((id) => !review.has(id));
    if (onlyCsv.length || onlyMd.length) console.warn(`경고: 문항 md 와 판정 CSV 표본이 다르다 — CSV 에만 ${onlyCsv.length}(${onlyCsv.slice(0, 5).join(', ')}) · md 에만 ${onlyMd.length}(${onlyMd.slice(0, 5).join(', ')})`);
  }
  const { kept, dropped } = applyExclusions(all, exclude);
  if (existsSync(W('items.json')) && !opt.force) {
    const prev = readJson('items.json');
    if (sha256(JSON.stringify(prev.items)) !== sha256(JSON.stringify(kept))) {
      console.error('items.json 이 이미 있고 문항 집합이 다르다 — 풀이가 시작된 run 의 문항을 바꾸면 안 된다. 새 --run 을 쓰거나 --force');
      process.exit(2);
    }
    console.log('items.json 동일 — 변경 없음'); return;
  }
  writeJson('items.json', { lot, items: kept });
  saveConfig({
    items: {
      lot, parsed: all.length, curated: true, kept: kept.length, excluded: dropped.length, excluded_by_review: rejectedIds.size,
      exclude_file_sha256: opt.exclude ? sha256(readFileSync(resolve(opt.exclude), 'utf8')) : null,
      review_csv: reviewPath && existsSync(reviewPath) ? rel(reviewPath) : null,
      md_sha256: Object.fromEntries(mdFiles.map((f) => [rel(f), sha256(readFileSync(f, 'utf8'))])),
      items_sha256: sha256(JSON.stringify(kept)),
    },
  });
  const perDim = [1, 2, 3, 4, 5].map((d) => `D${d} ${kept.filter((i) => i.dimension === d).length}`).join(' · ');
  console.log(`items.json ${kept.length}/${all.length} (제외 ${dropped.length}, 판정 기각 ${rejectedIds.size}) · ${perDim}`);
}

// ---------- 요청·답 파일 규약 ----------
// 두 단계(문항 확정 전에 인물을 미리 준비한다):
//   profile: req/<id>.persona.md → 에이전트가 ans/<id>.profile.md (지식 상태 서술) → absorb-profiles 가 profiles.json 으로 동결
//   solve:   req/<id>.items.md (인물 + 동결된 지식 상태 + 문항) → 에이전트가 ans/<id>.answers.md → absorb
// 불량 답은 rejected/<id>.<kind>.<k>.md 로 옮겨 다음 실행이 다시 푼다(단계별 최대 3회).
const REQ = () => W('req');
const ANS = () => W('ans');
const REJ = () => W('rejected');
const files = (id) => ({
  persona: join(REQ(), `${id}.persona.md`), items: join(REQ(), `${id}.items.md`), rateReq: join(REQ(), `${id}.rate.md`),
  profile: join(ANS(), `${id}.profile.md`), answers: join(ANS(), `${id}.answers.md`), rating: join(ANS(), `${id}.rate.md`),
});
const attemptsOf = (id, kind) => (existsSync(REJ()) ? readdirSync(REJ()).filter((f) => f.startsWith(`${id}.${kind}.`) && f.endsWith('.why.txt')).length : 0);
function reject(id, kind, reasons) {
  mkdirSync(REJ(), { recursive: true });
  const k = attemptsOf(id, kind) + 1;
  renameSync(files(id)[kind], join(REJ(), `${id}.${kind}.${k}.md`));
  writeFileSync(join(REJ(), `${id}.${kind}.${k}.why.txt`), reasons.join('\n') + '\n');
  return k;
}
const loadOr = (f, dflt) => (existsSync(W(f)) ? readJson(f) : dflt);
// 흡수 잠금 — 묶음(shard) 워크플로 여러 개가 동시에 끝나면 흡수가 겹쳐 results/profiles 를 서로 덮어쓰거나 같은 불량 답을 두 번 옮긴다.
// mkdir 은 원자적이라 잠금으로 쓴다. 10분 넘은 잠금은 죽은 프로세스의 잔재로 보고 걷어 낸다.
function withLock(fn) {
  const lock = W('.absorb.lock');
  const t0 = Date.now();
  for (;;) {
    try { mkdirSync(lock); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - statSync(lock).mtimeMs > 600000) { rmdirSync(lock); continue; } } catch {}
      if (Date.now() - t0 > 300000) throw new Error('흡수 잠금 대기 5분 초과 — 다른 흡수가 도는지 확인');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
  }
  try { return fn(); } finally { rmdirSync(lock); }
}
function pendingList(kind) {
  const plan = loadOr('plan.json', {});
  if (kind === 'rate') {
    const ratings = loadOr('ratings.json', {});
    return Object.keys(plan).sort()
      .filter((id) => existsSync(files(id).rateReq) && !ratings[id] && !existsSync(files(id).rating) && attemptsOf(id, 'rating') < MAX_ATTEMPTS)
      .map((id) => ({ id, request: files(id).rateReq, answer: files(id).rating, model: plan[id].model, items_count: 0, attempt: attemptsOf(id, 'rating') + 1 }));
  }
  if (kind === 'profile') {
    const profiles = loadOr('profiles.json', {});
    return Object.keys(plan).sort()
      .filter((id) => existsSync(files(id).persona) && !profiles[id] && !existsSync(files(id).profile) && attemptsOf(id, 'profile') < MAX_ATTEMPTS)
      .map((id) => ({ id, request: files(id).persona, answer: files(id).profile, model: plan[id].model, items_count: 0, attempt: attemptsOf(id, 'profile') + 1 }));
  }
  const results = loadOr('results.json', {});
  return Object.keys(plan).sort()
    .filter((id) => plan[id].items && !results[id] && !existsSync(files(id).answers) && attemptsOf(id, 'answers') < MAX_ATTEMPTS)
    .map((id) => ({ id, request: files(id).items, answer: files(id).answers, model: plan[id].model, items_count: plan[id].items, attempt: attemptsOf(id, 'answers') + 1 }));
}

// ---------- prep: 수준 배정 + 인물 파일 (문항 불필요) ----------
function prepStage() {
  need('personas.jsonl', 'personas');
  const personas = readJsonl('personas.jsonl');
  const cfg = config();
  const seed = Number(opt.seed ?? cfg.personas?.seed ?? 600);
  const models = String(opt.models ?? cfg.prep?.models?.join(',') ?? 'sonnet').split(',').map((x) => x.trim());
  for (const m of models) if (!MODELS.includes(m)) throw new Error(`--models 는 ${MODELS.join('|')} 중`);
  if (cfg.prep && cfg.prep.models.join() !== models.join()) { console.error('이 run 은 이미 다른 모델로 준비됐다 — 새 --run 을 써라'); process.exit(2); }
  const mode = opt.dims ? 'dims' : (cfg.prep?.mode ?? 'single');
  if (cfg.prep && (cfg.prep.mode ?? 'single') !== mode) { console.error('이 run 은 이미 다른 방식으로 준비됐다 — 새 --run 을 써라'); process.exit(2); }
  const plan = loadOr('plan.json', {});
  mkdirSync(REQ(), { recursive: true });
  let made = 0;
  for (const p of personas) {
    if (plan[p.syn_id]) continue;
    // 수준 = 나이대 이용률 통계 규칙(에이전트가 못 바꾼다) · 모델 = 인물 id 해시 — 인물 수가 늘어도 기존 배정이 안 바뀐다
    const level = assignLevel(p.age, `${seed}|${p.hf_uuid}`);
    // dims: 먼저 영역 관련성 평정(인물 파일은 평정 흡수 뒤 차원 수준과 함께 쓴다)
    if (mode === 'dims') writeFileSync(files(p.syn_id).rateReq, renderRateRequest(p));
    else writeFileSync(files(p.syn_id).persona, renderPersonaRequest(p, level));
    plan[p.syn_id] = { level, model: models[Math.floor(unitHash(`model|${seed}|${p.syn_id}`) * models.length)], prompt: [mode === 'dims' ? RATE_PROMPT_VER : PROFILE_PROMPT_VER] };
    made += 1;
  }
  writeJson('plan.json', plan);
  saveConfig({ prep: {
    seed, models, mode, profile_prompt: mode === 'dims' ? dimsPromptVer(!opt['no-general'], opt.areas === 'official').profile : PROFILE_PROMPT_VER,
    ...(mode === 'dims' ? { general: !opt['no-general'], areas: opt.areas === 'official' ? 'official' : 'custom' } : {}),
    level_rule: { source: '과기정통부 2025 인터넷이용실태조사 연령대별 생성형 AI 경험률(50대 보간)', rates: AI_USE_RATE_BY_AGE, user_split: USER_LEVEL_SPLIT },
    ...(mode === 'dims' ? { dim_rule: { formula: '차원 수준 = 전반 수준(0~4) + 영역 관련성 평정(-1/0/+1, 인물 정보 인용) + 개인 편차(시드, 각 1/3) → 0~4 로 자름', deviation: DIM_DEVIATION, rate_prompt: RATE_PROMPT_VER, areas: AREAS } } : {}),
  } });
  const lv = Object.values(plan).reduce((m, x) => ({ ...m, [x.level]: (m[x.level] ?? 0) + 1 }), {});
  console.log(`수준 배정 ${['never', 'tried', 'sometimes', 'often', 'daily'].map((k) => `${k} ${lv[k] ?? 0}`).join(' · ')}`);
  console.log(mode === 'dims' ? `평정 요청 ${made}명분 새로 씀 · 평정 대기 ${pendingList('rate').length}` : `인물 파일 ${made}명분 새로 씀 · 지식 상태 대기 ${pendingList('profile').length}`);
}

// ---------- fork: 같은 인물로 다른 조건 run 을 만든다(파일럿 비교) ----------
// --from 의 인물(--n 이면 전반 수준 비율대로 층화 추출)을 같은 syn_id 로 복사. 원본이 dims 로 준비됐으면 평정·차원 수준·지식 상태도 복사해 풀이 조건만 달리한다.
function forkStage() {
  const from = opt.from;
  if (!from || !/^[a-z0-9-]{1,16}$/.test(from)) throw new Error('--from <run> 필수');
  if (existsSync(W('personas.jsonl'))) { console.error(`${run} 은 이미 있다 — 새 --run 을 써라`); process.exit(2); }
  const SRC = resolve(join(ROOT, 'runs', from));
  const sj = (f) => JSON.parse(readFileSync(join(SRC, f), 'utf8'));
  const sx = (f) => existsSync(join(SRC, f));
  const srcCfg = sj('config.json');
  const srcPlan = sj('plan.json');
  let personas = readFileSync(join(SRC, 'personas.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  if (opt.n) {
    const n = Number(opt.n);
    const byLevel = {};
    for (const p of personas) (byLevel[srcPlan[p.syn_id].level] ??= []).push(p);
    const levels = Object.keys(byLevel).sort();
    const exact = levels.map((l) => (byLevel[l].length / personas.length) * n);
    const take = exact.map(Math.floor);
    levels.map((l, i) => [i, exact[i] - take[i]]).sort((a, b) => b[1] - a[1]).slice(0, n - take.reduce((a, b) => a + b, 0)).forEach(([i]) => { take[i] += 1; });
    personas = levels.flatMap((l, i) => [...byLevel[l]].sort((a, b) => unitHash(`fork|${run}|${a.syn_id}`) - unitHash(`fork|${run}|${b.syn_id}`)).slice(0, take[i]))
      .sort((a, b) => (a.syn_id < b.syn_id ? -1 : 1));
  }
  const ids = new Set(personas.map((p) => p.syn_id));
  mkdirSync(WORK, { recursive: true });
  writeFileSync(W('personas.jsonl'), personas.map((p) => JSON.stringify(p)).join('\n') + '\n');
  const pick = (obj) => Object.fromEntries(Object.entries(obj).filter(([k]) => ids.has(k)));
  const copyDims = srcCfg.prep?.mode === 'dims';
  if (copyDims) {
    if (!sx('profiles.json') || Object.keys(pick(sj('profiles.json'))).length !== ids.size) { console.error(`${from} 의 지식 상태가 다 고정되지 않았다`); process.exit(2); }
    writeJson('plan.json', Object.fromEntries(Object.entries(pick(srcPlan)).map(([k, b]) => [k, { level: b.level, model: b.model, dims: b.dims, noise: b.noise, prompt: b.prompt.slice(0, 2) }])));
    writeJson('ratings.json', pick(sj('ratings.json')));
    writeJson('profiles.json', pick(sj('profiles.json')));
  }
  writeJson('config.json', {
    study: STUDY, script_version: SCRIPT_VERSION, run, personas: srcCfg.personas,
    ...(copyDims ? { prep: srcCfg.prep } : {}),
    fork: { from, n: ids.size, misconceptions: Boolean(opt.misconceptions), ids_sha256: sha256([...ids].sort().join(',')) },
  });
  const lv = Object.values(pick(srcPlan)).reduce((m, x) => ({ ...m, [x.level]: (m[x.level] ?? 0) + 1 }), {});
  console.log(`${from} → ${run}: 인물 ${ids.size}명(${['never', 'tried', 'sometimes', 'often', 'daily'].map((k) => `${k} ${lv[k] ?? 0}`).join(' · ')})${copyDims ? ' · 평정·차원 수준·지식 상태 복사' : ''}${opt.misconceptions ? ' · 풀이에 착각 목록 사용' : ''}`);
}

// ---------- absorb-rates: 영역 관련성 평정 → 차원 수준 → 영역별 인물 파일 ----------
function absorbRatesStage() {
  need('plan.json', 'prep --dims');
  const plan = readJson('plan.json');
  const personas = new Map(readJsonl('personas.jsonl').map((p) => [p.syn_id, p]));
  const ratings = loadOr('ratings.json', {});
  const seed = Number(config().prep.seed);
  const general = config().prep.general !== false;
  const official = config().prep.areas === 'official';
  let ok = 0; let bad = 0;
  for (const id of Object.keys(plan).sort()) {
    if (ratings[id] || !existsSync(files(id).rating)) continue;
    const r = parseRateAnswer(readFileSync(files(id).rating, 'utf8'), personas.get(id));
    if (r.errors.length) {
      const k = reject(id, 'rating', r.errors);
      bad += 1;
      console.log(`  ${id}: 불량(${k}/${MAX_ATTEMPTS}) ${r.errors.join(' / ')}`);
      continue;
    }
    const { levels, noise } = dimLevels(plan[id].level, r.ratings, `${seed}|${personas.get(id).hf_uuid}`);
    ratings[id] = { ratings: r.ratings, evidence: r.evidence, prompt: RATE_PROMPT_VER };
    plan[id].dims = levels; plan[id].noise = noise; plan[id].prompt = [RATE_PROMPT_VER, dimsPromptVer(general, official).profile];
    writeFileSync(files(id).persona, renderPersonaDimsRequest(personas.get(id), plan[id].level, levels, { general, official }));
    ok += 1;
  }
  writeJson('ratings.json', ratings);
  writeJson('plan.json', plan);
  const done = Object.keys(ratings).filter((id) => plan[id]);
  const dist = AREAS.map((a, i) => `영역${a.dim} ${[-1, 0, 1].map((v) => done.filter((id) => ratings[id].ratings[i] === v).length).join('/')}`).join(' · ');
  console.log(`평정 흡수 +${ok} (불량 ${bad}) · 고정 ${done.length}/${Object.keys(plan).length} · 평정 대기 ${pendingList('rate').length} · 지식 상태 대기 ${pendingList('profile').length}`);
  if (done.length) console.log(`  관련성 -1/0/+1: ${dist}`);
}

function absorbProfilesStage() {
  need('plan.json', 'prep');
  const plan = readJson('plan.json');
  const profiles = loadOr('profiles.json', {});
  let ok = 0; let bad = 0;
  for (const id of Object.keys(plan).sort()) {
    if (profiles[id] || !existsSync(files(id).profile)) continue;
    const text = readFileSync(files(id).profile, 'utf8');
    const dims = plan[id].dims;
    const pr = dims ? parseDimProfileAnswer(text, id, dims) : parseProfileAnswer(text, [id]);
    if (pr.errors.length) {
      const k = reject(id, 'profile', pr.errors);
      bad += 1;
      console.log(`  ${id}: 불량(${k}/${MAX_ATTEMPTS}) ${pr.errors.join(' / ')}`);
      continue;
    }
    profiles[id] = dims ? { ...pr.profile, dims, model: plan[id].model, prompt: dimsPromptVer(config().prep.general !== false, config().prep.areas === 'official').profile } : { ...pr.profiles[id], model: plan[id].model, prompt: PROFILE_PROMPT_VER };
    ok += 1;
  }
  writeJson('profiles.json', profiles);
  const vals = Object.values(profiles);
  const dist = (k) => Object.entries(vals.reduce((m, r) => ({ ...m, [r[k]]: (m[r[k]] ?? 0) + 1 }), {})).sort().map(([a, c]) => `${a}:${c}`).join(' ');
  console.log(`지식 상태 흡수 +${ok} (불량 ${bad}) · 고정 ${vals.length}/${Object.keys(plan).length} · 대기 ${pendingList('profile').length}`);
  if (vals.length) console.log(`  app_persona ${dist('app_persona')} · employment ${dist('employment')}`);
}

// ---------- plan: 문항 파일 (문항 확정 뒤) ----------
function planStage() {
  need('plan.json', 'prep'); need('items.json', 'items'); need('profiles.json', 'absorb-profiles');
  const personas = readJsonl('personas.jsonl');
  const { items } = readJson('items.json');
  const profiles = readJson('profiles.json');
  const plan = readJson('plan.json');
  const cfg = config();
  const seed = Number(cfg.prep?.seed ?? cfg.personas?.seed ?? 600);
  const anchorsPerFamily = Number(opt.anchors ?? cfg.solve?.anchors ?? 1);
  const rotatePerFamily = Number(opt.rotate ?? cfg.solve?.rotate ?? 2);
  if (cfg.solve && (cfg.solve.anchors !== anchorsPerFamily || cfg.solve.rotate !== rotatePerFamily || cfg.solve.items_sha256 !== cfg.items.items_sha256)) {
    console.error('이 run 에 이미 다른 설정(배정·문항)으로 풀이 계획이 있다 — 같은 run 안에서 바꾸면 응답이 섞인다. 새 --run 을 써라'); process.exit(2);
  }
  const missing = personas.filter((p) => !profiles[p.syn_id]);
  if (missing.length && !opt['allow-missing-profiles']) {
    console.error(`지식 상태가 고정되지 않은 인물 ${missing.length}명 — profile 단계를 끝내라(그 인물을 빼고 가려면 --allow-missing-profiles)`); process.exit(2);
  }
  // 배정은 인물 전체로 한 번에 계산한다 — 회전 줄이 인물 순서로 돌아서, 인물 목록이 같으면 결과도 같다.
  const assignment = buildAssignment(items, personas.map((p) => p.syn_id), { seed, anchorsPerFamily, rotatePerFamily });
  const shown = new Set(Object.values(assignment.perPersona).flat());
  const unshown = items.filter((i) => !shown.has(i.item_id)).map((i) => i.item_id);
  // 검수 끝난 문항 표본(curated)은 한 문항도 버리면 안 된다 — 아무에게도 안 나가는 문항이 있으면 멈춘다.
  if (unshown.length && cfg.items.curated) {
    console.error(`아무에게도 안 나가는 표본 문항 ${unshown.length}개: ${unshown.slice(0, 8).join(', ')}${unshown.length > 8 ? ' …' : ''} — --rotate 를 문항모형당 위치 수에 맞게 올려라`);
    process.exit(2);
  }
  const itemById = new Map(items.map((i) => [i.item_id, i]));
  const misconceptions = Boolean(cfg.fork?.misconceptions);
  mkdirSync(REQ(), { recursive: true });  // fork 한 run 은 req/ 가 없다
  const general = cfg.prep?.general !== false;
  const official = cfg.prep?.areas === 'official';
  const solvePrompt = cfg.prep?.mode === 'dims' ? `${dimsPromptVer(general, official).solve}${misconceptions ? '+misconceptions' : ''}` : SOLVE_PROMPT_VER;
  let made = 0;
  for (const p of personas) {
    const b = plan[p.syn_id];
    if (!profiles[p.syn_id] || b.items) continue;
    const order = assignment.perPersona[p.syn_id];
    writeFileSync(files(p.syn_id).items, renderItemsRequest(p, b.level, profiles[p.syn_id], order.map((id) => itemById.get(id)), { seed, misconceptions, general, official }));
    b.items = order.length;
    b.prompt = profiles[p.syn_id].areas ? [RATE_PROMPT_VER, dimsPromptVer(general, official).profile, solvePrompt] : [PROFILE_PROMPT_VER, SOLVE_PROMPT_VER];
    made += 1;
  }
  writeJson('plan.json', plan);
  writeJson('assignment.json', assignment);
  saveConfig({ solve: { anchors: anchorsPerFamily, rotate: rotatePerFamily, seed, prompt: solvePrompt, items_sha256: cfg.items.items_sha256, anchors_n: assignment.anchors.length } });
  const exposure = new Map();
  for (const ids of Object.values(assignment.perPersona)) for (const id of ids) exposure.set(id, (exposure.get(id) ?? 0) + 1);
  const rot = [...exposure].filter(([id]) => !assignment.anchors.includes(id)).map(([, c]) => c);
  console.log(`문항 파일 ${made}명분 새로 씀 · 1인 ${assignment.perPersona[personas[0].syn_id].length}문항(앵커 ${assignment.anchors.length}) · 회전 문항 ${rot.length}/${items.length - assignment.anchors.length}개${rot.length ? ` 노출 ${Math.min(...rot)}~${Math.max(...rot)}회` : ''} · 풀이 대기 ${pendingList('solve').length}`);
}

// ---------- absorb: 풀이 답 ----------
function absorbStage() {
  need('plan.json', 'plan');
  const plan = readJson('plan.json');
  const results = loadOr('results.json', {});
  let ok = 0; let bad = 0;
  for (const [id, b] of Object.entries(plan)) {
    if (results[id] || !b.items || !existsSync(files(id).answers)) continue;
    const an = parseSolveAnswer(readFileSync(files(id).answers, 'utf8'), id, b.items);
    if (an.errors.length) {
      const k = reject(id, 'answers', an.errors);
      bad += 1;
      console.log(`  ${id}: 불량(${k}/${MAX_ATTEMPTS}) ${an.errors.slice(0, 4).join(' / ')}${an.errors.length > 4 ? ` 외 ${an.errors.length - 4}` : ''}`);
      continue;
    }
    results[id] = { level: b.level, dists: an.dists, model: b.model, prompt: b.prompt };
    ok += 1;
  }
  writeJson('results.json', results);
  const planned = Object.values(plan).filter((b) => b.items).length;
  const exhausted = Object.keys(plan).filter((id) => plan[id].items && !results[id] && attemptsOf(id, 'answers') >= MAX_ATTEMPTS);
  console.log(`풀이 흡수 +${ok} (불량 ${bad}) · 누적 ${Object.keys(results).length}/${planned}${exhausted.length ? ` · ${MAX_ATTEMPTS}회 실패로 제외 ${exhausted.length}` : ''} · 대기 ${pendingList('solve').length}`);
}

// ---------- emit ----------
function gitSha() {
  try {
    const sha = execSync('git rev-parse HEAD', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const dirty = execSync('git status --porcelain -- simulation', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() !== '';
    return dirty ? `${sha}+dirty` : sha;
  } catch { return 'unknown'; }
}
function emitStage() {
  need('results.json', 'absorb');
  const asOf = opt['as-of'];
  if (!asOf || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new Error('--as-of YYYY-MM-DD 필수 (answered_date 로 들어간다 — 재현을 위해 인자로 받는다)');
  const cfg = config();
  const personas = readJsonl('personas.jsonl');
  const results = readJson('results.json');
  const profiles = readJson('profiles.json');
  const answers = results;
  const { items } = readJson('items.json');
  const assignment = readJson('assignment.json');
  const levels = Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.level]));
  const snap = buildSyntheticSnapshot({ items, personas, profiles, answers, levels, assignment, asOfDate: asOf, seed: cfg.solve.seed });
  const report = buildReport({ detail: snap.detail, respondents: snap.respondents, items, anchors: assignment.anchors });
  const files = { ...snap.files, 'report.md': report.markdown };
  const manifest = {
    study: STUDY, script_version: SCRIPT_VERSION, source: 'synthetic', git_sha: gitSha(), as_of: asOf, run,
    rule: '실응답 파일과 합치지 않는다. user_hash = syn_ 접두, cohort_flag = synthetic, source 열 = synthetic',
    personas: cfg.personas, items: cfg.items, prep: cfg.prep, solve: cfg.solve,
    counts: snap.counts, warnings: report.warnings,
    files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1)).map(([n, c]) => [n, { bytes: Buffer.byteLength(c), sha256: sha256(c) }])),
    attribution: 'Personas: NVIDIA Nemotron-Personas-Korea (CC BY 4.0) — https://huggingface.co/datasets/nvidia/Nemotron-Personas-Korea',
  };
  console.log(`응답 ${snap.counts.output.responses} · 응답자 ${snap.counts.output.respondents} · 문항 ${snap.counts.output.items} · 위치 ${snap.counts.output.positions}`);
  for (const w of report.warnings) console.log(`  경고: ${w}`);
  if (!opt.write) { console.log('dry-run — 쓰려면 --out <dir> --write'); return; }
  if (!opt.out) throw new Error('--write 는 --out <dir> 이 필요하다');
  const out = resolve(opt.out);
  if (existsSync(out) && readdirSync(out).length) throw new Error(`${out} 가 비어 있지 않다 — 동결본 보호, 새 폴더를 써라`);
  mkdirSync(out, { recursive: true });
  for (const [n, c] of Object.entries(files)) writeFileSync(join(out, n), c);
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`→ ${out} (파일 ${Object.keys(files).length + 1}개). CFA: Rscript validation/cfa/run-cfa.R --snapshot ${rel(out)} --level position · IRT: Rscript calibration/irt/run-irt.R --snapshot ${rel(out)}`);
}

// ---------- status ----------
// --stage profile|solve(기본 solve, 지식 상태 대기 남으면 profile) · --limit N · --shard k/m(대기 목록을 m 묶음으로 나눈 k번째 — 워크플로 여러 개를 동시에 띄울 때)
function statusStage() {
  const kind = opt.stage ?? (pendingList('rate').length ? 'rate' : pendingList('profile').length ? 'profile' : 'solve');
  if (!['rate', 'profile', 'solve'].includes(kind)) throw new Error('--stage rate|profile|solve');
  let pending = pendingList(kind);
  if (opt.shard) {
    const [k, m] = String(opt.shard).split('/').map(Number);
    if (!(m >= 1 && k >= 0 && k < m)) throw new Error('--shard k/m (0 ≤ k < m)');
    pending = pending.filter((_, i) => i % m === k);
  }
  if (opt.limit) pending = pending.slice(0, Number(opt.limit));
  const s = {
    run, work: rel(WORK), stage: kind,
    personas: existsSync(W('personas.jsonl')) ? readJsonl('personas.jsonl').length : 0,
    items: existsSync(W('items.json')) ? readJson('items.json').items.length : 0,
    profiles: Object.keys(loadOr('profiles.json', {})).length,
    solve_planned: Object.values(loadOr('plan.json', {})).filter((b) => b.items).length,
    done: Object.keys(loadOr('results.json', {})).length,
    pending,
  };
  if (opt.json) { console.log(JSON.stringify(s)); return; }
  console.log(`run ${run} · ${s.work}\n  인물 ${s.personas} · 지식 상태 고정 ${s.profiles} · 문항 ${s.items} · 풀이 계획 ${s.solve_planned} · 풀이 완료 ${s.done}\n  대기(${kind}) ${pendingList(kind).length}${opt.shard || opt.limit ? ` → 이번 묶음 ${pending.length}` : ''}`);
}

const stages = {
  'fetch-parquet': fetchParquetStage, personas: personasStage, prep: prepStage, fork: forkStage, 'absorb-rates': () => withLock(absorbRatesStage), 'absorb-profiles': () => withLock(absorbProfilesStage),
  items: itemsStage, plan: planStage, absorb: () => withLock(absorbStage), emit: emitStage, status: statusStage,
};
if (!stages[stage]) { console.error(`stage: ${Object.keys(stages).join(' | ')}`); process.exit(2); }
await stages[stage]();
