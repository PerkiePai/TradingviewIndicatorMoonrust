import { evaluate } from 'file:///C:/Users/bower/tradingview-mcp/src/connection.js';
// Dump the ACTUAL (possibly user-overridden) MoonRush input values + current TP labels.
const d = await evaluate(`(function(){
  var ch=window.TradingViewApi._activeChartWidgetWV.value()._chartWidget, src=ch.model().model().dataSources(), s=null;
  for(var i=0;i<src.length;i++){var m=src[i].metaInfo&&src[i].metaInfo(); if(m&&(m.description||'').indexOf('MoonRush')>-1){s=src[i];break;}}
  var meta=s.metaInfo();
  // map input id -> {name, defval, current}
  var iv={}; try{ var a=s.getInputValues(); for(var k=0;k<a.length;k++){ iv[a[k].id]=a[k].value; } }catch(e){ iv={err:e.message}; }
  var rows=[];
  (meta.inputs||[]).forEach(function(p){
    if(p.id==='text'||p.id==='pineId'||p.id==='pineVersion'||p.id==='pineFeatures') return;
    var cur = iv[p.id];
    if(typeof cur==='string' && cur.length>60) return;
    rows.push({id:p.id, name:p.name, def:p.defval, cur:cur});
  });
  // current TP/entry labels
  var labels=[]; try{
    var g=s._graphics._primitivesCollection, outer=g.dwglabels.get('labels'), coll=outer.get(false);
    coll._primitivesDataById.forEach(function(v){ labels.push({t:v.t, y:v.y}); });
  }catch(e){}
  return {rows:rows, labels:labels};
})()`);
console.log('INPUT (name | default | current):');
for(const r of d.rows) console.log(`  ${r.id.padEnd(7)} ${String(r.name).padEnd(26)} def=${JSON.stringify(r.def)}  cur=${JSON.stringify(r.cur)}`);
console.log('\nLABELS (entry/TP):');
for(const l of d.labels) console.log(`  ${l.t}  @ ${l.y}`);
process.exit(0);
