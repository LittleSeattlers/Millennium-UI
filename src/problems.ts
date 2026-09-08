export type Route = {
  id: string;
  symbol: string;
  label: string;
  detail: string;
  searchFit: 'High' | 'Medium' | 'Low' | 'Calibration';
};

export type Problem = {
  index: string;
  id: string;
  uiSlug: string;
  gem: string;
  name: string;
  field: string;
  status: 'OPEN' | 'SOLVED REFERENCE';
  description: string;
  officialUrl: string;
  routes: [Route, Route];
  settlementTitle: string;
  settlementCopy: string;
  computeCan: string;
  computeCannot: string;
  frontier: string;
  history: { year: string; title: string }[];
};

const clay = 'https://www.claymath.org/millennium-problems/';

export const problems: Problem[] = [
  {
    index: '01',
    id: 'riemann-hypothesis',
    uiSlug: 'rh',
    gem: 'ruby',
    name: 'Riemann Hypothesis',
    field: 'Number theory',
    status: 'OPEN',
    description: 'Investigate the location of the nontrivial zeros of the Riemann zeta function through bounded, reviewable work.',
    officialUrl: clay,
    routes: [
      { id: 'prove', symbol: '∀', label: 'Prove RH', detail: 'Establish every nontrivial zero lies on Re(s) = ½', searchFit: 'Low' },
      { id: 'refute', symbol: '∃', label: 'Find an off-line zero', detail: 'One rigorously certified witness would refute RH', searchFit: 'High' },
    ],
    settlementTitle: 'One certified witness is enough.',
    settlementCopy: 'A rigorously verified nontrivial zero with real part other than ½ would refute the conjecture. A bounded negative search cannot prove the universal claim.',
    computeCan: 'Search finite ranges and emit checkable certificates',
    computeCannot: 'Turn a bounded negative search into a proof',
    frontier: 'A strong direct witness-search candidate. Agents are most useful for designing checks, attacking assumptions, and packaging certificates.',
    history: [
      { year: '1859', title: 'Riemann formulates the conjecture while studying prime counting.' },
      { year: '1914', title: 'Hardy proves infinitely many zeros lie on the critical line.' },
      { year: '2000', title: 'Clay names it a Millennium Prize Problem.' },
    ],
  },
  {
    index: '02',
    id: 'p-vs-np',
    uiSlug: 'pnp',
    gem: 'citrine',
    name: 'P vs NP',
    field: 'Computer science',
    status: 'OPEN',
    description: 'Separate efficient verification from efficient solution—or construct a general efficient algorithm that collapses the distinction.',
    officialUrl: clay,
    routes: [
      { id: 'equal', symbol: '=', label: 'Establish P = NP', detail: 'Give and prove a polynomial-time algorithm for an NP-complete problem', searchFit: 'Low' },
      { id: 'separate', symbol: '≠', label: 'Establish P ≠ NP', detail: 'Prove a lower bound strong enough to separate the classes', searchFit: 'Low' },
    ],
    settlementTitle: 'This is not a finite-counterexample problem.',
    settlementCopy: 'Hard inputs can break a proposed algorithm, but no finite collection proves P ≠ NP. Either direction needs a general mathematical argument.',
    computeCan: 'Falsify candidate algorithms and check bounded lemmas',
    computeCannot: 'Infer asymptotic separation from many hard instances',
    frontier: 'Use search as an adversarial critic for proposed algorithms, reductions, and proof steps—not as a vote based on observed runtime.',
    history: [
      { year: '1971', title: 'Cook formalizes NP-completeness through satisfiability.' },
      { year: '1973', title: 'Levin independently develops universal search problems.' },
      { year: '2000', title: 'Clay places P vs NP among the seven prize problems.' },
    ],
  },
  {
    index: '03',
    id: 'navier-stokes',
    uiSlug: 'ns',
    gem: 'emerald',
    name: 'Navier–Stokes',
    field: 'Analysis · PDE',
    status: 'OPEN',
    description: 'Determine whether smooth three-dimensional incompressible flows stay smooth for all time or can develop a singularity.',
    officialUrl: clay,
    routes: [
      { id: 'regular', symbol: '∞', label: 'Prove global regularity', detail: 'Establish existence and smoothness for all admissible data', searchFit: 'Low' },
      { id: 'blowup', symbol: '⚡', label: 'Prove finite-time breakdown', detail: 'Construct data and rigorously certify singular behavior', searchFit: 'Medium' },
    ],
    settlementTitle: 'A numerical blow-up is not yet a singularity.',
    settlementCopy: 'A counterexample route is legitimate, but numerical instability, discretization error, and true PDE blow-up need rigorous separation.',
    computeCan: 'Explore candidate mechanisms and support interval-certified bounds',
    computeCannot: 'Promote an apparent simulation singularity to a proof',
    frontier: 'Computer-assisted proof may matter here, but every numerical claim needs error control and a bridge back to the continuum equations.',
    history: [
      { year: '1822', title: 'Navier introduces equations for viscous flow.' },
      { year: '1934', title: 'Leray constructs global weak solutions in three dimensions.' },
      { year: '2000', title: 'Clay asks for smoothness or breakdown in three dimensions.' },
    ],
  },
  {
    index: '04',
    id: 'hodge-conjecture',
    uiSlug: 'hodge',
    gem: 'aquamarine',
    name: 'Hodge Conjecture',
    field: 'Algebraic geometry',
    status: 'OPEN',
    description: 'Ask whether certain topological features of projective algebraic varieties come from algebraic subvarieties.',
    officialUrl: clay,
    routes: [
      { id: 'prove', symbol: '∀', label: 'Prove algebraicity', detail: 'Show every rational Hodge class has the required algebraic origin', searchFit: 'Low' },
      { id: 'refute', symbol: '∃', label: 'Construct a non-algebraic class', detail: 'Exhibit and prove a rational Hodge class is not algebraic', searchFit: 'Low' },
    ],
    settlementTitle: 'The witness must include non-algebraicity.',
    settlementCopy: 'Enumerating varieties may suggest candidates, but the decisive step is a rigorous proof that a candidate class cannot be algebraic.',
    computeCan: 'Explore structured examples and verify symbolic consequences',
    computeCannot: 'Establish non-algebraicity by enumeration alone',
    frontier: 'High-value work targets precise special cases, formalized calculations, and reusable obstruction tests rather than undirected brute force.',
    history: [
      { year: '1930s', title: 'Hodge develops the decomposition framing the conjecture.' },
      { year: '1950', title: 'The conjecture enters the international problem canon.' },
      { year: '2000', title: 'Clay includes the rational Hodge conjecture.' },
    ],
  },
  {
    index: '05',
    id: 'birch-swinnerton-dyer',
    uiSlug: 'bsd',
    gem: 'amethyst',
    name: 'Birch–Swinnerton-Dyer',
    field: 'Arithmetic geometry',
    status: 'OPEN',
    description: 'Relate rational points on an elliptic curve to the behavior of its L-function at a distinguished point.',
    officialUrl: clay,
    routes: [
      { id: 'prove', symbol: '=', label: 'Prove the rank equality', detail: 'Establish the conjectured equality for every elliptic curve', searchFit: 'Low' },
      { id: 'refute', symbol: '≠', label: 'Find a rank mismatch', detail: 'Give a curve whose exact algebraic and analytic ranks differ', searchFit: 'Medium' },
    ],
    settlementTitle: 'A candidate curve is only the beginning.',
    settlementCopy: 'Computation can surface suspicious curves, but both relevant ranks must be established exactly before a mismatch becomes a counterexample.',
    computeCan: 'Search curves, compute evidence, and prioritize exact follow-up',
    computeCannot: 'Replace rigorous rank certification with decimals',
    frontier: 'A useful hybrid track: large-scale screening followed by proof-producing arithmetic and independent verification.',
    history: [
      { year: '1960s', title: 'Birch and Swinnerton-Dyer infer the pattern from computer experiments.' },
      { year: '1980s', title: 'Gross–Zagier and Kolyvagin establish major rank-one cases.' },
      { year: '2000', title: 'Clay selects the conjecture for the Millennium list.' },
    ],
  },
  {
    index: '06',
    id: 'yang-mills',
    uiSlug: 'ym',
    gem: 'sapphire',
    name: 'Yang–Mills & Mass Gap',
    field: 'Mathematical physics',
    status: 'OPEN',
    description: 'Construct a rigorous quantum Yang–Mills theory in four dimensions and prove that it has a positive mass gap.',
    officialUrl: clay,
    routes: [
      { id: 'construct', symbol: '△', label: 'Construct and prove a gap', detail: 'Build the continuum theory and establish positive mass', searchFit: 'Low' },
      { id: 'obstruct', symbol: '∅', label: 'Find a rigorous obstruction', detail: 'Show a required construction fails or produces gaplessness', searchFit: 'Low' },
    ],
    settlementTitle: 'Lattice evidence is not the continuum theory.',
    settlementCopy: 'Simulation strongly informs physics, but the prize asks for a mathematically rigorous construction and proof in the continuum.',
    computeCan: 'Test discretized models and audit finite derivations',
    computeCannot: 'Infer the required continuum construction from finite lattices',
    frontier: 'Treat numerical work as hypothesis generation. High-value attempts isolate a theorem-sized bridge to the continuum limit.',
    history: [
      { year: '1954', title: 'Yang and Mills introduce non-abelian gauge theory.' },
      { year: '1970s', title: 'Asymptotic freedom reshapes the theory of strong interactions.' },
      { year: '2000', title: 'Clay asks for rigorous existence and a mass gap.' },
    ],
  },
  {
    index: '07',
    id: 'poincare-conjecture',
    uiSlug: 'pc',
    gem: 'moonstone',
    name: 'Poincaré Conjecture',
    field: 'Calibration track',
    status: 'SOLVED REFERENCE',
    description: 'Use a known solved problem to test whether the protocol can reconstruct, critique, and preserve rigorous mathematical work.',
    officialUrl: clay,
    routes: [
      { id: 'reconstruct', symbol: '✓', label: 'Reconstruct the proof', detail: 'Build a dependency-aware explanation with verified sources', searchFit: 'Calibration' },
      { id: 'challenge', symbol: '?', label: 'Stress-test the proof', detail: 'Generate objections and confirm why they fail or matter', searchFit: 'Calibration' },
    ],
    settlementTitle: 'A solved track is the protocol’s unit test.',
    settlementCopy: 'If the network cannot distinguish a known proof from plausible noise here, it should not be trusted on an open problem.',
    computeCan: 'Measure reproduction, citation, and objection-handling quality',
    computeCannot: 'Claim novelty merely by restating known work',
    frontier: 'Use this track to tune review gates, artifact schemas, duplicate detection, and formalization before scaling open-problem attempts.',
    history: [
      { year: '1904', title: 'Poincaré poses the three-dimensional topology question.' },
      { year: '1982', title: 'Hamilton introduces Ricci flow as a route to geometrization.' },
      { year: '2002–03', title: 'Perelman posts the decisive Ricci-flow arguments.' },
    ],
  },
];
