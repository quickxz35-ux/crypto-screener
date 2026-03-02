#!/usr/bin/env node
const path = require('path');
const express = require('express');
const { execFile } = require('child_process');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;

async function fetchJSON(url, headers = {}) {
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.json();
}

app.use(express.static(path.join(ROOT, 'public')));

function runScan(timeframe = '', provider = 'binance') {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, OUTPUT: 'json', TOP_N: process.env.TOP_N || '25', MAX_IDEAS: process.env.MAX_IDEAS || '15', DATA_PROVIDER: provider };
    if (timeframe) env.TIMEFRAME = timeframe;
    execFile(process.execPath, [path.join(ROOT, 'scan_phase1.js')], {
      cwd: ROOT,
      env,
      maxBuffer: 1024 * 1024 * 4,
      timeout: 90000,
    }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      try {
        const parsed = JSON.parse(stdout || '[]');
        resolve(parsed.map(x => ({ ...x, _provider: provider })));
      } catch (e) {
        reject(new Error('Invalid JSON output from scanner'));
      }
    });
  });
}

async function runMultiScan(timeframe = '', providers = ['binance'], mode = 'union') {
  const unique = [...new Set(providers.map(p => String(p || '').toLowerCase()).filter(Boolean))];
  const scans = await Promise.all(unique.map(async p => {
    try { return { provider: p, rows: await runScan(timeframe, p), ok: true }; }
    catch (e) { return { provider: p, rows: [], ok: false, error: e.message }; }
  }));
  const anyOk = scans.some(s => s.ok);
  if (!anyOk) throw new Error(`All providers failed: ${scans.map(s => `${s.provider}: ${s.error || 'unknown'}`).join(' | ')}`);
  const flat = scans.flatMap(s => s.rows);

  const bySymbol = new Map();
  for (const row of flat) {
    const key = row.symbol;
    if (!bySymbol.has(key)) bySymbol.set(key, []);
    bySymbol.get(key).push(row);
  }

  const merged = [];
  for (const [symbol, rows] of bySymbol.entries()) {
    const best = rows.slice().sort((a, b) => (b.confidence || 0) - (a.confidence || 0))[0];
    const contributors = rows.map(r => r._provider);
    const sideVotes = rows.reduce((acc, r) => ({ ...acc, [r.side]: (acc[r.side] || 0) + 1 }), {});
    const votedSide = (sideVotes.LONG || 0) >= (sideVotes.SHORT || 0) ? 'LONG' : 'SHORT';
    const consensusCount = Math.max(sideVotes.LONG || 0, sideVotes.SHORT || 0);

    if (mode === 'consensus' && consensusCount < 2) continue;

    merged.push({
      ...best,
      side: mode === 'consensus' ? votedSide : best.side,
      contributors,
      agreement: `${consensusCount}/${contributors.length}`
    });
  }

  merged.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
  return merged;
}

app.get('/api/providers', (_req, res) => {
  const providers = [
    { id: 'binance', label: 'Binance (built-in)', ready: true },
    { id: 'codex', label: 'Codex (GraphQL)', ready: !!process.env.CODEX_API_KEY },
    { id: 'altfins', label: 'ALTFINS (analytics API)', ready: !!process.env.ALTFINS_API_KEY },
    { id: 'coinank', label: 'CoinAnk (adapter pending key)', ready: !!process.env.COINANK_API_KEY },
    { id: 'cryptoquant', label: 'CryptoQuant (adapter placeholder)', ready: !!process.env.CRYPTOQUANT_API_KEY },
    { id: 'glassnode', label: 'Glassnode (adapter placeholder)', ready: !!process.env.GLASSNODE_API_KEY }
  ];
  res.json({ ok: true, providers });
});

app.get('/api/scan', async (req, res) => {
  try {
    const tf = String(req.query.tf || '').trim();
    const providersRaw = String(req.query.providers || req.query.provider || 'binance').trim().toLowerCase();
    const mode = String(req.query.mode || 'union').trim().toLowerCase();
    const filtersRaw = String(req.query.filters || '').trim();
    const allowedTf = new Set(['1m','5m','15m','30m','1h','4h','1d']);
    const allowedProviders = new Set(['binance','codex','altfins','coinank','cryptoquant','glassnode']);
    const providers = providersRaw.split(',').map(x => x.trim()).filter(Boolean);
    if (tf && !allowedTf.has(tf)) return res.status(400).json({ ok: false, error: 'Invalid timeframe' });
    if (!['union','consensus'].includes(mode)) return res.status(400).json({ ok: false, error: 'Invalid mode' });
    if (!providers.length || providers.some(p => !allowedProviders.has(p))) return res.status(400).json({ ok: false, error: 'Invalid provider list' });

    let data = await runMultiScan(tf, providers, mode);

    if (filtersRaw) {
      let f = {};
      try { f = JSON.parse(filtersRaw); } catch {}
      data = data.filter(r => {
        const workflow = (f.workflow || 'both').toLowerCase();
        if (f.side && f.side !== 'both' && r.side !== f.side) return false;

        const passDiscovery = (f.minDiscovery == null || Number(r.discoveryScore || 0) >= Number(f.minDiscovery));
        const passEntry =
          (f.minConfidence == null || Number(r.confidence) >= Number(f.minConfidence)) &&
          (f.minRr == null || Number(r.rr) >= Number(f.minRr));

        if (workflow === 'discovery' && !passDiscovery) return false;
        if (workflow === 'entry' && !passEntry) return false;
        if (workflow === 'both' && !(passDiscovery && passEntry)) return false;

        if (f.minVolSpike != null && Number(r.volSpike) < Number(f.minVolSpike)) return false;
        if (f.minOiDelta != null && Number(r.oiDeltaPct) < Number(f.minOiDelta)) return false;
        if (f.minBuySellVolRatio != null && Number(r.buySellVolRatio || 1) < Number(f.minBuySellVolRatio)) return false;
        if (f.maxFundingAbs != null && Math.abs(Number(r.funding)) > Number(f.maxFundingAbs)) return false;
        if (f.minWhaleScore != null && Number(r.whaleScore) < Number(f.minWhaleScore)) return false;
        return true;
      });
    }

    res.json({ ok: true, data, timeframe: tf || process.env.TIMEFRAME || '5m', providers, mode });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/chart', async (req, res) => {
  try {
    const symbol = String(req.query.symbol || 'BTC/USDT:USDT').toUpperCase();
    const tf = String(req.query.tf || '5m');
    const raw = symbol.replace('/USDT:USDT', 'USDT').replace('/USDT', 'USDT');
    const interval = tf;

    const [klines, oiHist, funding, takerLs] = await Promise.all([
      fetchJSON(`https://fapi.binance.com/fapi/v1/klines?symbol=${raw}&interval=${interval}&limit=300`),
      fetchJSON(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${raw}&period=${interval}&limit=200`).catch(() => []),
      fetchJSON(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${raw}&limit=100`).catch(() => []),
      fetchJSON(`https://fapi.binance.com/futures/data/takerlongshortRatio?symbol=${raw}&period=${interval}&limit=300`).catch(() => []),
    ]);

    const candles = (klines || []).map(k => ({
      t: Number(k[0]), o: Number(k[1]), h: Number(k[2]), l: Number(k[3]), c: Number(k[4]), v: Number(k[5]),
    }));

    const oi = (oiHist || []).map(x => ({
      t: Number(x.timestamp || x.time || 0),
      v: Number(x.sumOpenInterest || x.sumOpenInterestValue || x.openInterest || 0),
    })).filter(x => x.t > 0);

    const fr = (funding || []).map(x => ({
      t: Number(x.fundingTime || 0),
      v: Number(x.fundingRate || 0),
    })).filter(x => x.t > 0);

    const taker = (takerLs || []).map(x => ({
      t: Number(x.timestamp || x.time || 0),
      buySellRatio: Number(x.buySellRatio || 1),
      buyVol: Number(x.buyVol || 0),
      sellVol: Number(x.sellVol || 0),
    })).filter(x => x.t > 0);

    res.json({ ok: true, symbol, timeframe: tf, candles, oi, funding: fr, taker });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Dashboard: http://localhost:${PORT}`);
});
