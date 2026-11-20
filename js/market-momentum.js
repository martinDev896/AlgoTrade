// ==========================================================
// AlgoTrade — Market Momentum Analysis
// Uses the app's ONE shared Deriv tick stream (markets.js).
// ==========================================================
(() => {
  const $ = (id) => document.getElementById(id);
  const marketEl = $('mm-market'), typeEl = $('mm-type'), barrierEl = $('mm-barrier');
  const predictionEl = $('mm-prediction'), windowEl = $('mm-window');
  const chartEl = $('mm-chart'), historyEl = $('mm-history'), insightsEl = $('mm-insights');
  const tradePanel = $('trade-panel'), tradeSlot = $('mm-trade-slot');
  const digitWidget = $('digits-widget'), digitSlot = $('mm-digits-slot');
  const tradeToggle = $('mm-trade-toggle');
  if (!marketEl || !tradePanel || !digitWidget) return;

  const tradeHome = tradePanel.parentElement;
  const tradeAnchor = document.createComment('trade-panel-home');
  tradeHome.insertBefore(tradeAnchor, tradePanel);
  const digitHome = digitWidget.parentElement;
  const digitAnchor = document.createComment('digits-widget-home');
  digitHome.insertBefore(digitAnchor, digitWidget);

  let active = false, symbol = null, meta = null, quotes = [], outcomes = [], generation = 0;
  let loading = false, bufferedTicks = [], tradeHidden = false;
  const choices = [1000, 500, 250, 100, 50, 25];

  for (let d = 0; d <= 9; d++) {
    const a = document.createElement('option'); a.value = String(d); a.textContent = String(d); barrierEl.appendChild(a);
    const b = document.createElement('option'); b.value = String(d); b.textContent = String(d); predictionEl.appendChild(b);
  }

  function isDigitType() { return typeEl.value !== 'rise_fall'; }
  function digitsSupported(s) { return s && s.marketCode === 'synthetic_index'; }
  function decimals() {
    const str = String(meta?.pipSize ?? 0.001), dot = str.indexOf('.');
    return dot < 0 ? 0 : str.length - dot - 1;
  }
  function lastDigit(q) { return Number(Number(q).toFixed(decimals()).slice(-1)); }
  function selectedWindow() { return Number(windowEl.value) || 1000; }
  function selectedBarrier() { return Number(barrierEl.value); }
  function labelFor(d) {
    switch (typeEl.value) {
      case 'even_odd': return d % 2 === 0 ? 'Even' : 'Odd';
      case 'over_under': return d > selectedBarrier() ? 'Over' : 'Under';
      case 'matches_differs': return d === Number(predictionEl.value) ? 'Match' : 'Differ';
      default: return '';
    }
  }
  function outcomeForDigit(d) {
    if (typeEl.value === 'even_odd') return d % 2 === 0 ? 'a' : 'b';
    if (typeEl.value === 'over_under') return d > selectedBarrier() ? 'a' : 'b';
    return d === Number(predictionEl.value) ? 'a' : 'b';
  }
  function buildOutcomes() {
    if (isDigitType()) return quotes.map(q => ({ kind: outcomeForDigit(lastDigit(q)), digit: lastDigit(q), quote: q }));
    const arr = [];
    for (let i = 1; i < quotes.length; i++) {
      const diff = Number(quotes[i]) - Number(quotes[i - 1]);
      arr.push({ kind: diff > 0 ? 'a' : diff < 0 ? 'b' : 'flat', quote: quotes[i] });
    }
    return arr;
  }
  function countsFor(list) {
    const counts = { a: 0, b: 0, flat: 0 };
    list.forEach(x => { if (counts[x.kind] !== undefined) counts[x.kind]++; });
    return counts;
  }
  function pct(n, total) { return total ? (n / total * 100) : 0; }
  function currentStreak(list) {
    if (!list.length) return { kind: '—', count: 0 };
    const kind = list[list.length - 1].kind;
    let count = 0;
    for (let i = list.length - 1; i >= 0 && list[i].kind === kind; i--) count++;
    return { kind, count };
  }
  function longestStreak(list) {
    let best = 0, run = 0, prev = null;
    list.forEach(x => { if (x.kind === 'flat') { run = 0; prev = null; } else { run = x.kind === prev ? run + 1 : 1; prev = x.kind; best = Math.max(best, run); } });
    return best;
  }
  function names() {
    if (typeEl.value === 'even_odd') return ['Even', 'Odd'];
    if (typeEl.value === 'over_under') return [`Over ${selectedBarrier()}`, `Under ${selectedBarrier()}`];
    if (typeEl.value === 'matches_differs') return [`Matches ${predictionEl.value}`, `Differs ${predictionEl.value}`];
    return ['Rise', 'Fall'];
  }
  function render() {
    if (!active) return;
    const data = buildOutcomes().slice(-selectedWindow());
    const valid = data.filter(x => x.kind !== 'flat');
    const counts = countsFor(data), total = valid.length, [nameA, nameB] = names();
    const pctA = pct(counts.a, total), pctB = pct(counts.b, total);
    const bars = typeEl.value === 'matches_differs' ? Array.from({length:10}, (_,d) => ({ label:String(d), a: data.filter(x => x.digit === d && x.kind === 'a').length, b: data.filter(x => x.digit === d && x.kind === 'b').length, total:data.filter(x=>x.digit===d).length })) : [
      { label:nameA, count:counts.a, percent:pctA, color:'up' },
      { label:nameB, count:counts.b, percent:pctB, color:'down' }
    ];
    chartEl.innerHTML = '';
    if (typeEl.value === 'matches_differs') {
      bars.forEach(bar => {
        const wrap = document.createElement('div'); wrap.className = 'mm-bar-item';
        const pctVal = pct(bar.total, data.length);
        wrap.innerHTML = `<div class="mm-bar-value">${pctVal.toFixed(1)}%</div><div class="mm-bar-track"><div class="mm-bar-fill ${bar.label === predictionEl.value ? 'up' : 'down'}" style="height:${Math.max(1,pctVal)}%"></div></div><b>${bar.label}</b><small>${bar.total}</small>`;
        chartEl.appendChild(wrap);
      });
    } else {
      bars.forEach(bar => {
        const wrap = document.createElement('div'); wrap.className = 'mm-bar-item';
        wrap.innerHTML = `<div class="mm-bar-value">${bar.percent.toFixed(1)}%</div><div class="mm-bar-track"><div class="mm-bar-fill ${bar.color}" style="height:${Math.max(1,bar.percent)}%"></div></div><b>${bar.label}</b><small>${bar.count}</small>`;
        chartEl.appendChild(wrap);
      });
    }
    $('mm-chart-legend').innerHTML = typeEl.value === 'matches_differs'
      ? `<span><i class="up"></i> Prediction: ${predictionEl.value} (match)</span><span><i class="down"></i> Other digits (differ)</span>`
      : `<span><i class="up"></i>${nameA}</span><span><i class="down"></i>${nameB}</span>${typeEl.value === 'rise_fall' ? '<span><i class="flat"></i>Flat movements excluded</span>' : ''}`;

    const recent = data.slice(-Math.max(1, Math.floor(data.length / 4)));
    const earlier = data.slice(0, Math.max(0, data.length - recent.length));
    const rc = countsFor(recent), ec = countsFor(earlier);
    const recentA = pct(rc.a, rc.a + rc.b), earlierA = pct(ec.a, ec.a + ec.b);
    const trend = earlier.length ? (recentA - earlierA) : 0;
    const dominant = counts.a === counts.b ? 'Balanced' : counts.a > counts.b ? nameA : nameB;
    const streak = currentStreak(data);
    const streakName = streak.kind === 'a' ? nameA : streak.kind === 'b' ? nameB : streak.kind === 'flat' ? 'Flat' : '—';
    const strength = total < 10 ? 'Limited data' : Math.abs(pctA - pctB) >= 20 ? 'Strong imbalance' : Math.abs(pctA-pctB) >= 8 ? 'Moderate imbalance' : 'Balanced';
    const trendText = !earlier.length ? 'Not enough comparison data' : Math.abs(trend) < 2 ? 'Broadly steady' : `${trend > 0 ? nameA : nameB} gaining share in the recent portion`;
    const readings = [
      ['Dominant outcome', dominant], ['Momentum balance', strength],
      ['Current streak', `${streak.count} ${streakName}`], ['Longest streak', `${longestStreak(data)} outcomes`],
      ['Recent comparison', trendText], ['Sample size', `${data.length} observations${typeEl.value === 'rise_fall' ? ` (${counts.flat} flat excluded)` : ''}`]
    ];
    insightsEl.innerHTML = readings.map(([k,v]) => `<div class="mm-insight"><span>${k}</span><b>${v}</b></div>`).join('');

    const recentHistory = data.slice(- (typeEl.value === 'rise_fall' ? 30 : 100));
    historyEl.innerHTML = recentHistory.map((x, i) => {
      let text, cls;
      if (typeEl.value === 'rise_fall') { text = x.kind === 'a' ? '↑' : x.kind === 'b' ? '↓' : '–'; cls = x.kind === 'a' ? 'up' : x.kind === 'b' ? 'down' : 'flat'; }
      else { text = typeEl.value === 'even_odd' ? (x.kind === 'a' ? 'E' : 'O') : typeEl.value === 'over_under' ? (x.kind === 'a' ? 'O' : 'U') : (x.kind === 'a' ? 'M' : 'D'); cls = x.kind === 'a' ? 'up' : 'down'; }
      return `<span class="mm-history-chip ${cls}" title="${i + 1}">${text}</span>`;
    }).join('');
    $('mm-history-count').textContent = `${recentHistory.length} recent ${typeEl.value === 'rise_fall' ? 'movements' : 'digits'}`;
    $('mm-subtitle').textContent = `${meta?.displayName || symbol} · last ${selectedWindow().toLocaleString()} ticks`;
  }

  function populateMarkets() {
    const list = (AppState.allSymbols || []).filter(s => !isDigitType() || digitsSupported(s));
    const old = marketEl.value;
    marketEl.innerHTML = list.map(s => `<option value="${s.symbol}">${s.displayName} (${s.symbol})</option>`).join('');
    if (list.some(s => s.symbol === old)) marketEl.value = old;
    else if (AppState.selectedSymbol && list.some(s => s.symbol === AppState.selectedSymbol)) marketEl.value = AppState.selectedSymbol;
    else if (list.length) marketEl.value = list[0].symbol;
  }
  async function loadHistory() {
    if (!symbol || !derivAPI || !derivAPI.send) return;
    const token = ++generation; loading = true; bufferedTicks = [];
    $('mm-live-status').textContent = 'Loading history…';
    try {
      const res = await derivAPI.send({ ticks_history: symbol, style: 'ticks', count: 1000, end: 'latest' });
      if (token !== generation || symbol !== marketEl.value) return;
      quotes = (res.history?.prices || res.prices || []).map(Number);
      // Remove a possible overlap between the history response and ticks
      // received while the request was in flight, without dropping ordinary
      // repeated-price ticks elsewhere in the stream.
      let overlap = 0;
      const maxOverlap = Math.min(quotes.length, bufferedTicks.length);
      for (let n = maxOverlap; n > 0; n--) {
        let same = true;
        for (let i = 0; i < n; i++) {
          if (Number(quotes[quotes.length - n + i]) !== Number(bufferedTicks[i])) { same = false; break; }
        }
        if (same) { overlap = n; break; }
      }
      bufferedTicks.slice(overlap).forEach(q => quotes.push(q));
      quotes = quotes.slice(-1000);
      render(); $('mm-live-status').textContent = '● Live';
    } catch (err) {
      if (token === generation) $('mm-live-status').textContent = 'History unavailable';
      console.error('Momentum history failed:', err.message);
    } finally { if (token === generation) loading = false; }
  }
  function changeSymbol(next) {
    if (!next) return;
    const found = AppState.allSymbols.find(s => s.symbol === next);
    if (!found) return;
    symbol = next; meta = found; quotes = []; outcomes = [];
    if (AppState.selectedSymbol !== next) selectSymbol(next, found.displayName);
    loadHistory();
  }
  function syncControls() {
    const digit = isDigitType();
    $('mm-barrier-wrap').classList.toggle('hidden', !digit || typeEl.value === 'even_odd' || typeEl.value === 'matches_differs');
    $('mm-prediction-wrap').classList.toggle('hidden', typeEl.value !== 'matches_differs');
    populateMarkets();
    const next = marketEl.value;
    if (next) changeSymbol(next);
    const showDigits = active && digit && digitsSupported(AppState.allSymbols.find(s=>s.symbol===next));
    digitSlot.classList.toggle('hidden', !showDigits);
    document.dispatchEvent(new CustomEvent('algotrade:momentum-digit-widget', { detail: { active: showDigits } }));
    render();
  }
  function showTab(on) {
    active = on;
    if (on) {
      tradeSlot.appendChild(tradePanel);
      digitSlot.appendChild(digitWidget);
      digitSlot.classList.toggle('hidden', !isDigitType() || !digitsSupported(meta));
      $('mm-trade-slot').classList.toggle('mm-trade-collapsed', tradeHidden);
      tradeToggle.textContent = tradeHidden ? 'Show' : 'Hide';
      tradeToggle.setAttribute('aria-expanded', String(!tradeHidden));
      populateMarkets();
      if (!symbol && marketEl.value) changeSymbol(marketEl.value);
      document.dispatchEvent(new CustomEvent('algotrade:momentum-digit-widget', { detail: { active: isDigitType() && digitsSupported(meta) } }));
    } else {
      tradeAnchor.parentNode.insertBefore(tradePanel, tradeAnchor.nextSibling);
      digitAnchor.parentNode.insertBefore(digitWidget, digitAnchor.nextSibling);
      document.dispatchEvent(new CustomEvent('algotrade:momentum-digit-widget', { detail: { active: false } }));
    }
  }

  document.addEventListener('algotrade:tab-shown', e => showTab(e.detail.tab === 'market-momentum'));
  document.addEventListener('algotrade:account-ready', () => { populateMarkets(); if (active && marketEl.value) changeSymbol(marketEl.value); });
  document.addEventListener('algotrade:symbol-selected', e => {
    if (!active) return;
    const m = AppState.allSymbols.find(s => s.symbol === e.detail.symbol);
    if (m && (!isDigitType() || digitsSupported(m))) { symbol = m.symbol; meta = m; marketEl.value = m.symbol; digitSlot.classList.toggle('hidden', !(isDigitType() && digitsSupported(m))); document.dispatchEvent(new CustomEvent('algotrade:momentum-digit-widget', { detail: { active: isDigitType() && digitsSupported(m) } })); loadHistory(); }
  });
  document.addEventListener('algotrade:tick', e => {
    if (!active || e.detail.symbol !== symbol) return;
    const q = Number(e.detail.quote);
    if (loading) { bufferedTicks.push(q); return; }
    quotes.push(q); if (quotes.length > 1000) quotes.shift(); render();
  });
  document.addEventListener('algotrade:reconnected', () => { if (active && symbol) loadHistory(); });
  marketEl.addEventListener('change', () => changeSymbol(marketEl.value));
  typeEl.addEventListener('change', syncControls);
  barrierEl.addEventListener('change', render); predictionEl.addEventListener('change', render); windowEl.addEventListener('change', render);
  tradeToggle.addEventListener('click', () => {
    tradeHidden = !tradeHidden;
    $('mm-trade-slot').classList.toggle('mm-trade-collapsed', tradeHidden);
    tradeToggle.textContent = tradeHidden ? 'Show' : 'Hide';
    tradeToggle.setAttribute('aria-expanded', String(!tradeHidden));
  });
  // If the shared market selector changes while this tab is open, keep the selector in sync.
  document.addEventListener('algotrade:symbol-selected', e => { if (active && marketEl.value !== e.detail.symbol) { const m=AppState.allSymbols.find(s=>s.symbol===e.detail.symbol); if(m && (!isDigitType() || digitsSupported(m))) marketEl.value=e.detail.symbol; } });
})();
