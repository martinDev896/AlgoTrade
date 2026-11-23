// =============================================================
// AlgoTrade — Step Index Dual Hedge Analyzer (Phase 1)
// Uses historical ticks + the app's existing shared live tick feed.
// No contracts are purchased in this phase.
// =============================================================
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const el = {
    sample: $('sih-sample'), market: $('sih-market'), stake: $('sih-stake'), minPayout: $('sih-min-payout'),
    scan: $('sih-scan'), one: $('sih-analyse-one'), status: $('sih-status'), progress: $('sih-progress'),
    ranking: $('sih-ranking'), subtitle: $('sih-selected-subtitle'), score: $('sih-selected-score'),
    metrics: $('sih-metrics'), distribution: $('sih-distribution'), calculator: $('sih-calculator'),
    paperStatus: $('sih-paper-status'), paperStats: $('sih-paper-stats'), paperLog: $('sih-paper-log')
  };
  if (!el.scan || typeof derivAPI === 'undefined') return;

  let active = false, scanning = false, selectedSymbol = null, selectedMeta = null;
  let generation = 0, results = new Map(), liveQuotes = [], paper = { pairs: 0, wins: 0, doubles: 0, flat: 0, returnToEntry: 0, last: [] };
  const money = n => '$' + Number(n || 0).toFixed(2);
  const pct = (n, d) => d ? (100 * n / d) : 0;
  const decimalsFor = pip => { const s = String(pip ?? 0.001), i = s.indexOf('.'); return i < 0 ? 0 : s.length - i - 1; };
  const norm = (v, decimals) => Number(Number(v).toFixed(decimals));
  const isStepIndex = s => s && s.marketCode === 'synthetic_index' && (/step/i.test(s.displayName || '') || /^stp/i.test(s.symbol || ''));
  const stepMarkets = () => (window.AppState?.allSymbols || []).filter(isStepIndex).sort((a,b) => a.displayName.localeCompare(b.displayName, undefined, {numeric:true}));
  const sampleSize = () => Math.max(100, Number(el.sample.value) || 500);

  function populateMarkets() {
    const list = stepMarkets();
    const previous = el.market.value || selectedSymbol;
    el.market.innerHTML = list.length ? list.map(s => `<option value="${s.symbol}">${s.displayName} (${s.symbol})</option>`).join('') : '<option value="">No Step Indices found</option>';
    if (list.some(s => s.symbol === previous)) el.market.value = previous;
    else if (list.length) el.market.value = list[0].symbol;
    if (el.market.value) setSelected(el.market.value, false);
    el.status.textContent = list.length ? `${list.length} Step Index market(s) discovered.` : 'No Step Index markets found. Connect to Deriv and refresh markets.';
  }

  function setSelected(symbol, syncGlobal = true) {
    const meta = stepMarkets().find(s => s.symbol === symbol);
    if (!meta) return;
    selectedSymbol = symbol; selectedMeta = meta;
    if (syncGlobal && window.AppState?.selectedSymbol !== symbol && typeof window.selectSymbol === 'function') {
      window.selectSymbol(symbol, meta.displayName);
    }
    liveQuotes = [];
    paper = { pairs: 0, wins: 0, doubles: 0, flat: 0, returnToEntry: 0, last: [] };
    renderPaper();
    el.paperStatus.textContent = 'Waiting for ticks';
    if (results.has(symbol)) renderSelected(results.get(symbol));
  }

  function classify(prices, decimals) {
    const out = { total: 0, rise: 0, fall: 0, zero: 0, returned: 0, flat: 0, examples: [] };
    // Each observation is an entry tick and the price exactly two ticks later.
    for (let i = 0; i + 2 < prices.length; i++) {
      const start = norm(prices[i], decimals), middle = norm(prices[i + 1], decimals), end = norm(prices[i + 2], decimals);
      out.total++;
      if (end > start) out.rise++;
      else if (end < start) out.fall++;
      else {
        out.zero++;
        if (middle !== start) out.returned++;
        else out.flat++;
      }
    }
    return out;
  }

  async function analyseMarket(meta, count, token) {
    const response = await derivAPI.send({ ticks_history: meta.symbol, style: 'ticks', count: count + 2, end: 'latest' });
    if (response.error) throw new Error(response.error.message || 'History request failed');
    const prices = (response.history?.prices || response.prices || []).map(Number).filter(Number.isFinite);
    if (prices.length < 3) throw new Error('Insufficient historical ticks returned');
    const stats = classify(prices, decimalsFor(meta.pipSize));
    return { symbol: meta.symbol, name: meta.displayName, pipSize: meta.pipSize, requested: count, ...stats, capturedAt: Date.now() };
  }

  async function runScan(onlySelected = false) {
    if (scanning) return;
    const list = onlySelected ? stepMarkets().filter(s => s.symbol === el.market.value) : stepMarkets();
    if (!list.length) { populateMarkets(); return; }
    if (!derivAPI.ws || derivAPI.ws.readyState !== WebSocket.OPEN) { el.status.textContent = 'Connect your Deriv account before analysing markets.'; return; }
    scanning = true; const token = ++generation; el.scan.disabled = el.one.disabled = true;
    const count = sampleSize();
    if (!onlySelected) results.clear();
    el.status.textContent = `Analysing ${list.length} market(s)…`;
    try {
      for (let i = 0; i < list.length; i++) {
        if (token !== generation) return;
        el.progress.textContent = `${i + 1} / ${list.length}`;
        try {
          const result = await analyseMarket(list[i], count, token);
          results.set(result.symbol, result);
        } catch (err) {
          results.set(list[i].symbol, { symbol: list[i].symbol, name: list[i].displayName, error: err.message, total: 0, zero: 0, rise: 0, fall: 0, returned: 0, flat: 0 });
        }
        renderRanking();
      }
      el.status.textContent = `Analysis complete · ${results.size} market(s) · ${count.toLocaleString()} two-tick observations requested per market.`;
      if (results.has(selectedSymbol)) renderSelected(results.get(selectedSymbol));
    } catch (err) {
      el.status.textContent = `Analysis stopped: ${err.message}`;
    } finally {
      if (token === generation) { scanning = false; el.scan.disabled = el.one.disabled = false; el.progress.textContent = ''; }
    }
  }

  function assessment(r) {
    if (r.error || !r.total) return ['Unavailable', 'muted'];
    const z = pct(r.zero, r.total);
    if (r.total < Math.min(100, r.requested || 100)) return ['Insufficient sample', 'muted'];
    if (z <= 5) return ['Lower observed risk', 'good'];
    if (z <= 12) return ['Moderate observed risk', 'mid'];
    return ['Higher observed risk', 'bad'];
  }
  function renderRanking() {
    const rows = [...results.values()].sort((a,b) => {
      if (a.error && !b.error) return 1; if (!a.error && b.error) return -1;
      return pct(a.zero,a.total) - pct(b.zero,b.total) || b.total - a.total;
    });
    if (!rows.length) { el.ranking.innerHTML = '<tr><td colspan="9" class="sih-empty">Run an analysis to compare markets.</td></tr>'; return; }
    el.ranking.innerHTML = rows.map((r,i) => {
      const [label, cls] = assessment(r), activeRow = r.symbol === selectedSymbol ? ' is-selected' : '';
      return `<tr class="${activeRow}" data-symbol="${r.symbol}"><td>${i+1}</td><td><button class="sih-market-link" data-symbol="${r.symbol}">${r.name}</button><small>${r.symbol}</small></td><td>${r.total || '—'}</td><td>${r.total ? pct(r.rise,r.total).toFixed(1)+'%' : '—'}</td><td>${r.total ? pct(r.fall,r.total).toFixed(1)+'%' : '—'}</td><td class="sih-zero">${r.total ? pct(r.zero,r.total).toFixed(2)+'%' : '—'}</td><td>${r.total ? pct(r.returned,r.total).toFixed(2)+'%' : '—'}</td><td>${r.total ? pct(r.flat,r.total).toFixed(2)+'%' : '—'}</td><td><span class="sih-assessment ${cls}">${r.error ? r.error : label}</span></td></tr>`;
    }).join('');
    el.ranking.querySelectorAll('[data-symbol]').forEach(btn => btn.addEventListener('click', () => { el.market.value = btn.dataset.symbol; setSelected(btn.dataset.symbol); renderRanking(); }));
  }

  function renderSelected(r) {
    if (!r || r.error || !r.total) { el.subtitle.textContent = r?.error || 'No analysis available.'; return; }
    const z = pct(r.zero,r.total), stake = Math.max(0, Number(el.stake.value) || 0), payout = Math.max(0, Number(el.minPayout.value) || 0);
    el.subtitle.textContent = `${r.name} (${r.symbol}) · ${r.total.toLocaleString()} overlapping two-tick observations · updated ${new Date(r.capturedAt).toLocaleTimeString()}`;
    el.score.textContent = `${z.toFixed(2)}% zero net`;
    el.metrics.innerHTML = [
      ['Two-tick rise', `${pct(r.rise,r.total).toFixed(2)}%`, `${r.rise.toLocaleString()} observations`],
      ['Two-tick fall', `${pct(r.fall,r.total).toFixed(2)}%`, `${r.fall.toLocaleString()} observations`],
      ['Zero net movement', `${z.toFixed(2)}%`, `${r.zero.toLocaleString()} double-loss cases`],
      ['Returned to entry', `${pct(r.returned,r.total).toFixed(2)}%`, `${r.returned.toLocaleString()} moved then returned`],
      ['Flat throughout', `${pct(r.flat,r.total).toFixed(2)}%`, `${r.flat.toLocaleString()} unchanged throughout`],
      ['Sample size', r.total.toLocaleString(), 'Overlapping entry windows']
    ].map(([k,v,n]) => `<div class="sih-metric"><span>${k}</span><b>${v}</b><small>${n}</small></div>`).join('');
    el.distribution.innerHTML = [
      ['Rise',r.rise,'rise'],['Fall',r.fall,'fall'],['Zero net',r.zero,'zero']
    ].map(([label,n,cls]) => `<div class="sih-dist-row"><div><span>${label}</span><b>${pct(n,r.total).toFixed(2)}%</b></div><div class="sih-dist-track"><i class="${cls}" style="width:${pct(n,r.total)}%"></i></div></div>`).join('');
    const q = r.zero / r.total, success = 1-q, expected = success * payout - 2 * stake;
    const breakEvenZero = payout > 0 ? Math.max(0, 1 - (2*stake/payout)) * 100 : 0;
    const totalStake = 2*stake, winNet = payout - totalStake;
    el.calculator.innerHTML = `<div class="sih-calc-grid"><div><span>Combined stake</span><b>${money(totalStake)}</b></div><div><span>One-win hedge result</span><b class="${winNet >= 0 ? 'positive':'negative'}">${money(winNet)}</b></div><div><span>Double-loss result</span><b class="negative">-${money(totalStake)}</b></div><div><span>Break-even max zero rate</span><b>${breakEvenZero.toFixed(2)}%</b></div></div><div class="sih-expectancy"><span>Estimated net per paired entry*</span><b class="${expected >= 0 ? 'positive':'negative'}">${money(expected)}</b></div><p class="sih-calc-caption">Using a winning payout of ${money(payout)} per winning contract and ${money(stake)} stake on each side. *Before quote changes, execution mismatch, and other risks.</p>`;
    renderRanking();
  }

  function renderPaper() {
    const total = paper.pairs, zeroRate = pct(paper.doubles,total);
    el.paperStats.innerHTML = [
      ['Observed pairs',total],['One-side wins',paper.wins],['Double-loss events',paper.doubles],['Double-loss rate',total ? zeroRate.toFixed(2)+'%' : '—']
    ].map(([k,v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('');
    el.paperLog.innerHTML = paper.last.length ? paper.last.slice().reverse().map(x => `<div class="sih-log-row"><span>${new Date(x.time).toLocaleTimeString()}</span><b class="${x.result === 'DOUBLE LOSS' ? 'negative' : 'positive'}">${x.result}</b><span>${x.start.toFixed(decimalsFor(selectedMeta?.pipSize))} → ${x.end.toFixed(decimalsFor(selectedMeta?.pipSize))}</span></div>`).join('') : 'Waiting for enough live ticks to complete a two-tick observation.';
  }

  function onTick(event) {
    if (!active || !selectedSymbol || event.detail?.symbol !== selectedSymbol) return;
    const quote = Number(event.detail.quote); if (!Number.isFinite(quote)) return;
    liveQuotes.push(quote); if (liveQuotes.length > 3) liveQuotes.shift();
    el.paperStatus.textContent = '● Observing live ticks';
    if (liveQuotes.length === 3) {
      const d = decimalsFor(selectedMeta?.pipSize), start = norm(liveQuotes[0],d), middle = norm(liveQuotes[1],d), end = norm(liveQuotes[2],d);
      const isZero = end === start;
      paper.pairs++;
      if (isZero) { paper.doubles++; if (middle !== start) paper.returnToEntry++; else paper.flat++; }
      else paper.wins++;
      paper.last.push({ time:Date.now(), start, end, result:isZero ? 'DOUBLE LOSS' : end > start ? 'RISE WINS' : 'FALL WINS' });
      if (paper.last.length > 12) paper.last.shift();
      renderPaper();
      // Slide the window by one tick: each live tick creates one new overlapping 2-tick observation.
      liveQuotes.shift();
    }
  }

  el.scan.addEventListener('click', () => runScan(false));
  el.one.addEventListener('click', () => runScan(true));
  el.market.addEventListener('change', () => { setSelected(el.market.value); if (active) runScan(true); });
  el.sample.addEventListener('change', () => { if (results.size) runScan(false); });
  el.stake.addEventListener('input', () => { const r = results.get(selectedSymbol); if (r) renderSelected(r); });
  el.minPayout.addEventListener('input', () => { const r = results.get(selectedSymbol); if (r) renderSelected(r); });
  document.addEventListener('algotrade:tick', onTick);
  document.addEventListener('algotrade:account-ready', populateMarkets);
  document.addEventListener('algotrade:reconnected', () => { if (active) { liveQuotes = []; el.paperStatus.textContent = 'Reconnected · waiting for ticks'; } });
  document.addEventListener('algotrade:symbol-selected', e => {
    if (!active || !e.detail?.symbol) return;
    // Keep the module's market selection authoritative only when that symbol is a Step Index.
    if (stepMarkets().some(s => s.symbol === e.detail.symbol) && e.detail.symbol !== selectedSymbol) {
      selectedSymbol = e.detail.symbol; selectedMeta = stepMarkets().find(s => s.symbol === selectedSymbol);
      el.market.value = selectedSymbol; liveQuotes = []; paper = { pairs:0,wins:0,doubles:0,flat:0,returnToEntry:0,last:[] }; renderPaper();
      if (results.has(selectedSymbol)) renderSelected(results.get(selectedSymbol));
    }
  });
  document.addEventListener('algotrade:tab-shown', e => {
    active = e.detail?.tab === 'step-index-hedge';
    if (active) { populateMarkets(); if (el.market.value && el.market.value !== selectedSymbol) setSelected(el.market.value); }
  });
})();
