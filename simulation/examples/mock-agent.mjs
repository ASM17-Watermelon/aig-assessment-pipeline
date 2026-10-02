#!/usr/bin/env node
// 모의 응답기 — LLM 없이 persona-sim 의 배선(요청 파일 → 답 파일 → 흡수 → 스냅샷)을 끝까지 확인하려고 답 파일을 대신 쓴다.
// 답 내용은 결정적 의사 난수이고 연구 데이터가 아니다. 실제 실험은 simulation/workflow/persona-sim.js(Claude Code 워크플로)가 에이전트로 답을 쓴다.
// 지원 단계: profile(단일 수준 판) · solve. 사용: node simulation/examples/mock-agent.mjs --run demo --stage profile|solve
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const run = arg('run', 'demo');
const stage = arg('stage', 'solve');
if (!['profile', 'solve'].includes(stage)) throw new Error('--stage profile|solve');

const status = JSON.parse(execFileSync('node', [join(ROOT, 'simulation/persona-sim.mjs'), 'status', '--run', run, '--stage', stage, '--json'], { cwd: ROOT }).toString());
const u = (key) => parseInt(createHash('sha256').update(key).digest('hex').slice(0, 8), 16) / 2 ** 32;

for (const p of status.pending) {
  const req = readFileSync(p.request, 'utf8');
  if (!req.includes(p.id)) throw new Error(`${p.request}: 인물 id 없음`);
  let body;
  if (stage === 'profile') {
    body = [
      `@persona ${p.id}`, 'app_persona: general', 'employment: emp_none',
      '아는 것: (모의 응답) 배선 확인용 서술이며 연구 데이터가 아니다.',
      '모르는 것: (모의 응답) 배선 확인용 서술이며 연구 데이터가 아니다.',
      '헷갈리기 쉬운 점: (모의 응답) 배선 확인용 서술이며 연구 데이터가 아니다.',
      '문제 푸는 태도: (모의 응답) 배선 확인용 서술이며 연구 데이터가 아니다.',
      '@end',
    ];
  } else {
    body = [`@persona ${p.id}`];
    for (let i = 1; i <= p.items_count; i += 1) {
      const q = `q${String(i).padStart(2, '0')}`;
      const w = ['a', 'b', 'c', 'd'].map((k) => 1 + u(`${p.id}|${q}|${k}`) * 9);
      const s = w.reduce((x, y) => x + y, 0);
      const pct = w.map((x) => Math.floor((x / s) * 100));
      pct[0] += 100 - pct.reduce((x, y) => x + y, 0);
      body.push(`${q} | a=${pct[0]} b=${pct[1]} c=${pct[2]} d=${pct[3]} | 모의 응답`);
    }
    body.push('@end');
  }
  mkdirSync(dirname(p.answer), { recursive: true });
  writeFileSync(p.answer, body.join('\n') + '\n');
}
console.log(`모의 응답 ${status.pending.length}명분 (${stage}) → ans/`);
