import { evaluate } from 'file:///C:/Users/bower/tradingview-mcp/src/connection.js';
const out = await evaluate(`(function(){
  var ch=window.TradingViewApi._activeChartWidgetWV.value()._chartWidget, src=ch.model().model().dataSources(), s=null;
  for(var i=0;i<src.length;i++){var m=src[i].metaInfo&&src[i].metaInfo(); if(m&&(m.description||'').indexOf('MoonRush')>-1){s=src[i];break;}}
  if(!s) return {err:'not found'};
  var info={keys:Object.keys(s), proto:Object.getOwnPropertyNames(Object.getPrototypeOf(s)).filter(function(k){return typeof s[k]==='function';})};
  // try to find a series accessor
  var probes={};
  ['data','series','studyData','_data','bars','_series','firstValue','priceScale'].forEach(function(k){
    try{ probes[k]= s[k]? (typeof s[k]==='function'?'fn':typeof s[k]) : null; }catch(e){ probes[k]='err'; }
  });
  // metaInfo plots
  var meta=s.metaInfo();
  info.plots = (meta.plots||[]).map(function(p){return p.id+':'+p.type;});
  info.styles = meta.styles? Object.keys(meta.styles):[];
  info.inputs = (meta.inputs||[]).map(function(x){return x.id+'='+x.defval+' ('+x.name+')';});
  info.probes = probes;
  return info;
})()`);
console.log(JSON.stringify(out,null,1));
process.exit(0);

