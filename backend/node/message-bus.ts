import { Kafka, type Producer } from 'kafkajs';

export interface MessageBusStats {
  driver: 'kafka';
  enabled: boolean;
  connected: boolean;
  mode: 'primary' | 'disabled' | 'fallback';
  published: number;
  failures: number;
  topics: string[];
}

export interface MessageBus {
  publish(topic: string, key: string, payload: unknown): Promise<void>;
  getStats(): Promise<MessageBusStats>;
}

export interface DeadLetterPayload {
  source: string;
  topic: string;
  key?: string;
  error: string;
  payload?: unknown;
  failedAt: number;
}

class NoopMessageBus implements MessageBus {
  async publish() {
    return;
  }

  async getStats(): Promise<MessageBusStats> {
    return {
      driver: 'kafka',
      enabled: false,
      connected: false,
      mode: 'disabled',
      published: 0,
      failures: 0,
      topics: [],
    };
  }
}

class KafkaMessageBus implements MessageBus {
  private producer: Producer | null = null;
  private connectPromise: Promise<void> | null = null;
  private connected = false;
  private published = 0;
  private failures = 0;
  private topics = new Set<string>();

  constructor(
    private readonly brokers: string[],
    private readonly clientId: string,
  ) {}

  private async ensureConnected() {
    if (this.connected && this.producer) return true;
    if (!this.connectPromise) {
      this.connectPromise = (async () => {
        try {
          const kafka = new Kafka({
            clientId: this.clientId,
            brokers: this.brokers,
          });
          this.producer = kafka.producer({
            allowAutoTopicCreation: true,
          });
          await this.producer.connect();
          this.connected = true;
        } catch (error) {
          this.failures += 1;
          this.connected = false;
          this.producer = null;
          console.warn('Failed to connect Kafka producer, bus will stay degraded', error);
        } finally {
          this.connectPromise = null;
        }
      })();
    }

    await this.connectPromise;
    return this.connected && this.producer !== null;
  }

  async publish(topic: string, key: string, payload: unknown) {
    this.topics.add(topic);

    if (!(await this.ensureConnected()) || !this.producer) {
      return;
    }

    try {
      await this.producer.send({
        topic,
        messages: [
          {
            key,
            value: JSON.stringify(payload),
          },
        ],
      });
      this.published += 1;
    } catch (error) {
      this.failures += 1;
      this.connected = false;
      console.warn(`Kafka publish failed for topic ${topic}`, error);
    }
  }

  async getStats(): Promise<MessageBusStats> {
    return {
      driver: 'kafka',
      enabled: true,
      connected: this.connected,
      mode: this.connected ? 'primary' : 'fallback',
      published: this.published,
      failures: this.failures,
      topics: Array.from(this.topics.values()).sort(),
    };
  }
}

let globalMessageBus: MessageBus | null = null;

export function getKafkaTopicMap() {
  const prefix = process.env.KAFKA_TOPIC_PREFIX || 'quantx';
  return {
    marketTickerRaw: `${prefix}.market.ticker.raw`,
    marketDepthRaw: `${prefix}.market.depth.raw`,
    marketKlineRaw: `${prefix}.market.kline.raw`,
    accountUserDataRaw: `${prefix}.account.userdata.raw`,
    exchangeHealth: `${prefix}.exchange.health`,
    indicatorComputeRequest: `${prefix}.indicator.compute.request`,
    klineSnapshot: `${prefix}.kline.snapshot`,
    marketSnapshot: `${prefix}.market.snapshot`,
    orderbookProjection: `${prefix}.orderbook.projection`,
    accountSnapshot: `${prefix}.account.snapshot`,
    indicatorSnapshot: `${prefix}.indicator.snapshot`,
    proxyHealth: `${prefix}.proxy.health`,
    deadLetter: `${prefix}.dead.letter`,
  };
}

export async function publishDeadLetter(
  bus: MessageBus,
  payload: DeadLetterPayload,
) {
  const topics = getKafkaTopicMap();
  await bus.publish(
    topics.deadLetter,
    `${payload.source}:${payload.topic}:${payload.failedAt}`,
    payload,
  );
}

export function getMessageBus() {
  if (!globalMessageBus) {
    const driver = (process.env.MESSAGE_BUS_DRIVER || 'none').toLowerCase();
    if (driver === 'kafka') {
      const brokers = (process.env.KAFKA_BROKERS || '127.0.0.1:9092')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      globalMessageBus = new KafkaMessageBus(brokers, process.env.KAFKA_CLIENT_ID || 'quantx-proxy');
    } else {
      globalMessageBus = new NoopMessageBus();
    }
  }

  return globalMessageBus;
}
