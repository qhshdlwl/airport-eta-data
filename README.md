# airport-eta-data

토스 미니앱 **공항 언제 갈까**(`airport-eta`)가 읽는 정적 데이터.

- `status.json` — 공항별 구간 소요시간·혼잡도·시간대별 예상 승객·편명 목록
- 30분마다 GitHub Actions가 갱신한다.

## 출처

- 한국공항공사 (공공데이터포털) — 공항 소요시간·혼잡도·일별 예상승객
- 인천국제공항공사 (공공데이터포털) — 승객 예고(출·입국장별)

## 왜 별도 레포인가

앱 레포(private)의 Actions 분을 아끼기 위해서다. 공개 레포는 Actions가 무제한이고,
`raw.githubusercontent.com`이 `Access-Control-Allow-Origin: *`을 주므로 미니앱이 바로 읽을 수 있다.

## 주의

배치가 실패해도 **이전 값을 유지**한다. 빈 값으로 덮으면 앱이 "대기 없음"이라고 틀리게 말한다.
`status.json`의 `problems` 배열에 그날의 실패가 기록된다.
