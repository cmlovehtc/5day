// backend/api/closes.js
const { DateTime } = require("luxon");
const cheerio = require("cheerio");

function normText(s) {
  return String(s || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}
function toNumber(s) {
  const t = normText(s).replace(/,/g, "");
  if (t === "-" || t === "" || t === "--") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}
function parseTradingDate(html) {
  const m = html.match(/日期[:：]\s*(\d{4}\/\d{2}\/\d{2})/);
  return m ? m[1] : null;
}
function findHeaderIndex(headers, includesAny) {
  const h = headers.map((x) => normText(x).replace(/\s/g, ""));
  for (let i = 0; i < h.length; i++) {
    for (const key of includesAny) {
      const k = String(key).replace(/\s/g, "");
      if (h[i].includes(k)) return i;
    }
  }
  return -1;
}

function parseCloseFromTables(html, symbol) {
  const $ = cheerio.load(html);
  let bestRow = null;
  const tables = $("table");
  if (!tables.length) return null;

  tables.each((_, table) => {
    const rows = $(table).find("tr");
    if (!rows.length) return;

    let headerRowIdx = -1;
    let headers = [];

    rows.each((ri, tr) => {
      const cells = $(tr).find("th,td");
      const texts = cells
        .map((_, c) => normText($(c).text()))
        .get()
        .filter((x) => x.length > 0);

      const joined = texts.join(" ");
      if (joined.includes("契約") && joined.includes("最後") && joined.includes("成交") && joined.includes("成交量")) {
        headerRowIdx = ri;
        headers = texts;
        return false;
      }
    });

    if (headerRowIdx === -1 || headers.length < 6) return;

    const idxContract = findHeaderIndex(headers, ["契約"]);
    const idxMonth = findHeaderIndex(headers, ["到期月份"]);
    const idxLast = findHeaderIndex(headers, ["最後成交價", "最後成交"]);
    const idxTotalVol = findHeaderIndex(headers, ["合計成交量"]);
    const idxRegVol = findHeaderIndex(headers, ["一般交易時段成交量"]);
    const idxAfterVol = findHeaderIndex(headers, ["盤後交易時段成交量"]);
    if (idxContract < 0 || idxMonth < 0 || idxLast < 0) return;

    for (let ri = headerRowIdx + 1; ri < rows.length; ri++) {
      const tr = rows.eq(ri);
      const cells = tr.find("th,td");
      if (!cells.length) continue;

      const texts = cells.map((_, c) => normText($(c).text())).get();
      const contract = texts[idxContract];
      const month = texts[idxMonth];

      if (contract !== symbol) continue;
      if (!/^\d{6}$/.test(month || "")) continue;

      const last = toNumber(texts[idxLast]);
      if (last == null) continue;

      const totalVol =
        (idxTotalVol >= 0 && toNumber(texts[idxTotalVol])) ??
        (idxRegVol >= 0 && toNumber(texts[idxRegVol])) ??
        (idxAfterVol >= 0 && toNumber(texts[idxAfterVol])) ??
        0;

      if (!bestRow || totalVol > bestRow.totalVol) {
        bestRow = { contract, month, close: last, totalVol };
      }
    }
  });

  return bestRow;
}

function parseQuoteLine(line) {
  const tokens = normText(line).split(" ").filter(Boolean);
  const nums = [];
  for (const t of tokens) {
    const n = toNumber(t);
    if (n != null) nums.push(n);
    if (nums.length >= 4) break;
  }
  if (nums.length < 4) return null;

  const close = nums[3];
  let totalVol = 0;

  const pctIdx = tokens.findIndex((t) => t.includes("%"));
  if (pctIdx >= 0) {
    const sumVol = toNumber(tokens[pctIdx + 3]);
    const regVol = toNumber(tokens[pctIdx + 2]);
    const afterVol = toNumber(tokens[pctIdx + 1]);
    totalVol = sumVol ?? regVol ?? afterVol ?? 0;
  } else {
    const allInts = tokens.map(toNumber).filter((n) => Number.isInteger(n));
    if (allInts.length) totalVol = Math.max(...allInts);
  }
  return { close, totalVol };
}

function parseCloseFromText(html, symbol) {
  const $ = cheerio.load(html);
  const text = $.text();
  const rawLines = text.split(/\r?\n/).map(normText).filter(Boolean);

  const stopIdx = rawLines.findIndex((l) => l.includes("價差行情表"));
  const lines = stopIdx >= 0 ? rawLines.slice(0, stopIdx) : rawLines;

  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] !== symbol) continue;

    let j = i + 1;
    while (j < lines.length && !/^\d{6}$/.test(lines[j])) j++;
    if (j >= lines.length) continue;

    const month = lines[j];

    let k = j + 1;
    while (k < lines.length && !/^\d/.test(lines[k])) k++;
    if (k >= lines.length) continue;

    const parsed = parseQuoteLine(lines[k]);
    if (!parsed) continue;

    rows.push({ contract: symbol, month, close: parsed.close, totalVol: parsed.totalVol });
  }

  if (!rows.length) return null;
  rows.sort((a, b) => (b.totalVol || 0) - (a.totalVol || 0));
  return rows[0];
}

function parseCloseMainContract(html, symbol) {
  return parseCloseFromTables(html, symbol) || parseCloseFromText(html, symbol);
}

async function fetchDailyExcel({ symbol, date, marketCode }) {
  const url = new URL("https://www.taifex.com.tw/cht/3/futDailyMarketExcel");
  url.searchParams.set("commodity_id", symbol);
  url.searchParams.set("queryDate", date);
  if (marketCode != null) url.searchParams.set("marketCode", String(marketCode));

  const res = await fetch(url.toString(), {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari",
      "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.6",
      Referer: "https://www.taifex.com.tw/",
    },
  });

  if (!res.ok) throw new Error(`TAIFEX fetch failed: ${res.status}`);
  const html = await res.text();

  const tradingDate = parseTradingDate(html);
  if (!tradingDate || tradingDate !== date) return null;

  const row = parseCloseMainContract(html, symbol);
  if (!row) return null;

  return { tradingDate, ...row };
}

async function getLastTradingCloses({ symbol, days, marketCode, startISO }) {
  const need = Math.max(1, Math.min(Number(days) || 30, 60)); // 一次最多 60（前端會分頁拼一年）
  const results = [];

  let d = startISO
    ? DateTime.fromISO(startISO, { zone: "Asia/Taipei" }).startOf("day")
    : DateTime.now().setZone("Asia/Taipei").startOf("day");

  let guard = 0;
  while (results.length < need && guard < 170) {
    const dateStr = d.toFormat("yyyy/MM/dd");
    try {
      const one = await fetchDailyExcel({ symbol, date: dateStr, marketCode });
      if (one) {
        results.push({
          date: d.toISODate(),
          close: one.close,
          contractMonth: one.month,
          volume: one.totalVol,
        });
      }
    } catch (_) {}
    d = d.minus({ days: 1 });
    guard++;
  }

  return results; // 最新在第 0 筆
}

module.exports = async (req, res) => {
  // CORS：讓 GitHub Pages 也能呼叫
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const symbol = String(url.searchParams.get("symbol") || "TX").toUpperCase();
  const days = Number(url.searchParams.get("days") || 30);
  const marketCode = url.searchParams.get("marketCode") != null ? Number(url.searchParams.get("marketCode")) : 0;
  const start = url.searchParams.get("start"); // yyyy-mm-dd

  if (!/^[A-Z0-9]+$/.test(symbol)) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.end(JSON.stringify({ error: "bad symbol" }));
  }

  const data = await getLastTradingCloses({ symbol, days, marketCode, startISO: start || null });

  let avgPrev4 = null;
  if (data.length >= 5) {
    const prev4 = data.slice(1, 5).map((d) => d.close);
    avgPrev4 = Number((prev4.reduce((a, b) => a + b, 0) / 4).toFixed(2));
  }

  let avgNext4 = null;
  if (data.length >= 4) {
    const next4 = data.slice(0, 4).map((d) => d.close);
    avgNext4 = Number((next4.reduce((a, b) => a + b, 0) / 4).toFixed(2));
  }

  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.statusCode = 200;
  res.end(
    JSON.stringify({
      symbol,
      marketCode,
      start: start || null,
      fetchedAtTaipei: DateTime.now().setZone("Asia/Taipei").toISO(),
      avgPrev4,
      avgNext4,
      data,
    })
  );
};
