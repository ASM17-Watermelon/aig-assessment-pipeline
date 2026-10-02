# results

`bash scripts/reproduce.sh` 가 `data/` 에서 다시 만든 산출물이다. `expected.json` 은 논문에 쓴 원 산출물에서 뽑은 기준값이고, `node scripts/check-results.mjs` 가 다시 만든 결과와 대조한다(허용 오차 0.001).

| 파일 | 내용 |
|---|---|
| `<run>/cfa_five.json` | 5요인 CFA · 판정 · 1요인(`one`)·D2+D5 병합(`four`) 내포 비교. r300d 는 D1+D5 병합(`merged`) 비교 포함 |
| `r300d/cfa_g15-2-3-4.json` | 4요인 CFA(D1+D5 통합) · 판정 · 1요인 비교 |
| `r300d/irt/` | 4역량 2PL: `irt_items.csv`(위치별 a · b · SE · 부하 · CFA 부하 · S-X2 · 플래그) · `irt_families.csv`(문항모형 단위 b 평균 · SD) · `irt_tif.csv`/`.png`(검사 정보 · 조건부 SE) · `irt_q3_flags.csv` · `irt_summary.json` · `irt_report.md` |
| `r300d/irt5/` | 같은 형식의 5역량 대조 |

CFA JSON 의 `started_at` · `elapsed_sec` 은 실행마다 달라진다. 그 밖의 수치는 같은 R · 패키지 버전에서 원 산출물과 같다.
