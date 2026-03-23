# Redis Cache Roadmap

## Current State

The local Binance proxy now uses a unified cache abstraction in:

- `server/cache-store.ts`

Today the proxy supports:

- `CACHE_DRIVER=memory`
- `CACHE_DRIVER=redis`

When Redis is enabled, the proxy will try to use Redis as the primary cache and fall back to in-memory cache if Redis is unavailable.

## What is already behind the cache abstraction

- ranked Binance base URL selection
- public REST hot responses
- indicator payload hot cache
- health endpoint cache stats

## Why this matters

This reduces the future Redis migration to an adapter swap instead of a full rewrite of:

- `server/binance-proxy.ts`
- hot read endpoints
- indicator precomputation responses

## What is already live

- Redis-backed cache adapter with memory fallback
- environment switches:
  - `CACHE_DRIVER=memory`
  - `CACHE_DRIVER=redis`
  - `REDIS_URL=redis://host:port`
- cache stats now expose:
  - driver
  - mode (`primary` or `fallback`)
  - connected
  - keys
  - hits / misses / sets / errors

## What is already cached

- ranked Binance base URL selection
- public REST hot responses
- indicator bundles

## Next Redis-backed keys

- ticker snapshots
- kline snapshots
- indicator bundles
- orderbook top-depth projections
- user session and account stream snapshots

Suggested keys:

- `public:spot:/api/v3/ticker/24hr`
- `public:futures:/fapi/v1/premiumIndex`
- `kline:spot:BTCUSDT:1m:1000`
- `indicator:futures:BTCUSDT:1h:1000`
- `orderbook:futures:BTCUSDT:160`

## When to switch from memory to Redis

Use Redis when one of these becomes true:

- multiple local services need the same hot data
- proxy restarts are causing cold-start pain
- indicator responses are being recalculated too often
- orderbook/top-depth should be shared across workers
- you want observability and persistence beyond one process
