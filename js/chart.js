// ==========================================================
// AlgoTrade — Charts
// Lightweight Charts terminal view fed by Deriv ticks_history.
// ==========================================================

const CANDLE_GRANULARITY_SECONDS = 60;
const CANDLE_COUNT = 200;

const chartContainerEl = document.getElementById("chart-container");
const chartExpandBtnEl = document.getElementById("chart-expand-btn");

let chart = null;
let candleSeries = null;
let unsubscribeCandles = null;
let resizeObserver = null;

function ensureChartCreated() {
  if (chart) return;

  chartContainerEl.innerHTML = "";
  chart = LightweightCharts.createChart(chartContainerEl, {
    layout: { background: { color: "#FFFFFF" }, textColor: "#333333" },
    grid: { vertLines: { color: "#F0F2F5" }, horzLines: { color: "#F0F2F5" } },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    rightPriceScale: { borderColor: "#DDE2E7", scaleMargins: { top: 0.08, bottom: 0.08 } },
    timeScale: { borderColor: "#DDE2E7", timeVisible: true, secondsVisible: false, rightOffset: 8 },
    handleScroll: true,
    handleScale: true,
    width: chartContainerEl.clientWidth,
    height: chartContainerEl.clientHeight,
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

  resizeObserver = new ResizeObserver(() => {
    if (!chart) return;
    chart.applyOptions({ width: chartContainerEl.clientWidth, height: chartContainerEl.clientHeight });
  });
  resizeObserver.observe(chartContainerEl);
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

async function loadChartFor(symbol) {
  ensureChartCreated();

  if (unsubscribeCandles) {
    unsubscribeCandles();
    unsubscribeCandles = null;
  }

  try {
    const res = await derivAPI.send({
      ticks_history: symbol,
      style: "candles",
      granularity: CANDLE_GRANULARITY_SECONDS,
      count: CANDLE_COUNT,
      end: "latest",
    });

    const candles = (res.candles || res.history || []).map(normalizeCandle).filter((c) => Number.isFinite(c.time));
    if (candles.length) {
      candleSeries.setData(candles);
      chart.timeScale().fitContent();
    }
  } catch (err) {
    console.error("Chart history failed:", err.message);
  }

  unsubscribeCandles = derivAPI.subscribe({
    ticks_history: symbol,
    style: "candles",
    granularity: CANDLE_GRANULARITY_SECONDS,
    end: "latest",
    count: 1,
  }, (data) => {
    if (data.ohlc) candleSeries.update(normalizeCandle(data.ohlc));
  });
}

chartExpandBtnEl.addEventListener("click", async () => {
  const workspace = document.querySelector(".chart-area");
  if (!document.fullscreenElement) {
    await workspace.requestFullscreen?.();
  } else {
    await document.exitFullscreen?.();
  }
  setTimeout(() => chart?.applyOptions({ width: chartContainerEl.clientWidth, height: chartContainerEl.clientHeight }), 100);
});

document.addEventListener("algotrade:symbol-selected", (e) => loadChartFor(e.detail.symbol));
