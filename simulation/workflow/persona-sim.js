export const meta = {
  name: 'persona-sim',
  description: '가상 응답자 풀이 — 대기 인물을 에이전트 1명씩 병렬로 돌리고 흡수까지 (stage rate=영역 관련성 평정, profile=지식 상태, solve=풀이 · 재실행하면 남은 인물만)',
  whenToUse: 'simulation/persona-sim.mjs prep(→profile) 또는 plan(→solve) 뒤. args {run, stage, limit, shard}',
  phases: [
    { title: 'List', detail: 'status --json 으로 대기 인물 목록' },
    { title: 'Run', detail: '인물 1명 = 에이전트 1개 (동시 실행은 워크플로당 CPU-2 개)' },
    { title: 'Absorb', detail: '형식 검증·흡수 (불량은 다음 실행에 재시도)' },
  ],
}

// 스크립트는 파일을 못 읽는다 — 대기 목록은 첫 에이전트가 CLI 로 받아 온다. 모델은 plan.json 이 인물마다 정한 값을 그대로 쓴다.
// 동시 실행을 늘리려면 이 워크플로를 shard '0/3'·'1/3'·'2/3' 로 동시에 띄운다(워크플로마다 상한이 따로 걸린다).
const RUN = (args && args.run) || 'r1'
const STAGE = (args && args.stage) || 'solve'
const LIMIT = (args && args.limit) || 100
const SHARD = (args && args.shard) || ''
const CLI = 'node simulation/persona-sim.mjs'
if (!['rate', 'profile', 'solve'].includes(STAGE)) throw new Error(`stage 는 rate|profile|solve (${STAGE})`)

const STATUS = {
  type: 'object',
  properties: {
    stage: { type: 'string' },
    pending: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' }, request: { type: 'string' }, answer: { type: 'string' },
          model: { type: 'string' }, items_count: { type: 'number' }, attempt: { type: 'number' },
        },
        required: ['id', 'request', 'answer', 'model', 'items_count'],
      },
    },
  },
  required: ['stage', 'pending'],
}

phase('List')
const status = await agent(
  `Bash 로 \`${CLI} status --run ${RUN} --stage ${STAGE} --json --limit ${LIMIT}${SHARD ? ` --shard ${SHARD}` : ''}\` 를 실행하고 출력 JSON 의 stage·pending 을 그대로 돌려줘. 다른 일은 하지 마.`,
  { label: 'list', phase: 'List', schema: STATUS, model: 'sonnet', effort: 'low' },
)
if (!status) throw new Error('대기 목록을 못 받았다')
log(`${RUN} · ${STAGE}${SHARD ? ` · 묶음 ${SHARD}` : ''} · 이번 실행 ${status.pending.length}명 (한도 ${LIMIT})`)

const profilePrompt = (p) => `너는 가상 인물 지식 상태 서술 에이전트다. 아래 파일만 다루고 다른 일(코드 수정·검색·커밋·다른 파일 열기)은 하지 마라.

1. Read 로 ${p.request} 를 읽는다. 그 파일에 정해진 수준을 바꾸지 말고, 지시대로 이 인물의 지식 상태를 서술한다.
2. 지정된 형식 그대로 ${p.answer} 에 Write 도구로 저장한다. 파일로 저장해야만 결과로 인정되고, 답을 메시지로 돌려주면 버려진다. 형식 밖의 말(인사·설명·코드 펜스)은 넣지 않는다.
3. 저장이 끝나면 "done ${p.id}" 한 줄만 돌려준다.`

const ratePrompt = (p) => `너는 가상 인물 영역 관련성 평정 에이전트다. 아래 파일만 다루고 다른 일(코드 수정·검색·커밋·다른 파일 열기)은 하지 마라.

1. Read 로 ${p.request} 를 읽고 지시대로 이 인물의 다섯 영역 관련성을 매긴다.
2. 지정된 형식 그대로 ${p.answer} 에 Write 도구로 저장한다. 파일로 저장해야만 결과로 인정되고, 답을 메시지로 돌려주면 버려진다. 형식 밖의 말(인사·설명·코드 펜스)은 넣지 않는다.
3. 저장이 끝나면 "done ${p.id}" 한 줄만 돌려준다.`

const solvePrompt = (p) => `너는 가상 인물 선택 예측 에이전트다. 아래 파일만 다루고 다른 일(코드 수정·검색·커밋·다른 파일 열기)은 하지 마라.

1. Read 로 ${p.request} 를 읽는다. 파일에 적힌 인물과 미리 정해 둔 수준·지식 상태를 바꾸지 않는다.
2. 그 파일의 지시대로 ${p.items_count}문항 전부(q01~q${String(p.items_count).padStart(2, '0')}) 이 인물의 보기별 선택 확률을 예측해 ${p.answer} 에 Write 도구로 저장한다. 파일로 저장해야만 결과로 인정되고, 답을 메시지로 돌려주면 버려진다. 형식 밖의 말(인사·설명·코드 펜스)은 넣지 않는다.
3. 저장이 끝나면 "done ${p.id}" 한 줄만 돌려준다.`

phase('Run')
const done = await parallel(status.pending.map((p) => () =>
  agent(STAGE === 'rate' ? ratePrompt(p) : STAGE === 'profile' ? profilePrompt(p) : solvePrompt(p), { label: `${p.id}·${STAGE}·${p.model}`, phase: 'Run', model: p.model })))
// r300 지식 상태 단계에서 300명 중 29명이 Write 없이 답을 메시지로 돌려줬다 → 그 답을 받아 적는 에이전트로 파일에 옮긴다(형식 검증은 흡수가 한다).
const unwritten = status.pending.map((p, i) => [p, done[i]]).filter(([, r]) => typeof r === 'string' && !/^\s*done\b/.test(r) && /^@end\s*$/m.test(r))
if (unwritten.length) {
  log(`파일 대신 메시지로 답한 ${unwritten.length}명 — 받아 적기: ${unwritten.slice(0, 10).map(([p]) => p.id).join(', ')}${unwritten.length > 10 ? ' …' : ''}`)
  await parallel(unwritten.map(([p, r]) => () => agent(
    `너는 받아 적기 담당이다. 아래 <답> 안의 내용을 한 글자도 바꾸지 말고 Write 도구로 ${p.answer} 에 저장하라. 다른 일은 하지 말고, 끝나면 "done ${p.id}" 한 줄만 돌려준다.\n<답>\n${r.trim()}\n</답>`,
    { label: `${p.id}·받아적기`, phase: 'Run', model: 'sonnet', effort: 'low' })))
}
const failed = status.pending.filter((_, i) => !done[i])
if (failed.length) log(`에이전트 실패 ${failed.length}명(사용량 한도·오류) — 다시 실행하면 이어서 한다: ${failed.slice(0, 10).map((p) => p.id).join(', ')}${failed.length > 10 ? ' …' : ''}`)

phase('Absorb')
// 파일럿에서 Haiku 보조가 명령을 건너뛰고 엉뚱한 답을 냈다 → Sonnet + 출력 스키마로 실행을 강제한다(흡수는 재실행해도 안전).
const ABSORB_CMD = `${CLI} ${{ rate: 'absorb-rates', profile: 'absorb-profiles', solve: 'absorb' }[STAGE]} --run ${RUN}`
const absorbed = await agent(
  `너는 명령 실행기다. 질문에 답하거나 설명하지 말고, Bash 도구로 정확히 이 명령 하나만 실행하라: \`${ABSORB_CMD}\`\n그리고 그 명령의 표준 출력 전문과 종료 코드를 그대로 돌려줘.`,
  { label: 'absorb', phase: 'Absorb', model: 'sonnet', effort: 'low', schema: { type: 'object', properties: { command: { type: 'string' }, exit_code: { type: 'number' }, output: { type: 'string' } }, required: ['command', 'exit_code', 'output'] } },
)
if (!absorbed || absorbed.exit_code !== 0 || !/흡수/.test(absorbed.output)) log(`흡수 확인 필요 — 손으로 실행: ${ABSORB_CMD}`)

return { run: RUN, stage: STAGE, shard: SHARD, attempted: status.pending.length, agent_failures: failed.map((p) => p.id), absorb: absorbed }
