# airport-eta-data

토스 미니앱 **공항 언제 갈까**(`airport-eta`)가 읽는 정적 데이터.

- `status.json` — 30분마다. 공항공사 구간 실측·혼잡도, 승객 예고(오늘·내일), 인천 주차·출국장 대기
- `live.json` — 30분마다. 오늘 출발편의 지연·결항·게이트
- `daily.json` — 하루 1회(04:10 KST). 운항 스케줄(편명 조회용), 최근 28일 요일별 승객 프로파일
- `history/process-YYYYMM.csv` — 실측 누적. 앱의 단계별 소요 범위를 보정하는 데 쓴다.

## 배치는 어디서 도나

**GitHub Actions 가 아니라 한국 IP 의 호스트에서 cron 으로 돈다** (`run-batch.sh`).
GitHub 러너(미국)에서는 `apis.data.go.kr` 에 TCP 연결이 안 된다(2026-09-19 `diag` 워크플로로 실측).
`.github/workflows/` 의 fetch·daily 는 수동 실행용으로만 남아 있고 러너에서는 성공하지 못한다.

```
7,37 * * * *  ~/toy_projects/airport-eta-data/run-batch.sh status
10 4 * * *    ~/toy_projects/airport-eta-data/run-batch.sh daily
```

- 인증키: 레포 밖 `~/.config/airport-eta/env` (`DATA_GO_KR_KEY=...`, chmod 600)
- 푸시: 이 레포 전용 배포 키(`~/.ssh/airport_eta_data_deploy`, write)
- 로그: `~/.local/state/airport-eta/batch.log`

## 출처

- 한국공항공사 (공공데이터포털) — 공항 소요시간·혼잡도·일별 예상승객
- 인천국제공항공사 (공공데이터포털) — 승객 예고(출·입국장별)

## 왜 별도 레포인가

앱 레포(private)의 Actions 분을 아끼기 위해서다. 공개 레포는 Actions가 무제한이고,
`raw.githubusercontent.com`이 `Access-Control-Allow-Origin: *`을 주므로 미니앱이 바로 읽을 수 있다.

## 주의

배치가 실패해도 **이전 값을 유지**한다. 빈 값으로 덮으면 앱이 "대기 없음"이라고 틀리게 말한다.
`status.json`의 `problems` 배열에 그날의 실패가 기록된다.
