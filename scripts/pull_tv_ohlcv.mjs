// Dump the full loaded main-series bar buffer of the active TradingView chart to CSV.
// Usage: node scripts/pull_tv_ohlcv.mjs [out.csv]
import { evaluate, KNOWN_PATHS } from 'file:///C:/Users/bower/tradingview-mcp/src/connection.js';
import fs from 'node:fs';
const out = process.argv[2] || 'data/XAUUSD_EIGHTCAP_1m.csv';
const st = await evaluate(`(function(){var c=window.TradingViewApi._activeChartWidgetWV.value();return {s:c.symbol(),r:c.resolution()}})()`);
const data = await evaluate(`(function(){
  var b=${KNOWN_PATHS.mainSeriesBars}; var r=[];
  for (var i=b.firstIndex(); i<=b.lastIndex(); i++){var v=b.valueAt(i); if(v) r.push(v.slice(0,6));}
  return r;})()`);
const rows = ['time,open,high,low,close,volume', ...data.map(v => v.map(x => x ?? 0).join(','))];
fs.writeFileSync(out, rows.join('\n') + '\n');
const iso = t => new Date(t * 1000).toISOString();
console.log(st, 'bars', data.length, iso(data[0][0]), '->', iso(data.at(-1)[0]), '->', out);
process.exit(0);
