import { createClient, type RedisClientType } from 'redis';

export interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export interface CacheStats {
  driver: string;
  mode: 'primary' | 'fallback';
  connected: boolean;
  keys: number;
  hits: number;
  misses: number;
  sets: number;
  errors: number;
}

export interface CacheStore {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlMs: number): Promise<void>;
  delete(key: string): Promise<void>;
  getStats(): Promise<CacheStats>;
}

class MemoryCacheStore implements CacheStore {
  private entries = new Map<string, CacheEntry<unknown>>();
  private hits = 0;
  private misses = 0;
  private sets = 0;

  async get<T>(key: string): Promise<T | null> {
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses += 1;
      return null;
    }

    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      this.misses += 1;
      return null;
    }

    this.hits += 1;
    return entry.value as T;
  }

  async set<T>(key: string, value: T, ttlMs: number) {
    this.sets += 1;
    this.entries.set(key, {
      value,
      expiresAt: Date.now() + ttlMs,
    });
  }

  async delete(key: string) {
    this.entries.delete(key);
  }

  async getStats() {
    for (const [key, entry] of this.entries.entries()) {
      if (entry.expiresAt <= Date.now()) {
        this.entries.delete(key);
      }
    }

    return {
      driver: 'memory',
      mode: 'primary' as const,
      connected: true,
      keys: this.entries.size,
      hits: this.hits,
      misses: this.misses,
      sets: this.sets,
      errors: 0,
    };
  }
}

class RedisCacheStore implements CacheStore {
  private client: RedisClientType;
  private connectPromise: Promise<void> | null = null;
  private connected = false;
  private fallback = new MemoryCacheStore();
  private hits = 0;
  private misses = 0;
  private sets = 0;
  private errors = 0;
  private fallbackMode = false;

  constructor(redisUrl: string) {
    this.client = createClient({ url: redisUrl });
    this.client.on('error', (error) => {
      this.errors += 1;
      this.fallbackMode = true;
      console.warn('Redis cache error, falling back to memory cache', error);
    });
  }

  private async ensureConnected() {
    if (this.connected) return true;
    if (!this.connectPromise) {
      this.connectPromise = this.client.connect()
        .then(() => {
          this.connected = true;
          this.fallbackMode = false;
        })
        .catch((error) => {
          this.errors += 1;
          this.fallbackMode = true;
          console.warn('Failed to connect to Redis, using in-memory fallback', error);
        })
        .finally(() => {
          this.connectPromise = null;
        });
    }

    await this.connectPromise;
    return this.connected;
  }

  async get<T>(key: string) {
    if (!(await this.ensureConnected())) {
      return this.fallback.get<T>(key);
    }

    try {
      const value = await this.client.get(key);
      if (value === null) {
        this.misses += 1;
        return null;
      }
      this.hits += 1;
      return JSON.parse(typeof value === 'string' ? value : String(value)) as T;
    } catch (error) {
      this.errors += 1;
      this.fallbackMode = true;
      console.warn('Redis GET failed, using in-memory fallback', error);
      return this.fallback.get<T>(key);
    }
  }

  async set<T>(key: string, value: T, ttlMs: number) {
    if (!(await this.ensureConnected())) {
      await this.fallback.set(key, value, ttlMs);
      return;
    }

    try {
      this.sets += 1;
      await this.client.set(key, JSON.stringify(value), {
        PX: ttlMs,
      });
    } catch (error) {
      this.errors += 1;
      this.fallbackMode = true;
      console.warn('Redis SET failed, using in-memory fallback', error);
      await this.fallback.set(key, value, ttlMs);
    }
  }

  async delete(key: string) {
    if (!(await this.ensureConnected())) {
      await this.fallback.delete(key);
      return;
    }

    try {
      await this.client.del(key);
    } catch (error) {
      this.errors += 1;
      this.fallbackMode = true;
      console.warn('Redis DEL failed, using in-memory fallback', error);
      await this.fallback.delete(key);
    }
  }

  async getStats(): Promise<CacheStats> {
    const fallbackStats = await this.fallback.getStats();

    if (!(await this.ensureConnected())) {
      return {
        driver: 'redis',
        mode: 'fallback' as const,
        connected: false,
        keys: fallbackStats.keys,
        hits: this.hits + fallbackStats.hits,
        misses: this.misses + fallbackStats.misses,
        sets: this.sets + fallbackStats.sets,
        errors: this.errors,
      };
    }

    try {
      const dbSize = await this.client.dbSize();
      return {
        driver: 'redis',
        mode: this.fallbackMode ? 'fallback' as const : 'primary' as const,
        connected: true,
        keys: dbSize,
        hits: this.hits + fallbackStats.hits,
        misses: this.misses + fallbackStats.misses,
        sets: this.sets + fallbackStats.sets,
        errors: this.errors,
      };
    } catch (error) {
      this.errors += 1;
      console.warn('Redis stats failed, reporting fallback stats', error);
      return {
        driver: 'redis',
        mode: 'fallback',
        connected: false,
        keys: fallbackStats.keys,
        hits: this.hits + fallbackStats.hits,
        misses: this.misses + fallbackStats.misses,
        sets: this.sets + fallbackStats.sets,
        errors: this.errors,
      };
    }
  }
}

let globalCacheStore: CacheStore | null = null;

export function getCacheStore() {
  if (!globalCacheStore) {
    const driver = (process.env.CACHE_DRIVER || 'memory').toLowerCase();
    if (driver === 'redis') {
      globalCacheStore = new RedisCacheStore(process.env.REDIS_URL || 'redis://127.0.0.1:6379');
    } else {
      globalCacheStore = new MemoryCacheStore();
    }
  }

  return globalCacheStore;
}
