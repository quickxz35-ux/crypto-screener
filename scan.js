#!/usr/bin/env node
const ccxt = require('ccxt');
const fs = require('fs');

const EXCHANGE_ID = process.env.EXCHANGE || 'binanceusdm';
const exchange = new ccxt[EXCHANGE_ID]({ enableRateLimit: true });

const TOP_N = Number(process.env.TOP_N || 20);
const TF = process.env.TIMEFRAME || '5m';
const LIMIT = Number(process.env.CANDLE_LIMIT || 220);
const WATCHLIST_FILE = process.env.WATCHLIST_FILE || 'watchlist.txt';

function ema(values, period) {
  const k = 2 / (period + 1);
  let out = values[0];
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

function atr(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const [, , h, l, , ] = candles[i];
    const prevClose = candles[i - 1][4];
    trs.push(Math.max(h - l, Math.abs(h - prevClose), Math.abs(l - prevClose)));
  }
  const slice = trs.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function round(v, n = 4) { return Number(v.toFixed(n)); }

function normalizeSymbol(x) {
  let s = String(x || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!s) return '';
  if (!s.includes('/')) return `${s}/USDT:USDT`;
  if (s.includes(':')) return s;
  if (s.endsWith('/USDT')) return `${s}:USDT`;
  return s;
}

function loadWatchlist() {
  const fromEnv = (process.env.WATCHLIST || '')
    .split(',')
    .map(s => normalizeSymbol(s))
    .filter(Boolean);

  let fromFile = [];
  if (fs.existsSync(WATCHLIST_FILE)) {
    fromFile = fs.readFileSync(WATCHLIST_FILE, 'utf8')
      .split('\n')
      .map(s => s.trim())
      .filter(s => s && !s.startsWith('#'))
      .map(s => normalizeSymbol(s));
  }

  return Array.from(new Set([...fromEnv, ...fromFile]));
}

function buildSetup(symbol, candles) {
  const closes = candles.map(c => c[4]);
  const highs = candles.map(c => c[2]);
  const lows = candles.map(c => c[3]);
  const vols = candles.map(c => c[5]);

  const last = closes[closes.length - 1];
  const ema20 = ema(closes.slice(-60), 20);
  const ema50 = ema(closes.slice(-120), 50);
  const r = rsi(closes, 14);
  const a = atr(candles, 14);
  const volNow = vols[vols.length - 1];
  const volAvg = vols.slice(-20).reduce((x, y) => x + y, 0) / 20;

  const recentHigh = Math.max(...highs.slice(-24));
  const recentLow = Math.min(...lows.slice(-24));

  const bullish = last > ema20 && ema20 > ema50;
  const bearish = last < ema20 && ema20 < ema50;

  if (!a || !r) return null;

  let side = 'NO_TRADE';
  let confidence = 0;

  if (bullish && r >= 50 && r <= 70 && volNow > volAvg) {
    side = 'LONG';
    confidence = 60 + Math.min(30, ((r - 50) * 1.2)) + Math.min(10, ((volNow / volAvg - 1) * 20));
  } else if (bearish && r <= 50 && r >= 30 && volNow > volAvg) {
    side = 'SHORT';
    confidence = 60 + Math.min(30, ((50 - r) * 1.2)) + Math.min(10, ((volNow / volAvg - 1) * 20));
  } else {
    return null;
  }

  let entry1, entry2, stop, tp1, tp2, invalidation;
  if (side === 'LONG') {
    entry1 = last - a * 0.25;
    entry2 = last + a * 0.15;
    stop = Math.min(recentLow, last - a * 1.2);
    tp1 = last + a * 1.2;
    tp2 = last + a * 2.2;
    invalidation = '5m close below EMA50';
  } else {
    entry1 = last - a * 0.15;
    entry2 = last + a * 0.25;
    stop = Math.max(recentHigh, last + a * 1.2);
    tp1 = last - a * 1.2;
    tp2 = last - a * 2.2;
    invalidation = '5m close above EMA50';
  }

  const risk = Math.abs(((entry1 + entry2) / 2) - stop);
  const reward = Math.abs(tp2 - ((entry1 + entry2) / 2));
  const rr = reward / Math.max(risk, 1e-9);

  return {
    symbol,
    side,
    confidence: round(Math.min(99, confidence), 1),
    price: round(last, 6),
    entryZone: [round(Math.min(entry1, entry2), 6), round(Math.max(entry1, entry2), 6)],
    stop: round(stop, 6),
    tp1: round(tp1, 6),
    tp2: round(tp2, 6),
    rr: round(rr, 2),
    rsi14: round(r, 2),
    atr14: round(a, 6),
    volSpike: round(volNow / Math.max(volAvg, 1e-9), 2),
    invalidation,
    why: side === 'LONG'
      ? 'Trend up (EMA20>EMA50), momentum supportive, and volume above average.'
      : 'Trend down (EMA20<EMA50), momentum supportive, and volume above average.'
  };
}

(async () => {
  try {
    await exchange.loadMarkets();
    const watchlist = loadWatchlist();

    let symbols = Object.values(exchange.markets)
      .filter(m => m.active && m.swap && m.quote === 'USDT')
      .sort((a, b) => (b.info?.quoteVolume || 0) - (a.info?.quoteVolume || 0))
      .slice(0, TOP_N)
      .map(m => m.symbol);

    if (watchlist.length) {
      const marketSet = new Set(Object.keys(exchange.markets).map(normalizeSymbol));
      symbols = watchlist
        .map(normalizeSymbol)
        .filter(s => marketSet.has(s));
      if (!symbols.length) {
        console.log('Watchlist is set, but no symbols matched this exchange.');
        return;
      }
    }

    const ideas = [];
    for (const s of symbols) {
      try {
        const candles = await exchange.fetchOHLCV(s, TF, undefined, LIMIT);
        const setup = buildSetup(s, candles);
        if (setup) ideas.push(setup);
      } catch (e) {}
    }

    ideas.sort((a, b) => b.confidence - a.confidence);

    if (!ideas.length) {
      console.log('No setups right now for ruleset. Try again in a few candles.');
      return;
    }

    const scopeLabel = watchlist.length ? `Watchlist(${symbols.length})` : `Top${TOP_N}`;
    console.log(`${EXCHANGE_ID} USDT Perps | ${TF} | ${scopeLabel} | Top ideas: ${Math.min(10, ideas.length)}\n`);
    for (const i of ideas.slice(0, 10)) {
      console.log(`${i.symbol} | ${i.side} | confidence ${i.confidence}`);
      console.log(`  Entry: ${i.entryZone[0]} - ${i.entryZone[1]} | Stop: ${i.stop} | TP1: ${i.tp1} | TP2: ${i.tp2} | R:R ${i.rr}`);
      console.log(`  RSI14: ${i.rsi14} | ATR14: ${i.atr14} | VolSpike: ${i.volSpike}x`);
      console.log(`  Invalidation: ${i.invalidation}`);
      console.log(`  Why: ${i.why}\n`);
    }
  } catch (e) {
    console.error('Scanner failed:', e.message);
    process.exit(1);
  }
})();
