import { evaluate } from 'file:///C:/Users/bower/tradingview-mcp/src/connection.js';
const BARS=`window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars()`;
const d = await evaluate(`(function(){
  var ch=window.TradingViewApi._activeChartWidgetWV.value()._chartWidget, src=ch.model().model().dataSources(), s=null;
  for(var i=0;i<src.length;i++){var m=src[i].metaInfo&&src[i].metaInfo(); if(m&&(m.description||'').indexOf('MoonRush')>-1){s=src[i];break;}}
  var raw=null; try{ raw=s.getInputValues(); }catch(e){ raw='err'; }
  var sample = Array.isArray(raw)? raw.slice(0,8).map(function(x){var o={};for(var k in x){var v=x[k]; if(typeof v==='string'&&v.length>40)v='<'+v.length+'chars>'; o[k]=v;} return o;}) : raw;
  var sv={}; var it=s.dataWindowView().items(); for(var j=0;j<it.length;j++){ if(it[j]._title) sv[it[j]._title]=it[j]._value; }
  var b=${BARS}, out=[], end=b.lastIndex(), start=b.firstIndex();
  for(var i=start;i<=end;i++){var v=b.valueAt(i); if(v) out.push([v[1],v[2],v[3],v[4]]);}
  return {rawSample:sample, sv:sv, bars:out};
})()`);
const num=s=>s==null?null:parseFloat(String(s).replace(/,/g,'').replace(/[^0-9.\-]/g,''));
const bars=d.bars, last=a=>a[a.length-1], C=bars.map(x=>x[3]);
console.log('getInputValues() sample element shape:', JSON.stringify(d.rawSample));
function ema(a,L){const k=2/(L+1);let e=a[0],o=[e];for(let i=1;i<a.length;i++){e=a[i]*k+e*(1-k);o.push(e);}return o;}
function rma(a,L){const k=1/L;let e=a[0],o=[e];for(let i=1;i<a.length;i++){e=a[i]*k+e*(1-k);o.push(e);}return o;}
function tr(b){const o=[b[0][1]-b[0][2]];for(let i=1;i<b.length;i++)o.push(Math.max(b[i][1]-b[i][2],Math.abs(b[i][1]-b[i-1][3]),Math.abs(b[i][2]-b[i-1][3])));return o;}
const fast=ema(ema(C,38),10), slow=ema(ema(C,62),10), TR=tr(bars);
const S1=num(d.sv.S1),R1=num(d.sv.R1),P=(S1+R1)/2, impliedATR=(R1-P)/6;
console.log(`\nimplied band ATR = ${impliedATR.toFixed(4)}  center P=${P.toFixed(3)}`);
// scan ATR length for the implied value
let bestL=0,bestE=1e9; for(let L=2;L<=800;L++){const a=last(rma(TR,L)); if(Math.abs(a-impliedATR)<bestE){bestE=Math.abs(a-impliedATR);bestL=L;}}
console.log(`closest RMA-ATR length to ${impliedATR.toFixed(4)}: ATR(${bestL})=${last(rma(TR,bestL)).toFixed(4)} (err ${bestE.toFixed(4)})`);
console.log(`ATR(800)=${last(rma(TR,800)).toFixed(4)}  ATR(100)=${last(rma(TR,100)).toFixed(4)}`);
// scan basis EMA(ema(close,X),Y) for P
let bb='',be=1e9; for(let X=2;X<=120;X++){const e1=ema(C,X); for(let Y=1;Y<=40;Y++){const v=last(ema(e1,Y)); if(Math.abs(v-P)<be){be=Math.abs(v-P);bb=`ema(ema(close,${X}),${Y})`;}}}
console.log(`closest basis to P: ${bb} (err ${be.toFixed(4)})   slow=${last(slow).toFixed(3)} river62/20=${last(ema(ema(C,62),20)).toFixed(3)}`);
// last bullish cross -> entry + ATR(100) there vs TP step 4.337
let xi=-1; for(let i=bars.length-1;i>0;i--){ if(fast[i]>slow[i] && fast[i-1]<=slow[i-1]){xi=i;break;} }
if(xi>0){ const atrSig=last(rma(TR.slice(0,xi+1),100));
  console.log(`\nlast bullish cross at bar ${xi} (from end ${bars.length-1-xi}): close=${C[xi].toFixed(3)}  ATR(100)@signal=${atrSig.toFixed(4)}  0.5*ATR=${(atrSig*0.5).toFixed(4)}  (TP step observed=4.337)`);
} else console.log('\nno bullish cross found in loaded bars');
// RSI(14)
function rsi(a,L){const g=[0],dn=[0];for(let i=1;i<a.length;i++){const c=a[i]-a[i-1];g.push(Math.max(c,0));dn.push(Math.max(-c,0));}const ag=rma(g,L),ad=rma(dn,L);return last(ad)===0?100:100-100/(1+last(ag)/last(ad));}
console.log(`\nRSI(14,close)=${rsi(C,14).toFixed(2)}  (compare to table 1m RSI)`);
process.exit(0);
