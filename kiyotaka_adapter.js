const KIYOTAKA_BASE = process.env.KIYOTAKA_BASE_URL || 'https://api.kiyotaka.ai';

function toRawSymbol(symbol = '') {
  return String(symbol).toUpperCase().replace('/USDT:USDT', 'USDT').replace('/USDT', 'USDT');
}

function tfToBinance(tf = '5m') {
  const allowed = new Set(['1m','3m','5m','15m','30m','1h','2h','4h','6h','8h','12h','1d']);
  return allowed.has(tf) ? tf : '5m';
}

function tfToKiyotaka(tf = '5m') {
  const map = { '1m': 'MINUTE', '5m': 'MINUTE', '15m': 'MINUTE', '30m': 'MINUTE', '1h': 'HOUR', '4h': 'HOUR', '1d': 'DAY' };
  return map[tf] || 'MINUTE';
}

module.exports = { KIYOTAKA_BASE, toRawSymbol, tfToBinance, tfToKiyotaka };
