const iconv = require("iconv-lite");
const Papa = require("papaparse");

const TAIFEX_OPEN_DATA_URL =
  "https://www.taifex.com.tw/data_gov/taifex_open_data.asp?data_name=DailyMarketReportFut";

function nowTaipeiISOString() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value || "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}.000+08:00`;
}

function normalizeDate(s) {
  if (!s) return null;
  const m = String(s).trim().match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  if (!m) return String(s).trim();
  return `${m[1]}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}`;
}

function toNumber(v) {
  const s = String(v ?? "").trim().replace(/,/g, "");
  if (!s || s === "-" || s === "—") return NaN;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

function guessDelimiter(firstLine) {
  if (firstLine.includes(";")) return ";";
  if (firstLine.includes(",")) return ",";
  return ";";
}

function buildFieldGetter(fields) {
  const find = (cands) => fields.find((f) => cands.some((k) => f.includes(k)));
  const fDate = find(["日期"]);
  const fContract = find(["契約"]);
  const fMonth = find(["到期月份"]);
  const fClose = find(["最後成交價"]);
  const fVol = find(["合計成交量"]);
  const fSession = find(["交易時段"]);
  if (!fDate || !fContract || !fMonth || !fClose || !fVol) {
    throw new Error("TAIFEX 欄位偵測失敗（欄位名稱可能更新）");
  }
  return { fDate, fContract, fMonth, fClose, fVol, fSession };
}

function sessionMatches(sessionText, marketCode) {
  const s = String(sessionText || "").trim();
  if (!s) return true;
  if (String(marketCode) === "0") return s.includes("一般");
  return s.includes("盤後") || s.includes("夜盤");
}

function pickMainForEachDate(rows, get) {
  const byDate = new Map();
  for (const r of rows) {
    const date = normalizeDate(r[get.fDate]);
    const close = toNumber(r[get.fClose]);
    const vol = toNumber(r[get.fVol]);
    const contractMonth = String(r[get.fMonth] || "").trim();
    if (!date || !Number.isFinite(close) || !Number.isFinite(vol) || !contractMonth) continue;
    const prev = byDate.get(date);
    if (!prev || vol > prev.volume) byDate.set(date, { date, close, volume: vol, contractMonth });
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? 1 : -1));
}

function computeAvgPrev4(dataNewestFirst) {
  if (dataNewestFirst.length < 5) return null;
  const slice = dataNewestFirst.slice(1, 5).map((d) => d.close);
  return Number((slice.reduce((a, b) => a + b, 0) / 4).toFixed(2));
}

function computeAvgNext4(dataNewestFirst) {
  if (dataNewestFirst.length < 4) return null;
  const slice = dataNewestFirst.slice(0, 4).map((d) => d.close);
  return Number((slice.reduce((a, b) => a + b, 0) / 4).toFixed(2));
}

async function fetchClosesFromTaifex({ symbol, marketCode, days = 30 }) {
  const res = await fetch(TAIFEX_OPEN_DATA_URL, {
    headers: { "user-agent": "Mozilla/5.0 (compatible; 5day-bot/1.0)" }
  });
  if (!res.ok) throw new Error(`TAIFEX HTTP ${res.status}`);

  const ab = await res.arrayBuffer();
  const buf = Buffer.from(ab);

  let text = iconv.decode(buf, "big5");
  if (!text || text.length < 10) text = buf.toString("utf8");

  const firstLine = text.split(/\r?\n/).find((l) => l.trim()) || "";
  const delimiter = guessDelimiter(firstLine);

  const parsed = Papa.parse(text, { header: true, skipEmptyLines: true, delimiter });
  const fields = parsed.meta?.fields || [];
  const get = buildFieldGetter(fields);

  const rows = (parsed.data || []).filter(Boolean);
  const filtered = rows.filter((r) => {
    const contract = String(r[get.fContract] || "").trim();
    if (contract !== symbol) return false;
    return sessionMatches(r[get.fSession], marketCode);
  });

  const mainByDate = pickMainForEachDate(filtered, get).slice(0, days);

  return {
    symbol,
    marketCode: Number(marketCode),
    fetchedAtTaipei: nowTaipeiISOString(),
    avgPrev4: computeAvgPrev4(mainByDate),
    avgNext4: computeAvgNext4(mainByDate),
    data: mainByDate
  };
}

module.exports = { fetchClosesFromTaifex };
