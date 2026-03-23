import { createClient, type ClickHouseClient } from '@clickhouse/client';

export interface ClickHouseStats {
  driver: 'clickhouse';
  enabled: boolean;
  connected: boolean;
  mode: 'primary' | 'disabled' | 'fallback';
  inserts: number;
  failures: number;
}

export interface ClickHouseStore {
  insertJsonEachRow(table: string, rows: Record<string, unknown>[]): Promise<void>;
  queryJson<T>(query: string): Promise<T[]>;
  ping(): Promise<boolean>;
  getStats(): Promise<ClickHouseStats>;
}

class NoopClickHouseStore implements ClickHouseStore {
  async insertJsonEachRow() {
    return;
  }

  async queryJson<T>() {
    return [] as T[];
  }

  async ping() {
    return false;
  }

  async getStats(): Promise<ClickHouseStats> {
    return {
      driver: 'clickhouse',
      enabled: false,
      connected: false,
      mode: 'disabled',
      inserts: 0,
      failures: 0,
    };
  }
}

class RealClickHouseStore implements ClickHouseStore {
  private client: ClickHouseClient;
  private connected = false;
  private connectPromise: Promise<void> | null = null;
  private inserts = 0;
  private failures = 0;

  constructor() {
    this.client = createClient({
      url: process.env.CLICKHOUSE_URL || 'http://127.0.0.1:8123',
      username: process.env.CLICKHOUSE_USER || 'default',
      password: process.env.CLICKHOUSE_PASSWORD || '',
      database: process.env.CLICKHOUSE_DATABASE || 'quantx',
    });
  }

  private async ensureConnected() {
    if (this.connected) return true;
    if (!this.connectPromise) {
      this.connectPromise = this.client.ping()
        .then(() => {
          this.connected = true;
        })
        .catch((error) => {
          this.failures += 1;
          this.connected = false;
          console.warn('Failed to connect to ClickHouse', error);
        })
        .finally(() => {
          this.connectPromise = null;
        });
    }

    await this.connectPromise;
    return this.connected;
  }

  async insertJsonEachRow(table: string, rows: Record<string, unknown>[]) {
    if (!rows.length) return;
    if (!(await this.ensureConnected())) return;

    try {
      await this.client.insert({
        table,
        values: rows,
        format: 'JSONEachRow',
      });
      this.inserts += rows.length;
    } catch (error) {
      this.failures += 1;
      this.connected = false;
      console.warn(`ClickHouse insert failed for table ${table}`, error);
    }
  }

  async queryJson<T>(query: string): Promise<T[]> {
    if (!(await this.ensureConnected())) {
      return [];
    }

    try {
      const result = await this.client.query({
        query,
        format: 'JSONEachRow',
      });
      return await result.json<T>();
    } catch (error) {
      this.failures += 1;
      this.connected = false;
      console.warn('ClickHouse query failed', error);
      return [];
    }
  }

  async ping() {
    try {
      const result = await this.client.ping();
      this.connected = result.success;
      return result.success;
    } catch (error) {
      this.failures += 1;
      this.connected = false;
      console.warn('ClickHouse ping failed', error);
      return false;
    }
  }

  async getStats(): Promise<ClickHouseStats> {
    return {
      driver: 'clickhouse',
      enabled: true,
      connected: this.connected,
      mode: this.connected ? 'primary' : 'fallback',
      inserts: this.inserts,
      failures: this.failures,
    };
  }
}

let globalClickHouseStore: ClickHouseStore | null = null;

export function getClickHouseStore() {
  if (!globalClickHouseStore) {
    const driver = (process.env.HISTORICAL_STORE_DRIVER || 'none').toLowerCase();
    if (driver === 'clickhouse') {
      globalClickHouseStore = new RealClickHouseStore();
    } else {
      globalClickHouseStore = new NoopClickHouseStore();
    }
  }

  return globalClickHouseStore;
}
