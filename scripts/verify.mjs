import { evaluate } from 'file:///C:/Users/bower/tradingview-mcp/src/connection.js';
const BARS = `window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars()`;

const d = await evaluate(`(function(){
  var ch=window.TradingViewApi._activeChartWidgetWV.value()._chartWidget, src=ch.model().model().dataSources(), s=null;
  for(var i=0;i<src.length;i++){var m=src[i].metaInfo&&src[i].metaInfo(); if(m&&(m.description||'').indexOf('MoonRush')>-1){s=src[i];break;}}
  var iv=null; try{ iv=s.getInputValues?s.getInputValues():(s.inputs?s.inputs():null); }catch(e){ iv='err:'+e.message; }
  // study values
  var sv={}; var dwv=s.dataWindowView(), it=dwv.items();
  for(var j=0;j<it.length;j++){ if(it[j]._title) sv[it[j]._title]=it[j]._value; }
  // bars (all loaded)
  var b=${BARS}, out=[], end=b.lastIndex(), start=b.firstIndex();
  for(var i=start;i<=end;i++){var v=b.valueAt(i); if(v) out.push([v[1],v[2],v[3],v[4]]);}
  return {inputs:iv, sv:sv, bars:out};
})()`);

const num = s => s==null?null:parseFloat(String(s).replace(/,/g,'').replace(/[^0-9.\-]/g,''));
const bars=d.bars, last=x=>x[x.length-1];
console.log('actual input values:', JSON.stringify(d.inputs));
console.log('bars loaded:', bars.length, ' last close', last(bars)[3]);
console.log('study values:', JSON.stringify(d.sv));

const SRC={close:b=>b.map(x=>x[3]),hl2:b=>b.map(x=>(x[1]+x[2])/2),hlc3:b=>b.map(x=>(x[1]+x[2]+x[3])/3),ohlc4:b=>b.map(x=>(x[0]+x[1]+x[2]+x[3])/4)};
function ema(a,L){const k=2/(L+1);let e=a[0],o=[e];for(let i=1;i<a.length;i++){e=a[i]*k+e*(1-k);o.push(e);}return o;}
function rma(a,L){const k=1/L;let e=a[0],o=[e];for(let i=1;i<a.length;i++){e=a[i]*k+e*(1-k);o.push(e);}return o;}
function tr(b){const o=[b[0][1]-b[0][2]];for(let i=1;i<b.length;i++)o.push(Math.max(b[i][1]-b[i][2],Math.abs(b[i][1]-b[i-1][3]),Math.abs(b[i][2]-b[i-1][3])));return o;}

const fast=num(d.sv['Fast EMA (smoothed)']), slow=num(d.sv['Slow EMA (smoothed)']), tc=num(d.sv['Trend Candles Overlay']);
const S1=num(d.sv.S1),R1=num(d.sv.R1),R2=num(d.sv.R2);
const P=(S1!=null&&R1!=null)?(S1+R1)/2:null;

console.log('\n-- EMA formula check (smoothed = ema(ema(src,L),smooth)) --');
for(const [sn,sf] of Object.entries(SRC)){
  const s=sf(bars);
  const F=last(ema(ema(s,38),10)), Sl=last(ema(ema(s,62),10)), Fs=last(ema(s,38)), Ss=last(ema(s,62));
  console.log(`src=${sn}: ema(ema,38/10)=${F.toFixed(3)} (Î”${(F-fast).toFixed(3)})  ema(ema,62/10)=${Sl.toFixed(3)} (Î”${(Sl-slow).toFixed(3)})  | single38=${Fs.toFixed(3)} single62=${Ss.toFixed(3)}`);
}
console.log(`observed Fast=${fast} Slow=${slow}`);

console.log('\n-- Center/River check (P='+P+', TrendCandles='+tc+') --');
for(const [sn,sf] of Object.entries(SRC)){
  const s=sf(bars);
  console.log(`src=${sn}: ema(ema,62/20)=${last(ema(ema(s,62),20)).toFixed(3)}  ema(ema,62/10)=${last(ema(ema(s,62),10)).toFixed(3)}  ema62=${last(ema(s,62)).toFixed(3)}`);
}

console.log('\n-- ATR bands check: offset = ATR(len)*mult, basis=? --');
const atr800=last(rma(tr(bars),800)), atr_n=last(rma(tr(bars),Math.min(800,bars.length-1)));
console.log(`ATR(800)=${atr800.toFixed(4)} (needs 800 bars; have ${bars.length})  ATR(${Math.min(800,bars.length-1)})=${atr_n.toFixed(4)}`);
console.log(`R1 offset from P = ${(R1-P).toFixed(4)}  => implied ATR = offset/6 = ${((R1-P)/6).toFixed(4)}`);
console.log(`R2 offset from P = ${(R2-P).toFixed(4)}  => /9 = ${((R2-P)/9).toFixed(4)}`);
// what basis makes P? try ema river / ohlc4 etc already above. Also check P vs (fast+slow)/2
console.log(`(fast+slow)/2 = ${((fast+slow)/2).toFixed(3)}  vs P=${P}`);

console.log('\n-- TP step check: ATR(100)*0.5 --');
const atr100=last(rma(tr(bars),100)), atr100s=last(((a,L)=>{const o=[];let s=0;for(let i=0;i<a.length;i++){s+=a[i];if(i>=L)s-=a[i-L];o.push(i>=L-1?s/L:a[i]);}return o;})(tr(bars),100));
console.log(`ATR(100) rma=${atr100.toFixed(4)} *0.5=${(atr100*0.5).toFixed(4)}   sma=${atr100s.toFixed(4)} *0.5=${(atr100s*0.5).toFixed(4)}`);
process.exit(0);

