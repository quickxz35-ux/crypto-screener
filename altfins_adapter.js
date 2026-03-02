const ALTFINS_BASE = process.env.ALTFINS_BASE_URL || 'https://altfins.com';

async function postJson(path, body, apiKey = '') {
  if (!apiKey) throw new Error('Missing ALTFINS_API_KEY');
  const r = await fetch(`${ALTFINS_BASE}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'accept': 'application/json',
      'X-API-KEY': apiKey,
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`ALTFINS HTTP ${r.status}`);
  return r.json();
}

async function getJson(path, apiKey = '') {
  if (!apiKey) throw new Error('Missing ALTFINS_API_KEY');
  const r = await fetch(`${ALTFINS_BASE}${path}`, {
    method: 'GET',
    headers: { accept: 'application/json', 'X-API-KEY': apiKey },
  });
  if (!r.ok) throw new Error(`ALTFINS HTTP ${r.status}`);
  return r.json();
}

function tfToAltfins(tf = '5m') {
  const map = {
    '1m': 'MINUTES15',
    '5m': 'HOURLY',
    '15m': 'HOURLY4',
    '30m': 'HOURLY12',
    '1h': 'DAILY',
    '4h': 'DAILY',
    '1d': 'DAILY',
  };
  return map[tf] || 'DAILY';
}

async function getHistoricalAnalytics(symbol, timeframe = '5m', analyticsType = 'RSI14', apiKey = '') {
  const body = {
    symbol: String(symbol || '').toUpperCase().replace('/USDT:USDT', ''),
    timeInterval: tfToAltfins(timeframe),
    analyticsType,
  };
  try {
    const data = await postJson('/api/v1/public/analytics/search-requests', body, apiKey);
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function getAnalyticTypes(apiKey = '') {
  try {
    const data = await getJson('/api/v1/public/analytics/types', apiKey);
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function findNumericDeep(x) {
  if (x == null) return null;
  if (typeof x === 'number' && Number.isFinite(x)) return x;
  if (typeof x === 'string') {
    const n = Number(x);
    if (Number.isFinite(n)) return n;
    return null;
  }
  if (Array.isArray(x)) {
    for (const v of x) {
      const n = findNumericDeep(v);
      if (n != null) return n;
    }
    return null;
  }
  if (typeof x === 'object') {
    for (const k of Object.keys(x)) {
      const n = findNumericDeep(x[k]);
      if (n != null) return n;
    }
  }
  return null;
}

async function getSupportResistance(symbol, timeframe = '5m', apiKey = '') {
  const candidates = ['SUPPORT', 'RESISTANCE', 'SUPPORT_LEVEL', 'RESISTANCE_LEVEL'];
  try {
    let support = null, resistance = null;
    for (const type of candidates) {
      const r = await getHistoricalAnalytics(symbol, timeframe, type, apiKey);
      if (!r.ok) continue;
      const n = findNumericDeep(r.data);
      if (n == null) continue;
      if (type.includes('SUPPORT')) support = n;
      if (type.includes('RESISTANCE')) resistance = n;
    }
    return { ok: support != null || resistance != null, support, resistance };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function inferBiasScore(payload) {
  const txt = JSON.stringify(payload || {}).toUpperCase();
  const bullHits = ['BUY', 'BULL', 'UPTREND', 'BREAKOUT', 'SUPPORT'].filter(k => txt.includes(k)).length;
  const bearHits = ['SELL', 'BEAR', 'DOWNTREND', 'BREAKDOWN', 'RESISTANCE'].filter(k => txt.includes(k)).length;
  if (bullHits === 0 && bearHits === 0) return 50;
  const net = bullHits - bearHits;
  return Math.max(0, Math.min(100, 50 + net * 15));
}

async function getSrSignalPack(symbol, timeframe = '5m', apiKey = '') {
  const probes = [
    { key: 'srBreakoutScore', type: 'SUPPORT_RESISTANCE_BREAKOUT' },
    { key: 'srApproachingScore', type: 'SUPPORT_RESISTANCE_APPROACHING' },
    { key: 'srObOsScore', type: 'SUPPORT_RESISTANCE_OVERBOUGHT_OVERSOLD' },
  ];

  const out = { srBreakoutScore: 50, srApproachingScore: 50, srObOsScore: 50, srSignalSource: 'altfins-probe' };
  let hits = 0;
  for (const p of probes) {
    const r = await getHistoricalAnalytics(symbol, timeframe, p.type, apiKey);
    if (!r.ok) continue;
    out[p.key] = inferBiasScore(r.data);
    hits += 1;
  }
  if (!hits) out.srSignalSource = 'fallback';
  return out;
}

module.exports = { getHistoricalAnalytics, getAnalyticTypes, getSupportResistance, getSrSignalPack, tfToAltfins };
