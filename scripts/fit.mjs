// Black-box fit for MoonRush V2. Pulls bars + live study values over CDP, brute-forces
// MA/ATR/RSI params against the indicator's own named plots. Reusable per symbol.
import { evaluate } from 'file:///C:/Users/bower/tradingview-mcp/src/connection.js';

const BARS = `window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars()`;

async function pull() {
  const bars = await evaluate(`(function(){
    var b=${BARS}; if(!b||!b.lastIndex) return null;
    var out=[], end=b.lastIndex(), start=Math.max(b.firstIndex(), end-499);
    for(var i=start;i<=end;i++){var v=b.valueAt(i); if(v) out.push([v[1],v[2],v[3],v[4]]);}
    return out;
  })()`);
  const sv = await evaluate(`(function(){
    var ch=window.TradingViewApi._activeChartWidgetWV.value()._chartWidget, src=ch.model().model().dataSources(), r={};
    for(var i=0;i<src.length;i++){var s=src[i]; if(!s.metaInfo) continue;
      var m=s.metaInfo(), n=m.description||m.shortDescription||''; if(n.indexOf('MoonRush')===-1) continue;
      var dwv=s.dataWindowView(); if(!dwv) continue; var it=dwv.items();
      for(var j=0;j<it.length;j++){ if(it[j]._title) r[it[j]._title]=it[j]._value; } break; }
    return r;
  })()`);
  return { bars, sv };
}

const num = s => s==null?null:parseFloat(String(s).replace(/,/g,'').replace(/[^0-9.\-]/g,''));

// --- source series ---
const SRC = {
  close: b => b.map(x=>x[3]),
  hl2:   b => b.map(x=>(x[1]+x[2])/2),
  hlc3:  b => b.map(x=>(x[1]+x[2]+x[3])/3),
  ohlc4: b => b.map(x=>(x[0]+x[1]+x[2]+x[3])/4),
};
// --- moving averages (return full series) ---
function ema(a,L){const k=2/(L+1);let e=a[0],o=[e];for(let i=1;i<a.length;i++){e=a[i]*k+e*(1-k);o.push(e);}return o;}
function rma(a,L){const k=1/L;let e=a[0],o=[e];for(let i=1;i<a.length;i++){e=a[i]*k+e*(1-k);o.push(e);}return o;}
function sma(a,L){const o=[];let s=0;for(let i=0;i<a.length;i++){s+=a[i];if(i>=L)s-=a[i-L];o.push(i>=L-1?s/L:a[i]);}return o;}
function wma(a,L){const o=[];for(let i=0;i<a.length;i++){if(i<L-1){o.push(a[i]);continue;}let s=0,w=0;for(let j=0;j<L;j++){const wt=L-j;s+=a[i-j]*wt;w+=wt;}o.push(s/w);}return o;}
const last = x => x[x.length-1];

function trueRange(b){const o=[b[0][1]-b[0][2]];for(let i=1;i<b.length;i++){const h=b[i][1],l=b[i][2],pc=b[i-1][3];o.push(Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc)));}return o;}
function rsi(a,L){const g=[0],d=[0];for(let i=1;i<a.length;i++){const c=a[i]-a[i-1];g.push(Math.max(c,0));d.push(Math.max(-c,0));}const ag=rma(g,L),ad=rma(d,L);return last(ad)===0?100:100-100/(1+last(ag)/last(ad));}

function fitMA(bars, target, label){
  if(target==null){console.log(`  ${label}: (no target)`);return;}
  const results=[];
  for(const [sn,sf] of Object.entries(SRC)){
    const s=sf(bars);
    for(let L=2;L<=100;L++){
      const singles={ema:last(ema(s,L)),rma:last(rma(s,L)),sma:last(sma(s,L)),wma:last(wma(s,L))};
      for(const [mn,val] of Object.entries(singles)) results.push([Math.abs(val-target),`${mn}(${sn},${L})`,val]);
      // double ema (smoothed): ema(ema(src,L),L2)
      const e1=ema(s,L);
      for(let L2=1;L2<=30;L2++){const v=last(ema(e1,L2));results.push([Math.abs(v-target),`ema(ema(${sn},${L}),${L2})`,v]);}
    }
  }
  results.sort((a,b)=>a[0]-b[0]);
  console.log(`  ${label}  target=${target}`);
  for(const r of results.slice(0,4)) console.log(`    err ${r[0].toFixed(4)}  ${r[1]} = ${r[2].toFixed(4)}`);
}

function fitATR(bars, offset, label){
  if(offset==null){console.log(`  ${label}: (no target)`);return;}
  const tr=trueRange(bars);
  console.log(`  ${label}  offset-unit=${offset}`);
  const out=[];
  for(let L=2;L<=50;L++){
    const a=last(rma(tr,L)), sm=last(sma(tr,L));
    out.push([a, `RMA/ATR(${L})`, offset/a]);
    out.push([sm,`SMA_TR(${L})`, offset/sm]);
  }
  // show the L whose multiplier is closest to a "clean" number
  const clean=[0.5,1,1.5,2,2.5,3,3.5,4,5];
  out.map(o=>{const m=o[2];const near=clean.reduce((p,c)=>Math.abs(c-m)<Math.abs(p-m)?c:p);o.push(Math.abs(near-m),near);return o;})
     .sort((a,b)=>a[3]-b[3]).slice(0,5)
     .forEach(o=>console.log(`    ${o[1]}=${o[0].toFixed(4)}  mult=${o[2].toFixed(3)}  (near ${o[4]}, off ${o[3].toFixed(3)})`));
}

const { bars, sv } = await pull();
console.log(`bars=${bars.length}  last close=${bars.length?last(bars)[3]:'?'}`);
console.log('study values:', JSON.stringify(sv));

const fast=num(sv['Fast EMA (smoothed)']), slow=num(sv['Slow EMA (smoothed)']), tc=num(sv['Trend Candles Overlay']);
const S1=num(sv.S1),S2=num(sv.S2),S3=num(sv.S3),R1=num(sv.R1),R2=num(sv.R2),R3=num(sv.R3);
const P=(S1!=null&&R1!=null)?(S1+R1)/2:null;
const unit=(R1!=null&&P!=null)?(R1-P)/2:null; // levels assumed at P Â± {2,3,4}*unit
console.log(`center P=${P}  band unit (step)=${unit}`);
if(R1!=null) console.log(`offsets from P:  R1=${(R1-P).toFixed(3)} R2=${(R2-P).toFixed(3)} R3=${(R3-P).toFixed(3)} | S1=${(P-S1).toFixed(3)} S2=${(P-S2).toFixed(3)} S3=${(P-S3).toFixed(3)}`);

console.log('\n== Fast EMA fit =='); fitMA(bars, fast, 'Fast');
console.log('\n== Slow EMA fit =='); fitMA(bars, slow, 'Slow');
console.log('\n== Center P fit =='); fitMA(bars, P, 'P');
console.log('\n== Trend Candles fit =='); fitMA(bars, tc, 'TrendCandle');
console.log('\n== Band step (unit) ATR fit =='); fitATR(bars, unit, 'bandUnit');
console.log('\n== Band R1 offset (2*unit) ATR fit =='); fitATR(bars, R1!=null?R1-P:null, 'R1off');

console.log('\n== RSI (1m) ==');
const cl=SRC.close(bars);
for(const L of [7,9,14,21]) console.log(`  RSI(${L}) = ${rsi(cl,L).toFixed(2)}`);

process.exit(0);

