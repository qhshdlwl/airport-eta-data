#!/usr/bin/env bash
# 한국 IP 호스트에서 cron 으로 도는 배치 실행기.
#   run-batch.sh status   # 30분마다
#   run-batch.sh daily    # 하루 1회
# GitHub 러너(미국)에서는 apis.data.go.kr 에 연결이 안 되므로 이 스크립트가 실제 운영 경로다.
# 인증키는 레포 밖 ~/.config/airport-eta/env 에 둔다(DATA_GO_KR_KEY=...).
set -uo pipefail
MODE="${1:-status}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${AIRPORT_ETA_ENV:-$HOME/.config/airport-eta/env}"
LOG_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/airport-eta"
LOG="$LOG_DIR/batch.log"
mkdir -p "$LOG_DIR"

# cron 은 PATH 가 비어 있다 — nvm 의 node 를 찾는다
if ! command -v node >/dev/null 2>&1; then
  # shellcheck disable=SC1091
  [ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
fi

# 로그가 2MB 를 넘으면 한 번 돌린다
[ -f "$LOG" ] && [ "$(stat -c%s "$LOG")" -gt 2097152 ] && mv -f "$LOG" "$LOG.1"

exec >>"$LOG" 2>&1
echo "===== $(TZ=Asia/Seoul date '+%F %T') $MODE ====="

# status 와 daily 가 겹치면 같은 레포에 동시에 쓰게 된다 — 한 번에 하나만
exec 9>"$LOG_DIR/lock"
if ! flock -w 600 9; then echo "잠금 대기 시간 초과 — 건너뜀"; exit 0; fi

cd "$HERE" || exit 1
[ -f "$ENV_FILE" ] || { echo "인증키 파일이 없다: $ENV_FILE"; exit 1; }
set -a; . "$ENV_FILE"; set +a

git pull -q --rebase || { echo "pull 실패 — 이번 회차는 건너뜀"; exit 0; }
OUT_DIR="$HERE" LOG_HISTORY=1 node scripts/fetch-airport.mjs "$MODE"
RC=$?
[ $RC -ne 0 ] && echo "배치 종료코드 $RC — 이전 데이터를 유지한다"

git add status.json live.json daily.json history 2>/dev/null
if git diff --cached --quiet; then echo "변경 없음"; exit 0; fi
git commit -q -m "data: $(TZ=Asia/Seoul date '+%F %H:%M') $MODE" && git push -q && echo "푸시 완료" || echo "푸시 실패 — 다음 회차에 같이 올라간다"
