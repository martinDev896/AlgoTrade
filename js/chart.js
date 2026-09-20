// ==========================================================
// AlgoTrade — Charts
// Lightweight Charts terminal view fed by Deriv tick history.
// Historical candles come from ticks_history. Live candles are built
// from the normal tick stream so the chart does not depend on a
// separate candle subscription.
// ==========================================================

const CANDLE_GRANULARITY_SECONDS = 60;
const CANDLE_COUNT = 200;

const chartContainerEl = document.getElementById("chart-container");
const chartExpandBtnEl = document.getElementById("chart-expand-btn");

let chart = null;
let candleSeries = null;
let unsubscribeLiveTicks = null;
let resizeObserver = null;
let activeChartSymbol = null;
let lastLiveCandle = null;

function ensureChartCreated() {
  if (chart) return;

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
    width: Math.max(1, chartContainerEl.clientWidth),
    height: Math.max(1, chartContainerEl.clientHeight),
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

  resizeObserver = new ResizeObserver(() => resizeChart());
  resizeObserver.observe(chartContainerEl);

  // The account screen becomes visible after authentication. Give the
  // browser one layout pass before measuring the chart for the first time.
  requestAnimationFrame(resizeChart);
}

function resizeChart() {
  if (!chart) return;
  const width = Math.max(1, Math.floor(chartContainerEl.clientWidth));
  const height = Math.max(1, Math.floor(chartContainerEl.clientHeight));
  if (width && height) chart.applyOptions({ width, height });
}

function normalizeCandle(raw) {
  return {
    time: Number(raw.epoch ?? raw.time),
    open: Number(raw.open),
    high: Number(raw.high),
    low: Number(raw.low),
    close: Number(raw.close),
  };
}

function candleFromTick(tick) {
  const epoch = Number(tick.epoch);
  const quote = Number(tick.quote);
  if (!Number.isFinite(epoch) || !Number.isFinite(quote)) return null;

  // Lightweight Charts accepts UNIX seconds. Bucket each tick into its
  // one-minute candle using UTC epoch seconds.
  const bucket = Math.floor(epoch / CANDLE_GRANULARITY_SECONDS) * CANDLE_GRANULARITY_SECONDS;

  if (!lastLiveCandle || lastLiveCandle.time !== bucket) {
    lastLiveCandle = {
      time: bucket,
      open: quote,
      high: quote,
      low: quote,
      close: quote,
    };
  } else {
    lastLiveCandle.high = Math.max(lastLiveCandle.high, quote);
    lastLiveCandle.low = Math.min(lastLiveCandle.low, quote);
    lastLiveCandle.close = quote;
  }

  return { ...lastLiveCandle };
}

async function loadChartFor(symbol) {
  activeChartSymbol = symbol;
  ensureChartCreated();
  lastLiveCandle = null;
  resizeChart();

  if (unsubscribeLiveTicks) {
    unsubscribeLiveTicks();
    unsubscribeLiveTicks = null;
  }

  // Clear the old market immediately so switching markets never leaves
  // candles from the previous symbol on screen.
  candleSeries.setData([]);

  try {
    const res = await derivAPI.send({
      ticks_history: symbol,
      style: "candles",
      granularity: CANDLE_GRANULARITY_SECONDS,
      count: CANDLE_COUNT,
      end: "latest",
    });

    if (activeChartSymbol !== symbol) return;

    const candles = (res.candles || [])
      .map(normalizeCandle)
      .filter((c) =>
        Number.isFinite(c.time) &&
        Number.isFinite(c.open) &&
        Number.isFinite(c.high) &&
        Number.isFinite(c.low) &&
        Number.isFinite(c.close)
      )
      .sort((a, b) => a.time - b.time);

    if (candles.length) {
      candleSeries.setData(candles);
      lastLiveCandle = candles[candles.length - 1];
      chart.timeScale().fitContent();
    }
  } catch (err) {
    console.error("Chart history failed:", err);
  }

  if (activeChartSymbol !== symbol) return;

  // Build the current candle from live ticks. This is deliberately separate
  // from Markets.js' price subscription so chart updates remain reliable.
  unsubscribeLiveTicks = derivAPI.subscribe({ ticks: symbol }, (data) => {
    if (activeChartSymbol !== symbol || !data.tick || !candleSeries) return;
    const candle = candleFromTick(data.tick);
    if (candle) candleSeries.update(candle);
  });
}

chartExpandBtnEl.addEventListener("click", async () => {
  const workspace = document.querySelector(".chart-area");
  if (!document.fullscreenElement) {
    await workspace.requestFullscreen?.();
  } else {
    await document.exitFullscreen?.();
  }
  setTimeout(resizeChart, 100);
});

document.addEventListener("fullscreenchange", resizeChart);
document.addEventListener("algotrade:symbol-selected", (e) => loadChartFor(e.detail.symbol));
