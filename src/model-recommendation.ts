import type {
  CodexEffort,
  CodexModel,
  ResearchMode,
  ResearchTask,
} from './local-codex';

export type CodexRecommendation = {
  model: CodexModel;
  effort: CodexEffort;
  reason: string;
};

type RecommendationInput = {
  models: CodexModel[];
  defaultModel?: string | null;
  researchMode: ResearchMode;
  taskKind?: ResearchTask['kind'] | null;
  safeMinutes: number;
  quotaRemainingPercent?: number | null;
};

const effortOrder: CodexEffort[] = ['low', 'medium', 'high', 'xhigh'];
const verificationKinds = new Set<ResearchTask['kind']>(['review', 'formalization']);
const proofKinds = new Set<ResearchTask['kind']>(['proof', 'counterexample-search']);
const exploratoryKinds = new Set<ResearchTask['kind']>(['exploration', 'synthesis']);

export function recommendCodexConfiguration({
  models,
  defaultModel,
  researchMode,
  taskKind,
  safeMinutes,
  quotaRemainingPercent,
}: RecommendationInput): CodexRecommendation | null {
  if (models.length === 0) return null;

  const sol = findModel(models, 'sol');
  const accountDefault = models.find((candidate) => candidate.model === defaultModel)
    ?? models.find((candidate) => candidate.isDefault)
    ?? models[0];
  const strongestForMathematics = sol ?? accountDefault;
  const minutes = Math.max(0, Math.floor(safeMinutes));
  const remaining = Number.isFinite(quotaRemainingPercent)
    ? Math.max(0, Math.min(100, Number(quotaRemainingPercent)))
    : null;
  const ample = minutes >= 45 && (remaining === null || remaining >= 30);
  const isVerification = researchMode === 'verify'
    || (taskKind !== undefined && taskKind !== null && verificationKinds.has(taskKind));
  const isProof = taskKind !== undefined && taskKind !== null && proofKinds.has(taskKind);
  const isExploration = researchMode === 'explore'
    || (taskKind !== undefined && taskKind !== null && exploratoryKinds.has(taskKind));
  const isComputation = taskKind === 'computation';

  let model: CodexModel;
  let targetEffort: CodexEffort;
  let reason: string;

  if (isVerification) {
    model = strongestForMathematics;
    targetEffort = ample ? 'xhigh' : 'high';
    reason = ample
      ? 'Mathematical verification uses Sol when available, with enough allowance for the strongest supported reasoning.'
      : 'Verification favors the strongest mathematics model and high reasoning.';
  } else if (isProof) {
    model = strongestForMathematics;
    targetEffort = 'high';
    reason = 'Proof and counterexample work favor Sol when available with high reasoning.';
  } else if (isComputation) {
    model = strongestForMathematics;
    targetEffort = 'high';
    reason = 'Mathematical computation uses Sol when available so certificate design and interpretation are not downgraded.';
  } else if (isExploration) {
    model = strongestForMathematics;
    targetEffort = 'high';
    reason = 'Open-ended mathematical exploration favors Sol when available and high reasoning breadth.';
  } else {
    model = strongestForMathematics;
    targetEffort = 'high';
    reason = 'The automatic frontier task receives the strongest mathematics configuration available.';
  }

  return {
    model,
    effort: nearestSupportedEffort(model, targetEffort),
    reason,
  };
}

function findModel(models: CodexModel[], family: 'sol') {
  const token = new RegExp(`(?:^|[^a-z])${family}(?:$|[^a-z])`, 'i');
  return models.find((candidate) => token.test(`${candidate.model} ${candidate.displayName}`));
}

function nearestSupportedEffort(model: CodexModel, target: CodexEffort) {
  const supported = model.supportedReasoningEfforts.length > 0
    ? model.supportedReasoningEfforts
    : [model.defaultReasoningEffort];
  if (supported.includes(target)) return target;

  const targetIndex = effortOrder.indexOf(target);
  for (let distance = 1; distance < effortOrder.length; distance += 1) {
    const lower = effortOrder[targetIndex - distance];
    if (lower && supported.includes(lower)) return lower;
    const higher = effortOrder[targetIndex + distance];
    if (higher && supported.includes(higher)) return higher;
  }
  return model.defaultReasoningEffort;
}
