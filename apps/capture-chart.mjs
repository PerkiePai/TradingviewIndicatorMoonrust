// Subprocess: zoom the active chart to its latest bars, screenshot the chart area, restore the view.
// Usage: node capture-chart.mjs <connection.js file URL> <bars> [outFile]
// Writes the PNG as base64 to stdout (or to outFile if given). Exit code != 0 on failure.
import { writeFileSync } from 'node:fs';

const [connUrl, barsArg = '80', outFile] = process.argv.slice(2);
const BARS = Math.max(10, Number(barsArg) || 80);
const MARGIN = 5;
const { evaluate, getClient } = await import(connUrl);

const CHART = 'window.TradingViewApi._activeChartWidgetWV.value()';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Save the user's view so we can put it back.
const saved = await evaluate(`(function () {
  var ts = ${CHART}._chartWidget.model().timeScale();
  return { spacing: ts.barSpacing(), offset: ts.rightOffset() };
})()`);

let png;
try {
  await evaluate(`(function () {
    var m = ${CHART}._chartWidget.model();
    var last = m.mainSeries().bars().lastIndex();
    m.timeScale().zoomToBarsRange(last - ${BARS}, last + ${MARGIN});
  })()`);
  await sleep(800); // let the canvas re-render

  const bounds = await evaluate(`(function () {
    var panes = Array.prototype.slice.call(document.querySelectorAll('[data-name="pane-canvas"]'));
    if (!panes.length) return null;
    var r = panes.map(function (p) { return p.getBoundingClientRect(); });
    var x = Math.min.apply(null, r.map(function (b) { return b.left; }));
    var y = Math.min.apply(null, r.map(function (b) { return b.top; }));
    var x2 = Math.max.apply(null, r.map(function (b) { return b.right; }));
    var y2 = Math.max.apply(null, r.map(function (b) { return b.bottom; }));
    return { x: x, y: y, width: x2 - x, height: y2 - y };
  })()`);
  const client = await getClient();
  const params = { format: 'png' };
  if (bounds) params.clip = { ...bounds, scale: 1 };
  png = Buffer.from((await client.Page.captureScreenshot(params)).data, 'base64');
} finally {
  try {
    await evaluate(`(function () {
      var ts = ${CHART}._chartWidget.model().timeScale();
      ts.setBarSpacing(${saved.spacing});
      ts.setRightOffset(${saved.offset});
    })()`);
  } catch (e) { console.error('restore failed:', e.message); }
}

if (outFile) { writeFileSync(outFile, png); process.stdout.write('ok', () => process.exit(0)); }
else process.stdout.write(png.toString('base64'), () => process.exit(0));
