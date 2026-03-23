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

export function getBrokerTargetLabel(target: string, brokers: BrokerRegistrySummary[]) {
  if (target === "paper") {
    return "纸面账户";
  }

  for (const broker of brokers) {
    const matched = broker.targets.find((item) => item.target === target);
    if (matched) {
      return matched.label;
    }
  }

  return target;
}

export function getRuntimeLabel(runtime: string) {
  if (runtime === "paper") {
    return "纸面";
  }
  if (runtime === "sandbox") {
    return "沙盒";
  }
  if (runtime === "production") {
    return "生产";
  }
  if (runtime === "backtest-only") {
    return "仅回测";
  }
  return runtime;
}

export function getDefaultExecutionTarget(brokers: BrokerRegistrySummary[]): BrokerTarget {
  return (
    brokers.flatMap((item) => item.targets).find((item) => item.mode === "sandbox")?.target
    || brokers.flatMap((item) => item.targets)[0]?.target
    || "paper"
  );
}

export function getRuntimeExecutionTarget(runtime: string, brokers: BrokerRegistrySummary[]): BrokerTarget {
  if (runtime === "paper") {
    return "paper";
  }

  const desiredMode = runtime === "production" ? "production" : "sandbox";
  return (
    brokers.flatMap((item) => item.targets).find((item) => item.mode === desiredMode)?.target
    || getDefaultExecutionTarget(brokers)
  );
}
