// ==========================================================
// AlgoTrade — chart.js
// Candlestick/line chart via TradingView's lightweight-charts,
// fed by Deriv's real ticks_history + live ohlc stream.
// ==========================================================

const CANDLE_GRANULARITY_SECONDS = 60; // 1-minute candles — the toggle
                                        // button applies at this timeframe.
const CANDLE_COUNT = 200;

const chartContainerEl = document.getElementById("chart-container");
const chartExpandBtnEl = document.getElementById("chart-expand-btn");
const chartTypeBtnEl = document.getElementById("chart-type-btn");

let chart = null;
let candleSeries = null;
let lineSeries = null;
let chartType = "candles"; // "candles" | "line"
let lastCandles = [];      // kept so toggling to line doesn't need a refetch
let unsubscribeCandles = null;

function ensureChartCreated() {
  if (chart) return true;

  if (typeof LightweightCharts === "undefined") {
    chartContainerEl.innerHTML =
      '<p class="chart-error">Chart library failed to load. Check your internet connection and reload the page.</p>';
    return false;
  }

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

  lineSeries = chart.addLineSeries({
    color: "#D4A94A",
    lineWidth: 2,
    priceLineVisible: true,
    lastValueVisible: true,
    visible: false, // candles are the default view
  });

  new ResizeObserver(() => {
    if (!chart) return;
    chart.applyOptions({ width: chartContainerEl.clientWidth, height: chartContainerEl.clientHeight });
  }).observe(chartContainerEl);

  return true;
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

function applyChartType(type) {
  chartType = type;
  candleSeries.applyOptions({ visible: type === "candles" });
  lineSeries.applyOptions({ visible: type === "line" });
  chartTypeBtnEl.textContent = type === "candles" ? "Candles" : "Line";
  chartTypeBtnEl.dataset.next = type === "candles" ? "line" : "candles";
}

function pushCandleToLine(candle) {
  lineSeries.update({ time: candle.time, value: candle.close });
}

async function loadChartFor(symbol) {
  if (!ensureChartCreated()) return; // error message already shown

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

    const candles = (res.candles || res.history || [])
      .map(normalizeCandle)
      .filter((c) => Number.isFinite(c.time));

    lastCandles = candles;

    if (candles.length) {
      candleSeries.setData(candles);
      lineSeries.setData(candles.map((c) => ({ time: c.time, value: c.close })));
      chart.timeScale().fitContent();
    } else {
      console.warn("Chart history returned no candles for", symbol, res);
    }
  } catch (err) {
    console.error("Chart history failed:", err.message);
  }

  unsubscribeCandles = derivAPI.subscribe(
    {
      ticks_history: symbol,
      style: "candles",
      granularity: CANDLE_GRANULARITY_SECONDS,
      end: "latest",
      count: 1,
    },
    (data) => {
      if (!data.ohlc) return;
      const candle = normalizeCandle(data.ohlc);
      candleSeries.update(candle);
      pushCandleToLine(candle);
    }
  );
}

// ---- Floating chart-type toggle (bottom-left of the chart) ----
if (chartTypeBtnEl) {
  chartTypeBtnEl.addEventListener("click", () => {
    applyChartType(chartTypeBtnEl.dataset.next || "line");
  });
}

// ---- Optional fullscreen expand button ----
if (chartExpandBtnEl) {
  chartExpandBtnEl.addEventListener("click", async () => {
    const workspace = document.querySelector(".chart-area");
    if (!document.fullscreenElement) {
      await workspace.requestFullscreen?.();
    } else {
      await document.exitFullscreen?.();
    }
    setTimeout(() => {
      chart?.applyOptions({ width: chartContainerEl.clientWidth, height: chartContainerEl.clientHeight });
    }, 100);
  });
}

document.addEventListener("algotrade:symbol-selected", (e) => loadChartFor(e.detail.symbol));
