import { listRegisteredStrategies, saveStrategy } from '../../strategy-registry';

export async function listPlatformStrategies() {
  return listRegisteredStrategies();
}

export async function savePlatformStrategy(input: any) {
  return saveStrategy(input);
}
