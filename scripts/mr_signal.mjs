import { evaluate } from 'file:///C:/Users/bower/tradingview-mcp/src/connection.js';
const BARS=`window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars()`;
const bars = await evaluate(`(function(){var b=${BARS},o=[],e=b.lastIndex(),s=b.firstIndex();for(var i=s;i<=e;i++){var v=b.valueAt(i);if(v)o.push([v[1],v[2],v[3],v[4]]);}return o;})()`);
const last=a=>a[a.length-1], C=bars.map(x=>x[3]);
function ema(a,L){const k=2/(L+1);let e=a[0],o=[e];for(let i=1;i<a.length;i++){e=a[i]*k+e*(1-k);o.push(e);}return o;}
function rma(a,L){const k=1/L;let e=a[0],o=[e];for(let i=1;i<a.length;i++){e=a[i]*k+e*(1-k);o.push(e);}return o;}
function tr(b){const o=[b[0][1]-b[0][2]];for(let i=1;i<b.length;i++)o.push(Math.max(b[i][1]-b[i][2],Math.abs(b[i][1]-b[i-1][3]),Math.abs(b[i][2]-b[i-1][3])));return o;}
const f=ema(ema(C,38),10), s=ema(ema(C,62),10), TR=tr(bars);
// resample 1m -> Nm for higher-TF ATR
function resample(b,n){const o=[];for(let i=0;i<b.length;i+=n){const g=b.slice(i,i+n);if(!g.length)break;o.push([g[0][0],Math.max(...g.map(x=>x[1])),Math.min(...g.map(x=>x[2])),g[g.length-1][3]]);}return o;}
console.log('idx  close    fast     slow    (f+s)/2  cross   ATR100');
const crosses=[];
for(let i=1;i<bars.length;i++){
  const up=f[i]>s[i]&&f[i-1]<=s[i-1], dn=f[i]<s[i]&&f[i-1]>=s[i-1];
  if(up||dn) crosses.push([i,up?'BULL':'BEAR']);
}
for(const [i,t] of crosses.slice(-6)){
  const atr100=last(rma(TR.slice(0,i+1),100));
  console.log(`${i}  ${C[i].toFixed(3)} ${f[i].toFixed(3)} ${s[i].toFixed(3)} ${((f[i]+s[i])/2).toFixed(3)}  ${t}  ${atr100.toFixed(3)}`);
}
// For the most recent cross, compare label entry 4126.11 candidates and TP-step 4.337 to ATRs
const [ci]=crosses[crosses.length-1];
console.log(`\nmost recent cross bar ${ci}: close=${C[ci].toFixed(3)} fast=${f[ci].toFixed(3)} slow=${s[ci].toFixed(3)} mid=${((f[ci]+s[ci])/2).toFixed(3)}`);
for(const n of [100,200,300]) console.log(`  ATR(${n})@cross=${last(rma(TR.slice(0,ci+1),n)).toFixed(3)}  *0.5=${(last(rma(TR.slice(0,ci+1),n))*0.5).toFixed(3)}`);
for(const tf of [5,15,30]){const rb=resample(bars.slice(0,ci+1),tf);const a=last(rma(tr(rb),100));console.log(`  ${tf}m ATR(100)@cross=${a.toFixed(3)} *0.5=${(a*0.5).toFixed(3)}  (bars=${rb.length})`);}
console.log('observed: entry=4126.110  TP step=4.337');
process.exit(0);
