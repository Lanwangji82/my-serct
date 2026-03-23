import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DATA_DIR = path.resolve(process.cwd(), 'server', 'data');

async function ensureDataDir() {
  await mkdir(DATA_DIR, { recursive: true });
}

export class JsonFileDb<T> {
  private queue = Promise.resolve();

  constructor(
    private readonly filename: string,
    private readonly defaultValue: T,
  ) {}

  private get filePath() {
    return path.join(DATA_DIR, this.filename);
  }

  async read(): Promise<T> {
    await ensureDataDir();
    try {
      const raw = await readFile(this.filePath, 'utf8');
      return JSON.parse(raw) as T;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? '');
      if (message.includes('ENOENT')) {
        await this.write(this.defaultValue);
        return structuredClone(this.defaultValue);
      }
      throw error;
    }
  }

  async write(value: T): Promise<void> {
    await ensureDataDir();
    this.queue = this.queue.then(() =>
      writeFile(this.filePath, JSON.stringify(value, null, 2), 'utf8')
    );
    await this.queue;
  }

  async update(updater: (current: T) => T | Promise<T>): Promise<T> {
    let nextValue: T = structuredClone(this.defaultValue);
    this.queue = this.queue.then(async () => {
      await ensureDataDir();
      let current: T;
      try {
        const raw = await readFile(this.filePath, 'utf8');
        current = JSON.parse(raw) as T;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error ?? '');
        if (message.includes('ENOENT')) {
          current = structuredClone(this.defaultValue);
        } else {
          throw error;
        }
      }
      nextValue = await updater(current);
      await writeFile(this.filePath, JSON.stringify(nextValue, null, 2), 'utf8');
    });
    await this.queue;
    return nextValue;
  }
}
