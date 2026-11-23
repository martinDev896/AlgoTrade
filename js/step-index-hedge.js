// =============================================================
// AlgoTrade — Step Index Dual Hedge Analyzer (Phase 1)
// Uses historical ticks + the app's existing shared live tick feed.
// No contracts are purchased in this phase.
// =============================================================
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const el = {
    sample: $('sih-sample'), method: $('sih-method'), market: $('sih-market'), refreshQuotes: $('sih-refresh-quotes'), quoteStatus: $('sih-quote-status'), stake: $('sih-stake'), minPayout: $('sih-min-payout'),
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

  function classify(prices, decimals, method = 'overlap') {
    const out = { total: 0, rise: 0, fall: 0, zero: 0, returned: 0, flat: 0, examples: [], method };
    // Both modes compare an entry quote with the quote exactly two ticks later.
    // Non-overlap advances by two ticks, so observations do not share prices.
    const stride = method === 'nonoverlap' ? 2 : 1;
    for (let i = 0; i + 2 < prices.length; i += stride) {
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

  async function analyseMarket(meta, count, token, method) {
    // Deriv historical tick requests are capped at 5,000 ticks. In non-overlap
    // mode this limits the available independent two-tick pairs to 2,499.
    const requestedTicks = method === 'nonoverlap' ? Math.min(5000, count * 2 + 1) : Math.min(5000, count + 2);
    const response = await derivAPI.send({ ticks_history: meta.symbol, style: 'ticks', count: requestedTicks, end: 'latest' });
    if (response.error) throw new Error(response.error.message || 'History request failed');
    const prices = (response.history?.prices || response.prices || []).map(Number).filter(Number.isFinite);
    if (prices.length < 3) throw new Error('Insufficient historical ticks returned');
    const stats = classify(prices, decimalsFor(meta.pipSize), method);
    const split = Math.max(1, Math.floor(stats.total * 0.8));
    const recentStart = method === 'nonoverlap' ? Math.min(prices.length - 3, split * 2) : Math.min(prices.length - 3, split);
    const recentPrices = prices.slice(recentStart);
    const recent = classify(recentPrices, decimalsFor(meta.pipSize), method);
    const earlier = { total: stats.total - recent.total, zero: stats.zero - recent.zero };
    return { symbol: meta.symbol, name: meta.displayName, pipSize: meta.pipSize, requested: count, requestedTicks, earlier, recent: { total: recent.total, zero: recent.zero }, ...stats, capturedAt: Date.now() };
  }

  async function runScan(onlySelected = false) {
    if (scanning) return;
    const list = onlySelected ? stepMarkets().filter(s => s.symbol === el.market.value) : stepMarkets();
    if (!list.length) { populateMarkets(); return; }
    if (!derivAPI.ws || derivAPI.ws.readyState !== WebSocket.OPEN) { el.status.textContent = 'Connect your Deriv account before analysing markets.'; return; }
    scanning = true; const token = ++generation; el.scan.disabled = el.one.disabled = true;
    const count = sampleSize(), method = el.method.value || 'overlap';
    if (!onlySelected) results.clear();
    el.status.textContent = `Analysing ${list.length} market(s)…`;
    try {
      for (let i = 0; i < list.length; i++) {
        if (token !== generation) return;
        el.progress.textContent = `${i + 1} / ${list.length}`;
        try {
          const result = await analyseMarket(list[i], count, token, method);
          results.set(result.symbol, result);
        } catch (err) {
          results.set(list[i].symbol, { symbol: list[i].symbol, name: list[i].displayName, error: err.message, total: 0, zero: 0, rise: 0, fall: 0, returned: 0, flat: 0 });
        }
        renderRanking();
      }
      el.status.textContent = `Analysis complete · ${results.size} market(s) · ${method === 'nonoverlap' ? 'Non-overlapping' : 'Overlapping'} two-tick analysis; up to ${count.toLocaleString()} pairs requested per market.`;
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
    if (z < 47.64) return ['Below illustrative break-even', 'mid'];
    return ['Above illustrative break-even', 'bad'];
  }
  function renderRanking() {
    const rows = [...results.values()].sort((a,b) => {
      if (a.error && !b.error) return 1; if (!a.error && b.error) return -1;
      return pct(a.zero,a.total) - pct(b.zero,b.total) || b.total - a.total;
    });
    if (!rows.length) { el.ranking.innerHTML = '<tr><td colspan="12" class="sih-empty">Run an analysis to compare markets.</td></tr>'; return; }
    el.ranking.innerHTML = rows.map((r,i) => {
      const [label, cls] = assessment(r), activeRow = r.symbol === selectedSymbol ? ' is-selected' : '';
      const recentRate = r.recent?.total ? pct(r.recent.zero,r.recent.total) : NaN; const earlierRate = r.earlier?.total ? pct(r.earlier.zero,r.earlier.total) : NaN; const change = Number.isFinite(recentRate) && Number.isFinite(earlierRate) ? recentRate-earlierRate : NaN; const stakeNow = Math.max(0, Number(el.stake.value)||0); const payout = r.quotes?.ready ? (r.rise/r.total)*(r.quotes.rise.payout-2*stakeNow) + (r.fall/r.total)*(r.quotes.fall.payout-2*stakeNow) - (r.zero/r.total)*2*stakeNow : NaN;
      return `<tr class="${activeRow}" data-symbol="${r.symbol}"><td>${i+1}</td><td><button class="sih-market-link" data-symbol="${r.symbol}">${r.name}</button><small>${r.symbol}</small></td><td>${r.total || '—'}</td><td>${r.total ? pct(r.rise,r.total).toFixed(1)+'%' : '—'}</td><td>${r.total ? pct(r.fall,r.total).toFixed(1)+'%' : '—'}</td><td class="sih-zero">${r.total ? pct(r.zero,r.total).toFixed(2)+'%' : '—'}</td><td>${r.total ? pct(r.returned,r.total).toFixed(2)+'%' : '—'}</td><td>${r.total ? pct(r.flat,r.total).toFixed(2)+'%' : '—'}</td><td>${Number.isFinite(recentRate) ? recentRate.toFixed(2)+'%' : '—'}</td><td>${Number.isFinite(change) ? (change>0?'+':'')+change.toFixed(2)+' pp' : '—'}</td><td>${Number.isFinite(payout) ? money(payout) : 'Quote needed'}</td><td><span class="sih-assessment ${cls}">${r.error ? r.error : label}</span></td></tr>`;
    }).join('');
    el.ranking.querySelectorAll('[data-symbol]').forEach(btn => btn.addEventListener('click', () => { el.market.value = btn.dataset.symbol; setSelected(btn.dataset.symbol); renderRanking(); }));
  }

  function renderSelected(r) {
    if (!r || r.error || !r.total) { el.subtitle.textContent = r?.error || 'No analysis available.'; return; }
    const z = pct(r.zero,r.total), stake = Math.max(0, Number(el.stake.value) || 0), payout = Math.max(0, Number(el.minPayout.value) || 0);
    el.subtitle.textContent = `${r.name} (${r.symbol}) · ${r.total.toLocaleString()} ${r.method === 'nonoverlap' ? 'non-overlapping' : 'overlapping'} two-tick observations · updated ${new Date(r.capturedAt).toLocaleTimeString()}`;
    el.score.textContent = `${z.toFixed(2)}% zero net`;
    el.metrics.innerHTML = [
      ['Two-tick rise', `${pct(r.rise,r.total).toFixed(2)}%`, `${r.rise.toLocaleString()} observations`],
      ['Two-tick fall', `${pct(r.fall,r.total).toFixed(2)}%`, `${r.fall.toLocaleString()} observations`],
      ['Zero net movement', `${z.toFixed(2)}%`, `${r.zero.toLocaleString()} double-loss cases`],
      ['Returned to entry', `${pct(r.returned,r.total).toFixed(2)}%`, `${r.returned.toLocaleString()} moved then returned`],
      ['Flat throughout', `${pct(r.flat,r.total).toFixed(2)}%`, `${r.flat.toLocaleString()} unchanged throughout`],
      ['Sample size', r.total.toLocaleString(), r.method === 'nonoverlap' ? 'Non-overlapping entry windows' : 'Overlapping entry windows'],
      ['Recent zero-net rate', r.recent?.total ? pct(r.recent.zero,r.recent.total).toFixed(2)+'%' : '—', 'Latest 20% of observations'],
      ['Earlier zero-net rate', r.earlier?.total ? pct(r.earlier.zero,r.earlier.total).toFixed(2)+'%' : '—', 'Earlier 80% of observations']
    ].map(([k,v,n]) => `<div class="sih-metric"><span>${k}</span><b>${v}</b><small>${n}</small></div>`).join('');
    el.distribution.innerHTML = [
      ['Rise',r.rise,'rise'],['Fall',r.fall,'fall'],['Zero net',r.zero,'zero']
    ].map(([label,n,cls]) => `<div class="sih-dist-row"><div><span>${label}</span><b>${pct(n,r.total).toFixed(2)}%</b></div><div class="sih-dist-track"><i class="${cls}" style="width:${pct(n,r.total)}%"></i></div></div>`).join('');
    const q = r.zero / r.total, success = 1-q, totalStake = 2*stake;
    const risePayout = r.quotes?.ready ? r.quotes.rise.payout : payout; const fallPayout = r.quotes?.ready ? r.quotes.fall.payout : payout;
    const riseNet = risePayout-totalStake, fallNet = fallPayout-totalStake;
    const expected = (r.rise/r.total)*riseNet + (r.fall/r.total)*fallNet + (r.zero/r.total)*(-totalStake);
    const avgWinPayout = (risePayout+fallPayout)/2; const breakEvenZero = avgWinPayout > 0 ? Math.max(0,1-(totalStake/avgWinPayout))*100 : 0;
    el.calculator.innerHTML = `<div class="sih-calc-grid"><div><span>Combined stake</span><b>${money(totalStake)}</b></div><div><span>Rise wins / net</span><b class="${riseNet>=0?'positive':'negative'}">${money(risePayout)} / ${money(riseNet)}</b></div><div><span>Fall wins / net</span><b class="${fallNet>=0?'positive':'negative'}">${money(fallPayout)} / ${money(fallNet)}</b></div><div><span>Double-loss result</span><b class="negative">-${money(totalStake)}</b></div><div><span>Break-even max zero rate*</span><b>${breakEvenZero.toFixed(2)}%</b></div><div><span>Quote status</span><b>${r.quotes?.ready ? 'Actual Deriv quotes' : 'Assumed payout'}</b></div></div><div class="sih-expectancy"><span>Estimated net per paired entry*</span><b class="${expected>=0?'positive':'negative'}">${money(expected)}</b></div><p class="sih-calc-caption">${r.quotes?.ready ? `Rise payout ${money(risePayout)}; Fall payout ${money(fallPayout)} (${r.quotes.currency}).` : `Assumed winning payout ${money(payout)} on either side.`} *Uses observed rise/fall/zero frequencies; excludes quote movement and different entry spots.</p>`;
    renderRanking();
  }

  function activeCurrency() { const a = (window.AppState?.accounts || []).find(x => x.account_id === window.AppState?.activeAccountId); return a?.currency || 'USD'; }

  async function requestPairQuotes(meta, stake) {
    const base = { amount: stake, basis: 'stake', currency: activeCurrency(), duration: 2, duration_unit: 't', symbol: meta.symbol };
    const [riseRes, fallRes] = await Promise.all([
      derivAPI.send({ proposal: 1, ...base, contract_type: 'PUT' }),
      derivAPI.send({ proposal: 1, ...base, contract_type: 'CALL' })
    ]);
    if (riseRes.error || fallRes.error || !riseRes.proposal || !fallRes.proposal) throw new Error(riseRes.error?.message || fallRes.error?.message || 'One or both proposals unavailable');
    return { ready: true, rise: { ask: Number(riseRes.proposal.ask_price), payout: Number(riseRes.proposal.payout), id: riseRes.proposal.id }, fall: { ask: Number(fallRes.proposal.ask_price), payout: Number(fallRes.proposal.payout), id: fallRes.proposal.id }, currency: activeCurrency(), capturedAt: Date.now() };
  }

  async function refreshAllQuotes() {
    if (!derivAPI.ws || derivAPI.ws.readyState !== WebSocket.OPEN) { el.quoteStatus.textContent = 'Connect to Deriv before requesting quotes.'; return; }
    const rows = [...results.values()].filter(r => !r.error); if (!rows.length) { el.quoteStatus.textContent = 'Run market analysis first.'; return; }
    el.refreshQuotes.disabled = true; let ok = 0;
    try {
      for (const r of rows) {
        const meta = stepMarkets().find(m => m.symbol === r.symbol); if (!meta) continue;
        try { r.quotes = await requestPairQuotes(meta, Math.max(0.35, Number(el.stake.value) || 1)); ok++; }
        catch (err) { r.quotes = { ready: false, error: err.message }; }
        if (r.symbol === selectedSymbol) renderSelected(r);
        renderRanking();
      }
      el.quoteStatus.textContent = `Actual Rise/Fall quotes received for ${ok} of ${rows.length} markets. Quotes are snapshots and may change before any purchase.`;
    } finally { el.refreshQuotes.disabled = false; }
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
  el.method.addEventListener('change', () => { if (results.size) runScan(false); });
  el.refreshQuotes.addEventListener('click', () => refreshAllQuotes());
  el.one.addEventListener('click', () => runScan(true));
  el.market.addEventListener('change', () => { setSelected(el.market.value); if (active) runScan(true); });
  el.sample.addEventListener('change', () => { if (results.size) runScan(false); });
  el.stake.addEventListener('input', () => { results.forEach(r => { r.quotes = null; }); const r = results.get(selectedSymbol); if (r) renderSelected(r); renderRanking(); el.quoteStatus.textContent = 'Stake changed · refresh quotes to update actual payouts.'; });
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
