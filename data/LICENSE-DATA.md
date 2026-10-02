# 데이터 이용 조건

`data/` 와 `results/` 의 파일은 저장소 루트의 `LICENSE` 조건을 따른다. 열람과 논문의 수치·절차 확인을 위한 내려받기와 실행만 허용하고, 그 밖의 복제·수정·재배포·다른 산출물에 가져다 쓰기·상업적 이용은 저작권자의 사전 서면 허락 없이 허용하지 않는다.

## 출처 표기

- 응답자 속성(`respondents.csv` 의 나이 · 성별 · 학력 · 직업 · 지역 · `hf_uuid`)은 아래 데이터셋의 합성 페르소나에서 왔다. 실존 인물이 아니다.
  - NVIDIA, **Nemotron-Personas-Korea**, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), https://huggingface.co/datasets/nvidia/Nemotron-Personas-Korea
  - 변경 사항: 100만 명 중 300명을 추출해 위 열만 실었고, 성별은 female/male 로 바꿔 적었으며, `birth_year_band` 는 나이에서 계산했다.
  - 이 속성 값에는 원본의 CC BY 4.0 이 그대로 적용된다. 저장소 `LICENSE` 의 제한은 저자가 만든 부분(가상 응답, 수준 배정, 결과, 코드, 그림, 문서)에만 적용하고, 원본에서 온 값의 조건은 바꾸지 않는다. 원본 전체는 위 주소에서 받을 수 있다.
  - 사용한 판본: `ada0f5b53a38bb5a30cce09358adde883c1ab63a`
- 응답(정답 여부 · 보기 확률 · 선택)은 이 저장소의 `simulation/` 파이프라인이 `claude-sonnet-5-5` 에이전트의 선택 확률 예측에서 결정적 해시로 표집해 만든 가상 응답이다. 실제 사람의 응답이 아니다.

## 포함하지 않은 것

문항 본문(줄기 · 보기 문장)은 실제 측정 문항 노출을 막기 위해 포함하지 않는다. `items.csv` 에는 문항 ID · 문항모형 · 차원 · 정답률 · 본문 해시만 있다.
