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
    paperStatus: $('sih-paper-status'), paperStats: $('sih-paper-stats'), paperLog: $('sih-paper-log'), delayed: $('sih-delayed-analysis'), validation: $('sih-validation')
  };
  if (!el.scan || typeof derivAPI === 'undefined') return;

  let active = false, scanning = false, selectedSymbol = null, selectedMeta = null;
  let generation = 0, results = new Map(), liveQuotes = [], paper = { pairs: 0, wins: 0, doubles: 0, flat: 0, returnToEntry: 0, last: [] };
  const money = n => '$' + Number(n || 0).toFixed(2);
  const pct = (n, d) => d ? (100 * n / d) : 0;
  const decimalsFor = pip => { const s = String(pip ?? 0.001), i = s.indexOf('.'); return i < 0 ? 0 : s.length - i - 1; };
  const norm = (v, decimals) => Number(Number(v).toFixed(decimals));
  const toUnits = (v, decimals) => Math.round(Number(v) * (10 ** decimals)); // integer pip units for exact comparisons
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
    const out = { total: 0, rise: 0, fall: 0, zero: 0, returned: 0, flat: 0, firstUp: 0, firstDown: 0, firstFlat: 0, continuation: 0, reversal: 0, secondFlat: 0, upThenDown: 0, downThenUp: 0, upThenUp: 0, downThenDown: 0, upThenFlat: 0, downThenFlat: 0, reversalToEntry: 0, reversalToRise: 0, reversalToFall: 0, reversalToZero: 0, examples: [], method };
    // Both modes compare an entry quote with the quote exactly two ticks later.
    // Non-overlap advances by two ticks, so observations do not share prices.
    const stride = method === 'nonoverlap' ? 2 : 1;
    for (let i = 0; i + 2 < prices.length; i += stride) {
      const start = toUnits(prices[i], decimals), middle = toUnits(prices[i + 1], decimals), end = toUnits(prices[i + 2], decimals);
      out.total++;
      const first = middle > start ? 1 : middle < start ? -1 : 0;
      const second = end > middle ? 1 : end < middle ? -1 : 0;
      if (first > 0) out.firstUp++; else if (first < 0) out.firstDown++; else out.firstFlat++;
      if (second === 0) {
        out.secondFlat++;
        if (first > 0) out.upThenFlat++; else if (first < 0) out.downThenFlat++;
      }
      if (first !== 0 && second !== 0) {
        if (first === second) { out.continuation++; if (first > 0) out.upThenUp++; else out.downThenDown++; }
        else {
          out.reversal++;
          if (first > 0) out.upThenDown++; else out.downThenUp++;
          // Classify the final endpoint independently from the direction pattern.
          if (end === start) { out.reversalToEntry++; }
          else if (end > start) out.reversalToRise++;
          else out.reversalToFall++;
        }
      }
      if (end > start) out.rise++;
      else if (end < start) out.fall++;
      else {
        out.zero++;
        if (middle !== start) out.returned++;
        else out.flat++;
      }
      if (first !== 0 && second !== 0 && end === start) out.reversalToZero++;
    }
    return out;
  }

  function classifyDelayedEntry(prices, decimals, method = 'overlap') {
    // Chronological holdout: earliest 80% of quote history selects a signal;
    // latest 20% is reserved for out-of-sample evaluation.
    const out = {
      total:0, signalUp:0, signalDown:0, signalFlat:0,
      upRise:0, upFall:0, upZero:0, downRise:0, downFall:0, downZero:0,
      overallRise:0, overallFall:0, overallZero:0,
      train:{total:0, up:{n:0,rise:0,fall:0,zero:0}, down:{n:0,rise:0,fall:0,zero:0}},
      test:{total:0, up:{n:0,rise:0,fall:0,zero:0}, down:{n:0,rise:0,fall:0,zero:0}},
      chosenSignal:'insufficient', chosenTest:null, walkForward:[], walkForwardAggregate:{n:0,rise:0,fall:0,zero:0,folds:0}
    };
    const stride = method === 'nonoverlap' ? 4 : 1;
    const splitAt = Math.floor(prices.length * 0.8);
    for (let i=0; i+3<prices.length; i+=stride) {
      const p0=toUnits(prices[i],decimals), p1=toUnits(prices[i+1],decimals), p3=toUnits(prices[i+3],decimals);
      const signal=Math.sign(p1-p0), outcome=Math.sign(p3-p1);
      const isTrain = i + 3 < splitAt;
      const bucket = isTrain ? out.train : (i >= splitAt ? out.test : null);
      // Omit the single window that straddles the chronological split.
      if (!bucket) continue;
      out.total++; bucket.total++;
      if (signal>0) out.signalUp++; else if(signal<0) out.signalDown++; else out.signalFlat++;
      if(outcome>0) out.overallRise++; else if(outcome<0) out.overallFall++; else out.overallZero++;
      if (signal > 0 || signal < 0) {
        const side = signal > 0 ? 'up' : 'down';
        const row = bucket[side]; row.n++;
        if (outcome > 0) row.rise++;
        else if (outcome < 0) row.fall++;
        else row.zero++;
        if(signal>0) { if(outcome>0) out.upRise++; else if(outcome<0) out.upFall++; else out.upZero++; }
        else { if(outcome>0) out.downRise++; else if(outcome<0) out.downFall++; else out.downZero++; }
      }
    }
    const upRate = out.train.up.n >= 30 ? out.train.up.zero/out.train.up.n : Infinity;
    const downRate = out.train.down.n >= 30 ? out.train.down.zero/out.train.down.n : Infinity;
    out.chosenSignal = Math.min(upRate,downRate) === Infinity ? 'insufficient (<30 train observations)' : (upRate <= downRate ? 'UP' : 'DOWN');
    const chosen = out.chosenSignal === 'UP' ? out.test.up : out.chosenSignal === 'DOWN' ? out.test.down : null;
    out.chosenTest = chosen ? {...chosen, zeroRate: chosen.n ? chosen.zero/chosen.n : null} : null;

    // Phase 7 expanding-window walk-forward validation. Each test block is
    // chronologically later than its training prefix; test blocks do not overlap.
    // In non-overlap mode, the source windows themselves also share no quotes.
    const windows = [];
    for (let i=0; i+3<prices.length; i+=stride) {
      const p0=toUnits(prices[i],decimals), p1=toUnits(prices[i+1],decimals), p3=toUnits(prices[i+3],decimals);
      windows.push({ index:i, signal:Math.sign(p1-p0), outcome:Math.sign(p3-p1) });
    }
    const foldSpecs = [0.50,0.60,0.70,0.80,0.90];
    const countSide = (arr, side) => {
      const selected = arr.filter(w => w.signal === side);
      return { n:selected.length, rise:selected.filter(w=>w.outcome>0).length, fall:selected.filter(w=>w.outcome<0).length, zero:selected.filter(w=>w.outcome===0).length };
    };
    for (let f=0; f<foldSpecs.length; f++) {
      const trainEnd = Math.floor(windows.length * foldSpecs[f]);
      const testEnd = Math.floor(windows.length * (foldSpecs[f] + 0.10));
      const testStartIndex = windows[trainEnd]?.index ?? Infinity;
      const testEndIndex = windows[testEnd]?.index ?? Infinity;
      const trainCutoffIndex = method === 'overlap' ? testStartIndex - 3 : testStartIndex;
      // Purge any overlapping training windows whose expiry reaches into the test block.
      const trainWindows = windows.filter((w,idx) => idx < trainEnd && w.index + 3 < trainCutoffIndex + 3);
      const testWindows = windows.slice(trainEnd,testEnd).filter(w => w.index < testEndIndex);
      const upTrain = countSide(trainWindows,1), downTrain = countSide(trainWindows,-1);
      const upRateFold = upTrain.n >= 30 ? upTrain.zero/upTrain.n : Infinity;
      const downRateFold = downTrain.n >= 30 ? downTrain.zero/downTrain.n : Infinity;
      const signal = Math.min(upRateFold,downRateFold) === Infinity ? 'INSUFFICIENT' : (upRateFold <= downRateFold ? 'UP' : 'DOWN');
      const testSide = signal === 'UP' ? countSide(testWindows,1) : signal === 'DOWN' ? countSide(testWindows,-1) : {n:0,rise:0,fall:0,zero:0};
      const fold = { round:f+1, trainWindows:trainWindows.length, testWindows:testWindows.length, signal, trainUp:upTrain, trainDown:downTrain, test:testSide, zeroRate:testSide.n ? testSide.zero/testSide.n : null };
      out.walkForward.push(fold);
      if (signal !== 'INSUFFICIENT' && testSide.n) {
        out.walkForwardAggregate.n += testSide.n;
        out.walkForwardAggregate.rise += testSide.rise;
        out.walkForwardAggregate.fall += testSide.fall;
        out.walkForwardAggregate.zero += testSide.zero;
        out.walkForwardAggregate.folds++;
      }
    }
    out.walkForwardAggregate.zeroRate = out.walkForwardAggregate.n ? out.walkForwardAggregate.zero/out.walkForwardAggregate.n : null;
    return out;
  }

  async function analyseMarket(meta, count, token, method) {
    // Phase 5 needs four quotes per delayed-entry observation.
    const requestedTicks = method === 'nonoverlap' ? Math.min(5000, count * 4 + 1) : Math.min(5000, count + 3);
    const response = await derivAPI.send({ ticks_history: meta.symbol, style: 'ticks', count: requestedTicks, end: 'latest' });
    if (response.error) throw new Error(response.error.message || 'History request failed');
    const prices = (response.history?.prices || response.prices || []).map(Number).filter(Number.isFinite);
    if (prices.length < 3) throw new Error('Insufficient historical ticks returned');
    const decimals = decimalsFor(meta.pipSize);
    // Keep the original simultaneous-entry sample at the requested pair count,
    // while the delayed-entry study uses its separate four-quote windows.
    const mainTickCount = method === 'nonoverlap' ? count * 2 + 1 : count + 2;
    const mainPrices = prices.slice(-Math.min(prices.length, mainTickCount));
    const stats = classify(mainPrices, decimals, method);
    const delayed = classifyDelayedEntry(prices, decimals, method);
    const split = Math.max(1, Math.floor(stats.total * 0.8));
    const recentStart = method === 'nonoverlap' ? Math.min(mainPrices.length - 3, split * 2) : Math.min(mainPrices.length - 3, split);
    const recentPrices = mainPrices.slice(recentStart);
    const recent = classify(recentPrices, decimalsFor(meta.pipSize), method);
    const earlier = { total: stats.total - recent.total, zero: stats.zero - recent.zero };
    return { symbol: meta.symbol, name: meta.displayName, pipSize: meta.pipSize, requested: count, requestedTicks, earlier, recent: { total: recent.total, zero: recent.zero }, delayed, ...stats, capturedAt: Date.now() };
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
    if (!rows.length) { el.ranking.innerHTML = '<tr><td colspan="18" class="sih-empty">Run an analysis to compare markets.</td></tr>'; return; }
    el.ranking.innerHTML = rows.map((r,i) => {
      const [label, cls] = assessment(r), activeRow = r.symbol === selectedSymbol ? ' is-selected' : '';
      const reversalRate = r.continuation + r.reversal ? pct(r.reversal,r.continuation+r.reversal) : NaN; const reversalEntryRate = r.reversal ? pct(r.reversalToEntry,r.reversal) : NaN; const continuationRate = r.continuation + r.reversal ? pct(r.continuation,r.continuation+r.reversal) : NaN; const recentRate = r.recent?.total ? pct(r.recent.zero,r.recent.total) : NaN; const earlierRate = r.earlier?.total ? pct(r.earlier.zero,r.earlier.total) : NaN; const change = Number.isFinite(recentRate) && Number.isFinite(earlierRate) ? recentRate-earlierRate : NaN; const stakeNow = Math.max(0, Number(el.stake.value)||0); const payout = r.quotes?.ready ? (r.rise/r.total)*(r.quotes.rise.payout-2*stakeNow) + (r.fall/r.total)*(r.quotes.fall.payout-2*stakeNow) - (r.zero/r.total)*2*stakeNow : NaN; const d=r.delayed||{};
      return `<tr class="${activeRow}" data-symbol="${r.symbol}"><td>${i+1}</td><td><button class="sih-market-link" data-symbol="${r.symbol}">${r.name}</button><small>${r.symbol}</small></td><td>${r.total || '—'}</td><td>${r.total ? pct(r.rise,r.total).toFixed(1)+'%' : '—'}</td><td>${r.total ? pct(r.fall,r.total).toFixed(1)+'%' : '—'}</td><td class="sih-zero">${r.total ? pct(r.zero,r.total).toFixed(2)+'%' : '—'}</td><td>${r.total ? pct(r.returned,r.total).toFixed(2)+'%' : '—'}</td><td>${r.total ? pct(r.flat,r.total).toFixed(2)+'%' : '—'}</td><td>${Number.isFinite(reversalRate) ? reversalRate.toFixed(1)+'%' : '—'}</td><td>${Number.isFinite(reversalEntryRate) ? reversalEntryRate.toFixed(1)+'%' : '—'}</td><td>${Number.isFinite(continuationRate) ? continuationRate.toFixed(1)+'%' : '—'}</td><td>${d.total ? pct(d.overallZero,d.total).toFixed(2)+'%' : '—'}</td><td>${d.signalUp ? pct(d.upZero,d.signalUp).toFixed(2)+'%' : '—'}</td><td>${d.signalDown ? pct(d.downZero,d.signalDown).toFixed(2)+'%' : '—'}</td><td>${Number.isFinite(recentRate) ? recentRate.toFixed(2)+'%' : '—'}</td><td>${Number.isFinite(change) ? (change>0?'+':'')+change.toFixed(2)+' pp' : '—'}</td><td>${Number.isFinite(payout) ? money(payout) : 'Quote needed'}</td><td><span class="sih-assessment ${cls}">${r.error ? r.error : label}</span></td></tr>`;
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
      ['First-tick up', `${pct(r.firstUp,r.total).toFixed(2)}%`, `${r.firstUp.toLocaleString()} first legs rose`],
      ['First-tick down', `${pct(r.firstDown,r.total).toFixed(2)}%`, `${r.firstDown.toLocaleString()} first legs fell`],
      ['Direction reversal', `${pct(r.reversal,r.continuation+r.reversal).toFixed(2)}%`, `${r.reversal.toLocaleString()} of non-flat two-leg paths`],
      ['Reversals returning to entry', `${pct(r.reversalToEntry,r.reversal).toFixed(2)}%`, `${r.reversalToEntry.toLocaleString()} of ${r.reversal.toLocaleString()} directional reversals`],
      ['Reversals ending above entry', `${r.reversal ? pct(r.reversalToRise,r.reversal).toFixed(2) : '0.00'}%`, `${r.reversalToRise.toLocaleString()} observations`],
      ['Reversals ending below entry', `${r.reversal ? pct(r.reversalToFall,r.reversal).toFixed(2) : '0.00'}%`, `${r.reversalToFall.toLocaleString()} observations`],
      ['Up then flat', `${pct(r.upThenFlat,r.total).toFixed(2)}%`, `${r.upThenFlat.toLocaleString()} observations`],
      ['Down then flat', `${pct(r.downThenFlat,r.total).toFixed(2)}%`, `${r.downThenFlat.toLocaleString()} observations`],
      ['Direction continuation', `${pct(r.continuation,r.continuation+r.reversal).toFixed(2)}%`, `${r.continuation.toLocaleString()} of non-flat two-leg paths`],
      ['Up then down', `${pct(r.upThenDown,r.total).toFixed(2)}%`, `${r.upThenDown.toLocaleString()} observations`],
      ['Down then up', `${pct(r.downThenUp,r.total).toFixed(2)}%`, `${r.downThenUp.toLocaleString()} observations`],
      ['Sample size', r.total.toLocaleString(), r.method === 'nonoverlap' ? 'Non-overlapping entry windows' : 'Overlapping entry windows'],
      ['Recent zero-net rate', r.recent?.total ? pct(r.recent.zero,r.recent.total).toFixed(2)+'%' : '—', 'Latest 20% of observations'],
      ['Earlier zero-net rate', r.earlier?.total ? pct(r.earlier.zero,r.earlier.total).toFixed(2)+'%' : '—', 'Earlier 80% of observations']
    ].map(([k,v,n]) => `<div class="sih-metric"><span>${k}</span><b>${v}</b><small>${n}</small></div>`).join('');
    el.distribution.innerHTML = [
      ['Rise',r.rise,'rise'],['Fall',r.fall,'fall'],['Zero net',r.zero,'zero']
    ].map(([label,n,cls]) => `<div class="sih-dist-row"><div><span>${label}</span><b>${pct(n,r.total).toFixed(2)}%</b></div><div class="sih-dist-track"><i class="${cls}" style="width:${pct(n,r.total)}%"></i></div></div>`).join('') + `<div class="sih-pattern-note"><b>Two-leg direction patterns</b><span>Up → Up: ${r.upThenUp} (${pct(r.upThenUp,r.firstUp).toFixed(1)}% of first-up) · Up → Down: ${r.upThenDown} (${pct(r.upThenDown,r.firstUp).toFixed(1)}%)</span><span>Down → Down: ${r.downThenDown} (${pct(r.downThenDown,r.firstDown).toFixed(1)}% of first-down) · Down → Up: ${r.downThenUp} (${pct(r.downThenUp,r.firstDown).toFixed(1)}%)</span><span>Flat second leg after Up: ${r.upThenFlat} · after Down: ${r.downThenFlat}</span><span>Of ${r.reversal} directional reversals: ${r.reversalToEntry} ended exactly at entry, ${r.reversalToRise} ended above entry, and ${r.reversalToFall} ended below entry.</span><small>Directional reversal and return-to-entry are separate measurements. The hedge double-loss condition is determined only by final price equalling the starting price, regardless of the path.</small></div>`;
    const q = r.zero / r.total, success = 1-q, totalStake = 2*stake;
    const risePayout = r.quotes?.ready ? r.quotes.rise.payout : payout; const fallPayout = r.quotes?.ready ? r.quotes.fall.payout : payout;
    const riseNet = risePayout-totalStake, fallNet = fallPayout-totalStake;
    const expected = (r.rise/r.total)*riseNet + (r.fall/r.total)*fallNet + (r.zero/r.total)*(-totalStake);
    const avgWinPayout = (risePayout+fallPayout)/2; const breakEvenZero = avgWinPayout > 0 ? Math.max(0,1-(totalStake/avgWinPayout))*100 : 0;
    el.calculator.innerHTML = `<div class="sih-calc-grid"><div><span>Combined stake</span><b>${money(totalStake)}</b></div><div><span>Rise wins / net</span><b class="${riseNet>=0?'positive':'negative'}">${money(risePayout)} / ${money(riseNet)}</b></div><div><span>Fall wins / net</span><b class="${fallNet>=0?'positive':'negative'}">${money(fallPayout)} / ${money(fallNet)}</b></div><div><span>Double-loss result</span><b class="negative">-${money(totalStake)}</b></div><div><span>Break-even max zero rate*</span><b>${breakEvenZero.toFixed(2)}%</b></div><div><span>Quote status</span><b>${r.quotes?.ready ? 'Actual Deriv quotes' : 'Assumed payout'}</b></div></div><div class="sih-expectancy"><span>Estimated net per paired entry*</span><b class="${expected>=0?'positive':'negative'}">${money(expected)}</b></div><p class="sih-calc-caption">${r.quotes?.ready ? `Rise payout ${money(risePayout)}; Fall payout ${money(fallPayout)} (${r.quotes.currency}).` : `Assumed winning payout ${money(payout)} on either side.`} *Uses observed rise/fall/zero frequencies; excludes quote movement and different entry spots.</p>`;
    const d = r.delayed || {};
    const delayedRows = [
      ['After first tick UP', d.signalUp || 0, d.upRise || 0, d.upFall || 0, d.upZero || 0],
      ['After first tick DOWN', d.signalDown || 0, d.downRise || 0, d.downFall || 0, d.downZero || 0]
    ];
    if (el.delayed) el.delayed.innerHTML = `<div class="sih-delayed-summary"><div><span>Delayed-entry windows</span><b>${d.total || 0}</b></div><div><span>Delayed Rise</span><b>${pct(d.overallRise || 0,d.total || 0).toFixed(2)}%</b></div><div><span>Delayed Fall</span><b>${pct(d.overallFall || 0,d.total || 0).toFixed(2)}%</b></div><div><span>Delayed zero-net</span><b class="negative">${pct(d.overallZero || 0,d.total || 0).toFixed(2)}%</b></div></div><div class="sih-delayed-table-wrap"><table class="sih-delayed-table"><thead><tr><th>First movement signal</th><th>Signals</th><th>2-tick Rise</th><th>2-tick Fall</th><th>2-tick zero</th></tr></thead><tbody>${delayedRows.map(([label,n,up,down,zero])=>`<tr><td>${label}</td><td>${n}</td><td>${n?pct(up,n).toFixed(2)+'%':'—'} <small>(${up})</small></td><td>${n?pct(down,n).toFixed(2)+'%':'—'} <small>(${down})</small></td><td>${n?pct(zero,n).toFixed(2)+'%':'—'} <small>(${zero})</small></td></tr>`).join('')}</tbody></table></div><p class="sih-calc-caption">Signal: P0 → P1; hypothetical entry: P1; expiry: P3. First-flat signals are included in overall outcomes but excluded from directional rows. ${r.method === 'nonoverlap' ? 'Four-quote windows advance by four ticks so no quote is shared between observations.' : 'Four-quote windows overlap and are descriptive, not independent trials.'} Exact comparisons use integer pip units.</p>`;
    if (el.validation) {
      const fmt = n => Number.isFinite(n) ? (n*100).toFixed(2)+'%' : '—';
      const tr = d.train || {up:{},down:{}}, te = d.test || {up:{},down:{}};
      const sideRows = [
        ['UP signal', tr.up, te.up],
        ['DOWN signal', tr.down, te.down]
      ];
      const selectedTrain = d.chosenSignal === 'UP' ? tr.up : d.chosenSignal === 'DOWN' ? tr.down : null;
      const selectedTest = d.chosenTest;
      const stakeNow = Math.max(0, Number(el.stake.value)||0);
      const assumed = Math.max(0, Number(el.minPayout.value)||0);
      const risePayoutForEV = r.quotes?.ready ? r.quotes.rise.payout : assumed;
      const fallPayoutForEV = r.quotes?.ready ? r.quotes.fall.payout : assumed;
      const totalStakeForEV = 2*stakeNow;
      const testEV = selectedTest && selectedTest.n ? ((selectedTest.rise/selectedTest.n)*(risePayoutForEV-totalStakeForEV) + (selectedTest.fall/selectedTest.n)*(fallPayoutForEV-totalStakeForEV) - (selectedTest.zero/selectedTest.n)*totalStakeForEV) : NaN;
      el.validation.innerHTML = `<div class="sih-validation-head"><div><h3>Phase 6 · Conditional strategy validation</h3><p>Earliest 80% selects the signal; newest 20% is held out and not used to choose it.</p></div><span class="sih-badge">Out-of-sample test</span></div>
        <div class="sih-validation-table-wrap"><table class="sih-delayed-table"><thead><tr><th>Entry condition</th><th>Train n</th><th>Train zero</th><th>Test n</th><th>Test zero</th><th>Test Rise</th><th>Test Fall</th></tr></thead><tbody>${sideRows.map(([label,a,b])=>`<tr><td>${label}</td><td>${a.n||0}</td><td>${a.n?fmt(a.zero/a.n):'—'} <small>(${a.zero||0})</small></td><td>${b.n||0}</td><td>${b.n?fmt(b.zero/b.n):'—'} <small>(${b.zero||0})</small></td><td>${b.n?fmt(b.rise/b.n):'—'} <small>(${b.rise||0})</small></td><td>${b.n?fmt(b.fall/b.n):'—'} <small>(${b.fall||0})</small></td></tr>`).join('')}</tbody></table></div>
        <div class="sih-validation-result"><div><span>Signal selected using training data</span><b>${d.chosenSignal}</b><small>${selectedTrain ? `${selectedTrain.n} training observations · ${fmt(selectedTrain.n?selectedTrain.zero/selectedTrain.n:NaN)} zero-net` : 'Insufficient directional observations'}</small></div><div><span>Held-out observations for selected signal</span><b>${selectedTest?.n || 0}</b><small>${selectedTest ? `${selectedTest.zero} double-loss cases · ${fmt(selectedTest.zeroRate)}` : 'No holdout sample'}</small></div><div><span>Illustrative held-out net / pair</span><b class="${Number.isFinite(testEV)&&testEV>=0?'positive':'negative'}">${Number.isFinite(testEV)?money(testEV):'—'}</b><small>${r.quotes?.ready ? 'Current quoted payouts' : 'Assumed payout '+money(assumed)}; quotes can change before execution.</small></div></div>
        <p class="sih-calc-caption">Holdout windows are chronologically later than training windows. Flat first signals are excluded from UP/DOWN strategy rows. The test sample is a single historical holdout, not proof of future performance; overlapping mode also contains dependent observations.</p>`;
      const wf = d.walkForward || [];
      const agg = d.walkForwardAggregate || {n:0,rise:0,fall:0,zero:0,folds:0};
      const wfEV = agg.n ? ((agg.rise/agg.n)*(risePayoutForEV-totalStakeForEV) + (agg.fall/agg.n)*(fallPayoutForEV-totalStakeForEV) - (agg.zero/agg.n)*totalStakeForEV) : NaN;
      const wfRows = wf.map(f => `<tr><td>${f.round}</td><td>${f.trainWindows}</td><td>${f.testWindows}</td><td>${f.signal}</td><td>${f.test.n}</td><td>${f.test.n?fmt(f.zeroRate):'—'}</td><td>${f.test.zero}/${f.test.n}</td></tr>`).join('');
      el.validation.innerHTML += `<div class="sih-wf-block"><div class="sih-validation-head"><div><h3>Phase 7 · Expanding walk-forward validation</h3><p>Each round selects UP or DOWN using only earlier observations, then evaluates that choice on the next chronological block. Test blocks are disjoint.</p></div><span class="sih-badge">5 sequential rounds</span></div>
        <div class="sih-validation-table-wrap"><table class="sih-delayed-table"><thead><tr><th>Round</th><th>Training windows</th><th>Test windows</th><th>Selected signal</th><th>Selected test n</th><th>Test zero-net</th><th>Double losses / n</th></tr></thead><tbody>${wfRows || '<tr><td colspan="7">Insufficient history for walk-forward testing.</td></tr>'}</tbody></table></div>
        <div class="sih-validation-result"><div><span>Qualifying walk-forward rounds</span><b>${agg.folds || 0} / 5</b><small>Rounds with at least 30 training examples per eligible signal and selected test observations.</small></div><div><span>Aggregated selected-signal test</span><b>${agg.n || 0} observations · ${fmt(agg.zeroRate)}</b><small>${agg.zero || 0} double-loss cases across disjoint test blocks.</small></div><div><span>Illustrative walk-forward net / pair</span><b class="${Number.isFinite(wfEV)&&wfEV>=0?'positive':'negative'}">${Number.isFinite(wfEV)?money(wfEV):'—'}</b><small>${r.quotes?.ready ? 'Current quoted payouts' : 'Assumed payout '+money(assumed)}; quotes can change before execution.</small></div></div>
        <p class="sih-calc-caption">The expanding training windows begin at 50% of available observations and advance in 10-point increments; each round tests the next 10%. In overlapping mode, adjacent observations still share ticks. Even non-overlapping historical windows do not guarantee future performance. This is a historical walk-forward diagnostic, not proof of a tradable edge.</p></div>`;
    }

    renderRanking();
  }

  function activeCurrency() { const a = (window.AppState?.accounts || []).find(x => x.account_id === window.AppState?.activeAccountId); return a?.currency || 'USD'; }

  async function requestPairQuotes(meta, stake) {
    const base = { amount: stake, basis: 'stake', currency: activeCurrency(), duration: 2, duration_unit: 't', symbol: meta.symbol };
    const [riseRes, fallRes] = await Promise.all([
      derivAPI.send({ proposal: 1, ...base, contract_type: 'CALL' }),
      derivAPI.send({ proposal: 1, ...base, contract_type: 'PUT' })
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
