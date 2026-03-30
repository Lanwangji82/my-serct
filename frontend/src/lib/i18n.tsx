import React, { createContext, useContext, useState } from "react";

type Language = "en" | "zh";

const en = {
  dashboard: "Dashboard",
  dataCenter: "Data Center",
  backtesting: "Backtesting",
  strategies: "Strategies",
  marketIntelligence: "Market Intelligence",
  marketCenter: "Market Center",
  settings: "Settings",
  searchPlaceholder: "Search strategies, market, settings...",
  status: "Status",
  systemsOperational: "Systems operational",
  adminUser: "Local Admin",
  proPlan: "Workspace Mode",
  language: "Language",
  english: "English",
  chinese: "Chinese",
  notifications: "Notifications",
  markAllRead: "Mark all as read",
  noNotifications: "No new notifications",
  justNow: "Just now",
  minutesAgo: "m ago",
  engineType: "Engine",
  vectorized: "Vectorized",
  eventDriven: "Event-driven",
  simulation: "Simulation",
  slippage: "Slippage",
  commission: "Commission",
  marginInterest: "Margin interest",
  l2Matching: "L2 matching",
  priceLimits: "Price limits",
  optimization: "Optimization",
  optMethod: "Method",
  gridSearch: "Grid search",
  geneticAlgo: "Genetic algorithm",
  targetMetric: "Target metric",
  computing: "Computing",
  threads: "Threads",
  parallelTasks: "Parallel tasks",
  runOptimization: "Run optimization",
  results: "Results",
  cagr: "CAGR",
  sharpeRatio: "Sharpe ratio",
  maxDrawdown: "Max drawdown",
  profitFactor: "Profit factor",
  tradesWinRate: "Trades / Win rate",
};

const zh: typeof en = {
  ...en,
  dashboard: "总览",
  dataCenter: "数据中心",
  backtesting: "回测中心",
  strategies: "策略",
  marketIntelligence: "市场情报",
  marketCenter: "行情中心",
  settings: "设置",
  searchPlaceholder: "搜索策略、研究、配置项...",
  status: "状态",
  systemsOperational: "系统运行正常",
  adminUser: "本地管理员",
  proPlan: "工作区模式",
  language: "语言",
  english: "英文",
  chinese: "中文",
  notifications: "通知",
  markAllRead: "全部已读",
  noNotifications: "暂无新通知",
  justNow: "刚刚",
  minutesAgo: "分钟前",
  engineType: "引擎",
  vectorized: "向量化",
  eventDriven: "事件驱动",
  simulation: "仿真设置",
  slippage: "滑点",
  commission: "手续费",
  marginInterest: "融资利息",
  l2Matching: "二档撮合",
  priceLimits: "价格限制",
  optimization: "参数优化",
  optMethod: "优化方式",
  gridSearch: "网格搜索",
  geneticAlgo: "遗传算法",
  targetMetric: "目标指标",
  computing: "计算资源",
  threads: "线程数",
  parallelTasks: "并行任务",
  runOptimization: "运行优化",
  results: "结果",
  cagr: "年化收益",
  sharpeRatio: "夏普比率",
  maxDrawdown: "最大回撤",
  profitFactor: "盈亏比",
  tradesWinRate: "交易次数 / 胜率",
};

export const translations = { en, zh } as const;
export type TranslationKey = keyof typeof en;

interface LanguageContextType {
  language: Language;
  setLanguage: (lang: Language) => void;
  t: (key: TranslationKey) => string;
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [language, setLanguage] = useState<Language>("zh");

  const t = (key: TranslationKey) => {
    return translations[language][key] || translations.en[key] || key;
  };

  return <LanguageContext.Provider value={{ language, setLanguage, t }}>{children}</LanguageContext.Provider>;
}

export function useTranslation() {
  const context = useContext(LanguageContext);
  if (!context) {
    throw new Error("useTranslation must be used within a LanguageProvider");
  }
  return context;
}
