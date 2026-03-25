export type StrategyArtifactSummary = {
  rootDir: string;
  sourceFile: string;
  latestSourceFile: string;
  metadataFile: string;
  latestMetadataFile: string;
  version: number;
};

export type PlatformStrategy = {
  id?: string;
  name: string;
  description: string;
  createdAt?: number;
  updatedAt?: number;
  marketType: "spot" | "futures";
  symbol: string;
  interval: string;
  runtime: string;
  template: string;
  parameters: Record<string, number>;
  risk: {
    maxNotional: number;
    maxLeverage: number;
    maxDailyLoss: number;
    allowedSymbols: string[];
  };
  sourceCode?: string | null;
  compiler?: {
    valid: boolean;
    errors: string[];
    warnings: string[];
    checkedAt?: number;
  } | null;
  artifactSummary?: StrategyArtifactSummary | null;
};
