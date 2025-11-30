const { redis } = require("../_lib/redis");
const { fetchClosesFromTaifex } = require("../_lib/taifex");

const SYMBOLS = ["TX", "MTX", "TMF"];
const MARKET_CODE = "1";
const TTL_SECONDS = 60 * 60 * 24 * 8;

function keyOf(symbol, marketCode) {
  return `FUT:CLOSES:${symbol}:${marketCode}`;
}
function authed(req) {
  const auth = req.headers.authorization || "";
  return process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`;
}

module.exports = async (req, res) => {
  if (!authed(req)) return res.status(401).send("Unauthorized");

  const results = [];
  for (const symbol of SYMBOLS) {
    try {
      const payload = await fetchClosesFromTaifex({ symbol, marketCode: MARKET_CODE, days: 30 });
      await redis.set(keyOf(symbol, MARKET_CODE), payload, { ex: TTL_SECONDS });
      results.push({ symbol, marketCode: 1, ok: true, fetchedAtTaipei: payload.fetchedAtTaipei });
    } catch (e) {
      results.push({ symbol, marketCode: 1, ok: false, error: String(e?.message || e) });
    }
  }
  return res.status(200).json({ ok: true, type: "night", results });
};
