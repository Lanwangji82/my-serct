import { useEffect, useState } from "react";
import { authorizedFetch, PLATFORM_API_BASE } from "../lib/platform-client";

export type AccountScope = {
  scopeId: string;
  accountType: string;
  connectionMode: "live" | "paper";
  enabled: boolean;
  extraConfig?: Record<string, string | number | boolean>;
  status?: {
    ok: boolean;
    code?: string;
    message: string;
    checkedAt: number;
  };
  createdAt: number;
  updatedAt: number;
};

export type AccountConnection = {
  accountId: string;
  label: string;
  market: "crypto" | "a_share";
  providerId: string;
  brokerId: string;
  exchangeId?: string;
  mode: "readonly";
  enabled: boolean;
  apiKeyMasked: string;
  apiSecretMasked: string;
  passphraseMasked?: string;
  status?: {
    ok: boolean;
    code?: string;
    message: string;
    checkedAt: number;
  };
  scopes: AccountScope[];
  createdAt: number;
  updatedAt: number;
};

type AccountConnectionsPayload = {
  generatedAt: number;
  connections: AccountConnection[];
};

type SavePayload = {
  accountId?: string;
  label: string;
  market: "crypto" | "a_share";
  providerId: string;
  exchangeId?: string;
  enabled: boolean;
  credentials: {
    apiKey: string;
    apiSecret: string;
    passphrase?: string;
  };
  scopes: Array<{
    scopeId?: string;
    accountType: string;
    connectionMode: "live" | "paper";
    enabled: boolean;
    extraConfig?: Record<string, string | number | boolean>;
  }>;
};

export function useAccountConnections() {
  const [data, setData] = useState<AccountConnectionsPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const reload = async () => {
    setLoading(true);
    try {
      const payload = await authorizedFetch<AccountConnectionsPayload>(`${PLATFORM_API_BASE}/portfolio/accounts`, "");
      setData(payload);
      setError("");
      return payload;
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "加载账户连接失败");
      return null;
    } finally {
      setLoading(false);
    }
  };

  const save = async (payload: SavePayload) => {
    const result = await authorizedFetch<{ connection: AccountConnection }>(`${PLATFORM_API_BASE}/portfolio/accounts`, "", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    await reload();
    return result.connection;
  };

  const toggleEnabled = async (accountId: string, enabled: boolean) => {
    const result = await authorizedFetch<{ connection: AccountConnection }>(`${PLATFORM_API_BASE}/portfolio/accounts/${accountId}/status`, "", {
      method: "POST",
      body: JSON.stringify({ enabled }),
    });
    await reload();
    return result.connection;
  };

  const testConnection = async (accountId: string) => {
    const result = await authorizedFetch<{ result: { ok: boolean; code?: string; message: string; checkedAt: number; scopes?: Array<Record<string, unknown>> } }>(
      `${PLATFORM_API_BASE}/portfolio/accounts/${accountId}/test`,
      "",
      {
        method: "POST",
        body: JSON.stringify({}),
      },
    );
    await reload();
    return result.result;
  };

  const remove = async (accountId: string) => {
    const result = await authorizedFetch<{ result: { accountId: string; deleted: boolean } }>(`${PLATFORM_API_BASE}/portfolio/accounts/${accountId}`, "", {
      method: "DELETE",
    });
    await reload();
    return result.result;
  };

  useEffect(() => {
    void reload();
  }, []);

  return {
    data,
    loading,
    error,
    reload,
    save,
    toggleEnabled,
    testConnection,
    remove,
  };
}
