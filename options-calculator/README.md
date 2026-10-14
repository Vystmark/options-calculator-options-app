# Options Scenario Calculator

A small web app for sizing up stock option trades. Enter a stock symbol, price, strike, expiration date and strategy, and it shows the payoff chart, breakevens, max profit and loss, chance of profit, Greeks, and P/L for a range of stock moves and dates.

It runs entirely in your browser: no server, no account, no data sent anywhere. After the first visit it also works offline, and it can be installed on your phone or computer like an app.

## Put it on GitHub Pages

1. Sign in at [github.com](https://github.com) (create a free account if you don't have one).
2. Click **+** (top right) → **New repository**. Name it `options-calculator`, set it to **Public**, and click **Create repository**.
3. On the new repository page, click **uploading an existing file**.
4. Unzip `options-calculator.zip` on your computer, open the folder, and drag **everything inside it** (`index.html`, `manifest.webmanifest`, `sw.js`, `README.md` and the `icons` folder) into the upload box. Click **Commit changes**.
5. Go to **Settings → Pages**. Under **Build and deployment**, set **Source** to **Deploy from a branch**, choose branch **main** and folder **/ (root)**, then click **Save**.
6. Wait a minute or two and refresh the page. Your app's address appears at the top:
   `https://YOUR-USERNAME.github.io/options-calculator/`

GitHub Pages on a free account requires the repository to be public. The code is visible to anyone, but nothing you type into the calculator is stored on GitHub; your inputs stay in your own browser.

## Install it as an app

Open your app's address, then:

- **iPhone / iPad:** in Safari, tap **Share → Add to Home Screen**.
- **Android:** in Chrome, tap **⋮ → Install app** (or **Add to Home screen**).
- **Windows / Mac in Chrome:** click the install icon at the right end of the address bar, or **⋮ → Cast, save and share → Install page as app**.
- **Windows / Mac in Edge:** **… → Apps → Install this site as an app**.
- **Mac in Safari:** **File → Add to Dock**.

## Updating it later

Upload the new `index.html` to the repository (it replaces the old one). Installed copies pick up the change the next time they're opened with an internet connection. If you change `sw.js`, bump the version in `const CACHE = 'options-calc-v1'` so old caches are cleared.

## Files

| File | Purpose |
|---|---|
| `index.html` | The calculator |
| `manifest.webmanifest` | App name, icons and colors used when installing |
| `sw.js` | Caches the app so it opens offline |
| `icons/` | Home-screen and app icons |

## Notes

Option prices are Black-Scholes estimates from the volatility you enter; type your broker's actual prices into the legs table for exact results. The model assumes European-style options, no dividends, no early assignment and no commissions. For education and planning, not investment advice.
