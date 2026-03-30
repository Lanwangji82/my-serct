import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

const ENV_FILES = ['.env', '.env.local'];

for (const envFile of ENV_FILES) {
  const fullPath = path.resolve(process.cwd(), envFile);
  if (fs.existsSync(fullPath)) {
    dotenv.config({ path: fullPath, override: true });
  }
}

if (!process.env.NODE_USE_ENV_PROXY && (process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.ALL_PROXY)) {
  process.env.NODE_USE_ENV_PROXY = '1';
}
