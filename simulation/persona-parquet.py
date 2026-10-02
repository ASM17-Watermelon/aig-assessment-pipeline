#!/usr/bin/env python3
# Nemotron-Personas-Korea parquet 에서 지정 오프셋의 행을 읽는다 — HF datasets-server 조회 제한(429)을 피하는 경로.
# simulation/persona-sim.mjs personas --parquet-dir 가 부른다. stdin = 오프셋 JSON 배열(전역 행 번호), stdout = 오프셋 순서대로 JSON 한 줄씩.
# 전역 행 번호 = 샤드 00000~00008 을 이름순으로 이어 붙인 순서(datasets-server /rows 의 offset 과 같은 순서).
import json
import sys
from pathlib import Path

import pyarrow.parquet as pq

FIELDS = [
    'uuid', 'persona', 'professional_persona', 'family_persona', 'cultural_background', 'skills_and_expertise',
    'hobbies_and_interests', 'career_goals_and_ambitions', 'sex', 'age', 'marital_status', 'family_type', 'housing_type',
    'education_level', 'bachelors_field', 'occupation', 'district', 'province',
]


def main():
    shard_dir = Path(sys.argv[sys.argv.index('--dir') + 1])
    shards = sorted(shard_dir.glob('train-*-of-*.parquet'))
    if not shards:
        sys.exit(f'{shard_dir} 에 train-*.parquet 없음')
    offsets = json.load(sys.stdin)
    bounds = []
    start = 0
    for s in shards:
        n = pq.ParquetFile(s).metadata.num_rows
        bounds.append((start, start + n, s))
        start += n
    by_shard = {}
    for i, o in enumerate(offsets):
        for lo, hi, s in bounds:
            if lo <= o < hi:
                by_shard.setdefault(s, []).append((i, o - lo))
                break
        else:
            sys.exit(f'오프셋 {o} 가 범위 밖(총 {start}행)')
    out = [None] * len(offsets)
    for s, picks in by_shard.items():
        table = pq.read_table(s, columns=FIELDS).take([local for _, local in picks]).to_pylist()
        for (i, _), row in zip(picks, table):
            out[i] = row
    for o, row in zip(offsets, out):
        print(json.dumps({'offset': o, 'row': row}, ensure_ascii=False))


if __name__ == '__main__':
    main()
