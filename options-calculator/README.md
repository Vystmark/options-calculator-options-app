# Options Scenario Calculator

A web app for sizing up stock option trades. Load a symbol to pull its live option chain, pick one of 42 strategies (or build your own), and see the payoff chart, breakevens, max profit and loss, chance of profit, Greeks, and P/L across stock prices and dates.

It runs entirely in your browser: no server and no account. Once installed it also opens offline (live prices need a connection).

## Live prices

Choose the source under **Settings**:

| Source | Cost | Delay | Symbols | What you need |
|---|---|---|---|---|
| **Cboe via your quote robot** (default) | Free | 15 minutes, refreshed about every 10 minutes | The ones in `symbols.txt` (up to 40) | Nothing beyond this repository |
| **Tradier** | Free | 15 minutes with a sandbox token; real-time with a brokerage token | Any | A token from developer.tradier.com (sandbox) or a Tradier brokerage account |
| **Manual entry** | — | — | Any | Type the stock price; option prices come from the model |

**Why a robot?** Cboe publishes free option chains, but its server tells browsers not to share the data with other websites, so a web page can't read it directly. The quote robot is a small GitHub Action in this repository (`.github/workflows/quotes.yml` running `tools/fetch_quotes.py`). It downloads the chains on GitHub's servers every 10 minutes while the market is open and saves a compact copy to this repository's `quotes` branch, which the app reads.

- **Add or remove symbols:** edit `symbols.txt` on GitHub (pencil icon), one symbol per line, then **Commit changes**. The robot runs right away; quotes appear a minute or two later. Indexes such as SPX, NDX, RUT, VIX and XSP work too.
- **Refresh now:** **Actions** tab → **Update option quotes** → **Run workflow**.
- **Check on it:** the Actions tab lists every run. A green check means it worked. If a symbol failed, the app tells you why when you load it.
- GitHub can start scheduled runs 5–15 minutes late when it's busy. The app warns you if quotes are more than 35 minutes old during market hours.
- If the repository has no activity for 60 days, GitHub pauses scheduled runs and emails you. Click **Enable workflow** on the Actions tab to resume.

Option prices are the midpoint of bid and ask. Each leg shows its bid/ask, implied volatility, delta, open interest and contract code. You can always type your actual fill price into any leg. Your Tradier token is stored only in your own browser and sent only to Tradier.

## Strategies

- **Bullish:** long call, short put, cash-secured put, bull call spread, bull put spread, synthetic long, risk reversal, call ratio backspread, poor man's covered call, call diagonal, jade lizard
- **Bearish:** long put, short call, bear put spread, bear call spread, synthetic short, put ratio backspread, put diagonal
- **Neutral:** iron condor, iron butterfly, short straddle, short strangle, call and put butterflies, broken-wing butterfly, call condor, call and put calendars, call and put ratio spreads
- **Volatile:** long straddle, long strangle, strap, strip, reverse iron condor, reverse iron butterfly
- **Stock & hedge:** long stock, short stock, covered call, protective put, collar, covered put
- **Custom:** add, remove or change any leg (side, quantity, call/put/stock, expiration, strike, price, IV)

## Put it on GitHub Pages

1. On github.com, click **+ → New repository**. Name it `options-calculator`, set it to **Public**, and create it.
2. Click **uploading an existing file**. Unzip `options-calculator.zip`, open the folder, select **everything inside it** and drag it in, including the hidden **`.github`** folder. Click **Commit changes**.
   - On a Mac, Finder hides folders that start with a dot. Press **Cmd + Shift + .** in Finder to show `.github`, then select it with the rest.
   - Check: the repository's main page should list `.github`, `icons`, `tests`, `tools`, `engine.js`, `index.html`, `symbols.txt` and the other files at the top level.
3. Go to **Settings → Pages**. Set Source to **Deploy from a branch**, branch **main**, folder **/ (root)**, and click **Save**.
4. Go to the **Actions** tab. If GitHub asks, click to enable workflows. Open **Update option quotes** → **Run workflow** → **Run workflow** to fetch the first quotes (about a minute).
5. Open the link shown on **Settings → Pages** ("Your site is live at …").

`index.html` must be at the top level of the repository, not inside a folder, or GitHub shows a 404.

**If the `.github` folder didn't upload:** on the repository page click **Add file → Create new file**, type `.github/workflows/quotes.yml` as the name, paste in the contents of that file from the zip, and click **Commit changes**.

**Updating from an earlier version:** upload all the new files over the old ones (GitHub replaces files with the same name), then do step 4. Installed copies update the next time they open online.

## Install it as an app

- **iPhone / iPad:** Safari → **Share → Add to Home Screen**
- **Android:** Chrome → **⋮ → Install app**
- **Windows / Mac:** Chrome's install icon in the address bar, or Edge **… → Apps → Install this site as an app**

## How it calculates

- **Pricing:** Black-Scholes-Merton with a dividend yield, using each leg's own implied volatility and time to expiration (to 4pm on expiration day).
- **At expiration:** the solid line. For calendars and diagonals this is the first expiration, with the later leg valued by the model.
- **Scenario date and volatility change:** the dashed line and the P/L grid reprice every leg on the chosen date with volatility shifted by the chosen amount.
- **Max profit / max loss / breakevens:** found exactly at every strike plus a fine price grid, with unlimited cases detected from the slope beyond the last strike.
- **Chance of profit:** lognormal distribution at the at-the-money implied volatility.
- **Assumptions:** European-style exercise (no early assignment), no commissions or margin interest.

For education and planning, not investment advice. Verify prices with your broker before trading.

## Tests

`tests/engine.test.js` checks the engine (run `node tests/engine.test.js`): Black-Scholes prices and Greeks against textbook values (Hull), put-call parity and implied-volatility round trips on 2,000 random cases, every strategy's max profit, max loss and breakevens against an independent brute-force payoff, closed-form results for the classic strategies, calendar pricing, the Cboe and Tradier data parsers, and a real AAPL option chain captured from Cboe on 19 Oct 2026: the quote robot's output matches Cboe quote for quote, the model reprices real contracts within their bid/ask, and an iron condor built from real prices matches a hand calculation.
