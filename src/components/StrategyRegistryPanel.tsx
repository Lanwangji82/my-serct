import React, { useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Card } from "./ui";

type Strategy = {
  id: string;
  name: string;
};

const PAGE_SIZE = 6;

function matchesQuery(strategy: Strategy, query: string) {
  const value = query.trim().toLowerCase();
  if (!value) return true;
  return strategy.name.toLowerCase().includes(value);
}

export function StrategyRegistryPanel(props: {
  strategies: Strategy[];
  selectedStrategy: Strategy | null;
  busy?: boolean;
  onRefresh: () => Promise<void>;
  onSelectStrategy: (strategyId: string) => void;
  onImportStrategy: (payload: { name: string; fileName: string; sourceCode: string }) => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [importName, setImportName] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const filtered = useMemo(() => props.strategies.filter((item) => matchesQuery(item, query)), [props.strategies, query]);
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageItems = useMemo(() => filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE), [filtered, currentPage]);

  useEffect(() => setPage(1), [query]);
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const readFileText = (file: File) =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error || new Error("读取文件失败"));
      reader.readAsText(file, "utf-8");
    });

  const resetImport = () => {
    setSelectedFile(null);
    setImportName("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleImport = async () => {
    if (!selectedFile || !importName.trim()) return;
    setImporting(true);
    try {
      const sourceCode = await readFileText(selectedFile);
      await props.onImportStrategy({ name: importName.trim(), fileName: selectedFile.name, sourceCode });
      resetImport();
    } finally {
      setImporting(false);
    }
  };

  return (
    <Card className="border-zinc-800 bg-zinc-950/85">
      <div className="space-y-4 p-4 md:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-zinc-100">策略档案库</h2>
            <p className="mt-1 text-xs text-zinc-500">策略按名称纵向排列，支持搜索、翻页和从本地硬盘导入 Python 文件。</p>
          </div>
          <div className="flex items-center gap-2 text-xs text-zinc-500">
            <Button size="sm" variant="outline" onClick={() => void props.onRefresh()} disabled={props.busy || importing}>
              刷新策略库
            </Button>
            <Badge variant="default">全部 {props.strategies.length}</Badge>
            <Badge variant="success">筛选 {filtered.length}</Badge>
          </div>
        </div>

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
          <div className="space-y-3">
            <label className="space-y-2">
              <div className="text-xs text-zinc-400">搜索策略</div>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="按策略名称搜索"
                className="h-9 w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 text-sm text-zinc-50 placeholder:text-zinc-600 focus:border-emerald-500 focus:outline-none"
              />
            </label>

            <div className="flex items-end gap-2">
              <Button size="sm" variant="outline" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={currentPage <= 1}>
                上一页
              </Button>
              <Button size="sm" variant="outline" onClick={() => setPage((current) => Math.min(totalPages, current + 1))} disabled={currentPage >= totalPages}>
                下一页
              </Button>
              <div className="rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs text-zinc-500">
                {currentPage} / {totalPages}
              </div>
            </div>

            {pageItems.length ? (
              <div className="space-y-2">
                {pageItems.map((strategy) => {
                  const selected = props.selectedStrategy?.id === strategy.id;
                  return (
                    <button
                      key={strategy.id}
                      onClick={() => props.onSelectStrategy(strategy.id)}
                      className={`block w-full rounded-xl border px-4 py-3 text-left transition-all ${
                        selected
                          ? "border-emerald-500/50 bg-emerald-500/10 shadow-[0_0_0_1px_rgba(16,185,129,0.25)]"
                          : "border-zinc-800 bg-zinc-900/40 hover:border-zinc-700 hover:bg-zinc-900/65"
                      }`}
                    >
                      <div className="truncate font-medium text-zinc-100">{strategy.name}</div>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-900/30 p-4 text-sm text-zinc-500">当前没有匹配的策略，换个关键词再试试。</div>
            )}
          </div>

          <div className="space-y-2 rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
            <div className="text-xs font-medium text-zinc-300">导入本地 Python 策略</div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".py,text/x-python,.txt"
              onChange={(event) => {
                const file = event.target.files?.[0] || null;
                setSelectedFile(file);
                if (file && !importName.trim()) {
                  setImportName(file.name.replace(/\.py$/i, ""));
                }
              }}
              className="block w-full text-xs text-zinc-400 file:mr-3 file:rounded-md file:border-0 file:bg-zinc-800 file:px-3 file:py-2 file:text-xs file:text-zinc-100"
            />
            <input
              value={importName}
              onChange={(event) => setImportName(event.target.value)}
              placeholder="自定义策略名称"
              className="h-9 w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 text-sm text-zinc-50 placeholder:text-zinc-600 focus:border-emerald-500 focus:outline-none"
            />
            <div className="text-[11px] text-zinc-500">
              {selectedFile ? `已选择: ${selectedFile.name}` : "选择硬盘中的 Python 文件后，可自定义名称并保存到策略档案库。"}
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => void handleImport()} disabled={props.busy || importing || !selectedFile || !importName.trim()}>
                {importing ? "导入中..." : "导入并保存"}
              </Button>
              <Button size="sm" variant="outline" onClick={resetImport} disabled={props.busy || importing}>
                清空
              </Button>
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}
