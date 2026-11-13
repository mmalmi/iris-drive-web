/** Charts load the first time a spreadsheet shows or makes one. */
type ChartModule = typeof import('../../lib/sheets/chart');

let loaded: ChartModule | null = null;
let loading: Promise<ChartModule> | null = null;

/** The chart code if it has loaded, for work that cannot wait. */
export function chartsNow(): ChartModule | null {
  return loaded;
}

export function loadCharts(): Promise<ChartModule> {
  loading ??= import('../../lib/sheets/chart').then((module) => {
    loaded = module;
    return module;
  });
  return loading;
}
