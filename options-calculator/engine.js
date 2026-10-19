/* Options Scenario Calculator — pricing engine, strategy library and data feeds.
   Works in the browser (window.OptEngine) and in Node (module.exports) for testing. */
(function (root) {
  'use strict';

  /* ---------------- math ---------------- */
  // Normal CDF (Hart / West double-precision algorithm, abs error < 1e-14)
  function N(x) {
    const z = Math.abs(x);
    let c;
    if (z > 37) c = 0;
    else {
      const e = Math.exp(-z * z / 2);
      if (z < 7.07106781186547) {
        let n = 3.52624965998911e-02 * z + 0.700383064443688;
        n = n * z + 6.37396220353165; n = n * z + 33.912866078383; n = n * z + 112.079291497871;
        n = n * z + 221.213596169931; n = n * z + 220.206867912376;
        let d = 8.83883476483184e-02 * z + 1.75566716318264;
        d = d * z + 16.064177579207; d = d * z + 86.7807322029461; d = d * z + 296.564248779674;
        d = d * z + 637.333633378831; d = d * z + 793.826512519948; d = d * z + 440.413735824752;
        c = e * n / d;
      } else {
        let b = z + 0.65; b = z + 4 / b; b = z + 3 / b; b = z + 2 / b; b = z + 1 / b;
        c = e / b / 2.506628274631;
      }
    }
    return x > 0 ? 1 - c : c;
  }
  const npdf = x => Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);

  /** Black-Scholes-Merton price and Greeks for one share.
   *  type 'C' | 'P' | 'S'; T in years; r, q, v as decimals.
   *  theta is per calendar day, vega per 1 vol point. */
  function bs(type, S, K, T, r, q, v) {
    if (type === 'S') return { price: S, delta: 1, gamma: 0, theta: 0, vega: 0 };
    if (!(T > 0) || !(v > 0) || !(S > 0)) {
      const price = type === 'C' ? Math.max(S - K, 0) : Math.max(K - S, 0);
      const delta = type === 'C' ? (S > K ? 1 : 0) : (S < K ? -1 : 0);
      return { price, delta, gamma: 0, theta: 0, vega: 0 };
    }
    const sq = Math.sqrt(T), d1 = (Math.log(S / K) + (r - q + v * v / 2) * T) / (v * sq), d2 = d1 - v * sq;
    const dq = Math.exp(-q * T), dr = Math.exp(-r * T), pd = npdf(d1);
    const gamma = dq * pd / (S * v * sq), vega = S * dq * pd * sq / 100, decay = -S * dq * pd * v / (2 * sq);
    if (type === 'C') return {
      price: S * dq * N(d1) - K * dr * N(d2), delta: dq * N(d1), gamma, vega,
      theta: (decay - r * K * dr * N(d2) + q * S * dq * N(d1)) / 365
    };
    return {
      price: K * dr * N(-d2) - S * dq * N(-d1), delta: dq * (N(d1) - 1), gamma, vega,
      theta: (decay + r * K * dr * N(-d2) - q * S * dq * N(-d1)) / 365
    };
  }

  /** Implied volatility from a price, by bisection. Returns null when the price is outside model bounds. */
  function impliedVol(type, price, S, K, T, r, q) {
    if (type === 'S' || !(T > 0) || !(price > 0)) return null;
    const lo0 = bs(type, S, K, T, r, q, 1e-4).price, hi0 = bs(type, S, K, T, r, q, 5).price;
    if (price <= lo0 + 1e-9 || price >= hi0) return null;
    let lo = 1e-4, hi = 5;
    for (let i = 0; i < 80; i++) {
      const mid = (lo + hi) / 2;
      if (bs(type, S, K, T, r, q, mid).price > price) hi = mid; else lo = mid;
    }
    return (lo + hi) / 2;
  }

  /* ---------------- dates ---------------- */
  const YEAR_MS = 365 * 864e5;
  /** Market close (4pm local) on an ISO date string 'YYYY-MM-DD'. */
  function closeOf(iso) { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d, 16, 0, 0); }
  function isoOf(dt) { return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0'); }
  function addDays(iso, n) { const d = closeOf(iso); d.setDate(d.getDate() + n); return isoOf(d); }
  function daysBetween(aIso, bIso) { return Math.round((closeOf(bIso) - closeOf(aIso)) / 864e5); }

  /** Standard monthly expirations (third Friday) for the next n months — used when no live chain is loaded. */
  function monthlyExpirations(now, n) {
    const out = [];
    for (let k = 0; out.length < n && k < n + 2; k++) {
      const d = new Date(now.getFullYear(), now.getMonth() + k, 1);
      const first = (5 - d.getDay() + 7) % 7 + 1; d.setDate(first + 14);
      d.setHours(16);
      if (d > now) out.push(isoOf(d));
    }
    return out;
  }
  /** Listed-style strike ladder around a price — used when no live chain is loaded. */
  function syntheticStrikes(S) {
    const inc = S < 5 ? 0.5 : S < 25 ? 0.5 : S < 100 ? 1 : S < 250 ? 2.5 : S < 1000 ? 5 : S < 3000 ? 10 : 25;
    const lo = Math.max(inc, Math.floor(S * 0.4 / inc) * inc), hi = Math.ceil(S * 1.8 / inc) * inc, out = [];
    for (let k = lo; k <= hi + 1e-9; k += inc) out.push(Math.round(k * 100) / 100);
    return out;
  }

  /* ---------------- strategy library ----------------
     Each leg: t = C/P/S, s = +1 buy / -1 sell, q = ratio, m = strike offset in "width units"
     (0 = at the money, +1 = one unit above), e = 'front' | 'back' expiration. */
  const L = (t, s, q, m, e) => ({ t, s, q, m: m || 0, e: e || 'front' });
  const STRATEGIES = [
    // Bullish
    { id: 'long_call', name: 'Long call', group: 'Bullish', legs: [L('C', 1, 1, 0)], desc: 'Buy a call. Profits as the stock rises; risk is the premium paid.' },
    { id: 'short_put', name: 'Short put', group: 'Bullish', legs: [L('P', -1, 1, -1)], desc: 'Sell a put and keep the premium if the stock stays above the strike. Large downside if it falls.' },
    { id: 'csp', name: 'Cash-secured put', group: 'Bullish', legs: [L('P', -1, 1, -1)], cash: true, desc: 'Short put with cash set aside to buy 100 shares per contract at the strike.' },
    { id: 'bull_call', name: 'Bull call spread', group: 'Bullish', legs: [L('C', 1, 1, 0), L('C', -1, 1, 1)], desc: 'Buy a call, sell a higher call. Cheaper than a long call; gains capped at the upper strike.' },
    { id: 'bull_put', name: 'Bull put spread', group: 'Bullish', legs: [L('P', -1, 1, 0), L('P', 1, 1, -1)], desc: 'Sell a put, buy a lower put. Collect a credit with defined risk.' },
    { id: 'synthetic_long', name: 'Synthetic long stock', group: 'Bullish', legs: [L('C', 1, 1, 0), L('P', -1, 1, 0)], desc: 'Buy a call and sell a put at the same strike. Behaves like owning 100 shares.' },
    { id: 'risk_reversal', name: 'Risk reversal', group: 'Bullish', legs: [L('P', -1, 1, -1), L('C', 1, 1, 1)], desc: 'Sell an out-of-the-money put to pay for an out-of-the-money call.' },
    { id: 'call_backspread', name: 'Call ratio backspread', group: 'Bullish', legs: [L('C', -1, 1, 0), L('C', 1, 2, 1)], desc: 'Sell one call, buy two higher calls. Wants a big move up.' },
    { id: 'pmcc', name: "Poor man's covered call", group: 'Bullish', legs: [L('C', 1, 1, -1.5, 'back'), L('C', -1, 1, 1)], desc: 'Long in-the-money call in a later month replaces stock; sell a near-term call against it.' },
    { id: 'call_diagonal', name: 'Call diagonal', group: 'Bullish', legs: [L('C', 1, 1, 0, 'back'), L('C', -1, 1, 1)], desc: 'Buy a later call, sell a nearer higher call. Earns from time decay with a bullish tilt.' },
    { id: 'jade_lizard', name: 'Jade lizard', group: 'Bullish', legs: [L('P', -1, 1, -1), L('C', -1, 1, 1), L('C', 1, 1, 2)], desc: 'Short put plus a short call spread. With enough credit there is no upside risk.' },
    // Bearish
    { id: 'long_put', name: 'Long put', group: 'Bearish', legs: [L('P', 1, 1, 0)], desc: 'Buy a put. Profits as the stock falls; risk is the premium paid.' },
    { id: 'short_call', name: 'Short call (naked)', group: 'Bearish', legs: [L('C', -1, 1, 1)], desc: 'Sell a call without owning shares. Keeps the premium if the stock stays below; unlimited risk.' },
    { id: 'bear_put', name: 'Bear put spread', group: 'Bearish', legs: [L('P', 1, 1, 0), L('P', -1, 1, -1)], desc: 'Buy a put, sell a lower put. Cheaper than a long put; gains capped.' },
    { id: 'bear_call', name: 'Bear call spread', group: 'Bearish', legs: [L('C', -1, 1, 0), L('C', 1, 1, 1)], desc: 'Sell a call, buy a higher call. Collect a credit with defined risk.' },
    { id: 'synthetic_short', name: 'Synthetic short stock', group: 'Bearish', legs: [L('C', -1, 1, 0), L('P', 1, 1, 0)], desc: 'Sell a call and buy a put at the same strike. Behaves like shorting 100 shares.' },
    { id: 'put_backspread', name: 'Put ratio backspread', group: 'Bearish', legs: [L('P', -1, 1, 0), L('P', 1, 2, -1)], desc: 'Sell one put, buy two lower puts. Wants a big move down.' },
    { id: 'put_diagonal', name: 'Put diagonal', group: 'Bearish', legs: [L('P', 1, 1, 0, 'back'), L('P', -1, 1, -1)], desc: 'Buy a later put, sell a nearer lower put. Earns from time decay with a bearish tilt.' },
    // Neutral
    { id: 'iron_condor', name: 'Iron condor', group: 'Neutral', legs: [L('P', 1, 1, -2), L('P', -1, 1, -1), L('C', -1, 1, 1), L('C', 1, 1, 2)], desc: 'Sell an out-of-the-money put spread and call spread. Profits if the stock stays in a range.' },
    { id: 'iron_butterfly', name: 'Iron butterfly', group: 'Neutral', legs: [L('P', 1, 1, -1), L('P', -1, 1, 0), L('C', -1, 1, 0), L('C', 1, 1, 1)], desc: 'Sell an at-the-money straddle and buy wings. Best if the stock pins the middle strike.' },
    { id: 'short_straddle', name: 'Short straddle', group: 'Neutral', legs: [L('C', -1, 1, 0), L('P', -1, 1, 0)], desc: 'Sell a call and put at the same strike. Collects the most premium; unlimited risk.' },
    { id: 'short_strangle', name: 'Short strangle', group: 'Neutral', legs: [L('P', -1, 1, -1), L('C', -1, 1, 1)], desc: 'Sell an out-of-the-money put and call. Wider profit zone than a straddle; unlimited risk.' },
    { id: 'call_butterfly', name: 'Long call butterfly', group: 'Neutral', legs: [L('C', 1, 1, -1), L('C', -1, 2, 0), L('C', 1, 1, 1)], desc: 'Buy 1-2-1 calls. Cheap, defined risk; peak profit at the middle strike.' },
    { id: 'put_butterfly', name: 'Long put butterfly', group: 'Neutral', legs: [L('P', 1, 1, -1), L('P', -1, 2, 0), L('P', 1, 1, 1)], desc: 'Buy 1-2-1 puts. Cheap, defined risk; peak profit at the middle strike.' },
    { id: 'bwb', name: 'Broken-wing butterfly', group: 'Neutral', legs: [L('C', 1, 1, -1), L('C', -1, 2, 0), L('C', 1, 1, 2)], desc: 'A call butterfly with a wider upper wing, often opened for a credit.' },
    { id: 'call_condor', name: 'Long call condor', group: 'Neutral', legs: [L('C', 1, 1, -1.5), L('C', -1, 1, -0.5), L('C', -1, 1, 0.5), L('C', 1, 1, 1.5)], desc: 'Like a butterfly with a flat top. Wider profit zone, smaller peak.' },
    { id: 'call_calendar', name: 'Call calendar', group: 'Neutral', legs: [L('C', -1, 1, 0), L('C', 1, 1, 0, 'back')], desc: 'Sell a near-term call, buy a later call at the same strike. Profits from faster decay of the near month.' },
    { id: 'put_calendar', name: 'Put calendar', group: 'Neutral', legs: [L('P', -1, 1, 0), L('P', 1, 1, 0, 'back')], desc: 'Sell a near-term put, buy a later put at the same strike.' },
    { id: 'call_ratio', name: 'Call ratio spread', group: 'Neutral', legs: [L('C', 1, 1, 0), L('C', -1, 2, 1)], desc: 'Buy one call, sell two higher calls. Profits from a modest rise; unlimited risk above.' },
    { id: 'put_ratio', name: 'Put ratio spread', group: 'Neutral', legs: [L('P', 1, 1, 0), L('P', -1, 2, -1)], desc: 'Buy one put, sell two lower puts. Profits from a modest drop; large risk below.' },
    // Volatile
    { id: 'long_straddle', name: 'Long straddle', group: 'Volatile', legs: [L('C', 1, 1, 0), L('P', 1, 1, 0)], desc: 'Buy a call and put at the same strike. Profits from a big move either way.' },
    { id: 'long_strangle', name: 'Long strangle', group: 'Volatile', legs: [L('P', 1, 1, -1), L('C', 1, 1, 1)], desc: 'Buy an out-of-the-money put and call. Cheaper than a straddle; needs a bigger move.' },
    { id: 'strap', name: 'Strap', group: 'Volatile', legs: [L('C', 1, 2, 0), L('P', 1, 1, 0)], desc: 'Two calls and one put at the same strike. A straddle tilted to the upside.' },
    { id: 'strip', name: 'Strip', group: 'Volatile', legs: [L('C', 1, 1, 0), L('P', 1, 2, 0)], desc: 'One call and two puts at the same strike. A straddle tilted to the downside.' },
    { id: 'reverse_ic', name: 'Reverse iron condor', group: 'Volatile', legs: [L('P', -1, 1, -2), L('P', 1, 1, -1), L('C', 1, 1, 1), L('C', -1, 1, 2)], desc: 'Buy a put spread and call spread. Defined-risk bet on a breakout.' },
    { id: 'reverse_ib', name: 'Reverse iron butterfly', group: 'Volatile', legs: [L('P', -1, 1, -1), L('P', 1, 1, 0), L('C', 1, 1, 0), L('C', -1, 1, 1)], desc: 'Buy a straddle and sell wings. Cheaper long straddle with capped gains.' },
    // Stock & hedges
    { id: 'long_stock', name: 'Long stock', group: 'Stock & hedge', legs: [L('S', 1, 1)], desc: '100 shares per contract, for comparison.' },
    { id: 'short_stock', name: 'Short stock', group: 'Stock & hedge', legs: [L('S', -1, 1)], desc: 'Short 100 shares per contract, for comparison.' },
    { id: 'covered_call', name: 'Covered call', group: 'Stock & hedge', legs: [L('S', 1, 1), L('C', -1, 1, 1)], desc: 'Own the shares and sell a call. Income now, upside capped at the strike.' },
    { id: 'protective_put', name: 'Protective put', group: 'Stock & hedge', legs: [L('S', 1, 1), L('P', 1, 1, -1)], desc: 'Own the shares and buy a put as insurance. Sets a floor under the position.' },
    { id: 'collar', name: 'Collar', group: 'Stock & hedge', legs: [L('S', 1, 1), L('P', 1, 1, -1), L('C', -1, 1, 1)], desc: 'Own the shares, buy a put, sell a call to pay for it. Locks a range.' },
    { id: 'covered_put', name: 'Covered put', group: 'Stock & hedge', legs: [L('S', -1, 1), L('P', -1, 1, -1)], desc: 'Short the shares and sell a put. Income on a short position, gains capped.' }
  ];
  const GROUPS = ['Bullish', 'Bearish', 'Neutral', 'Volatile', 'Stock & hedge'];

  function nearestIndex(arr, x) { let b = 0; for (let i = 1; i < arr.length; i++) if (Math.abs(arr[i] - x) < Math.abs(arr[b] - x)) b = i; return b; }

  /** Turn a strategy template into concrete legs.
   *  ctx: { S0, strikes: {front:[...], back:[...]}, front, back, iv, now } */
  function buildLegs(tpl, ctx) {
    const T = Math.max((closeOf(ctx.front) - ctx.now) / YEAR_MS, 7 / 365);
    const u = Math.min(0.08, Math.max(0.015, (ctx.iv || 0.3) * Math.sqrt(T) * 0.5));
    const ks = ctx.strikes.front;
    const ms = [...new Set(tpl.legs.filter(l => l.t !== 'S').map(l => l.m))].sort((a, b) => a - b);
    const atm = nearestIndex(ks, ctx.S0), idx = {};
    // map offsets to strike indices: nearest to target, strictly increasing, centred on ATM for m = 0
    let prev = -1;
    ms.forEach(m => {
      let i = m === 0 ? atm : nearestIndex(ks, ctx.S0 * (1 + m * u));
      if (i <= prev) i = prev + 1;
      idx[m] = Math.min(i, ks.length - 1); prev = idx[m];
    });
    // if the upper end ran out of strikes, shift down
    const vals = ms.map(m => idx[m]);
    for (let j = vals.length - 1; j > 0; j--) if (vals[j] <= vals[j - 1]) vals[j - 1] = vals[j] - 1;
    ms.forEach((m, j) => idx[m] = Math.max(0, vals[j]));
    return tpl.legs.map(l => {
      if (l.t === 'S') return { t: 'S', s: l.s, q: l.q, k: null, exp: null };
      const exp = l.e === 'back' ? ctx.back : ctx.front;
      let k = ks[idx[l.m]];
      if (l.e === 'back' && ctx.strikes.back && ctx.strikes.back.length) k = ctx.strikes.back[nearestIndex(ctx.strikes.back, k)];
      return { t: l.t, s: l.s, q: l.q, k, exp };
    });
  }

  /* ---------------- position analysis ---------------- */
  /** legs: [{t, s, q, k, exp, price, iv}]; opts: {S0, r, q, contracts, now, horizon(ISO)} */
  function analyze(legs, opts) {
    const { S0, r, q, contracts } = opts, now = opts.now || new Date(), mult = 100 * contracts;
    const optLegs = legs.filter(l => l.t !== 'S');
    const horizonIso = optLegs.length ? optLegs.map(l => l.exp).sort()[0] : opts.horizon;
    const horizon = closeOf(horizonIso);
    const tLeft = (l, at) => Math.max(0, (closeOf(l.exp) - at) / YEAR_MS);

    function legValue(l, S, at, ivShift) {
      if (l.t === 'S') return S;
      return bs(l.t, S, l.k, tLeft(l, at), r, q, Math.max(0.005, l.iv + (ivShift || 0))).price;
    }
    /** P/L in dollars for the whole position at stock price S on moment `at`. */
    function pnl(S, at, ivShift) {
      at = at || horizon; let v = 0;
      for (const l of legs) v += l.s * l.q * (legValue(l, S, at, ivShift) - l.price);
      return v * mult;
    }
    const net = legs.reduce((a, l) => a + l.s * l.q * l.price, 0) * mult; // + debit, − credit

    // extremes at the horizon: evaluate at 0, every strike (kinks), a fine grid, and the far tail
    const strikes = optLegs.map(l => l.k);
    const hi = Math.max(S0, ...strikes) * 4;
    const pts = new Set([0, ...strikes]);
    for (let i = 1; i <= 2400; i++) pts.add(hi * i / 2400);
    const xs = [...pts].sort((a, b) => a - b), ys = xs.map(S => pnl(S));
    let maxP = -Infinity, minP = Infinity;
    ys.forEach(y => { if (y > maxP) maxP = y; if (y < minP) minP = y; });
    const far1 = hi * 2, far2 = hi * 3;
    const slope = (pnl(far2) - pnl(far1)) / (far2 - far1) / mult; // per share
    const unlimitedUp = slope > 0.05, unlimitedDown = slope < -0.05;

    // breakevens: sign changes, refined by bisection
    const bes = [], eps = 1e-9 * mult;
    let last = -1; // index of the last point with a clearly non-zero P/L
    for (let i = 0; i < xs.length; i++) {
      if (Math.abs(ys[i]) <= eps) continue;
      if (last >= 0 && (ys[last] < 0) !== (ys[i] < 0)) {
        if (i - last > 1) bes.push(xs[last + 1]); // P/L lands exactly on zero at a grid point
        else {
          let lo = xs[last], hi2 = xs[i], flo = ys[last];
          for (let k = 0; k < 60; k++) { const m = (lo + hi2) / 2, fm = pnl(m); if ((fm < 0) === (flo < 0)) { lo = m; flo = fm; } else hi2 = m; }
          bes.push((lo + hi2) / 2);
        }
      }
      last = i;
    }
    // long tail crossing beyond grid (e.g. backspreads)
    if (ys[ys.length - 1] < 0 && slope > 0.05) { let lo = hi, hi2 = hi * 50; for (let k = 0; k < 80; k++) { const m = (lo + hi2) / 2; if (pnl(m) < 0) lo = m; else hi2 = m; } bes.push((lo + hi2) / 2); }

    // probability of profit at the horizon (lognormal, risk-neutral drift)
    const T = Math.max(0, (horizon - now) / YEAR_MS), sig = opts.popIv || (optLegs[0] ? optLegs[0].iv : 0.3);
    const mu = Math.log(S0) + (r - q - sig * sig / 2) * T, sd = sig * Math.sqrt(T);
    const cdf = S => S <= 0 ? 0 : sd > 0 ? N((Math.log(S) - mu) / sd) : (S >= S0 ? 1 : 0);
    const cuts = [0, ...bes, Infinity];
    let pop = 0;
    for (let i = 1; i < cuts.length; i++) {
      const a = cuts[i - 1], b = cuts[i], mid = b === Infinity ? a * 1.5 + 1 : (a + b) / 2;
      if (pnl(mid) > 0) pop += (b === Infinity ? 1 : cdf(b)) - cdf(a);
    }

    // greeks now
    const g = { delta: 0, gamma: 0, theta: 0, vega: 0 };
    for (const l of legs) {
      const x = l.t === 'S' ? { delta: 1, gamma: 0, theta: 0, vega: 0 } : bs(l.t, S0, l.k, tLeft(l, now), r, q, l.iv);
      for (const k in g) g[k] += l.s * l.q * x[k] * mult;
    }
    const maxProfit = unlimitedUp ? Infinity : maxP, maxLoss = unlimitedDown ? -Infinity : minP;
    return {
      net, maxProfit, maxLoss, breakevens: bes, pop, greeks: g, pnl, horizonIso, horizon, T, mult,
      expectedMove: S0 * sig * Math.sqrt(T), sigma: sig
    };
  }

  /* ---------------- data feeds ---------------- */
  const OCC = /^(.*?)\s*(\d{6})([CP])(\d{8})$/; // root is everything before the last 15 characters
  function parseOcc(sym) {
    const m = OCC.exec(String(sym).trim().toUpperCase()); if (!m) return null;
    return { root: m[1], exp: '20' + m[2].slice(0, 2) + '-' + m[2].slice(2, 4) + '-' + m[2].slice(4, 6), t: m[3], k: +m[4] / 1000 };
  }
  const num = x => (x === null || x === undefined || x === '' || isNaN(+x)) ? null : +x;

  /** Normalised chain: { symbol, price, change, prevClose, asOf(Date|null), source, delayed, expirations:[iso], quotes: Map key 'exp|C|strike' -> {bid,ask,last,iv,oi,vol,delta} } */
  function emptyChain(symbol, source, delayed) { return { symbol, price: null, change: null, prevClose: null, asOf: null, source, delayed, expirations: [], quotes: new Map() }; }
  const qkey = (exp, t, k) => exp + '|' + t + '|' + (+k).toFixed(3);

  /** Cboe delayed quotes (no key; 15-minute delayed). */
  function parseCboe(json, symbol) {
    const d = json && json.data; if (!d) throw new Error('Unexpected response from Cboe.');
    const ch = emptyChain(symbol, 'Cboe delayed quotes', true);
    ch.price = num(d.current_price) ?? num(d.close);
    ch.prevClose = num(d.prev_day_close);
    ch.change = num(d.price_change) ?? (ch.price != null && ch.prevClose != null ? ch.price - ch.prevClose : null);
    ch.asOf = json.timestamp ? new Date(String(json.timestamp).replace(' ', 'T') + 'Z') : null; // Cboe's timestamp is UTC
    const exps = new Set();
    (d.options || []).forEach(o => {
      const p = parseOcc(o.option); if (!p) return;
      exps.add(p.exp);
      ch.quotes.set(qkey(p.exp, p.t, p.k), { bid: num(o.bid), ask: num(o.ask), last: num(o.last_trade_price), iv: num(o.iv), oi: num(o.open_interest), vol: num(o.volume), delta: num(o.delta) });
    });
    ch.expirations = [...exps].sort();
    return ch;
  }

  /* Quote robot: Cboe chains fetched by a GitHub Action and published to the repo's `quotes` branch.
     (Cboe's feed blocks web pages from reading it directly, so the app reads the robot's copy.) */
  /** Work out "owner/repo" from a GitHub Pages address like https://owner.github.io/repo/ */
  function repoFromLocation(loc) {
    if (!loc || !/\.github\.io$/i.test(loc.hostname || '')) return null;
    const owner = loc.hostname.split('.')[0], seg = (loc.pathname || '/').split('/').filter(Boolean)[0];
    return owner + '/' + (seg && !/\.[a-z0-9]+$/i.test(seg) ? seg : owner + '.github.io');
  }
  function robotUrl(repo, file) { return 'https://raw.githubusercontent.com/' + repo + '/quotes/' + file + '?t=' + Math.floor(Date.now() / 60000); }
  function parseRobot(json) {
    if (!json || json.v !== 1 || !Array.isArray(json.options)) throw new Error('The quote file is not in the expected format.');
    const ch = emptyChain(json.symbol, 'Cboe delayed quotes', true);
    ch.price = num(json.price); ch.change = num(json.change); ch.prevClose = num(json.prevClose);
    ch.asOf = json.asOf ? new Date(json.asOf) : null; ch.fetched = json.fetched ? new Date(json.fetched) : null;
    ch.via = 'robot';
    const exps = new Set();
    json.options.forEach(r => {
      const p = parseOcc(r[0]); if (!p) return;
      exps.add(p.exp);
      ch.quotes.set(qkey(p.exp, p.t, p.k), { bid: num(r[1]), ask: num(r[2]), iv: num(r[3]), oi: num(r[4]), delta: num(r[5]), last: num(r[6]), vol: null });
    });
    ch.expirations = [...exps].sort();
    return ch;
  }
  async function fetchRobotIndex(repo, fetchFn) {
    const r = await fetchFn(robotUrl(repo, 'index.json'), { cache: 'no-store' });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error('GitHub returned an error (' + r.status + ') for the quote list.');
    return r.json();
  }
  async function fetchRobot(repo, symbol, fetchFn) {
    const s = symbol.toUpperCase();
    const r = await fetchFn(robotUrl(repo, encodeURIComponent(s) + '.json'), { cache: 'no-store' });
    if (r.status === 404) { const e = new Error('not-on-list'); e.code = 'NOT_ON_LIST'; throw e; }
    if (!r.ok) throw new Error('GitHub returned an error (' + r.status + ') for ' + s + '.');
    return parseRobot(await r.json());
  }

  /** Tradier market data (free token; real-time with a brokerage token, delayed with a sandbox token). */
  const arr = x => x == null ? [] : Array.isArray(x) ? x : [x];
  function parseTradierQuote(json, ch) {
    const q = arr(json && json.quotes && json.quotes.quote)[0];
    if (!q) throw new Error('Tradier did not recognise that symbol.');
    ch.price = num(q.last) ?? num(q.close) ?? num(q.prevclose);
    ch.prevClose = num(q.prevclose); ch.change = num(q.change);
    ch.asOf = q.trade_date ? new Date(+q.trade_date) : null;
  }
  function parseTradierChain(json, ch, exp) {
    arr(json && json.options && json.options.option).forEach(o => {
      const t = o.option_type === 'call' ? 'C' : o.option_type === 'put' ? 'P' : null; if (!t) return;
      const g = o.greeks || {};
      ch.quotes.set(qkey(o.expiration_date || exp, t, o.strike), { bid: num(o.bid), ask: num(o.ask), last: num(o.last), iv: num(g.mid_iv) || num(g.smv_vol), oi: num(o.open_interest), vol: num(o.volume), delta: num(g.delta) });
    });
  }
  async function fetchTradier(symbol, token, sandbox, fetchFn, wantExps) {
    const base = sandbox ? 'https://sandbox.tradier.com/v1/' : 'https://api.tradier.com/v1/';
    const h = { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } };
    const get = async path => {
      const r = await fetchFn(base + path, h);
      if (r.status === 401) throw new Error('Tradier rejected the token. Check it in Settings.');
      if (!r.ok) throw new Error('Tradier returned an error (' + r.status + ').');
      return r.json();
    };
    const s = symbol.toUpperCase(), ch = emptyChain(s, sandbox ? 'Tradier (sandbox, delayed)' : 'Tradier', !!sandbox);
    parseTradierQuote(await get('markets/quotes?symbols=' + encodeURIComponent(s)), ch);
    const ex = await get('markets/options/expirations?symbol=' + encodeURIComponent(s) + '&includeAllRoots=true');
    ch.expirations = arr(ex && ex.expirations && ex.expirations.date).slice().sort();
    const load = (wantExps && wantExps.length ? wantExps : ch.expirations.slice(0, 1)).filter(e => ch.expirations.includes(e));
    for (const e of load) parseTradierChain(await get('markets/options/chains?symbol=' + encodeURIComponent(s) + '&expiration=' + e + '&greeks=true'), ch, e);
    ch.loadedExps = new Set(load);
    return ch;
  }
  async function fetchTradierExpiry(ch, exp, token, sandbox, fetchFn) {
    const base = sandbox ? 'https://sandbox.tradier.com/v1/' : 'https://api.tradier.com/v1/';
    const r = await fetchFn(base + 'markets/options/chains?symbol=' + encodeURIComponent(ch.symbol) + '&expiration=' + exp + '&greeks=true', { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } });
    if (!r.ok) throw new Error('Tradier returned an error (' + r.status + ').');
    parseTradierChain(await r.json(), ch, exp); ch.loadedExps.add(exp);
  }
  function chainStrikes(ch, exp) {
    const s = new Set(); for (const k of ch.quotes.keys()) { const [e, , st] = k.split('|'); if (e === exp) s.add(+st); }
    return [...s].sort((a, b) => a - b);
  }
  function chainQuote(ch, exp, t, k) { return ch ? ch.quotes.get(qkey(exp, t, k)) || null : null; }
  function mid(q) {
    if (!q) return null;
    if (q.bid != null && q.ask != null && q.ask > 0 && q.ask >= q.bid) return (q.bid + q.ask) / 2;
    return q.last != null && q.last > 0 ? q.last : null;
  }

  const api = {
    N, bs, impliedVol, closeOf, isoOf, addDays, daysBetween, monthlyExpirations, syntheticStrikes, YEAR_MS,
    STRATEGIES, GROUPS, buildLegs, analyze,
    parseOcc, parseCboe, repoFromLocation, robotUrl, parseRobot, fetchRobot, fetchRobotIndex, parseTradierQuote, parseTradierChain, fetchTradier, fetchTradierExpiry, emptyChain,
    chainStrikes, chainQuote, mid, qkey
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.OptEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
