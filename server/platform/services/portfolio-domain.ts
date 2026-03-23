import { getPaperAccount } from '../../platform-store';

export async function getPlatformPortfolioAccount(userId: string) {
  return getPaperAccount(userId);
}
