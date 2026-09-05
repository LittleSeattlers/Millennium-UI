export type PublicProblemStats = {
  id: string;
  ui_slug: string;
  runs: number;
  completed: number;
  checkpointed: number;
  aborted: number;
};

export type PublicDashboard = {
  schema_version: 1;
  generated_at: string;
  data_scope: 'validated canonical contribution records on public main';
  totals: {
    runs: number;
    completed: number;
    checkpointed: number;
    aborted: number;
  };
  problems: PublicProblemStats[];
};

const allowedIds = new Set([
  'riemann-hypothesis',
  'p-vs-np',
  'navier-stokes',
  'hodge-conjecture',
  'birch-swinnerton-dyer',
  'yang-mills',
  'poincare-conjecture',
]);

const isCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;

export function parsePublicDashboard(value: unknown): PublicDashboard {
  if (!value || typeof value !== 'object') throw new Error('Dashboard snapshot is not an object.');
  const input = value as Record<string, unknown>;
  if (input.schema_version !== 1) throw new Error('Unsupported dashboard schema.');
  if (typeof input.generated_at !== 'string' || Number.isNaN(Date.parse(input.generated_at))) {
    throw new Error('Dashboard snapshot has an invalid publication time.');
  }
  if (input.data_scope !== 'validated canonical contribution records on public main') {
    throw new Error('Dashboard snapshot has an unknown data scope.');
  }

  const rawTotals = input.totals as Record<string, unknown> | undefined;
  if (!rawTotals || !['runs', 'completed', 'checkpointed', 'aborted'].every((key) => isCount(rawTotals[key]))) {
    throw new Error('Dashboard totals are invalid.');
  }
  if (!Array.isArray(input.problems) || input.problems.length !== 7) {
    throw new Error('Dashboard problem catalog is incomplete.');
  }

  const problems = input.problems.map((entry) => {
    if (!entry || typeof entry !== 'object') throw new Error('Dashboard problem entry is invalid.');
    const item = entry as Record<string, unknown>;
    if (typeof item.id !== 'string' || !allowedIds.has(item.id) || typeof item.ui_slug !== 'string') {
      throw new Error('Dashboard problem identity is invalid.');
    }
    if (!['runs', 'completed', 'checkpointed', 'aborted'].every((key) => isCount(item[key]))) {
      throw new Error('Dashboard problem counts are invalid.');
    }
    return item as PublicProblemStats;
  });

  if (new Set(problems.map(({ id }) => id)).size !== 7) {
    throw new Error('Dashboard problem identities are duplicated.');
  }

  const totals = rawTotals as PublicDashboard['totals'];
  if (totals.runs !== totals.completed + totals.checkpointed + totals.aborted) {
    throw new Error('Dashboard totals do not reconcile.');
  }
  if (problems.reduce((sum, item) => sum + item.runs, 0) !== totals.runs) {
    throw new Error('Dashboard problem counts do not reconcile.');
  }

  return {
    schema_version: 1,
    generated_at: input.generated_at as string,
    data_scope: 'validated canonical contribution records on public main',
    totals,
    problems,
  };
}
