#!/usr/bin/env bash
# 공개 응답 스냅샷(data/) → CFA 게이트 → IRT 보정을 다시 돌리고, 논문 수치(results/expected.json)와 대조한다.
#   bash scripts/reproduce.sh                 # results/ 에 다시 쓴다(커밋된 결과를 덮어씀)
#   OUT=/tmp/aig bash scripts/reproduce.sh    # 다른 폴더에 쓰고 대조만
#   SKIP_INSTALL=1 bash scripts/reproduce.sh  # R 패키지가 이미 있으면 설치 단계를 건너뜀
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${OUT:-results}"
RUNS=(r300 r300b r300c r300d)

step() { printf '\n== %s\n' "$*"; }
t0=$(date +%s)

if [ "${SKIP_INSTALL:-0}" != 1 ]; then
  step "R 패키지 설치 (CRAN 2026-09-01 스냅샷)"
  Rscript validation/cfa/install.R
  Rscript calibration/irt/install.R
fi

step "단위 테스트 (Node, 의존성 없음)"
node --test --test-reporter=dot simulation/*.test.mjs validation/cfa/*.test.mjs

for r in "${RUNS[@]}"; do
  mkdir -p "$OUT/$r"
  extra=()
  [ "$r" = r300d ] && extra=(--compare-groups 1+5,2,3,4)
  step "CFA 5요인 · $r (1요인·병합 모형과 내포 비교)"
  Rscript validation/cfa/run-cfa.R --snapshot "data/$r" --model five --compare true ${extra[@]+"${extra[@]}"} --out "$OUT/$r/cfa_five.json"
done

step "CFA 4요인 · r300d (D1+D5 통합, 1요인과 내포 비교)"
Rscript validation/cfa/run-cfa.R --snapshot data/r300d --groups 1+5,2,3,4 --compare true --out "$OUT/r300d/cfa_g15-2-3-4.json"

step "IRT 2PL · r300d · 4역량"
Rscript calibration/irt/run-irt.R --snapshot data/r300d --groups 1+5,2,3,4 --cfa "$OUT/r300d/cfa_g15-2-3-4.json" --out "$OUT/r300d/irt" > /dev/null
step "IRT 2PL · r300d · 5역량 (대조)"
Rscript calibration/irt/run-irt.R --snapshot data/r300d --groups 1,2,3,4,5 --cfa "$OUT/r300d/cfa_five.json" --out "$OUT/r300d/irt5" > /dev/null

step "논문 수치와 대조"
node scripts/check-results.mjs "$OUT"
printf '\n완료 (%ss)\n' "$(( $(date +%s) - t0 ))"
