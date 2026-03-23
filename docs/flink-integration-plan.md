# Flink Integration Plan

## Why Flink is still not fully live

The repo already has a local `stream-compute-worker`, but it is still a lightweight Node worker. It does not yet provide:

- stateful windowing
- checkpoint / savepoint management
- replay / reprocessing
- parallel job scaling
- Flink-native metrics

## Current bridge points already available

- Kafka topics are standardized in `server/message-bus.ts`
- stream task envelope is defined in `server/stream-task-model.ts`
- Redis hot-read layer exists in `server/cache-store.ts`
- ClickHouse historical sink exists in `server/clickhouse-store.ts`

## First Flink job to implement

Input:
- `quantx.market.kline.raw`

Output:
- `quantx.indicator.snapshot`

Logic:
- keyed by `market_type + symbol + interval`
- keep rolling state for candles
- continuously compute:
  - MA
  - EMA
  - RSI
  - MACD

## Next Flink jobs

1. `funding.anomaly`
2. `orderbook.imbalance`
3. `risk.evaluate`
4. `liquidation-burst`

## Suggested deployment shape

- Flink JobManager + TaskManager via Docker Compose or Kubernetes
- Kafka as ingress/egress bus
- Redis for hot projection output
- ClickHouse for historical sink

## Minimal rollout order

1. Keep current Node worker as fallback
2. Stand up Flink in parallel
3. Mirror `indicator.compute` flow into Flink
4. Compare Flink output with current local worker
5. Switch indicator snapshot publishing to Flink as primary

