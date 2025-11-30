const { redis } = require("./_lib/redis");
const { fetchClosesFromTaifex } = require("./_lib/taifex");

const SYMBOLS = new Set(["TX", "MTX", "TMF"]);
const TTL_SECONDS = 60 * 60 * 24 * 8;

function keyOf(symbol, marketCode) {
  return `FUT:CLOSES:${symbol}:${marketCode}`;
}

// ✅ CORS：讓 GitHub Pages 可以 fetch 你的 Vercel API
function setCors(req, res) {
  // 你也可以改成只允許你的前端網域：https://cmlovehtc.github.io
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return true;
  }
  return false;
}

module.exports = async (req, res) => {
  try {
    if (setCors(req, res)) return;

    const symbol = String(req.query.symbol || "TX").toUpperCase();
    const marketCode = String(req.query.marketCode ?? "0");
    const days = Math.min(Number(req.query.days || 30), 30);

    if (!SYMBOLS.has(symbol)) return res.status(400).json({ error: "BAD_SYMBOL" });
    if (!["0", "1"].includes(marketCode)) return res.status(400).json({ error: "BAD_MARKETCODE" });

    const k = keyOf(symbol, marketCode);
    const cached = await redis.get(k);

    // ✅ 避免 CDN/瀏覽器快取卡住
    res.setHeader("Cache-Control", "no-store");

    if (cached) {
      return res.status(200).json(cached);
    }

    // 首次暖機（cron 還沒跑到也能有資料）
    const fresh = await fetchClosesFromTaifex({ symbol, marketCode, days });
    await redis.set(k, fresh, { ex: TTL_SECONDS });
    return res.status(200).json(fresh);
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(500).json({ error: "SERVER_ERROR", message: String(e?.message || e) });
  }
};
