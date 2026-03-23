import './bootstrap-env';

type CcxtProxyOptions = {
  httpProxy?: string;
  httpsProxy?: string;
  socksProxy?: string;
  wsProxy?: string;
  wssProxy?: string;
};

function firstNonEmpty(...values: Array<string | undefined>) {
  for (const value of values) {
    if (value && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

export function getCcxtProxyOptions(): CcxtProxyOptions {
  const httpProxy = firstNonEmpty(process.env.CCXT_HTTP_PROXY, process.env.HTTP_PROXY);
  const httpsProxy = firstNonEmpty(process.env.CCXT_HTTPS_PROXY, process.env.HTTPS_PROXY, httpProxy);
  const socksProxy = firstNonEmpty(process.env.CCXT_SOCKS_PROXY, process.env.ALL_PROXY);
  const wsProxy = firstNonEmpty(process.env.CCXT_WS_PROXY, httpProxy, socksProxy);
  const wssProxy = firstNonEmpty(process.env.CCXT_WSS_PROXY, httpsProxy, socksProxy, wsProxy);

  return {
    ...(httpProxy ? { httpProxy } : {}),
    ...(httpsProxy ? { httpsProxy } : {}),
    ...(socksProxy ? { socksProxy } : {}),
    ...(wsProxy ? { wsProxy } : {}),
    ...(wssProxy ? { wssProxy } : {}),
  };
}
