export const PLATFORM_API_BASE = "/api/platform";
export const RESEARCH_API_BASE = "/research";
export const PORTFOLIO_API_BASE = "/portfolio";
export const GOVERNANCE_API_BASE = "/governance";

export type BrokerTarget = "paper" | `${string}:${"sandbox" | "production"}`;

export type BrokerRegistrySummary = {
  brokerId: string;
  label: string;
  supportsMarketData: boolean;
  supportsExecution: boolean;
  targets: Array<{
    target: `${string}:${"sandbox" | "production"}`;
    mode: "sandbox" | "production";
    label: string;
  }>;
};

export function formatDateTime(value: number) {
  return new Date(value).toLocaleString("zh-CN");
}

export function formatMoney(value: number | null | undefined, digits = 2) {
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value ?? 0);
}

export async function authorizedFetch<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((init?.headers as Record<string, string>) || {}),
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(path, {
    ...init,
    headers,
  });

  const json = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(json?.detail || json?.message || "平台请求失败");
  }

  return json as T;
}
