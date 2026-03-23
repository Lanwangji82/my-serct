# QuantX Execution Priority Checklist

## P1. Stabilize the current backbone

- Standardize cache keys in `server/cache-keys.ts`
- Standardize Kafka topics in `server/message-bus.ts`
- Persist dead-letter events through `quantx.dead.letter`
- Add ClickHouse TTL/partition rules in `server/clickhouse-schema.sql`
- Expose service health/metrics through:
  - `runtime-monitor.ts`
  - `market-ingest-service.ts`
  - `market-query-service.ts`
  - `account-gateway-service.ts`
  - `risk-service.ts`
  - `alert-service.ts`

## P2. Make burst traffic survivable

- Producers should publish raw topics:
  - `market.ticker.raw`
  - `market.depth.raw`
  - `market.kline.raw`
  - `account.userdata.raw`
  - `exchange.health`
- Consumers should publish dead letters on non-recoverable processing failures
- Redis should remain the first hot-read layer
- ClickHouse should remain the first historical sink

## P3. Stream compute migration path

- Use `server/stream-task-model.ts` as the shared envelope for:
  - `indicator.compute`
  - `kline.aggregate`
  - `funding.anomaly`
  - `orderbook.imbalance`
  - `risk.evaluate`
- Current local worker:
  - `npm run stream:compute`
- Future Flink migration:
  - feed Kafka raw topics into Flink
  - emit computed snapshots back to Kafka/Redis/ClickHouse

## P4. Historical store scope

- `klines`
- `market_snapshots`
- `funding_snapshots`
- `orderbook_snapshots`
- `indicator_snapshots`
- `account_snapshots`
- `account_events`
- `trades_raw`
- `dead_letter_events`

## P5. Runbook

1. Start proxy: `npm run proxy`
2. Start query/serving split services as needed:
   - `npm run service:market-ingest`
   - `npm run service:market-query`
   - `npm run service:account-gateway`
   - `npm run service:risk`
   - `npm run service:alert`
3. If Kafka enabled:
   - `npm run bus:consumer`
   - `npm run stream:compute`
   - `npm run store:historical`
4. If ClickHouse enabled:
   - apply `server/clickhouse-schema.sql`
5. If Flink enabled later:
   - deploy Flink job consuming Kafka raw topics

