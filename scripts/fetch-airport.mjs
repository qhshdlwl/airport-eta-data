// 배치: 공항 소요시간·혼잡도·시간대 예보·운항 스케줄 → public/data/status.json
// 실행: node --env-file-if-exists=.env scripts/fetch-airport.mjs
// 앱은 이 JSON만 읽는다. 인증키는 여기서만 쓴다 (docs/98 7절).
//
// 안전 규칙 (CLAUDE.md 보수적 계산 · 정직성)
//  - 항목 단위로 판단한다. 어떤 공항을 못 읽으면 그 공항만 이전 값을 유지하고 나머지는 갱신한다.
//  - 빈 값으로 덮지 않는다. 빈 값은 앱이 "대기 없음"이라고 틀리게 말하게 만든다.
//  - 응답 모양이 예상과 다르면 조용히 넘어가지 말고 크게 실패한다. 틀린 데이터가 없는 데이터보다 나쁘다.
import { readFile, writeFile } from "node:fs/promises";

const OUT = new URL("../status.json", import.meta.url);
const KEY = process.env.DATA_GO_KR_KEY; // Decoding 키
const KAC = "https://apis.data.go.kr/B551178"; // 한국공항공사
const IIA = "https://apis.data.go.kr/B551177"; // 인천국제공항공사

// api 구분은 src/airports.js 와 같은 기준이다
const KAC_AIRPORTS = [
  { code: "GMP", v: "v1" }, { code: "CJU", v: "v1" },
  { code: "PUS", v: "v2" }, { code: "TAE", v: "v2" }, { code: "CJJ", v: "v2" }
];

if (!KEY) {
  console.error("DATA_GO_KR_KEY 가 없다. .env 또는 Actions secret 을 확인할 것.");
  process.exit(1);
}

const problems = [];
const note = (m) => { problems.push(m); console.warn("  ⚠", m); };

async function getJson(url, { tries = 3 } = {}) {
  let last = "";
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
      const text = await r.text();
      // 공공데이터포털은 에러를 200 + XML 로 주기도 한다
      if (text.trimStart().startsWith("<")) {
        const m = text.match(/<errMsg>([^<]+)<|<returnAuthMsg>([^<]+)</);
        throw new Error(`XML 에러 응답: ${m?.[1] ?? m?.[2] ?? text.slice(0, 120)}`);
      }
      const j = JSON.parse(text);
      const code = j?.response?.header?.resultCode;
      if (code && code !== "00") {
        throw new Error(`resultCode=${code} ${j.response.header.resultMsg ?? ""}`);
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return j;
    } catch (e) {
      last = e.message;
      if (i < tries - 1) await new Promise((ok) => setTimeout(ok, 3000 * (i + 1)));
    }
  }
  throw new Error(last);
}

/** 공공데이터포털 표준 응답에서 item 배열을 꺼낸다. 모양이 다르면 던진다. */
function items(j, where) {
  const it = j?.response?.body?.items;
  if (it == null) throw new Error(`${where}: items 가 없다 — 응답 구조가 바뀌었을 수 있다. 원문: ${JSON.stringify(j).slice(0, 200)}`);
  const arr = Array.isArray(it) ? it : Array.isArray(it.item) ? it.item : it.item ? [it.item] : [];
  return arr;
}

const q = (o) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
const base = { serviceKey: KEY, type: "json", numOfRows: 100, pageNo: 1 };
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

/* ---------- 1. 한국공항공사: 구간별 소요시간 ---------- */
async function fetchProcessTimes() {
  const out = {};
  for (const v of ["v1", "v2"]) {
    try {
      const j = await getJson(`${KAC}/airport-process-time/${v}?${q(base)}`);
      for (const it of items(j, `process-time/${v}`)) {
        const code = it.IATA_APCD;
        if (!code) continue;
        if (String(it.OPR_STS_CD) === "0") continue; // 비운영 시간대는 건너뛴다
        out[code] = {
          a: num(it.STY_TCT_AVG_A), b: num(it.STY_TCT_AVG_B),
          c: num(it.STY_TCT_AVG_C), d: num(it.STY_TCT_AVG_D),
          all: num(it.STY_TCT_AVG_ALL), at: it.PRC_HR ?? null
        };
      }
    } catch (e) { note(`소요시간 ${v} 실패: ${e.message}`); }
  }
  return out;
}

/* ---------- 2. 한국공항공사: 구간별 혼잡도 ---------- */
async function fetchCongestion() {
  const out = {};
  for (const v of ["v1", "v2"]) {
    try {
      const j = await getJson(`${KAC}/airport-congestion/${v}?${q(base)}`);
      for (const it of items(j, `congestion/${v}`)) {
        if (!it.IATA_APCD) continue;
        out[it.IATA_APCD] = num(it.CGDR_ALL_LVL);
      }
    } catch (e) { note(`혼잡도 ${v} 실패: ${e.message}`); }
  }
  return out;
}

/* ---------- 3. 한국공항공사: 시간대별 예상 승객 (김포·김해·제주) ---------- */
async function fetchKacForecast() {
  const out = {};
  try {
    const j = await getJson(`${KAC}/airport-daily-expect-passenger/info?${q({ ...base, numOfRows: 500 })}`);
    for (const it of items(j, "daily-expect-passenger")) {
      const code = (it.ARP ?? "").trim();
      const hh = String(it.HH ?? "").padStart(2, "0");
      const pax = num(it.PCT);
      if (!code || !hh || pax == null) continue;
      if (String(it.AOD ?? "D") !== "D") continue; // 출발만
      out[code] ??= { hourly: {} };
      out[code].hourly[hh] = (out[code].hourly[hh] ?? 0) + pax;
    }
  } catch (e) { note(`일별 예상승객 실패: ${e.message}`); }
  return out;
}

/* ---------- 4. 인천: 시간대별 승객 예고 (당일 + 익일) ---------- */
async function fetchIcnForecast() {
  try {
    const j = await getJson(`${IIA}/passgrAnncmt/getPassgrAnncmt?${q({ ...base, numOfRows: 200 })}`);
    const hourly = {};
    const byDate = {};
    for (const it of items(j, "passgrAnncmt")) {
      const hh = String(it.atime ?? "").slice(0, 2);
      if (!/^\d\d$/.test(hh)) continue;
      // 출국장 합계만 쓴다(이 앱은 나가는 사람용)
      const dep = (num(it.t1dgsum1) ?? 0) + (num(it.t2dgsum2) ?? 0);
      if (!dep) continue;
      const d = String(it.adate ?? "");
      byDate[d] ??= {};
      byDate[d][hh] = dep;
    }
    // 오늘(가장 이른 날짜)을 기본 hourly 로 쓴다
    const dates = Object.keys(byDate).sort();
    if (dates.length) Object.assign(hourly, byDate[dates[0]]);
    if (!Object.keys(hourly).length) throw new Error("출국장 합계가 비어 있다");
    return { ICN: { hourly, byDate } };
  } catch (e) { note(`인천 승객예고 실패: ${e.message}`); return {}; }
}

/* ---------- 5. 운항 스케줄 → 편명 조회용 ---------- */
async function fetchFlights() {
  // TODO(키 발급 후 1회): 실제 응답 필드명을 확인해 매핑을 확정할 것.
  //   한국공항공사 15158949 / 인천 15095059 는 파라미터·필드가 문서에만 있다.
  //   확정 전까지는 기존 목록을 유지한다(빈 배열로 덮지 않는다).
  note("운항 스케줄 매핑 미확정 — 편명 목록은 이전 값을 유지한다");
  return null;
}

/* ---------- 실행 ---------- */
const prev = JSON.parse(await readFile(OUT, "utf8").catch(() => '{"airports":{},"forecast":{},"flights":[]}'));

const [proc, cong, kacFc, icnFc, flights] = await Promise.all([
  fetchProcessTimes(), fetchCongestion(), fetchKacForecast(), fetchIcnForecast(), fetchFlights()
]);

const airports = { ...prev.airports };
for (const { code } of KAC_AIRPORTS) {
  const p = proc[code] ?? prev.airports?.[code]?.process ?? null;
  const c = cong[code] ?? prev.airports?.[code]?.congestion ?? null;
  const hourly = (kacFc[code] ?? prev.forecast?.[code])?.hourly ?? null;
  // baselinePax = 지금 시각의 예상 승객 = 실측 소요시간이 찍힌 조건
  const nowHH = String(new Date().getHours()).padStart(2, "0");
  airports[code] = { process: p, congestion: c, baselinePax: hourly?.[nowHH] ?? prev.airports?.[code]?.baselinePax ?? null };
}
{
  const hourly = (icnFc.ICN ?? prev.forecast?.ICN)?.hourly ?? null;
  const nowHH = String(new Date().getHours()).padStart(2, "0");
  airports.ICN = {
    process: null, // 인천은 실측 API 없음 — SPEC 커버리지 표 참조
    congestion: prev.airports?.ICN?.congestion ?? null,
    baselinePax: hourly?.[nowHH] ?? prev.airports?.ICN?.baselinePax ?? null
  };
}

const out = {
  updatedAt: new Date().toISOString(),
  airports,
  forecast: { ...prev.forecast, ...kacFc, ...icnFc },
  flights: flights ?? prev.flights ?? [],
  problems: problems.length ? problems : undefined
};

// 전부 실패했으면 아무것도 쓰지 않는다
const gotSomething = Object.keys(proc).length || Object.keys(cong).length
  || Object.keys(kacFc).length || Object.keys(icnFc).length;
if (!gotSomething) {
  console.error("전부 실패했다. 이전 데이터를 유지하고 종료한다.");
  process.exit(1);
}

await writeFile(OUT, JSON.stringify(out, null, 2) + "\n");
console.log(`저장: 소요시간 ${Object.keys(proc).length}곳 · 혼잡도 ${Object.keys(cong).length}곳 · 예보 ${Object.keys({ ...kacFc, ...icnFc }).length}곳`);
if (problems.length) console.log(`문제 ${problems.length}건 — status.json 의 problems 참조`);
