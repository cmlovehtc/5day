const { redis } = require("./_lib/redis");
const { fetchClosesFromTaifex } = require("./_lib/taifex");

const SYMBOLS = new Set(["TX", "MTX", "TMF"]);
const TTL_SECONDS = 60 * 60 * 24 * 8;

function keyOf(symbol, marketCode) {
  return `FUT:CLOSES:${symbol}:${marketCode}`;
}

module.exports = async (req, res) => {
  try {
    const symbol = String(req.query.symbol || "TX").toUpperCase();
    const marketCode = String(req.query.marketCode ?? "0");
    const days = Math.min(Number(req.query.days || 30), 30);

    if (!SYMBOLS.has(symbol)) return res.status(400).json({ error: "BAD_SYMBOL" });
    if (!["0", "1"].includes(marketCode)) return res.status(400).json({ error: "BAD_MARKETCODE" });

    const k = keyOf(symbol, marketCode);
    const cached = await redis.get(k);

    if (cached) {
      res.setHeader("cache-control", "no-store");
      return res.status(200).json(cached);
    }

    // 第一次還沒跑到 cron 時：暖機一次（讓前端不會空白）
    const fresh = await fetchClosesFromTaifex({ symbol, marketCode, days });
    await redis.set(k, fresh, { ex: TTL_SECONDS });

    res.setHeader("cache-control", "no-store");
    return res.status(200).json(fresh);
  } catch (e) {
    return res.status(500).json({ error: "SERVER_ERROR", message: String(e?.message || e) });
  }
};
