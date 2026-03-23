import type { Express } from 'express';
import { registerQuantPlatformApi } from './platform/register-platform-api';

export function registerPlatformApi(app: Express) {
  registerQuantPlatformApi(app);
}
