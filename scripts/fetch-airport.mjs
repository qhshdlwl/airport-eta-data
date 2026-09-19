// 배치: 공항 데이터 → 정적 JSON. 앱은 이 JSON만 읽는다. 인증키는 여기서만 쓴다 (docs/98 7절).
//
//   node --env-file-if-exists=.env scripts/fetch-airport.mjs status   # 30분마다 — 실시간·예보·주차
//   node --env-file-if-exists=.env scripts/fetch-airport.mjs daily    # 하루 1회 — 운항 스케줄·요일 프로파일
//   node --env-file-if-exists=.env scripts/fetch-airport.mjs all
//
// 산출물: $OUT_DIR/status.json · live.json(오늘 출발편 지연·게이트) · daily.json  (기본 OUT_DIR = ../public/data)
//
// 안전 규칙 (CLAUDE.md 보수적 계산 · 정직성)
//  - 항목 단위로 실패를 격리한다. 하나를 못 읽으면 그 항목만 이전 값을 유지한다.
//  - 빈 값으로 덮지 않는다. 빈 값은 앱이 "대기 없음"이라고 틀리게 말하게 만든다.
//  - 응답 모양이 예상과 다르면 조용히 넘어가지 않고 problems 에 남긴다.
//
// 2026-09-19 실호출로 확인한 사실 (추측 아님)
//  - airport-process-time v1 과 v2 는 같은 5개 공항 데이터를 준다 → v1 만 부른다.
//  - 구간 정의: A=체크인→신분확인, B=신분확인→보안검색, C=보안검색→탑승, D=탑승→출발. ALL=A+B+C.
//    전부 "국내선"의 "체류시간"이다(줄 길이가 아님). 대구 A=38분인데 공식 혼잡도는 원활이었다.
//  - airport-daily-expect-passenger: schDate=YYYYMMDD, schAirport=GMP. 오늘·내일만 미래, 과거는 2015년부터 전부.
//  - flight-schedule/dom|int: schDate, schDeptCityCode. numOfRows 상한 100 (300 은 HTTP_ERROR).
//  - 인천 passgrAnncmt: selectdate=0(오늘)/1(내일). adate="합계" 행이 섞여 있다.
//  - 미신청 API 는 JSON 으로 returnReasonCode 30 을 준다.
//  - 인천 출국장 혼잡도: 운영이 끝난 출국장도 waitTime 이 그대로(6 등) 찍혀 나온다. operatingTime("06:00~19:00", 미운영은 "")
//    으로 걸러야 한다 — 거르는 일은 앱이 한다("지금"이 언제인지는 앱만 안다).
//  - flight-status/info: schAirCode=GMP, schIOType=O(출발), schFln=KE1007 필터가 된다. 오늘 것만 준다(schDate 는 무시된다).
//    편명에 접미 문자가 붙기도 한다(ZE781A).
import { readFile, writeFile, mkdir, appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const MODE = process.argv[2] ?? "status";
const OUT_DIR = process.env.OUT_DIR
  ? pathToFileURL(process.env.OUT_DIR.replace(/\/?$/, "/"))
  : new URL("../public/data/", import.meta.url);
const KEY = process.env.DATA_GO_KR_KEY;
const KAC = "https://apis.data.go.kr/B551178"; // 한국공항공사
const IIA = "https://apis.data.go.kr/B551177"; // 인천국제공항공사
const KAC_AIRPORTS = ["GMP", "CJU", "PUS", "TAE", "CJJ"];
const KOREAN_AIRPORTS = new Set(["ICN", "GMP", "CJU", "PUS", "TAE", "CJJ", "KWJ", "RSU", "USN", "KPO", "HIN", "KUV", "WJU", "YNY", "MWX"]);

if (!KEY) {
  console.error("DATA_GO_KR_KEY 가 없다. .env 또는 Actions secret 을 확인할 것.");
  process.exit(1);
}
if (!["status", "daily", "all"].includes(MODE)) {
  console.error(`알 수 없는 모드: ${MODE} (status | daily | all)`);
  process.exit(1);
}

const problems = [];
const note = (m) => { problems.push(m); console.warn("  ⚠", m); };
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const pad2 = (n) => String(n).padStart(2, "0");
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

/** KST 기준 날짜 유틸 — 러너는 UTC 다 */
function kstDay(offset = 0) { const d = new Date(Date.now() + 9 * 3600e3); d.setUTCDate(d.getUTCDate() + offset); return d; }
function ymd(d) { return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}`; }

class ApiError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

// 전역 속도 제한: 호출 간 최소 간격. 병렬로 불러도 실제 요청은 이 간격으로 줄을 선다.
// (2026-09-19 실측: 4~5개 병렬이면 LIMITED_NUMBER_OF_SERVICE_REQUESTS_PER_SECOND 에 걸린다)
const MIN_GAP_MS = 220;
let gate = Promise.resolve();
function throttle() {
  const turn = gate.then(() => sleep(MIN_GAP_MS));
  gate = turn.catch(() => {});
  return turn;
}

async function getJson(url, { tries = 4 } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      await throttle();
      const r = await fetch(url, { signal: AbortSignal.timeout(25000) });
      const text = await r.text();
      if (text.trimStart().startsWith("<")) {
        throw new ApiError(`XML 에러 응답 ${text.match(/<errMsg>([^<]+)</)?.[1] ?? text.slice(0, 80)}`, text.match(/<returnReasonCode>(\d+)</)?.[1]);
      }
      const j = JSON.parse(text);
      const gw = j?.OpenAPI_ServiceResponse?.cmmMsgHeader; // 게이트웨이 에러는 이 모양으로 온다
      if (gw) throw new ApiError(`${gw.errMsg} ${gw.returnAuthMsg ?? ""}`.trim(), String(gw.returnReasonCode ?? ""));
      const code = j?.response?.header?.resultCode;
      if (code && code !== "00") throw new ApiError(`resultCode=${code} ${j.response.header.resultMsg ?? ""}`, String(code));
      return j;
    } catch (e) {
      last = e;
      if (e.code === "30" || e.code === "20") break; // 미신청·권한없음은 재시도해도 같다
      const perSecond = /PER_SECOND/.test(e.message ?? "");
      if (i < tries - 1) await sleep((perSecond ? 4000 : 2500) * (i + 1));
    }
  }
  throw last;
}

/** 표준 응답에서 item 배열을 꺼낸다. 인천은 items 가 곧 배열이고, 공항공사는 items.item 이다. */
function itemsOf(j, where) {
  const it = j?.response?.body?.items;
  if (it == null || it === "") return [];
  if (Array.isArray(it)) return it;
  if (Array.isArray(it.item)) return it.item;
  if (it.item) return [it.item];
  throw new Error(`${where}: items 모양이 예상과 다르다 — ${JSON.stringify(it).slice(0, 120)}`);
}

/** 페이지를 끝까지 넘긴다. pageSize 100 은 공항공사 스케줄 API 의 실측 상한이다. */
async function fetchAll(base, params, { pageSize = 100, maxPages = 60, where = base } = {}) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const q = new URLSearchParams({ serviceKey: KEY, type: "json", numOfRows: String(pageSize), pageNo: String(page), ...params });
    const j = await getJson(`${base}?${q}`);
    const rows = itemsOf(j, where);
    out.push(...rows);
    const total = num(j?.response?.body?.totalCount) ?? rows.length;
    if (out.length >= total || rows.length === 0) break;
  }
  return out;
}

/** 실패해도 배치를 멈추지 않는다. 미신청(30)은 문제가 아니라 상태다. */
async function attempt(label, fn, fallback) {
  try { return await fn(); }
  catch (e) {
    if (e.code === "30") note(`${label}: 활용신청 전이라 건너뜀`);
    else note(`${label} 실패: ${e.message}`);
    return fallback;
  }
}

async function readPrev(name) {
  try { return JSON.parse(await readFile(new URL(name, OUT_DIR), "utf8")); } catch { return null; }
}
async function writeOut(name, data) {
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(new URL(name, OUT_DIR), JSON.stringify(data) + "\n");
}

/* ================================================================== status */

async function kacLive() {
  const [proc, cong] = await Promise.all([
    attempt("공항공사 소요시간", () => fetchAll(`${KAC}/airport-process-time/v1`, {}, { where: "process-time" }), null),
    attempt("공항공사 혼잡도", () => fetchAll(`${KAC}/airport-congestion/v1`, {}, { where: "congestion" }), null)
  ]);
  if (!proc && !cong) return null;
  const out = {};
  for (const it of proc ?? []) {
    if (!KAC_AIRPORTS.includes(it.IATA_APCD) || String(it.OPR_STS_CD) === "0") continue;
    out[it.IATA_APCD] = {
      at: it.PRC_HR ?? null,
      sec: { a: num(it.STY_TCT_AVG_A), b: num(it.STY_TCT_AVG_B), c: num(it.STY_TCT_AVG_C), d: num(it.STY_TCT_AVG_D) }
    };
  }
  for (const it of cong ?? []) {
    if (!KAC_AIRPORTS.includes(it.IATA_APCD)) continue;
    (out[it.IATA_APCD] ??= { at: it.PRC_HR ?? null }).lvl = {
      a: num(it.CGDR_A_LVL), b: num(it.CGDR_B_LVL), c: num(it.CGDR_C_LVL), all: num(it.CGDR_ALL_LVL)
    };
  }
  return out;
}

/** 공항공사 예상승객 — 출발(AOD=D)만, 국내(D)/국제(I) 분리. {GMP:{D:{ymd:{HH:pax}},I:{...},busy:{D:{ymd:[HH]}}}} */
function foldKacForecast(rows, into = {}) {
  for (const it of rows) {
    const ap = String(it.ARP ?? "").trim();
    if (!KAC_AIRPORTS.includes(ap) || it.AOD !== "D") continue;
    const line = it.TOF === "I" ? "I" : "D";
    const day = String(it.SDT ?? ""), hh = pad2(it.HH ?? "");
    const pax = num(it.PCT);
    if (!/^\d{8}$/.test(day) || !/^\d\d$/.test(hh) || pax == null) continue;
    const slot = (((into[ap] ??= {})[line] ??= {})[day] ??= {});
    slot[hh] = (slot[hh] ?? 0) + pax;
    if (it.CONGEST_YN === "Y") {
      const b = ((((into[ap].busy ??= {})[line] ??= {})[day]) ??= []);
      if (!b.includes(hh)) b.push(hh);
    }
  }
  return into;
}

async function kacForecast() {
  const out = {};
  let got = 0;
  for (const off of [0, 1]) {
    const day = ymd(kstDay(off));
    const rows = await attempt(`공항공사 예상승객 ${day}`, () =>
      fetchAll(`${KAC}/airport-daily-expect-passenger/info`, { schDate: day }, { where: "expect-passenger" }), null);
    if (rows) { foldKacForecast(rows, out); got += rows.length; }
  }
  return got ? out : null;
}

/** 인천 승객예고 — 출국장 합계를 터미널별로. {T1:{ymd:{HH:pax}},T2:{...}} */
async function icnForecast() {
  const out = { T1: {}, T2: {} };
  let got = 0;
  for (const sel of [0, 1]) {
    const rows = await attempt(`인천 승객예고 +${sel}일`, () =>
      fetchAll(`${IIA}/passgrAnncmt/getPassgrAnncmt`, { selectdate: String(sel) }, { where: "passgrAnncmt" }), null);
    for (const it of rows ?? []) {
      const day = String(it.adate ?? "");
      const hh = String(it.atime ?? "").slice(0, 2);
      if (!/^\d{8}$/.test(day) || !/^\d\d$/.test(hh)) continue; // "합계" 행을 거른다
      (out.T1[day] ??= {})[hh] = num(it.t1dgsum1) ?? 0;
      (out.T2[day] ??= {})[hh] = num(it.t2dgsum2) ?? 0;
      got++;
    }
  }
  return got ? out : null;
}

/** 인천 출국장별 실측 대기 — 활용신청(15148225·15161098) 후 동작. 필드는 포털 명세 기준이며 첫 성공 시 확인할 것. */
async function icnGates() {
  const out = {};
  const calls = [
    ["T1", `${IIA}/statusOfDepartureCongestion/getDepartureCongestion`],
    ["T2", `${IIA}/statusOfDepartureCongestionT2/getDepartureCongestionT2`]
  ];
  for (const [tid, url] of calls) {
    const rows = await attempt(`인천 출국장 혼잡도 ${tid}`, () => fetchAll(url, {}, { where: `gates-${tid}` }), null);
    if (!rows) continue;
    for (const it of rows) {
      const term = it.terminalId === "P03" ? "T2" : it.terminalId === "P01" ? "T1" : tid;
      const wait = num(it.waitTime), len = num(it.waitLength);
      if (!it.gateId || (wait == null && len == null)) continue;
      const list = (out[term] ??= []);
      if (!list.some((g) => g.gate === String(it.gateId))) {
        list.push({ gate: String(it.gateId), wait, len, at: it.occurtime ?? null, open: it.operatingTime ?? null });
      }
    }
  }
  return Object.keys(out).length ? out : null;
}

async function parking() {
  const out = {};
  const icn = await attempt("인천 주차", () => fetchAll(`${IIA}/StatusOfParking/getTrackingParking`, {}, { where: "icn-parking" }), null);
  if (icn?.length) {
    out.ICN = icn.map((it) => ({ name: String(it.floor ?? "").trim(), used: num(it.parking), total: num(it.parkingarea) }))
      .filter((p) => p.name && p.total > 0);
  }
  // 공항공사 주차 혼잡도 — 활용신청(15158689) 후 동작
  const kac = await attempt("공항공사 주차 혼잡도", () => fetchAll(`${KAC}/parking-congestion/info`, {}, { where: "kac-parking" }), null);
  const NAME2CODE = { 김포: "GMP", 제주: "CJU", 김해: "PUS", 대구: "TAE", 청주: "CJJ" };
  for (const it of kac ?? []) {
    const code = Object.entries(NAME2CODE).find(([k]) => String(it.airportKor ?? "").includes(k))?.[1];
    const total = num(it.parkingTotalSpace), used = num(it.parkingOccupiedSpace);
    const lotName = String(it.parkingAirportCodeName ?? "");
    if (!code || !total) continue;
    if (lotName.includes("화물") && !lotName.includes("여객")) continue; // 화물청사·화물주차장은 여객용이 아니다
    (out[code] ??= []).push({ name: String(it.parkingAirportCodeName ?? "").trim(), used, total });
  }
  return Object.keys(out).length ? out : null;
}

/** 실측을 월별 CSV 로 누적한다 — 단계별 소요 범위(src/airports.js BANDS)를 나중에 실데이터로 보정하기 위한 것. */
async function logHistory(live) {
  try {
    const now = kstDay(0);
    const file = new URL(`history/process-${now.getUTCFullYear()}${pad2(now.getUTCMonth() + 1)}.csv`, OUT_DIR);
    await mkdir(new URL("history/", OUT_DIR), { recursive: true });
    const exists = await readFile(file, "utf8").then(() => true, () => false);
    const stamp = `${ymd(now)}T${pad2(now.getUTCHours())}${pad2(now.getUTCMinutes())}`;
    const rows = Object.entries(live).filter(([, v]) => v.sec && v.lvl).map(([ap, v]) =>
      [stamp, ap, v.at ?? "", v.sec.a, v.sec.b, v.sec.c, v.sec.d, v.lvl.a, v.lvl.b, v.lvl.c, v.lvl.all].join(","));
    if (!rows.length) return;
    await appendFile(file, (exists ? "" : "kst,airport,measuredAt,secA,secB,secC,secD,lvlA,lvlB,lvlC,lvlAll\n") + rows.join("\n") + "\n");
  } catch (e) { note(`history 기록 실패: ${e.message}`); }
}

/**
 * 오늘 출발편의 지연·결항·게이트. 행 = [편명, 공항, 예정HHMM, 변경HHMM|null, 게이트|null, 상태, D|I, 터미널|null, 체크인카운터|null]
 * 인천(15112968)은 활용신청이 반영되면 붙는다 — 필드는 포털 명세 기준이며 첫 성공 시 확인할 것.
 */
async function liveFlights() {
  const rows = [];
  for (const ap of KAC_AIRPORTS) {
    const list = await attempt(`실시간 운항 ${ap}`, () =>
      fetchAll(`${KAC}/flight-status/info`, { schAirCode: ap, schIOType: "O" }, { where: "flight-status" }), null);
    for (const it of list ?? []) {
      if (it.airport !== ap || it.io !== "O") continue;
      const no = String(it.airFln ?? "").trim().toUpperCase();
      const std = hhmm(it.std);
      if (!no || !std) continue;
      rows.push([no, ap, std, it.etd ? hhmm(it.etd) : null, it.gate ? String(it.gate).trim() : null,
        String(it.rmkKor ?? "").trim() || null, it.line === "국제" ? "I" : "D", null, null]);
    }
  }
  const today = ymd(kstDay(0));
  const icn = await attempt("인천 실시간 운항", () =>
    fetchAll(`${IIA}/StatusOfPassengerFlightsDeOdp/getPassengerDeparturesDeOdp`, {}, { where: "icn-flight-status" }), null);
  for (const it of icn ?? []) {
    const sch = String(it.scheduleDateTime ?? ""), est = String(it.estimatedDateTime ?? "");
    if (sch.slice(0, 8) !== today) continue;
    const term = { P01: "T1", P02: "T1C", P03: "T2" }[it.terminalid] ?? null; // P02 = 탑승동
    rows.push([String(it.flightId ?? "").trim().toUpperCase(), "ICN", sch.slice(8, 12), est.length >= 12 ? est.slice(8, 12) : null,
      it.gatenumber ? String(it.gatenumber).trim() : null, String(it.remark ?? "").trim() || null,
      it.typeOfFlight === "D" ? "D" : "I", term, it.chkinrange ? String(it.chkinrange).trim() : null]);
  }
  return rows.length ? { date: today, rows } : null;
}

async function runStatus() {
  const prev = (await readPrev("status.json")) ?? {};
  const [live, kfc, ifc, gates, park, flightsNow] = await Promise.all([kacLive(), kacForecast(), icnForecast(), icnGates(), parking(), liveFlights()]);
  if (!live && !kfc && !ifc && !park) {
    console.error("status: 전부 실패했다. 이전 데이터를 유지하고 종료한다.");
    process.exit(1);
  }
  const prevFc = prev.v === 2 ? prev.forecast ?? {} : {};
  const out = {
    v: 2,
    updatedAt: new Date().toISOString(),
    kac: live ?? (prev.v === 2 ? prev.kac : null) ?? {},
    forecast: { ...prevFc, ...(kfc ?? {}), ...(ifc ? { ICN: ifc } : {}) },
    icnGates: gates ?? null, // 실측은 낡으면 해롭다 — 못 읽었으면 이전 값을 끌고 가지 않는다
    parking: park ?? (prev.v === 2 ? prev.parking : null) ?? {},
    problems: problems.length ? [...problems] : undefined
  };
  await writeOut("status.json", out);
  // 운항 현황은 낡으면 해롭다 — 못 읽었으면 빈 목록으로 덮어 "정보 없음"이 되게 한다
  await writeOut("live.json", {
    v: 2, updatedAt: out.updatedAt, date: flightsNow?.date ?? ymd(kstDay(0)),
    cols: ["no", "ap", "std", "etd", "gate", "rmk", "line", "term", "chkin"], rows: flightsNow?.rows ?? []
  });
  if (live && process.env.LOG_HISTORY === "1") await logHistory(live); // 데이터 레포에서만 켠다 — 앱 번들에 CSV 가 섞이면 안 된다
  console.log(`status 저장: 운항 ${flightsNow?.rows.length ?? 0}편 · 실측 ${Object.keys(out.kac).length}곳 · 예보 ${Object.keys(out.forecast).length}곳 · 출국장실측 ${gates ? "있음" : "없음"} · 주차 ${Object.keys(out.parking).length}곳`);
}

/* =================================================================== daily */

const DAYS_KAC_DOM = ["domesticSun", "domesticMon", "domesticTue", "domesticWed", "domesticThu", "domesticFri", "domesticSat"];
const DAYS_KAC_INT = ["internationalSun", "internationalMon", "internationalTue", "internationalWed", "internationalThu", "internationalFri", "internationalSat"];
const DAYS_ICN = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const flags = (it, keys) => keys.map((k) => (it[k] === "Y" ? "Y" : "N")).join("");
const dateOnly = (s) => String(s ?? "").replace(/-/g, "").slice(0, 8);
const hhmm = (s) => { const t = String(s ?? "").replace(/\D/g, "").padStart(4, "0").slice(0, 4); return /^\d{4}$/.test(t) ? t : null; };
const isPax = (it) => !it.flightPurpose || String(it.flightPurpose).includes("여객");

/** 편명 조회용 스케줄. 행 = [편명, 출발공항, D|I, HHMM, 시작ymd, 종료ymd, 일~토 YN 7자, 도착지, 항공사] */
async function schedules() {
  const seen = new Map();
  const put = (row) => { const k = row.slice(0, 7).join("|"); if (row[0] && row[3] && !seen.has(k)) seen.set(k, row); };

  // 1) 공항공사 5개 공항 — 앞으로 7일(=모든 요일)을 조회해 현재 유효한 스케줄만 모은다
  for (let off = 0; off < 7; off++) {
    const day = ymd(kstDay(off));
    await Promise.all(KAC_AIRPORTS.map(async (ap) => {
      const dom = await attempt(`국내선 스케줄 ${ap} ${day}`, () =>
        fetchAll(`${KAC}/flight-schedule/dom`, { schDate: day, schDeptCityCode: ap }, { where: "sched-dom" }), []);
      for (const it of dom) {
        if (it.startcityCode !== ap || !isPax(it)) continue;
        put([String(it.domesticNum ?? "").trim().toUpperCase(), ap, "D", hhmm(it.domesticStartTime),
          dateOnly(it.domesticStdate), dateOnly(it.domesticEddate), flags(it, DAYS_KAC_DOM), it.arrivalcity ?? "", it.airlineKorean ?? ""]);
      }
      const intl = await attempt(`국제선 스케줄 ${ap} ${day}`, () =>
        fetchAll(`${KAC}/flight-schedule/int`, { schDate: day, schDeptCityCode: ap }, { where: "sched-int" }), []);
      for (const it of intl) {
        if (it.cityCode !== ap || it.internationalIoType !== "OUT" || !isPax(it)) continue;
        put([String(it.internationalNum ?? "").trim().toUpperCase(), ap, "I", hhmm(it.internationalTime),
          dateOnly(it.internationalStdate), dateOnly(it.internationalEddate), flags(it, DAYS_KAC_INT), it.airport ?? "", it.airlineKorean ?? ""]);
      }
    }));
  }

  // 2) 인천 — 시즌 전체를 한 번에 준다
  const icn = await attempt("인천 정기운항편", () =>
    fetchAll(`${IIA}/PaxFltSched/getPaxFltSchedDepartures`, {}, { where: "sched-icn" }), []);
  const today = ymd(kstDay(0));
  for (const it of icn) {
    if (dateOnly(it.lastdate) < today) continue;
    const line = KOREAN_AIRPORTS.has(String(it.airportcode ?? "")) ? "D" : "I";
    put([String(it.flightid ?? "").trim().toUpperCase(), "ICN", line, hhmm(it.st),
      dateOnly(it.firstdate), dateOnly(it.lastdate), flags(it, DAYS_ICN), it.airport ?? "", it.airline ?? ""]);
  }
  return [...seen.values()];
}

/** 최근 28일 아카이브 → 요일×시간대 평균 출발 승객 + 공항별 기준치(P90). 내일 이후 날짜에 답하기 위한 것. */
async function weekdayProfile() {
  const sums = {}; // ap/line/wd/hh → {s,n}
  const all = {};  // ap/line → [시간대 승객 전부] (P90 용)
  let days = 0;
  const offs = Array.from({ length: 28 }, (_, i) => -28 + i);
  for (let i = 0; i < offs.length; i += 4) { // 4일씩 병렬
    await Promise.all(offs.slice(i, i + 4).map(async (off) => {
      const d = kstDay(off), day = ymd(d), wd = d.getUTCDay();
      const rows = await attempt(`아카이브 ${day}`, () =>
        fetchAll(`${KAC}/airport-daily-expect-passenger/info`, { schDate: day }, { where: "archive" }), null);
      if (!rows?.length) return;
      days++;
      const folded = foldKacForecast(rows);
      for (const [ap, lines] of Object.entries(folded)) {
        for (const line of ["D", "I"]) {
          for (const [hh, pax] of Object.entries(lines[line]?.[day] ?? {})) {
            const cell = ((((sums[ap] ??= {})[line] ??= {})[wd] ??= {})[hh] ??= { s: 0, n: 0 });
            cell.s += pax; cell.n++;
            ((all[ap] ??= {})[line] ??= []).push(pax);
          }
        }
      }
    }));
  }
  if (!days) return null;
  const profile = {}, ref = {};
  for (const [ap, lines] of Object.entries(sums)) {
    for (const [line, wds] of Object.entries(lines)) {
      for (const [wd, hours] of Object.entries(wds)) {
        for (const [hh, c] of Object.entries(hours)) {
          ((((profile[ap] ??= {})[line] ??= {})[wd] ??= {})[hh]) = Math.round(c.s / c.n);
        }
      }
      const v = all[ap][line].filter((x) => x > 0).sort((a, b) => a - b);
      if (v.length) (ref[ap] ??= {})[line] = v[Math.min(v.length - 1, Math.floor(v.length * 0.9))];
    }
  }
  return { profile, ref, days };
}

async function runDaily() {
  const prev = (await readPrev("daily.json")) ?? {};
  const list = await schedules();
  const prof = await weekdayProfile();
  // 스케줄이 비정상적으로 줄었으면 덮지 않는다 (부분 실패로 편명이 사라지는 것을 막는다)
  const prevN = prev.flights?.length ?? 0;
  const keepPrev = prevN > 0 && list.length < Math.max(200, prevN * 0.6);
  if (keepPrev) note(`스케줄이 ${list.length}건뿐이라(이전 ${prevN}건) 이전 목록을 유지한다`);
  if (!list.length && !prevN && !prof) {
    console.error("daily: 전부 실패했다. 이전 데이터를 유지하고 종료한다.");
    process.exit(1);
  }
  const out = {
    v: 2,
    updatedAt: new Date().toISOString(),
    flightCols: ["no", "ap", "line", "time", "from", "to", "days(일~토)", "dest", "airline"],
    flights: keepPrev ? prev.flights : list,
    profile: prof?.profile ?? prev.profile ?? {},
    ref: prof?.ref ?? prev.ref ?? {},
    profileDays: prof?.days ?? prev.profileDays ?? 0,
    problems: problems.length ? [...problems] : undefined
  };
  await writeOut("daily.json", out);
  console.log(`daily 저장: 스케줄 ${out.flights.length}건 · 프로파일 ${Object.keys(out.profile).length}곳(${out.profileDays}일치)`);
}

/* ==================================================================== main */
if (MODE === "status" || MODE === "all") await runStatus();
if (MODE === "daily" || MODE === "all") { problems.length = 0; await runDaily(); }
