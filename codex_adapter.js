const CODEX_URL = 'https://api.codex.io/graphql';

async function codexQuery(query, variables = {}, apiKey = '') {
  if (!apiKey) throw new Error('Missing CODEX_API_KEY');
  const r = await fetch(CODEX_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'Authorization': apiKey,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!r.ok) throw new Error(`Codex HTTP ${r.status}`);
  const j = await r.json();
  if (j.errors?.length) throw new Error(j.errors[0].message || 'Codex query error');
  return j.data;
}

function mapToBinanceUnified(symbolLike) {
  const raw = String(symbolLike || '').toUpperCase();
  const base = raw.replace(/[^A-Z0-9]/g, '').replace(/USDT$/, '');
  if (!base) return '';
  return `${base}/USDT:USDT`;
}

async function getCodexTopSymbols(limit = 35, apiKey = '') {
  // Best-effort query; schema can vary by account/version.
  const query = `
    query TopTokens($limit: Int!) {
      filterTokens(limit: $limit, sortBy: VOLUME_USD, sortOrder: DESC) {
        items {
          symbol
          name
        }
      }
    }
  `;

  try {
    const data = await codexQuery(query, { limit }, apiKey);
    const items = data?.filterTokens?.items || [];
    const out = [];
    for (const t of items) {
      const s = mapToBinanceUnified(t?.symbol || t?.name || '');
      if (s) out.push(s);
    }
    return [...new Set(out)].slice(0, limit);
  } catch {
    return [];
  }
}

module.exports = { getCodexTopSymbols };
