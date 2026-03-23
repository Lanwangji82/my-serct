export function getPlatformModuleCatalog() {
  return [
    {
      id: 'research',
      label: 'Research',
      capabilities: ['strategy registry', 'signal definitions', 'experiment lifecycle'],
    },
    {
      id: 'simulation',
      label: 'Simulation',
      capabilities: ['historical replay', 'backtests', 'parameter sweeps'],
    },
    {
      id: 'portfolio',
      label: 'Portfolio',
      capabilities: ['paper accounts', 'allocations', 'exposure oversight'],
    },
    {
      id: 'governance',
      label: 'Governance',
      capabilities: ['audit trail', 'credential summaries', 'policy controls'],
    },
    {
      id: 'execution-adapters',
      label: 'Execution Adapters',
      capabilities: ['paper execution', 'broker registry', 'extensible execution adapters'],
    },
  ];
}
