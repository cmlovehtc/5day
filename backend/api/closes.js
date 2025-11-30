const { redis } = require("./_lib/redis");
const { fetchClosesFromTaifex } = require("./_lib/taifex");

const SYMBOLS = new Set(["TX", "MTX", "TMF"]);
const TTL_SECONDS = 60 * 60 * 24 * 8;

function keyOf(symbol, marketCode) {
  return `FUT:CLOSES:${symbol}:${marketCode}`;
}

function setCors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") {
    res.status(204).end();
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

    res.setHeader("Cache-Control", "no-store");

    const k = keyOf(symbol, marketCode);
    const cached = await redis.get(k);
    if (cached) return res.status(200).json(cached);

    const fresh = await fetchClosesFromTaifex({ symbol, marketCode, days });
    await redis.set(k, fresh, { ex: TTL_SECONDS });
    return res.status(200).json(fresh);
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(500).json({ error: "SERVER_ERROR", message: String(e?.message || e) });
  }
};
