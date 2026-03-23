# QuantX Streaming Architecture Upgrade

## Goal

Move the platform from a browser-heavy market terminal to a service-oriented, low-latency architecture that can survive burst traffic and support real-time indicators, account sync, and multi-exchange growth.

## Recommended Phases

### Phase 1: Stabilize the current local-proxy architecture

- Keep the existing local Binance proxy as the single ingress for market snapshots, signed REST requests, and future user-data streams.
- Add Redis as the first shared cache layer.
- Cache the following data in Redis:
  - latest ticker per symbol
  - latest kline snapshot per symbol/interval
  - top-of-book and grouped depth views
  - exchange metadata and symbol filters
  - user session state and account sync timestamps
- Expose low-latency read endpoints from the proxy so the frontend stops querying exchange REST directly for hot data.

### Phase 2: Introduce a market-data bus

- Insert Kafka as the core market-data message bus.
- Producers:
  - exchange market data adapters
  - account/user-data adapters
  - backfill workers
- Topics:
  - `market.ticker.raw`
  - `market.depth.raw`
  - `market.kline.raw`
  - `account.userdata.raw`
  - `exchange.health`
- Consumers:
  - Redis projection workers
  - indicator calculation workers
  - time-series persistence workers
  - alert/risk workers

Reason:
- Kafka absorbs exchange bursts and disconnect/reconnect storms.
- It decouples ingestion from UI serving and prevents the proxy from becoming the only pressure point.

## What is already live in this repo for Phase 2

- Kafka-ready message bus abstraction in `server/message-bus.ts`
- environment switches:
  - `MESSAGE_BUS_DRIVER=none`
  - `MESSAGE_BUS_DRIVER=kafka`
  - `KAFKA_BROKERS=host1:9092,host2:9092`
  - `KAFKA_CLIENT_ID=quantx-proxy`
  - `KAFKA_TOPIC_PREFIX=quantx`
- hot event publishing points already wired for:
  - market snapshot projection
  - orderbook projection
  - account snapshot
  - indicator snapshot
  - proxy health snapshot

Current limitation:

- Kafka projection consumer now exists in `server/kafka-projection-consumer.ts`
- consumer writes market / orderbook / account / indicator / health snapshots back into the cache layer
- run it with `npm run bus:consumer`
- indicator compute worker now exists in `server/stream-compute-worker.ts`
- proxy publishes `indicator.compute.request` tasks
- the compute worker consumes those tasks and publishes indicator snapshots back into the bus/cache flow
- run it with `npm run stream:compute`
- runtime health snapshots now exist for:
  - `kafka-projection-consumer`
  - `stream-compute-worker`
- aggregated runtime health can be read from proxy endpoint `/api/binance/runtime/health`
- Kafka is optional and disabled by default so the current proxy flow keeps working without a broker

### Phase 3: Add stream processing

- Use Flink for stateful stream computation.
- Compute and continuously publish:
  - MACD
  - RSI
  - MA / EMA
  - funding-rate anomalies
  - spread and basis
  - order-book imbalance
  - abnormal volume / liquidation bursts
- Write the processed outputs to:
  - Redis for hot reads
  - ClickHouse for historical analytics and replay

Reason:
- Indicators should not be recalculated in every browser.
- The terminal should consume already-computed streams and only handle rendering.

### Phase 4: Adopt a TSDB / analytical store

- Use ClickHouse as the core historical market store.
- Recommended tables:
  - `klines_1m`
  - `trades_raw`
  - `depth_snapshots`
  - `indicator_snapshots`
  - `account_events`
- Store:
  - normalized multi-exchange klines
  - derived indicator history
  - replayable account events
- Query use cases:
  - instant interval aggregation
  - chart backfill
  - backtesting data feeds
  - strategy analytics

Reason:
- ClickHouse is a better fit than the browser for historical K-line slicing, replay, and aggregation.

## What is already live in this repo for Phase 4

- ClickHouse storage adapter in `server/clickhouse-store.ts`
- schema bootstrap file in `server/clickhouse-schema.sql`
- Kafka-to-ClickHouse persistence worker in `server/clickhouse-persistence-worker.ts`
- run it with `npm run store:historical`
- proxy exposes storage stats at `/api/binance/storage/stats`
- proxy exposes historical kline query endpoint at `/api/binance/klines/query`
- frontend `useBinanceKlines` now prefers the local query service before falling back to exchange REST
- indicator endpoint now also checks ClickHouse historical snapshots before falling back to live compute
- historical kline and indicator responses now carry freshness semantics and can return stale data first while refreshing in the background
- proxy maintains active query subscriptions at `/api/binance/query/subscribe` so visible charts can keep K-lines and indicator snapshots warm without waiting for the next user click
- proxy runtime health now aggregates:
  - `kafka-projection-consumer`
  - `stream-compute-worker`
  - `clickhouse-persistence-worker`

### Phase 5: Split serving layers

- Introduce dedicated services:
  - `market-ingest-service`
  - `stream-compute-service`
  - `market-query-service`
  - `account-gateway-service`
  - `risk-service`
  - `alert-service`
- Frontend should only read from:
  - query APIs
  - WebSocket gateway
- Frontend should stop speaking raw exchange protocols directly.

## Frontend Implications

- K-line switching:
  - first paint from in-memory cache or Redis-backed hot API
  - background refresh after first paint
  - interval aggregation served from ClickHouse or cached Redis projections
- Order book:
  - frontend receives already-projected top depth, not full exchange diff streams when possible
  - grouping and tick-size aggregation should move server-side for shared hot symbols
- Indicators:
  - frontend subscribes to computed indicator streams instead of recalculating MACD/RSI locally

## What was improved immediately in this repo

- Added client-side K-line cache and request race protection.
- Reduced order-book render pressure by only flushing a bounded top depth slice into React state.

## Next code steps in this repo

1. Add Redis-backed cache endpoints to the local proxy.
2. Add a server-side order-book projection worker.
3. Add a WebSocket gateway from proxy to frontend so the browser no longer maintains multiple exchange sockets per panel.
4. Move indicator calculation out of the chart component into the server side or shared worker layer.
5. Add symbol/interval prefetch and warm-cache endpoints for the active workspace.
