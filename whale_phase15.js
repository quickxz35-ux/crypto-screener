const BINANCE_FAPI = 'https://fapi.binance.com';

async function getJSON(url) {
  const r = await fetch(url, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

function round(x, n = 3) { return Number((x ?? 0).toFixed(n)); }
function tfToMs(tf = '5m') {
  const map = { '1m': 60000, '5m': 300000, '15m': 900000, '30m': 1800000, '1h': 3600000, '4h': 14400000, '1d': 86400000 };
  return map[tf] || 300000;
}

function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
function std(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length);
}

async function getWhaleProxy(binanceId, usdThreshold = 50000, limit = 1000, timeframe = '5m', baselineBars = 20, currentWindowBars = 3) {
  try {
    const rows = await getJSON(`${BINANCE_FAPI}/fapi/v1/aggTrades?symbol=${binanceId}&limit=${limit}`);
    const binMs = tfToMs(timeframe);
    const bins = new Map();

    for (const t of rows) {
      const px = Number(t.p || 0);
      const qty = Number(t.q || 0);
      const usd = px * qty;
      if (usd < usdThreshold) continue;

      const ts = Number(t.T || t.E || Date.now());
      const k = Math.floor(ts / binMs);
      if (!bins.has(k)) bins.set(k, { buy: 0, sell: 0, count: 0 });
      const b = bins.get(k);
      b.count += 1;
      if (t.m) b.sell += usd; else b.buy += usd;
    }

    const keys = [...bins.keys()].sort((a, b) => a - b);
    if (!keys.length) {
      return {
        whaleBuyUsd: 0, whaleSellUsd: 0, whaleNetUsd: 0, whaleTradeCount: 0,
        whaleScore: 50, whaleFlowPct: 0, whaleBurstZ: 0, whaleMode: `binance_aggtrade_${timeframe}`
      };
    }

    // Build contiguous series so baseline includes quiet bins (zeros) instead of only active bins.
    const endKey = keys[keys.length - 1];
    const startKey = endKey - (baselineBars + currentWindowBars + 5);
    const series = [];
    for (let k = startKey; k <= endKey; k++) {
      const v = bins.get(k) || { buy: 0, sell: 0, count: 0 };
      const tUsd = v.buy + v.sell;
      const flow = tUsd > 0 ? ((v.buy - v.sell) / tUsd) * 100 : 0;
      series.push({ k, ...v, flow });
    }

    const curSlice = series.slice(-currentWindowBars);
    const curAgg = curSlice.reduce((acc, v) => {
      acc.buy += v.buy; acc.sell += v.sell; acc.count += v.count;
      return acc;
    }, { buy: 0, sell: 0, count: 0 });

    const buyUsd = curAgg.buy, sellUsd = curAgg.sell;
    const total = buyUsd + sellUsd;
    const net = buyUsd - sellUsd;
    const flowPct = total > 0 ? (net / total) * 100 : 0;
    const score = 50 + (flowPct / 2);

    const baselineSlice = series.slice(-(baselineBars + currentWindowBars), -currentWindowBars);
    const baseline = baselineSlice.map(v => v.flow);
    const mu = mean(baseline);
    const sd = std(baseline);
    let z = sd > 0 ? (flowPct - mu) / sd : 0;

    // If baseline variance collapses to zero, fall back to net-USD burst vs baseline absolute net USD.
    if (sd === 0 && baselineSlice.length) {
      const curNet = net;
      const baseNetAbs = baselineSlice.map(v => Math.abs(v.buy - v.sell));
      const muAbs = mean(baseNetAbs);
      const sdAbs = std(baseNetAbs);
      if (sdAbs > 0) z = (Math.abs(curNet) - muAbs) / sdAbs;
    }

    return {
      whaleBuyUsd: round(buyUsd, 0),
      whaleSellUsd: round(sellUsd, 0),
      whaleNetUsd: round(net, 0),
      whaleTradeCount: curAgg.count,
      whaleScore: round(Math.max(0, Math.min(100, score)), 1),
      whaleFlowPct: round(flowPct, 2),
      whaleBurstZ: round(z, 2),
      whaleMode: `binance_aggtrade_${timeframe}`
    };
  } catch {
    return {
      whaleBuyUsd: 0,
      whaleSellUsd: 0,
      whaleNetUsd: 0,
      whaleTradeCount: 0,
      whaleScore: 50,
      whaleFlowPct: 0,
      whaleBurstZ: 0,
      whaleMode: 'unavailable'
    };
  }
}

module.exports = { getWhaleProxy };