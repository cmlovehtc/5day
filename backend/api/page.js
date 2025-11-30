const { redis } = require("./_lib/redis");
const { fetchClosesFromTaifex } = require("./_lib/taifex");

const SYMBOLS = ["TX", "MTX", "TMF"];
const MARKETCODES = ["0", "1"];
const TTL_SECONDS = 60 * 60 * 24 * 8;

function keyOf(symbol, marketCode) {
  return `FUT:CLOSES:${symbol}:${marketCode}`;
}

// 逃逸避免 XSS（我們會把 JSON 直接塞進 HTML）
function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function getOrWarm(symbol, marketCode) {
  const k = keyOf(symbol, marketCode);
  const cached = await redis.get(k);
  if (cached) return cached;

  // 如果 cron 還沒跑到，第一次有人打開首頁也能有資料（暖機）
  const fresh = await fetchClosesFromTaifex({ symbol, marketCode, days: 30 });
  await redis.set(k, fresh, { ex: TTL_SECONDS });
  return fresh;
}

module.exports = async (req, res) => {
  try {
    // 預設顯示 TX + 一般
    const defaultSymbol = "TX";
    const defaultMarket = "0";

    // 把 6 份快取都一起塞進 HTML，這樣切換 TX/MTX/TMF、一般/盤後都能「立刻有資料」
    const boot = {};
    for (const mc of MARKETCODES) {
      for (const sym of SYMBOLS) {
        const payload = await getOrWarm(sym, mc);
        boot[`${sym}:${mc}`] = payload;
      }
    }

    const bootJson = escapeHtml(JSON.stringify({
      defaultSymbol,
      defaultMarket,
      boot
    }));

    const html = `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
  <title>台指/小台/微型台指：前四日平均</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
</head>

<body class="bg-slate-950 text-slate-100">
  <main class="mx-auto max-w-5xl px-4 pb-10 pt-5 sm:px-6 sm:pt-8">
    <header class="flex flex-col gap-4">
      <div>
        <h1 class="text-xl sm:text-2xl md:text-3xl font-semibold tracking-tight leading-snug">
          收盤價/最後成交價 & 前四日平均
        </h1>
        <p class="text-slate-300 mt-2 text-sm sm:text-base leading-relaxed">
          首屏直接使用後端共享快取（SSR 注入）；之後前端會背景同步更新。
        </p>
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <label class="block">
          <div class="text-xs text-slate-400 mb-1">商品</div>
          <select id="symbol" class="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-3 text-base">
            <option value="TX" selected>TX（大台）</option>
            <option value="MTX">MTX（小台）</option>
            <option value="TMF">TMF（微型臺指）</option>
          </select>
        </label>
        <label class="block">
          <div class="text-xs text-slate-400 mb-1">交易時段</div>
          <select id="marketCode" class="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-3 text-base">
            <option value="0" selected>一般交易時段</option>
            <option value="1">盤後交易時段</option>
          </select>
        </label>
      </div>

      <div class="flex items-center justify-between text-xs text-slate-400">
        <div id="autoInfo">自動同步：每 2 分鐘檢查一次</div>
        <button id="retry" class="hidden underline decoration-slate-600 hover:decoration-slate-200">
          重新讀取
        </button>
      </div>
    </header>

    <section class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 mt-5 sm:mt-6">
      <div class="bg-slate-900/60 border border-slate-800 rounded-2xl p-4">
        <div class="text-slate-300 text-sm">最新交易日收盤價（最後成交價）</div>
        <div id="closeToday" class="text-2xl font-semibold mt-2">—</div>
        <div id="closeMeta" class="text-xs text-slate-400 mt-2 break-words">—</div>
      </div>
      <div class="bg-slate-900/60 border border-slate-800 rounded-2xl p-4">
        <div class="text-slate-300 text-sm">前 4 交易日平均（不含今天）</div>
        <div id="avgPrev4" class="text-2xl font-semibold mt-2">—</div>
        <div id="avgPrev4Meta" class="text-xs text-slate-400 mt-2 break-words">—</div>
      </div>
      <div class="bg-slate-900/60 border border-slate-800 rounded-2xl p-4">
        <div class="text-slate-300 text-sm">預測下一交易日：前四日平均</div>
        <div id="avgNext4" class="text-2xl font-semibold mt-2">—</div>
        <div id="avgNext4Meta" class="text-xs text-slate-400 mt-2 break-words">—</div>
      </div>
      <div class="bg-slate-900/60 border border-slate-800 rounded-2xl p-4">
        <div class="text-slate-300 text-sm">今天 -（不含今天的前四日平均）</div>
        <div id="diff" class="text-2xl font-semibold mt-2">—</div>
        <div id="diffMeta" class="text-xs text-slate-400 mt-2 break-words">—</div>
      </div>
    </section>

    <section class="bg-slate-900/60 border border-slate-800 rounded-2xl p-4 mt-4">
      <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div>
          <div class="text-slate-200 font-medium">圖表</div>
          <div id="status" class="text-xs text-slate-400 mt-1">—</div>
        </div>
        <div class="text-xs text-slate-400">平均線：每個點取它前 4 個交易日（不含當天）</div>
      </div>
      <div class="mt-4 h-[300px] sm:h-[360px]">
        <canvas id="chart"></canvas>
      </div>
    </section>
  </main>

  <script id="BOOTSTRAP" type="application/json">${bootJson}</script>

  <script>
    const API_BASE = "https://5day.vercel.app";
    const POLL_MS = 120000;

    let chart = null;
    let pollTimer = null;
    let reqSeq = 0;

    const BOOT = JSON.parse(document.getElementById("BOOTSTRAP").textContent);
    const memBoot = BOOT.boot || {};

    document.getElementById("symbol").value = BOOT.defaultSymbol || "TX";
    document.getElementById("marketCode").value = BOOT.defaultMarket || "0";

    function fmt(n) {
      if (n == null || Number.isNaN(n)) return "—";
      return new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 2 }).format(n);
    }
    function setStatus(text) { document.getElementById("status").textContent = text; }
    function setRetryVisible(v) { document.getElementById("retry").classList.toggle("hidden", !v); }

    function buildPrev4AvgLine(dataNewestFirst) {
      const closes = dataNewestFirst.map(d => d.close);
      return closes.map((_, i) => {
        if (i + 4 >= closes.length) return null;
        const slice = closes.slice(i + 1, i + 5);
        const avg = slice.reduce((a, b) => a + b, 0) / 4;
        return Number(avg.toFixed(2));
      });
    }

    function render(json, note="") {
      const data = json?.data || [];
      if (!data.length) { setStatus("沒有資料可顯示"); return; }

      const today = data[0];
      document.getElementById("closeToday").textContent = fmt(today.close);
      document.getElementById("closeMeta").textContent = \`日期：\${today.date}｜合約月：\${today.contractMonth}｜成交量：\${fmt(today.volume)}\`;

      const avgPrev4 = json.avgPrev4;
      document.getElementById("avgPrev4").textContent = avgPrev4 != null ? fmt(avgPrev4) : "資料不足";
      document.getElementById("avgPrev4Meta").textContent =
        (data.length >= 5) ? \`使用：\${data[1].date}, \${data[2].date}, \${data[3].date}, \${data[4].date}\` : \`目前只有 \${data.length} 筆\`;

      const avgNext4 = json.avgNext4;
      document.getElementById("avgNext4").textContent = avgNext4 != null ? fmt(avgNext4) : "資料不足";
      document.getElementById("avgNext4Meta").textContent =
        (data.length >= 4) ? \`使用：\${data[0].date}, \${data[1].date}, \${data[2].date}, \${data[3].date}\` : \`目前只有 \${data.length} 筆\`;

      if (avgPrev4 != null) {
        const diff = Number((today.close - avgPrev4).toFixed(2));
        const pct = Number(((diff / avgPrev4) * 100).toFixed(2));
        document.getElementById("diff").textContent = \`\${diff >= 0 ? "+" : ""}\${fmt(diff)}（\${diff >= 0 ? "+" : ""}\${fmt(pct)}%）\`;
        document.getElementById("diffMeta").textContent = \`(\${fmt(today.close)} - \${fmt(avgPrev4)}) / \${fmt(avgPrev4)}\`;
      } else {
        document.getElementById("diff").textContent = "—";
        document.getElementById("diffMeta").textContent = "—";
      }

      setStatus(\`後端快取更新時間（台北）：\${new Date(json.fetchedAtTaipei).toLocaleString("zh-TW")}\${note ? "｜" + note : ""}\`);
      setRetryVisible(false);

      const labels = [...data].reverse().map(d => d.date);
      const closes = [...data].reverse().map(d => d.close);
      const avgLine = buildPrev4AvgLine(data);
      const avgLineReversed = [...avgLine].reverse();

      const ctx = document.getElementById("chart");
      if (chart) chart.destroy();
      chart = new Chart(ctx, {
        type: "line",
        data: {
          labels,
          datasets: [
            { label: "收盤價/最後成交價", data: closes, tension: 0.25, pointRadius: 2 },
            { label: "前四交易日平均（不含當天）", data: avgLineReversed, tension: 0.25, pointRadius: 2, spanGaps: true }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: "index", intersect: false },
          plugins: { legend: { labels: { color: "#e2e8f0" } } },
          scales: {
            x: { ticks: { color: "#94a3b8" }, grid: { color: "rgba(148,163,184,0.12)" } },
            y: { ticks: { color: "#94a3b8" }, grid: { color: "rgba(148,163,184,0.12)" } }
          }
        }
      });
    }

    function selection() {
      return {
        symbol: document.getElementById("symbol").value,
        marketCode: document.getElementById("marketCode").value
      };
    }

    function showBoot() {
      const { symbol, marketCode } = selection();
      const hit = memBoot[\`\${symbol}:\${marketCode}\`];
      if (hit) render(hit, "首屏快取");
      else setStatus("此組合尚無快取（等後端 cron 更新）");
    }

    async function syncFromApi({ silent=true } = {}) {
      const { symbol, marketCode } = selection();
      const mySeq = ++reqSeq;

      try {
        const url = \`\${API_BASE}/api/closes?symbol=\${encodeURIComponent(symbol)}&days=30&marketCode=\${encodeURIComponent(marketCode)}&_t=\${Date.now()}\`;
        const res = await fetch(url, { cache: "no-store" });
        const json = await res.json();
        if (mySeq !== reqSeq) return;

        if (!res.ok) {
          setRetryVisible(true);
          if (!silent) setStatus("同步失敗，請稍後重試");
          return;
        }
        memBoot[\`\${symbol}:\${marketCode}\`] = json;
        render(json, "已同步");
      } catch {
        setRetryVisible(true);
        if (!silent) setStatus("連線失敗");
      }
    }

    document.getElementById("symbol").addEventListener("change", () => { showBoot(); syncFromApi({ silent:true }); });
    document.getElementById("marketCode").addEventListener("change", () => { showBoot(); syncFromApi({ silent:true }); });
    document.getElementById("retry").addEventListener("click", () => syncFromApi({ silent:false }));

    // ✅ 首屏：不用等 API，直接顯示 SSR 注入的快取
    showBoot();
    // 背景再同步（確保最新）
    syncFromApi({ silent:true });

    pollTimer = setInterval(() => syncFromApi({ silent:true }), POLL_MS);
    document.getElementById("autoInfo").textContent = "自動同步：每 2 分鐘檢查一次";
  </script>
</body>
</html>`;

    res.setHeader("content-type", "text/html; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    return res.status(200).send(html);
  } catch (e) {
    return res.status(500).send("SERVER_ERROR: " + String(e?.message || e));
  }
};
