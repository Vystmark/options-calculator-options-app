#!/usr/bin/env python3
"""Quote robot for the Options Scenario Calculator.

Runs on GitHub Actions (see .github/workflows/quotes.yml). Downloads Cboe's free
15-minute-delayed option chains for every symbol in symbols.txt and writes one small
JSON file per symbol, plus index.json, into an output folder. The workflow then
publishes that folder to the repository's `quotes` branch, where the app reads it.

Why this exists: Cboe's feed works from a server but blocks web pages from reading it
directly, so a GitHub Pages app cannot fetch it on its own.

Usage:
  python3 tools/fetch_quotes.py symbols.txt out/
  python3 tools/fetch_quotes.py symbols.txt out/ --from-file AAPL=tests/cboe-aapl-sample.json   (offline test)
"""
import datetime as dt
import json
import pathlib
import re
import sys
import time
import urllib.error
import urllib.request
from zoneinfo import ZoneInfo

NY = ZoneInfo("America/New_York")
INDEXES = {"SPX", "NDX", "RUT", "VIX", "XSP", "DJX", "OEX", "MRUT", "XND"}
SYMBOL_RE = re.compile(r"^[A-Z][A-Z0-9.]{0,9}$")
OCC_RE = re.compile(r"^(.*)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$")
MAX_SYMBOLS = 40
HEADERS = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "Accept": "application/json",
    "Referer": "https://www.cboe.com/",
}


def read_symbols(path):
    out, bad = [], []
    for raw in pathlib.Path(path).read_text(encoding="utf-8").splitlines():
        s = raw.split("#", 1)[0].strip().upper().lstrip("^$")
        if not s:
            continue
        (out if SYMBOL_RE.match(s) else bad).append(s)
    seen, uniq = set(), []
    for s in out:
        if s not in seen:
            seen.add(s)
            uniq.append(s)
    return uniq[:MAX_SYMBOLS], bad


def download(symbol):
    url = "https://cdn.cboe.com/api/global/delayed_quotes/options/{}{}.json".format(
        "_" if symbol in INDEXES else "", symbol)
    last = None
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=40) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code in (403, 404):
                raise RuntimeError("Cboe has no listed options for {}".format(symbol))
            last = "HTTP {}".format(e.code)
        except Exception as e:  # network hiccup: retry
            last = str(e)
        time.sleep(3 + attempt * 4)
    raise RuntimeError("Could not download {}: {}".format(symbol, last))


def num(x, places=None):
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    if v != v:  # NaN
        return None
    if places is not None:
        v = round(v, places)
    return int(v) if places == 0 else v


def compact(symbol, payload, now_utc):
    """Shrink Cboe's ~1.5 MB response to the fields the app uses (~10x smaller)."""
    d = payload.get("data") or {}
    price = num(d.get("current_price")) or num(d.get("close"))
    if not price:
        raise RuntimeError("Cboe returned no price for {}".format(symbol))
    as_of = None
    if d.get("last_trade_time"):  # Cboe gives New York local time without an offset
        try:
            as_of = dt.datetime.fromisoformat(str(d["last_trade_time"])).replace(tzinfo=NY).isoformat()
        except ValueError:
            as_of = None
    fetched = now_utc
    if payload.get("timestamp"):  # Cboe's own UTC timestamp
        try:
            fetched = dt.datetime.fromisoformat(str(payload["timestamp"]).replace(" ", "T")).replace(tzinfo=dt.timezone.utc)
        except ValueError:
            pass
    today_ny = now_utc.astimezone(NY).date()
    rows = []
    for o in d.get("options") or []:
        occ = str(o.get("option") or "")
        m = OCC_RE.match(occ)
        if not m:
            continue
        exp = dt.date(2000 + int(m.group(2)), int(m.group(3)), int(m.group(4)))
        if exp < today_ny:
            continue
        rows.append([occ, num(o.get("bid"), 2), num(o.get("ask"), 2), num(o.get("iv"), 4),
                     num(o.get("open_interest"), 0), num(o.get("delta"), 4), num(o.get("last_trade_price"), 2)])
    return {
        "v": 1, "symbol": symbol, "source": "Cboe", "delayedMinutes": 15,
        "price": price, "change": num(d.get("price_change")), "prevClose": num(d.get("prev_day_close")),
        "iv30": num(d.get("iv30")), "asOf": as_of,
        "fetched": fetched.astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z"),
        "fields": ["option", "bid", "ask", "iv", "oi", "delta", "last"],
        "options": rows,
    }


def main(argv):
    if len(argv) < 3:
        print(__doc__)
        return 2
    symbols, bad = read_symbols(argv[1])
    out = pathlib.Path(argv[2])
    out.mkdir(parents=True, exist_ok=True)
    offline = dict(a.split("=", 1) for a in argv[4:]) if len(argv) > 4 and argv[3] == "--from-file" else {}
    now = dt.datetime.now(dt.timezone.utc)
    done, errors = [], {s: "Not a valid symbol" for s in bad}
    for i, sym in enumerate(symbols):
        try:
            payload = json.loads(pathlib.Path(offline[sym]).read_text()) if sym in offline else download(sym)
            data = compact(sym, payload, now)
            (out / (sym + ".json")).write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
            done.append(sym)
            print("OK   {:<6} ${:<10} {:>5} contracts".format(sym, data["price"], len(data["options"])))
        except Exception as e:
            errors[sym] = str(e)
            print("FAIL {:<6} {}".format(sym, e))
        if not offline and i < len(symbols) - 1:
            time.sleep(1.5)  # be polite to Cboe
    index = {"v": 1, "updated": now.isoformat().replace("+00:00", "Z"), "symbols": done, "errors": errors,
             "source": "Cboe delayed quotes (15-minute delay)"}
    (out / "index.json").write_text(json.dumps(index, indent=1), encoding="utf-8")
    (out / "README.md").write_text(
        "Option quotes written automatically by the quote robot. Do not edit; this branch is replaced on every run.\n",
        encoding="utf-8")
    print("\n{} of {} symbols updated.".format(len(done), len(symbols)))
    return 0 if done else 1  # a red X in Actions means nothing could be fetched


if __name__ == "__main__":
    sys.exit(main(sys.argv))
