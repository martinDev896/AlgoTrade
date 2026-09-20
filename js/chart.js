// ==========================================================
// AlgoTrade — Charts
// Historical candles are built from Deriv tick history so the chart
// does not depend on Deriv's candle-history response format. Live ticks
// are then applied to the current one-minute candle.
// ==========================================================

const CANDLE_GRANULARITY_SECONDS = 60;
const TICK_HISTORY_COUNT = 3000;

const chartContainerEl = document.getElementById("chart-container");
const chartExpandBtnEl = document.getElementById("chart-expand-btn");

let chart = null;
let candleSeries = null;
let unsubscribeLiveTicks = null;
let resizeObserver = null;
let activeChartSymbol = null;
let lastLiveCandle = null;

function ensureChartCreated() {
  if (chart || !chartContainerEl) return;

  if (!window.LightweightCharts) {
    chartContainerEl.innerHTML = '<div class="chart-placeholder">Chart library could not be loaded.</div>';
    console.error("Lightweight Charts is not available.");
    return;
  }

  chartContainerEl.innerHTML = "";
  chart = LightweightCharts.createChart(chartContainerEl, {
    layout: { background: { color: "#FFFFFF" }, textColor: "#333333" },
    grid: { vertLines: { color: "#F0F2F5" }, horzLines: { color: "#F0F2F5" } },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    rightPriceScale: {
      borderColor: "#DDE2E7",
      scaleMargins: { top: 0.08, bottom: 0.08 },
    },
    timeScale: {
      borderColor: "#DDE2E7",
      timeVisible: true,
      secondsVisible: false,
      rightOffset: 8,
      barSpacing: 8,
      minBarSpacing: 3,
    },
    handleScroll: true,
    handleScale: true,
  });

  candleSeries = chart.addCandlestickSeries({
    upColor: "#19A974",
    downColor: "#E05252",
    borderVisible: false,
    wickUpColor: "#19A974",
    wickDownColor: "#E05252",
    priceLineVisible: true,
    lastValueVisible: true,
  });

  resizeObserver = new ResizeObserver(resizeChart);
  resizeObserver.observe(chartContainerEl);
  requestAnimationFrame(resizeChart);
}

function resizeChart() {
  if (!chart || !chartContainerEl) return;
  const width = Math.max(1, Math.floor(chartContainerEl.clientWidth));
  const height = Math.max(1, Math.floor(chartContainerEl.clientHeight));
  chart.applyOptions({ width, height });
}

function candleFromTickValues(epoch, quote, previous) {
  const time = Number(epoch);
  const price = Number(quote);
  if (!Number.isFinite(time) || !Number.isFinite(price)) return null;

  const bucket = Math.floor(time / CANDLE_GRANULARITY_SECONDS) * CANDLE_GRANULARITY_SECONDS;

  if (!previous || previous.time !== bucket) {
    return { time: bucket, open: price, high: price, low: price, close: price };
  }

  return {
    time: bucket,
    open: previous.open,
    high: Math.max(previous.high, price),
    low: Math.min(previous.low, price),
    close: price,
  };
}

function buildCandles(times, prices) {
  const candles = [];
  let current = null;
  const count = Math.min(times.length, prices.length);

  for (let i = 0; i < count; i++) {
    const next = candleFromTickValues(times[i], prices[i], current);
    if (!next) continue;

    if (!current || current.time !== next.time) {
      if (current) candles.push(current);
      current = next;
    } else {
      current = next;
    }
  }

  if (current) candles.push(current);
  return candles;
}

async function loadChartFor(symbol) {
  activeChartSymbol = symbol;
  ensureChartCreated();
  lastLiveCandle = null;
  resizeChart();

  if (!candleSeries) return;

  if (unsubscribeLiveTicks) {
    await unsubscribeLiveTicks();
    unsubscribeLiveTicks = null;
  }

  candleSeries.setData([]);

  try {
    // Request ticks and build candles locally. This is more reliable across
    // Deriv synthetic markets than depending on the candle-history response.
    const res = await derivAPI.send({
      ticks_history: symbol,
      style: "ticks",
      count: TICK_HISTORY_COUNT,
      end: "latest",
    });

    if (activeChartSymbol !== symbol) return;

    const times = res.history?.times || [];
    const prices = res.history?.prices || [];
    const candles = buildCandles(times, prices);

    if (candles.length) {
      candleSeries.setData(candles);
      lastLiveCandle = candles[candles.length - 1];
      chart.timeScale().fitContent();
    }
  } catch (err) {
    console.error("Chart history failed:", err);
  }

  if (activeChartSymbol !== symbol) return;

  unsubscribeLiveTicks = derivAPI.subscribe({ ticks: symbol }, (data) => {
    if (activeChartSymbol !== symbol || !data.tick || !candleSeries) return;

    const next = candleFromTickValues(data.tick.epoch, data.tick.quote, lastLiveCandle);
    if (!next) return;

    lastLiveCandle = next;
    candleSeries.update(next);
  });
}

chartExpandBtnEl.addEventListener("click", async () => {
  const workspace = document.querySelector(".chart-area");
  if (!workspace) return;

  if (!document.fullscreenElement) {
    await workspace.requestFullscreen?.();
  } else {
    await document.exitFullscreen?.();
  }
  setTimeout(resizeChart, 100);
});

document.addEventListener("fullscreenchange", resizeChart);
document.addEventListener("algotrade:symbol-selected", (e) => {
  loadChartFor(e.detail.symbol);
});
