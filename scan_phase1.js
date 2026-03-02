#!/usr/bin/env node
const fs = require('fs');
const ccxt = require('ccxt');
const { getWhaleProxy } = require('./whale_phase15');
const { getCodexTopSymbols } = require('./codex_adapter');
const { getHistoricalAnalytics, getSupportResistance, getSrSignalPack } = require('./altfins_adapter');

const BINANCE_FAPI = 'https://fapi.binance.com';
const cfg = JSON.parse(fs.readFileSync('./config.phase1.json', 'utf8'));
const DATA_PROVIDER = (process.env.DATA_PROVIDER || 'binance').toLowerCase();
const TF = process.env.TIMEFRAME || cfg.timeframe || '5m';
const TOP_N = Number(process.env.TOP_N || cfg.topN || 40);
const WATCHLIST_FILE = process.env.WATCHLIST_FILE || 'watchlist.txt';
const RISK_USD = Number(process.env.RISK_USD || 50);
const exchange = new ccxt.binanceusdm({ enableRateLimit: true });

function normalizeSymbol(s) {
  s = String(s || '').trim().toUpperCase();
  if (!s) return '';
  if (s.includes('/')) return s.includes(':') ? s : `${s}:USDT`;
  return `${s}/USDT:USDT`;
}
function binanceIdFromUnified(s) {
  return s.split('/')[0] + 'USDT';
}
function ema(values, p) {
  const k = 2 / (p + 1); let out = values[0];
  for (let i = 1; i < values.length; i++) out = values[i] * k + out * (1 - k);
  return out;
}
function rsi(values, period = 14) {
  if (values.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  if (loss === 0) return 100;
  const rs = (gain / period) / (loss / period);
  return 100 - 100 / (1 + rs);
}
function pct(a, b) { return b ? ((a - b) / b) * 100 : 0; }
function round(x, n = 3) { return Number((x ?? 0).toFixed(n)); }
function atr(candles, period = 14) {
  if (!candles || candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i][2], low = candles[i][3], prevClose = candles[i - 1][4];
    trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  const cut = trs.slice(-period);
  return cut.reduce((a, b) => a + b, 0) / Math.max(cut.length, 1);
}

function buildEntryPlan(side, price, atrV, recentLow, recentHigh) {
  if (!atrV) return null;
  let entryLow, entryHigh, stop, tp1, tp2, invalidation;
  if (side === 'LONG') {
    entryLow = price - atrV * 0.25;
    entryHigh = price + atrV * 0.15;
    stop = Math.min(recentLow, price - atrV * 1.2);
    tp1 = price + atrV * 1.2;
    tp2 = price + atrV * 2.2;
    invalidation = '5m close below EMA50';
  } else {
    entryLow = price - atrV * 0.15;
    entryHigh = price + atrV * 0.25;
    stop = Math.max(recentHigh, price + atrV * 1.2);
    tp1 = price - atrV * 1.2;
    tp2 = price - atrV * 2.2;
    invalidation = '5m close above EMA50';
  }
  const entryMid = (entryLow + entryHigh) / 2;
  const risk = Math.abs(entryMid - stop);
  const reward = Math.abs(tp2 - entryMid);
  const rr = reward / Math.max(risk, 1e-9);

  const entryLowN = round(Math.min(entryLow, entryHigh), 6);
  const entryHighN = round(Math.max(entryLow, entryHigh), 6);
  const stopN = round(stop, 6);
  const tp1N = round(tp1, 6);
  const tp2N = round(tp2, 6);
  const entryMidN = (entryLowN + entryHighN) / 2;
  const riskPerUnit = Math.abs(entryMidN - stopN);
  const sizeUnits = RISK_USD > 0 ? (RISK_USD / Math.max(riskPerUnit, 1e-9)) : 0;
  const positionNotional = sizeUnits * entryMidN;

  return {
    entryLow: entryLowN,
    entryHigh: entryHighN,
    stop: stopN,
    tp1: tp1N,
    tp2: tp2N,
    rr: round(rr, 2),
    invalidation,
    riskUsd: round(RISK_USD, 2),
    sizeUnits: round(sizeUnits, 6),
    positionNotional: round(positionNotional, 2)
  };
}

async function getJSON(url, timeoutMs = 6000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { 'accept': 'application/json' }, signal: ctl.signal });
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

function loadWatchlist() {
  const envList = (process.env.WATCHLIST || '').split(',').map(normalizeSymbol).filter(Boolean);
  let fileList = [];
  if (fs.existsSync(WATCHLIST_FILE)) {
    fileList = fs.readFileSync(WATCHLIST_FILE, 'utf8').split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#')).map(normalizeSymbol);
  }
  return [...new Set([...envList, ...fileList])];
}

async function getTopSymbols() {
  const rows = await getJSON(`${BINANCE_FAPI}/fapi/v1/ticker/24hr`);
  return rows
    .filter(r => r.symbol.endsWith('USDT') && !r.symbol.includes('_') && Number(r.quoteVolume) > 0)
    .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume))
    .slice(0, TOP_N)
    .map(r => normalizeSymbol(r.symbol.replace('USDT', '/USDT')));
}

async function getDerivsFeatures(binanceId) {
  const [fund, oiNow, oiHist, taker] = await Promise.allSettled([
    getJSON(`${BINANCE_FAPI}/fapi/v1/premiumIndex?symbol=${binanceId}`),
    getJSON(`${BINANCE_FAPI}/fapi/v1/openInterest?symbol=${binanceId}`),
    getJSON(`${BINANCE_FAPI}/futures/data/openInterestHist?symbol=${binanceId}&period=5m&limit=2`),
    getJSON(`${BINANCE_FAPI}/futures/data/takerlongshortRatio?symbol=${binanceId}&period=5m&limit=2`)
  ]);

  const funding = fund.status === 'fulfilled' ? Number(fund.value.lastFundingRate || 0) : 0;
  const oi = oiNow.status === 'fulfilled' ? Number(oiNow.value.openInterest || 0) : 0;
  let oiDeltaPct = 0;
  if (oiHist.status === 'fulfilled' && Array.isArray(oiHist.value) && oiHist.value.length >= 2) {
    const prev = Number(oiHist.value[0].sumOpenInterest || oiHist.value[0].sumOpenInterestValue || 0);
    const cur = Number(oiHist.value[1].sumOpenInterest || oiHist.value[1].sumOpenInterestValue || 0);
    oiDeltaPct = pct(cur, prev);
  }
  let takerRatio = 1;
  let buyVol = 0;
  let sellVol = 0;
  if (taker.status === 'fulfilled' && Array.isArray(taker.value) && taker.value.length) {
    const last = taker.value[taker.value.length - 1];
    takerRatio = Number(last.buySellRatio || 1);
    buyVol = Number(last.buyVol || 0);
    sellVol = Number(last.sellVol || 0);
  }
  const buySellVolRatio = sellVol > 0 ? (buyVol / sellVol) : (buyVol > 0 ? 2 : 1);
  const buySellVolNetPct = (buyVol + sellVol) > 0 ? ((buyVol - sellVol) / (buyVol + sellVol)) * 100 : 0;
  return { funding, oi, oiDeltaPct, takerRatio, buyVol, sellVol, buySellVolRatio, buySellVolNetPct };
}

function buildDiscovery(features) {
  // Discovery-first score: find interesting coins before entry timing
  let score = 0;
  const reasons = [];

  const flowIntensity = Math.abs(features.takerRatio - 1);
  const flowPts = Math.min(25, flowIntensity * 120);
  score += flowPts;
  if (flowPts > 8) reasons.push(`Flow intensity ${round(features.takerRatio,3)}`);

  const burstPts = Math.min(20, Math.max(0, (features.volSpike - 1) * 40));
  score += burstPts;
  if (burstPts > 6) reasons.push(`Burst vol ${round(features.volSpike,2)}x`);

  const walletProxy = Math.max(0, (features.whaleScore - 50) / 2);
  score += walletProxy;
  if (walletProxy > 6) reasons.push(`Wallet/whale accumulation ${round(features.whaleScore,1)}`);

  const positionPts = Math.min(20, Math.abs(features.oiDeltaPct) * 8);
  score += positionPts;
  if (positionPts > 5) reasons.push(`Positioning shift OIΔ ${round(features.oiDeltaPct,2)}%`);

  const structurePts = Math.min(15, Math.abs(features.obImb - 0.5) * 100);
  score += structurePts;
  if (structurePts > 5) reasons.push(`Orderbook skew ${round(features.obImb,3)}`);

  return {
    discoveryScore: round(Math.max(0, Math.min(100, score)), 1),
    discoveryReasons: reasons.slice(0, 3)
  };
}

function inferAltfinsBias(payload) {
  try {
    const txt = JSON.stringify(payload).toUpperCase();
    if (txt.includes('BUY') || txt.includes('BULL') || txt.includes('LONG')) return 'LONG';
    if (txt.includes('SELL') || txt.includes('BEAR') || txt.includes('SHORT')) return 'SHORT';
  } catch {}
  return 'NEUTRAL';
}

function score(features) {
  const { w, t } = features;
  let long = 0, short = 0, reasonsL = [], reasonsS = [];

  if (features.ema20 > features.ema50) { long += w.trend; reasonsL.push('EMA20>EMA50'); }
  else if (features.ema20 < features.ema50) { short += w.trend; reasonsS.push('EMA20<EMA50'); }

  if (features.rsi14 >= t.rsiLongMin) { long += w.momentum; reasonsL.push(`RSI ${round(features.rsi14,1)}`); }
  if (features.rsi14 <= t.rsiShortMax) { short += w.momentum; reasonsS.push(`RSI ${round(features.rsi14,1)}`); }

  if (features.volSpike >= t.volumeSpikeMin) {
    long += w.volume; short += w.volume;
  }

  if (features.oiDeltaPct >= t.oiDeltaMinPct) { long += w.oiDelta * 0.6; short += w.oiDelta * 0.6; }
  if (features.oiDeltaPct > 0 && features.priceChg5m > 0) { long += w.oiDelta * 0.4; reasonsL.push('OI↑ + Price↑'); }
  if (features.oiDeltaPct > 0 && features.priceChg5m < 0) { short += w.oiDelta * 0.4; reasonsS.push('OI↑ + Price↓'); }

  if (features.funding > t.fundingTooHigh) { short += w.funding; reasonsS.push('Funding overheated +'); }
  else if (features.funding < t.fundingTooLow) { long += w.funding; reasonsL.push('Funding crowded shorts'); }

  if (features.obImb >= t.orderbookLongMin) { long += w.orderbook; reasonsL.push('Orderbook bid imbalance'); }
  if (features.obImb <= t.orderbookShortMax) { short += w.orderbook; reasonsS.push('Orderbook ask imbalance'); }

  if (features.takerRatio >= t.takerLongMin) { long += w.takerFlow; reasonsL.push('Taker buy pressure'); }
  if (features.takerRatio <= t.takerShortMax) { short += w.takerFlow; reasonsS.push('Taker sell pressure'); }

  if (features.buySellVolRatio >= t.buySellLongMin) { long += w.buySellVol; reasonsL.push('Buy volume > sell volume'); }
  if (features.buySellVolRatio <= t.buySellShortMax) { short += w.buySellVol; reasonsS.push('Sell volume > buy volume'); }

  if (features.whaleScore >= t.whaleBullMin) { long += w.whale; reasonsL.push('Whale flow net buy'); }
  if (features.whaleScore <= t.whaleBearMax) { short += w.whale; reasonsS.push('Whale flow net sell'); }

  if (features.altfinsBias === 'LONG') { long += 8; reasonsL.push('ALTFINS analytics bias long'); }
  if (features.altfinsBias === 'SHORT') { short += 8; reasonsS.push('ALTFINS analytics bias short'); }

  const srBull = ((features.srBreakoutScore || 50) + (features.srApproachingScore || 50) + (features.srObOsScore || 50)) / 3;
  if (srBull > 55) { long += 6; reasonsL.push('ALTFINS S/R signal bullish'); }
  if (srBull < 45) { short += 6; reasonsS.push('ALTFINS S/R signal bearish'); }

  const side = long >= short ? 'LONG' : 'SHORT';
  const confidence = round(Math.max(long, short), 1);
  return { side, confidence, reasons: side === 'LONG' ? reasonsL : reasonsS };
}

(async () => {
  await exchange.loadMarkets();
  const providerNote = DATA_PROVIDER === 'binance' ? 'binance' : `${DATA_PROVIDER} (fallback: binance)`;
  const watch = loadWatchlist();
  let universe;
  if (watch.length) {
    universe = watch;
  } else if (DATA_PROVIDER === 'codex') {
    const codex = await getCodexTopSymbols(TOP_N, process.env.CODEX_API_KEY || '');
    universe = codex.length ? codex : await getTopSymbols();
  } else {
    universe = await getTopSymbols();
  }
  const w = cfg.weights, t = cfg.thresholds;
  const out = [];

  for (const symbol of universe) {
    try {
      const id = binanceIdFromUnified(symbol);
      const [candles, ob, deriv, whale, altfins, altfinsSR, altfinsSrSignals] = await Promise.all([
        exchange.fetchOHLCV(symbol, TF, undefined, 220),
        exchange.fetchOrderBook(symbol, 20),
        getDerivsFeatures(id),
        getWhaleProxy(id, t.whaleUsdThreshold || 250000, 1000, TF, 20),
        DATA_PROVIDER === 'altfins'
          ? getHistoricalAnalytics(id, TF, 'RSI14', process.env.ALTFINS_API_KEY || '')
          : Promise.resolve({ ok: false }),
        DATA_PROVIDER === 'altfins'
          ? getSupportResistance(id, TF, process.env.ALTFINS_API_KEY || '')
          : Promise.resolve({ ok: false }),
        DATA_PROVIDER === 'altfins'
          ? getSrSignalPack(id, TF, process.env.ALTFINS_API_KEY || '')
          : Promise.resolve({ srBreakoutScore: 50, srApproachingScore: 50, srObOsScore: 50, srSignalSource: 'fallback' })
      ]);
      const closes = candles.map(c => c[4]);
      const vols = candles.map(c => c[5]);
      const highs = candles.map(c => c[2]);
      const lows = candles.map(c => c[3]);
      const last = closes[closes.length - 1];
      const prev = closes[closes.length - 2] || last;
      const ema20 = ema(closes.slice(-60), 20);
      const ema50 = ema(closes.slice(-120), 50);
      const rsi14 = rsi(closes, 14) || 50;
      const volNow = vols[vols.length - 1];
      const volAvg = vols.slice(-20).reduce((a, b) => a + b, 0) / 20;
      const bids = ob.bids.reduce((a, x) => a + x[1], 0);
      const asks = ob.asks.reduce((a, x) => a + x[1], 0);
      const obImb = bids / Math.max(bids + asks, 1e-9);

      const altfinsBias = (altfins && altfins.ok) ? inferAltfinsBias(altfins.data) : 'NEUTRAL';
      const feats = {
        symbol, price: last, priceChg5m: pct(last, prev), ema20, ema50, rsi14,
        volSpike: volNow / Math.max(volAvg, 1e-9), obImb,
        funding: deriv.funding, oi: deriv.oi, oiDeltaPct: deriv.oiDeltaPct, takerRatio: deriv.takerRatio,
        buySellVolRatio: deriv.buySellVolRatio, buySellVolNetPct: deriv.buySellVolNetPct,
        whaleScore: whale.whaleScore, altfinsBias,
        srBreakoutScore: altfinsSrSignals?.srBreakoutScore,
        srApproachingScore: altfinsSrSignals?.srApproachingScore,
        srObOsScore: altfinsSrSignals?.srObOsScore,
        w, t
      };

      const s = score(feats);
      const d = buildDiscovery(feats);
      if (s.confidence < (cfg.minConfidence || 55)) continue;

      const atr14 = atr(candles, 14);
      const recentLow = Math.min(...lows.slice(-24));
      const recentHigh = Math.max(...highs.slice(-24));
      const plan = buildEntryPlan(s.side, last, atr14, recentLow, recentHigh);

      let supportLevel = recentLow;
      let resistanceLevel = recentHigh;
      let srSource = 'local';
      if (DATA_PROVIDER === 'altfins' && altfinsSR?.ok) {
        if (typeof altfinsSR.support === 'number' && Number.isFinite(altfinsSR.support)) supportLevel = altfinsSR.support;
        if (typeof altfinsSR.resistance === 'number' && Number.isFinite(altfinsSR.resistance)) resistanceLevel = altfinsSR.resistance;
        if (altfinsSR.support != null || altfinsSR.resistance != null) srSource = 'altfins';
      }

      const supportDistPct = ((last - supportLevel) / Math.max(last, 1e-9)) * 100;
      const resistanceDistPct = ((resistanceLevel - last) / Math.max(last, 1e-9)) * 100;
      const nearestDistPct = Math.max(0, Math.min(Math.abs(supportDistPct), Math.abs(resistanceDistPct)));
      const srProximity = Math.max(0, 100 - Math.min(100, nearestDistPct * 50)); // closer => higher score
      const srZone = Math.abs(supportDistPct) <= Math.abs(resistanceDistPct) ? 'support' : 'resistance';
      const srNearestType = srZone;
      const srNearestDistPct = nearestDistPct;

      out.push({
        provider: providerNote,
        symbol,
        side: s.side,
        confidence: s.confidence,
        price: round(last, 6),
        priceChg5m: round(pct(last, prev), 3),
        rsi14: round(rsi14, 2),
        volSpike: round(feats.volSpike, 2),
        obImb: round(obImb, 3),
        oiDeltaPct: round(deriv.oiDeltaPct, 2),
        funding: round(deriv.funding, 6),
        takerRatio: round(deriv.takerRatio, 3),
        buySellVolRatio: round(deriv.buySellVolRatio, 3),
        buySellVolNetPct: round(deriv.buySellVolNetPct, 2),
        whaleScore: round(whale.whaleScore, 1),
        whaleFlowPct: round(whale.whaleFlowPct, 2),
        whaleBurstZ: round(whale.whaleBurstZ, 2),
        whaleNetUsd: round(whale.whaleNetUsd, 0),
        whaleTradeCount: whale.whaleTradeCount,
        altfinsBias,
        atr14: round(atr14 || 0, 6),
        entryLow: plan?.entryLow,
        entryHigh: plan?.entryHigh,
        stop: plan?.stop,
        tp1: plan?.tp1,
        tp2: plan?.tp2,
        rr: plan?.rr,
        invalidation: plan?.invalidation,
        riskUsd: plan?.riskUsd,
        sizeUnits: plan?.sizeUnits,
        positionNotional: plan?.positionNotional,
        supportDistPct: round(supportDistPct, 3),
        resistanceDistPct: round(resistanceDistPct, 3),
        srProximity: round(srProximity, 1),
        srZone,
        srNearestType,
        srNearestDistPct: round(srNearestDistPct, 3),
        srSource,
        supportLevel: round(supportLevel, 6),
        resistanceLevel: round(resistanceLevel, 6),
        srBreakoutScore: round(altfinsSrSignals?.srBreakoutScore ?? 50, 1),
        srApproachingScore: round(altfinsSrSignals?.srApproachingScore ?? 50, 1),
        srObOsScore: round(altfinsSrSignals?.srObOsScore ?? 50, 1),
        srSignalSource: altfinsSrSignals?.srSignalSource || 'fallback',
        discoveryScore: d.discoveryScore,
        discoveryWhy: d.discoveryReasons.join(' | '),
        why: s.reasons.join(' | ')
      });
    } catch (_) {}
  }

  out.sort((a, b) => b.confidence - a.confidence);
  const maxIdeas = Number(process.env.MAX_IDEAS || cfg.maxIdeas || 10);
  const final = out.slice(0, maxIdeas);

  if ((process.env.OUTPUT || '').toLowerCase() === 'json') {
    process.stdout.write(JSON.stringify(final));
    return;
  }

  if (!final.length) {
    console.log('No phase1 candidates right now.');
    return;
  }

  console.log(`Phase1 Scanner | ${TF} | Provider: ${providerNote} | Candidates: ${final.length}\n`);
  for (const x of final) {
    console.log(`${x.symbol} | ${x.side} | conf ${x.confidence} | discovery ${x.discoveryScore}`);
    console.log(`  Price ${x.price} | RSI ${x.rsi14} | VolSpike ${x.volSpike}x | OIΔ ${x.oiDeltaPct}% | Funding ${x.funding} | OB ${x.obImb} | Taker ${x.takerRatio} | B/S Vol ${x.buySellVolRatio} (${x.buySellVolNetPct}%) | WhaleFlow ${x.whaleFlowPct}%`);
    if (x.entryLow !== undefined) {
      console.log(`  Entry ${x.entryLow} - ${x.entryHigh} | Stop ${x.stop} | TP1 ${x.tp1} | TP2 ${x.tp2} | R:R ${x.rr}`);
      console.log(`  Size @ risk $${x.riskUsd}: ${x.sizeUnits} units (~$${x.positionNotional} notional)`);
      console.log(`  Invalidation: ${x.invalidation}`);
    }
    console.log(`  Discovery Why: ${x.discoveryWhy || 'n/a'}`);
    console.log(`  Why: ${x.why}\n`);
  }
})();
