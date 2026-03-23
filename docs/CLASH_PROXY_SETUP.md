# Clash Proxy Setup

QuantX now uses the Python platform service for research, backtests, and execution.
`ccxt` in the Python backend can read proxy settings directly from `.env`.

## Recommended setup

For a local Clash mixed-port:

```env
NODE_USE_ENV_PROXY=1
HTTP_PROXY=http://127.0.0.1:7890
HTTPS_PROXY=http://127.0.0.1:7890
NO_PROXY=127.0.0.1,localhost

CCXT_HTTP_PROXY=http://127.0.0.1:7890
CCXT_HTTPS_PROXY=http://127.0.0.1:7890
CCXT_TIMEOUT_MS=15000
```

If your best node is SOCKS-based instead:

```env
ALL_PROXY=socks5://127.0.0.1:7890
CCXT_SOCKS_PROXY=socks5://127.0.0.1:7890
CCXT_TIMEOUT_MS=15000
```

## Why this is faster

- Keep `MATCH` as `DIRECT` so only exchange/API traffic is proxied
- Let Clash choose among only a few low-latency trading nodes
- Raise `ccxt` timeout slightly to avoid false negatives on market metadata loads
- Keep chart/UI traffic direct unless it is actually blocked

## Clash template

Use [clash-trading-rules.yaml](/D:/quantx-platform/docs/clash-trading-rules.yaml) as the minimal template.

Important:

- Replace the `DIRECT` entries inside the `AUTO` group with your real nodes
- Put your best two or three nodes there, not your whole subscription
- For trading, more nodes usually makes auto-test slower and noisier

## Recommended node order to test

For most exchange/API workloads, test in this order:

1. Japan
2. Singapore
3. Hong Kong
4. US West

## Good practical defaults

- Keep `MARKET_DATA_DRIVER="binance"` for faster Kline switching
- Use proxy mainly for Python `ccxt` execution and research fetches
- Leave media and other global traffic out of the trading path

## Startup

```powershell
npm run dev:all
```

If you only want the Python quant backend:

```powershell
npm run service:py-platform
```
