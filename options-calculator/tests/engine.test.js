// Run with: node tests/engine.test.js
const E = require('../engine.js');
let pass = 0, fail = 0;
const near = (a, b, tol) => Math.abs(a - b) <= tol;
function check(name, ok, detail) { if (ok) pass++; else { fail++; console.log('FAIL', name, detail || ''); } }

/* 1. Black-Scholes against published textbook values */
// Hull, Options Futures & Other Derivatives, Example 15.6: S=42 K=40 r=10% σ=20% T=0.5 → c=4.76, p=0.81
check('Hull call', near(E.bs('C', 42, 40, 0.5, 0.10, 0, 0.2).price, 4.7594, 1e-3));
check('Hull put', near(E.bs('P', 42, 40, 0.5, 0.10, 0, 0.2).price, 0.8086, 1e-3));
// Standard reference: S=K=100 T=1 r=5% σ=20% → call 10.4506, put 5.5735
check('ATM call', near(E.bs('C', 100, 100, 1, 0.05, 0, 0.2).price, 10.4506, 1e-4));
check('ATM put', near(E.bs('P', 100, 100, 1, 0.05, 0, 0.2).price, 5.5735, 1e-4));
check('ATM call delta', near(E.bs('C', 100, 100, 1, 0.05, 0, 0.2).delta, 0.6368, 1e-4));
// Hull Example 19.x Greeks: S=49 K=50 r=5% σ=20% T=0.3846 → delta .522, gamma .066, vega 12.1 (per 100%), theta −4.31/yr
const h = E.bs('C', 49, 50, 0.3846, 0.05, 0, 0.2);
check('Hull delta', near(h.delta, 0.522, 1e-3), h.delta);
check('Hull gamma', near(h.gamma, 0.066, 1e-3), h.gamma);
check('Hull vega', near(h.vega * 100, 12.1, 0.05), h.vega);
check('Hull theta', near(h.theta * 365, -4.31, 0.01), h.theta * 365);
// Merton with dividend yield: Hull Ex 17.1 S=930 K=900 r=8% q=3% σ=20% T=2/12 → call 51.83
check('Merton call (dividends)', near(E.bs('C', 930, 900, 2 / 12, 0.08, 0.03, 0.2).price, 51.83, 0.01));
// Normal CDF
check('N(0)', near(E.N(0), 0.5, 1e-12)); check('N(1.96)', near(E.N(1.96), 0.9750021, 1e-7)); check('N(-3)', near(E.N(-3), 0.0013499, 1e-7));

/* 2. Put-call parity and implied vol round-trip on random inputs */
let worstParity = 0, worstIv = 0;
for (let i = 0; i < 2000; i++) {
  const S = 5 + Math.random() * 995, K = S * (0.5 + Math.random()), T = 0.01 + Math.random() * 2, r = Math.random() * 0.08, q = Math.random() * 0.04, v = 0.05 + Math.random() * 1.2;
  const c = E.bs('C', S, K, T, r, q, v).price, p = E.bs('P', S, K, T, r, q, v).price;
  worstParity = Math.max(worstParity, Math.abs(c - p - (S * Math.exp(-q * T) - K * Math.exp(-r * T))) / S);
  const t = Math.random() < .5 ? 'C' : 'P', price = t === 'C' ? c : p;
  if (price > 0.01) { const iv = E.impliedVol(t, price, S, K, T, r, q); if (iv) worstIv = Math.max(worstIv, Math.abs(E.bs(t, S, K, T, r, q, iv).price - price)); }
}
check('put-call parity (2000 random)', worstParity < 1e-10, worstParity);
check('implied vol round-trip (price error < $0.0001)', worstIv < 1e-4, worstIv);

/* 3. Every strategy: analyzer vs an independent brute-force payoff at expiration */
const now = new Date(2026, 9, 14, 10, 0, 0);
const front = '2026-11-20', back = '2026-12-18', S0 = 255, r = 0.036, q = 0;
const strikes = E.syntheticStrikes(S0);
function intrinsicPnl(legs, S, mult) { // independent: pure payoff at front expiry; back legs valued with BS
  let v = 0;
  for (const l of legs) {
    let val;
    if (l.t === 'S') val = S;
    else if (l.exp === front) val = l.t === 'C' ? Math.max(S - l.k, 0) : Math.max(l.k - S, 0);
    else val = E.bs(l.t, S, l.k, (E.closeOf(l.exp) - E.closeOf(front)) / E.YEAR_MS, r, q, l.iv).price;
    v += l.s * l.q * (val - l.price);
  }
  return v * mult;
}
const summary = [];
for (const tpl of E.STRATEGIES) {
  const legs = E.buildLegs(tpl, { S0, strikes: { front: strikes, back: strikes }, front, back, iv: 0.28, now })
    .map(l => { const T = l.t === 'S' ? 0 : (E.closeOf(l.exp) - now) / E.YEAR_MS; return { ...l, iv: 0.28, price: l.t === 'S' ? S0 : E.bs(l.t, S0, l.k, T, r, q, 0.28).price }; });
  // legs sanity: strikes valid and ordered as the template intends
  const bad = legs.some(l => l.t !== 'S' && !(l.k > 0));
  check(tpl.name + ': strikes assigned', !bad);
  const optM = tpl.legs.filter(l => l.t !== 'S');
  for (let i = 0; i < optM.length; i++) for (let j = 0; j < optM.length; j++) {
    const a = legs[tpl.legs.indexOf(optM[i])], b = legs[tpl.legs.indexOf(optM[j])];
    if (optM[i].m < optM[j].m && optM[i].e === optM[j].e) check(tpl.name + ': strike order', a.k < b.k, a.k + ' vs ' + b.k);
  }
  const A = E.analyze(legs, { S0, r, q, contracts: 1, now, popIv: 0.28, horizon: front });
  // brute force on a very fine grid
  let mx = -Infinity, mn = Infinity; const bes = []; let prev = null, zeroAt = null;
  for (let i = 0; i <= 200000; i++) {
    const S = i * 0.01; const y = intrinsicPnl(legs, S, 100);
    mx = Math.max(mx, y); mn = Math.min(mn, y);
    if (Math.abs(y) < 1e-7) { if (prev !== null && zeroAt === null) zeroAt = S; continue; }
    if (prev !== null && (prev < 0) !== (y < 0)) bes.push(zeroAt ?? S);
    prev = y; zeroAt = null;
  }
  const tailSlope = (intrinsicPnl(legs, 5000, 100) - intrinsicPnl(legs, 4000, 100)) / 1000 / 100;
  const unlimUp = tailSlope > 0.05, unlimDn = tailSlope < -0.05;
  check(tpl.name + ': unlimited profit flag', (A.maxProfit === Infinity) === unlimUp, A.maxProfit + ' slope ' + tailSlope);
  check(tpl.name + ': unlimited loss flag', (A.maxLoss === -Infinity) === unlimDn, A.maxLoss + ' slope ' + tailSlope);
  if (!unlimUp) check(tpl.name + ': max profit', near(A.maxProfit, mx, 0.6), A.maxProfit.toFixed(2) + ' vs ' + mx.toFixed(2));
  if (!unlimDn) check(tpl.name + ': max loss', near(A.maxLoss, mn, 0.6), A.maxLoss.toFixed(2) + ' vs ' + mn.toFixed(2));
  const bInGrid = A.breakevens.filter(b => b <= 2000);
  check(tpl.name + ': breakeven count', bInGrid.length === bes.length, JSON.stringify(bInGrid.map(b => b.toFixed(2))) + ' vs ' + JSON.stringify(bes));
  bInGrid.forEach((b, i) => check(tpl.name + ': breakeven ' + i, bes[i] != null && near(b, bes[i], 0.011), b + ' vs ' + bes[i]));
  check(tpl.name + ': chance of profit within 0..1', A.pop >= 0 && A.pop <= 1.000001, A.pop);
  summary.push([tpl.name, legs.map(l => (l.s > 0 ? '+' : '-') + l.q + l.t + (l.k ?? '') + (l.exp === back ? 'b' : '')).join(' '), A.net.toFixed(0), A.maxProfit === Infinity ? 'unl' : A.maxProfit.toFixed(0), A.maxLoss === -Infinity ? 'unl' : A.maxLoss.toFixed(0), A.breakevens.map(b => b.toFixed(2)).join('/'), (A.pop * 100).toFixed(1) + '%']);
}

/* 4. Closed-form checks for the classic strategies */
function make(spec) { return spec.map(([t, s, qq, k, price]) => ({ t, s, q: qq, k, exp: front, price, iv: 0.3 })); }
const opt = { S0: 100, r: 0.03, q: 0, contracts: 1, now, popIv: 0.3, horizon: front };
let A = E.analyze(make([['C', 1, 1, 100, 4]]), opt);
check('long call: max loss = premium', near(A.maxLoss, -400, 1e-6)); check('long call: BE = K + p', near(A.breakevens[0], 104, 1e-6)); check('long call: unlimited', A.maxProfit === Infinity);
A = E.analyze(make([['C', 1, 1, 100, 4], ['C', -1, 1, 110, 1.5]]), opt);
check('bull call: max profit', near(A.maxProfit, (10 - 2.5) * 100, 1e-6)); check('bull call: max loss', near(A.maxLoss, -250, 1e-6)); check('bull call: BE', near(A.breakevens[0], 102.5, 1e-6));
A = E.analyze(make([['P', 1, 1, 90, 0.8], ['P', -1, 1, 95, 1.9], ['C', -1, 1, 105, 2.1], ['C', 1, 1, 110, 0.9]]), opt);
check('iron condor: credit', near(A.net, -230, 1e-6)); check('iron condor: max profit', near(A.maxProfit, 230, 1e-6)); check('iron condor: max loss', near(A.maxLoss, -270, 1e-6));
check('iron condor: BEs', near(A.breakevens[0], 92.7, 1e-6) && near(A.breakevens[1], 107.3, 1e-6), A.breakevens);
A = E.analyze(make([['C', 1, 1, 100, 4], ['P', 1, 1, 100, 3.5]]), opt);
check('straddle: BEs', near(A.breakevens[0], 92.5, 1e-6) && near(A.breakevens[1], 107.5, 1e-6)); check('straddle: max loss', near(A.maxLoss, -750, 1e-6));
A = E.analyze([{ t: 'S', s: 1, q: 1, k: null, exp: null, price: 100, iv: 0 }, ...make([['C', -1, 1, 105, 2]])], opt);
check('covered call: max profit', near(A.maxProfit, 700, 1e-6)); check('covered call: BE', near(A.breakevens[0], 98, 1e-6)); check('covered call: max loss', near(A.maxLoss, -9800, 1e-6));
A = E.analyze(make([['P', -1, 1, 95, 2]]), opt);
check('short put: max loss', near(A.maxLoss, -9300, 1e-6)); check('short put: BE', near(A.breakevens[0], 93, 1e-6));
A = E.analyze(make([['C', 1, 1, 95, 6], ['C', -1, 2, 100, 3], ['C', 1, 1, 105, 1]]), opt);
check('butterfly: max profit', near(A.maxProfit, 400, 1e-6)); check('butterfly: max loss', near(A.maxLoss, -100, 1e-6)); check('butterfly: BEs', near(A.breakevens[0], 96, 1e-6) && near(A.breakevens[1], 104, 1e-6));
A = E.analyze(make([['C', -1, 1, 100, 4], ['C', 1, 2, 105, 2]]), opt); // zero-cost backspread
check('backspread: unlimited up', A.maxProfit === Infinity); check('backspread: max loss at upper strike', near(A.maxLoss, -500, 1e-6)); check('backspread: upper BE', near(A.breakevens[A.breakevens.length - 1], 110, 1e-6));
// contracts scale linearly
const A5 = E.analyze(make([['C', 1, 1, 100, 4]]), { ...opt, contracts: 5 }); check('5 contracts scale', near(A5.maxLoss, -2000, 1e-6));
// probability of profit: long stock-like synthetic, BE at forward → ~50%; long call BE far out → small
A = E.analyze(make([['C', 1, 1, 100, 0.0001]]), opt); const T0 = (E.closeOf(front) - now) / E.YEAR_MS;
check('PoP of near-free call = P(S_T > 100)', near(A.pop, E.N((Math.log(100 / 100) + (0.03 - 0.045) * T0) / (0.3 * Math.sqrt(T0))), 1e-3), A.pop);

/* 5. Calendar: T+0 value at today equals zero when priced at model, and horizon uses back-leg time value */
const cal = [{ t: 'C', s: -1, q: 1, k: 100, exp: front, iv: 0.3 }, { t: 'C', s: 1, q: 1, k: 100, exp: back, iv: 0.3 }]
  .map(l => ({ ...l, price: E.bs('C', 100, 100, (E.closeOf(l.exp) - now) / E.YEAR_MS, 0.03, 0, 0.3).price }));
A = E.analyze(cal, opt);
check('calendar: P/L now at spot = 0', near(A.pnl(100, now), 0, 1e-6));
const backAtFront = E.bs('C', 100, 100, (E.closeOf(back) - E.closeOf(front)) / E.YEAR_MS, 0.03, 0, 0.3).price;
check('calendar: horizon P/L at strike', near(A.pnl(100), (backAtFront - cal[1].price + cal[0].price) * 100, 1e-6));
check('calendar: horizon = front expiry', A.horizonIso === front);

/* 6. Data parsers with sample payloads in each provider's documented shape */
check('OCC parse', JSON.stringify(E.parseOcc('AAPL261120C00260000')) === JSON.stringify({ root: 'AAPL', exp: '2026-11-20', t: 'C', k: 260 }));
check('OCC parse index', E.parseOcc('_SPX261218P05500000').k === 5500);
check('OCC parse half strike', E.parseOcc('F261120C00012500').k === 12.5);
const cboe = E.parseCboe({ timestamp: '2026-10-14 13:20:01', data: { symbol: 'AAPL', current_price: 254.1, price_change: -1.2, prev_day_close: 255.3, last_trade_time: '2026-10-14T13:19:58', options: [
  { option: 'AAPL261120C00260000', bid: 5.1, ask: 5.3, iv: 0.271, open_interest: 1200, volume: 300, delta: 0.42, last_trade_price: 5.2 },
  { option: 'AAPL261120P00250000', bid: 6.0, ask: 6.2, iv: 0.29, open_interest: 900, volume: 120, delta: -0.38, last_trade_price: 6.1 },
  { option: 'AAPL261218C00260000', bid: 8.0, ask: 8.4, iv: 0.27 }] } }, 'AAPL');
check('Cboe price', cboe.price === 254.1 && cboe.change === -1.2);
check('Cboe expirations', JSON.stringify(cboe.expirations) === '["2026-11-20","2026-12-18"]');
check('Cboe quote lookup + mid', near(E.mid(E.chainQuote(cboe, '2026-11-20', 'C', 260)), 5.2, 1e-9));
check('Cboe strikes', JSON.stringify(E.chainStrikes(cboe, '2026-11-20')) === '[250,260]');
const tr = E.emptyChain('AAPL', 'Tradier', false);
E.parseTradierQuote({ quotes: { quote: { symbol: 'AAPL', last: 254.5, change: -0.8, prevclose: 255.3, trade_date: 1792000000000 } } }, tr);
E.parseTradierChain({ options: { option: [{ symbol: 'AAPL261120C00260000', strike: 260, option_type: 'call', bid: 5.0, ask: 5.4, last: 5.2, expiration_date: '2026-11-20', greeks: { delta: 0.41, mid_iv: 0.268, smv_vol: 0.27 } }] } }, tr, '2026-11-20');
E.parseTradierChain({ options: { option: { strike: 250, option_type: 'put', bid: 6, ask: 6.4, expiration_date: '2026-11-20', greeks: null } } }, tr, '2026-11-20'); // single object, no greeks
check('Tradier quote', tr.price === 254.5);
check('Tradier chain (array + single object)', E.chainStrikes(tr, '2026-11-20').join() === '250,260' && near(E.chainQuote(tr, '2026-11-20', 'C', 260).iv, 0.268, 1e-9));
check('mid falls back to last when no ask', E.mid({ bid: 0, ask: 0, last: 1.1 }) === 1.1);

/* 7. Real Cboe data (AAPL snapshot captured 19 Oct 2026, 11:10 AM ET) and the quote robot's output */
const fs = require('fs'), path = require('path'), cp = require('child_process'), os = require('os');
check('OCC parse root with digit', JSON.stringify(E.parseOcc('AAPL1261120C00340000')) === JSON.stringify({ root: 'AAPL1', exp: '2026-11-20', t: 'C', k: 340 }));
check('OCC parse weekly index root', E.parseOcc('SPXW261120P05500000').root === 'SPXW');
const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'cboe-aapl-sample.json'), 'utf8'));
const direct = E.parseCboe(raw, 'AAPL');
check('real Cboe: price', direct.price === 343.97);
check('real Cboe: timestamp read as UTC', direct.asOf.toISOString() === '2026-10-19T15:10:23.000Z', direct.asOf);
check('real Cboe: expirations', direct.expirations.join() === '2026-11-20,2026-12-18');
// run the robot script on the same data and compare every quote
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'robot-'));
fs.writeFileSync(path.join(tmp, 'symbols.txt'), 'AAPL\nZZZZ!\n');
cp.execFileSync('python3', [path.join(__dirname, '..', 'tools', 'fetch_quotes.py'), path.join(tmp, 'symbols.txt'), path.join(tmp, 'out'), '--from-file', 'AAPL=' + path.join(__dirname, 'cboe-aapl-sample.json')], { stdio: 'pipe' });
const robotJson = JSON.parse(fs.readFileSync(path.join(tmp, 'out', 'AAPL.json'), 'utf8'));
const index = JSON.parse(fs.readFileSync(path.join(tmp, 'out', 'index.json'), 'utf8'));
const viaRobot = E.parseRobot(robotJson);
check('robot: index lists AAPL', index.symbols.join() === 'AAPL');
check('robot: index reports invalid symbol', !!index.errors['ZZZZ!']);
check('robot: last trade time kept in New York time', new Date(robotJson.asOf).toISOString() === '2026-10-19T14:55:23.000Z', robotJson.asOf);
check('robot: same number of quotes as Cboe', viaRobot.quotes.size === direct.quotes.size, viaRobot.quotes.size + ' vs ' + direct.quotes.size);
let qMismatch = 0;
for (const [k, q] of direct.quotes) { const r = viaRobot.quotes.get(k); if (!r || r.bid !== q.bid || r.ask !== q.ask || r.iv !== q.iv || r.oi !== q.oi || r.delta !== q.delta || r.last !== q.last) qMismatch++; }
check('robot: every bid/ask/IV/OI/delta identical to Cboe', qMismatch === 0, qMismatch);
check('robot: size is a fraction of Cboe', JSON.stringify(robotJson).length < JSON.stringify(raw).length * 0.6);
check('robot: price & change', viaRobot.price === 343.97 && viaRobot.change === 0.51);
// pricing model vs real market: reprice the Nov 20 chain from Cboe's own IVs; should land inside or near the bid/ask
const snapNow = new Date('2026-10-19T14:55:23Z'); let worst = 0, worstIvGap = 0, rt = 0, inside = 0, n = 0;
for (const [k, q] of viaRobot.quotes) {
  const [exp, t, ks] = k.split('|'); if (!(q.iv > 0.05 && q.ask > 0.5)) continue;
  const T = (E.closeOf(exp) - snapNow) / E.YEAR_MS, model = E.bs(t, 343.97, +ks, T, 0.036, 0.004, q.iv).price, m = E.mid(q);
  worst = Math.max(worst, Math.abs(model - m) / Math.max(m, 1)); n++; if (model >= q.bid - 0.1 && model <= q.ask + 0.1) inside++;
  const iv = E.impliedVol(t, m, 343.97, +ks, T, 0.036, 0.004);              // what the app uses for each leg
  if (Math.abs(q.delta) > 0.15 && Math.abs(q.delta) < 0.85) worstIvGap = Math.max(worstIvGap, Math.abs(iv - q.iv)); // near the money (deep ITM spreads make IV noisy)
  rt = Math.max(rt, Math.abs(E.bs(t, 343.97, +ks, T, 0.036, 0.004, iv).price - m)); // reprices the mid exactly
}
check(`model with Cboe's IV within 3% of real mid (${n} AAPL options)`, worst < 0.03, (worst * 100).toFixed(2) + '%');
check(`model within 10 cents of the real bid/ask on ${inside}/${n} options`, inside >= n - 2, inside + '/' + n);
check('implied vol from real near-the-money mids within 1.5 pts of Cboe IV', worstIvGap < 0.015, (worstIvGap * 100).toFixed(2) + ' pts');
check('leg IV reprices the real mid to the cent', rt < 0.005, rt);
// real-data strategy: iron condor from the live Nov 20 chain, cross-checked by hand
const leg = (t, s, k) => { const q = E.chainQuote(viaRobot, '2026-11-20', t, k); return { t, s, q: 1, k, exp: '2026-11-20', price: E.mid(q), iv: q.iv }; };
const ic = [leg('P', 1, 320), leg('P', -1, 330), leg('C', -1, 360), leg('C', 1, 370)];
const credit = -(3.425) + 5.575 + 4.70 - 2.315; // mids: 320P 3.425, 330P 5.575, 360C 4.70, 370C 2.315
const Aic = E.analyze(ic, { S0: 343.97, r: 0.036, q: 0.004, contracts: 1, now: snapNow, popIv: 0.27 });
check('real iron condor: credit', near(-Aic.net, credit * 100, 1e-6), Aic.net);
check('real iron condor: max profit', near(Aic.maxProfit, credit * 100, 1e-6));
check('real iron condor: max loss', near(Aic.maxLoss, -(10 - credit) * 100, 1e-6));
check('real iron condor: breakevens', near(Aic.breakevens[0], 330 - credit, 1e-6) && near(Aic.breakevens[1], 360 + credit, 1e-6), Aic.breakevens);
fs.rmSync(tmp, { recursive: true, force: true });
// GitHub Pages address → repository
check('repo from Pages URL', E.repoFromLocation({ hostname: 'nivy.github.io', pathname: '/options-calculator/' }) === 'nivy/options-calculator');
check('repo from user site', E.repoFromLocation({ hostname: 'nivy.github.io', pathname: '/' }) === 'nivy/nivy.github.io');
check('no repo off GitHub Pages', E.repoFromLocation({ hostname: 'example.com', pathname: '/x/' }) === null);

console.log('\nStrategy results (AAPL $255 example, Nov 20 / Dec 18, IV 28%, model prices):');
console.table(summary.map(s => ({ strategy: s[0], legs: s[1], 'net $': s[2], 'max profit': s[3], 'max loss': s[4], breakevens: s[5], 'chance': s[6] })));
console.log(`\n${pass} checks passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
