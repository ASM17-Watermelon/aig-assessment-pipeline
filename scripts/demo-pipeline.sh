#!/usr/bin/env bash
# 가상 응답 생성 파이프라인 배선 점검 — LLM·문항은행 없이 끝까지 돈다(데모 문항 3개 · 인물 6명 · 모의 응답기).
# 실제 실험은 모의 응답기 대신 Claude Code 워크플로(simulation/workflow/persona-sim.js)가 인물 1명당 에이전트 1개로 답을 쓴다.
#   bash scripts/demo-pipeline.sh                                  # 인물은 HF 조회 API 로 6명(네트워크 필요)
#   PARQUET=runs/_hf/<revision> bash scripts/demo-pipeline.sh      # fetch-parquet 로 받아 둔 원본에서 뽑기
#   RUN=demo2 bash scripts/demo-pipeline.sh                        # 작업 폴더 이름(runs/<RUN>) — 이미 있으면 멈춘다
set -euo pipefail
cd "$(dirname "$0")/.."
RUN="${RUN:-demo}"
CLI="node simulation/persona-sim.mjs"
if [ -e "runs/$RUN" ]; then echo "runs/$RUN 이 이미 있다 — RUN=<새 이름> 으로 다시 실행하라" >&2; exit 2; fi

$CLI personas --run "$RUN" --n 6 ${PARQUET:+--parquet-dir "$PARQUET"}
$CLI prep --run "$RUN"
node simulation/examples/mock-agent.mjs --run "$RUN" --stage profile
$CLI absorb-profiles --run "$RUN"
$CLI items --run "$RUN" --md simulation/examples/demo-items.md --lot demo
$CLI plan --run "$RUN"
node simulation/examples/mock-agent.mjs --run "$RUN" --stage solve
$CLI absorb --run "$RUN"
$CLI emit --run "$RUN" --as-of 2026-10-01 --out "runs/$RUN/out" --write
echo
echo "스냅샷 → runs/$RUN/out (응답 행렬·문항·응답자·리포트). 문항 3개·인물 6명이라 CFA·IRT 는 돌리지 않는다."
