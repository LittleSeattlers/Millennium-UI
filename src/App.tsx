import { useEffect, useMemo, useState } from 'react';
import { parsePublicDashboard, type PublicDashboard, type PublicProblemStats } from './dashboard';
import { installGemFavicon } from './favicon';
import { LocalResearchConsole } from './LocalResearchConsole';
import { problems, type Problem } from './problems';

const repositoryUrl = 'https://github.com/LittleSeattlers/Millennium-UI';

type ProblemBriefTab = 'context' | 'history' | 'method';

function Gem({ kind, large = false }: { kind: string; large?: boolean }) {
  return <span aria-hidden="true" className={`problem-gem gem-${kind}${large ? ' gem-large' : ''}`} />;
}

function StatNumber({ value }: { value: number | undefined }) {
  return <>{value === undefined ? '—' : value.toLocaleString()}</>;
}

function ProblemRail({
  selected,
  stats,
  onSelect,
}: {
  selected: Problem;
  stats: Map<string, PublicProblemStats>;
  onSelect: (problem: Problem) => void;
}) {
  return (
    <aside className="panel problem-panel" aria-label="Millennium problems">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">THE SEVEN</p>
          <h2>Problem index</h2>
        </div>
        <span className="count-badge">6 OPEN</span>
      </div>
      <div className="problem-list">
        {problems.map((problem) => {
          const itemStats = stats.get(problem.id);
          return (
            <button
              aria-controls="problem-workspace"
              aria-pressed={selected.id === problem.id}
              className={`problem-card${selected.id === problem.id ? ' active' : ''}`}
              key={problem.id}
              onClick={() => onSelect(problem)}
              type="button"
            >
              <span className="problem-number">
                {problem.index}
                <Gem kind={problem.gem} />
              </span>
              <span className="problem-copy">
                <strong>{problem.name}</strong>
                <small>{problem.field}</small>
              </span>
              <span className="problem-stat">
                <b><StatNumber value={itemStats?.runs} /></b>
                <small>runs</small>
                {problem.status === 'SOLVED REFERENCE' && <span className="solved-label">SOLVED REF</span>}
              </span>
            </button>
          );
        })}
      </div>
      <p className="rail-note">
        Counts come from strict-schema contribution records merged into this public repository—not from local starts or browser sessions.
      </p>
    </aside>
  );
}

function ProblemBrief({ problem }: { problem: Problem }) {
  const [tab, setTab] = useState<ProblemBriefTab>('context');
  const tabs: Array<{ id: ProblemBriefTab; label: string }> = [
    { id: 'context', label: 'Context' },
    { id: 'history', label: 'History' },
    { id: 'method', label: 'Method' },
  ];

  return (
    <section className="problem-brief" aria-label={`Research brief for ${problem.name}`}>
      <div className="problem-brief-tabs" role="group" aria-label="Research brief section">
        {tabs.map((item) => (
          <button
            aria-controls={`problem-brief-${item.id}`}
            aria-pressed={tab === item.id}
            className={tab === item.id ? 'active' : ''}
            key={item.id}
            onClick={() => setTab(item.id)}
            type="button"
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="problem-brief-body">
      <section
        className="problem-brief-section brief-context"
        hidden={tab !== 'context'}
        id="problem-brief-context"
      >
        <p className="eyebrow">WHAT WOULD SETTLE IT</p>
        <h2>{problem.settlementTitle}</h2>
        <p>{problem.settlementCopy}</p>
        <dl className="truth-grid">
          <div className="truth-card">
            <dt>COMPUTATION CAN</dt>
            <dd>{problem.computeCan}</dd>
          </div>
          <div className="truth-card muted">
            <dt>COMPUTATION CANNOT</dt>
            <dd>{problem.computeCannot}</dd>
          </div>
        </dl>
      </section>

      <section
        className="problem-brief-section brief-method"
        hidden={tab !== 'method'}
        id="problem-brief-method"
      >
        <p className="eyebrow">RESEARCH FIT</p>
        <h2>Where computation helps</h2>
        <p>{problem.frontier}</p>
        <div className="task-pills" aria-label="Research requirements">
          <span>BOUNDED</span><span>CHECKABLE</span><span>REUSABLE</span><span>CRITIQUE-READY</span>
        </div>
      </section>

      <section
        className="problem-brief-section brief-history"
        hidden={tab !== 'history'}
        id="problem-brief-history"
      >
        <p className="eyebrow">SELECTED HISTORY</p>
        <h2>A long human relay</h2>
        <ol className="history-list">
          {problem.history.map((item) => (
            <li className="timeline-item" key={`${item.year}-${item.title}`}>
              <span>{item.year}</span><p>{item.title}</p>
            </li>
          ))}
        </ol>
      </section>
      </div>

      <p className="brief-boundary">
        <span>PUBLIC BOUNDARY</span>
        Counts show durable activity—not truth, novelty, independent review, or prize eligibility.
      </p>
    </section>
  );
}

function ProblemWorkspace({
  problem,
  routeId,
  stats,
  onRouteChange,
}: {
  problem: Problem;
  routeId: string;
  stats?: PublicProblemStats;
  onRouteChange: (routeId: string) => void;
}) {
  const route = problem.routes.find((item) => item.id === routeId) ?? problem.routes[0];

  return (
    <main className="workspace" id="problem-workspace">
      <section className="panel problem-hero" id="problems">
        <div className="problem-kicker">
          <span>{problem.index}</span>
          {problem.status} · {problem.field.toUpperCase()}
        </div>
        <div className="hero-row">
          <div className="hero-title-group">
            <Gem kind={problem.gem} large />
            <div>
              <h1>{problem.name}</h1>
              <p>{problem.description}</p>
            </div>
          </div>
          <a className="source-link" href={problem.officialUrl} rel="noreferrer" target="_blank">
            CLAY REFERENCE ↗
          </a>
        </div>
        <ProblemBrief problem={problem} />
        <div className="route-heading">
          <span>RESEARCH DIRECTIONS</span>
          <small>Choose a route to inspect its settlement condition</small>
        </div>
        <div className="route-row">
          {problem.routes.map((item) => (
            <button
              className={`route-chip${route.id === item.id ? ' selected' : ''}`}
              key={item.id}
              onClick={() => onRouteChange(item.id)}
              type="button"
            >
              <span className="route-symbol">{item.symbol}</span>
              <span>
                <b>{item.label}</b>
                <small>{item.detail}</small>
              </span>
              <em className={`fit-${item.searchFit.toLowerCase()}`}>{item.searchFit} search fit</em>
            </button>
          ))}
        </div>
      </section>

      <LocalResearchConsole problem={problem} route={route} />

      <section className="panel problem-ledger-card">
        <div>
          <p className="eyebrow">PUBLIC RECORD</p>
          <h2>{stats?.runs ?? 0} durable {stats?.runs === 1 ? 'run' : 'runs'}</h2>
          <p>
            Each run contributes a bounded summary, claims, limitations, failed approaches, citations, and next tasks. Raw workspaces and execution telemetry remain local.
          </p>
        </div>
        <div className="state-grid" aria-label={`${problem.name} run states`}>
          <div><strong>{stats?.runs ?? 0}</strong><span>Contributions</span></div>
          <div><strong>{stats?.completed ?? 0}</strong><span>Completed</span></div>
          <div><strong>{stats?.aborted ?? 0}</strong><span>Partial / stopped</span></div>
        </div>
      </section>

      <section className="panel protocol-card" id="method">
        <div className="protocol-heading">
          <div>
            <p className="eyebrow">PUBLICATION PIPELINE</p>
            <h2>Private work. Public accountability.</h2>
          </div>
          <span className="privacy-seal">ALLOWLISTED DATA</span>
        </div>
        <div className="pipeline" aria-label="Research publication flow">
          <div className="pipeline-node"><span>01</span><b>Local Codex</b><small>Runs bounded work</small></div>
          <i aria-hidden="true">→</i>
          <div className="pipeline-node"><span>02</span><b>Shared context</b><small>Reads trusted findings</small></div>
          <i aria-hidden="true">→</i>
          <div className="pipeline-node"><span>03</span><b>Data-only PR</b><small>Publishes one JSON record</small></div>
          <i aria-hidden="true">→</i>
          <div className="pipeline-node public"><span>04</span><b>Public network</b><small>Validates, merges, reallocates</small></div>
        </div>
        <p className="protocol-note">
          The public contract accepts only structured findings, limitations, successor tasks, and citations. It rejects local paths, commands, source code, credentials, account data, raw logs, token usage, and subscription quota.
        </p>
      </section>
    </main>
  );
}

export default function App() {
  const [selected, setSelected] = useState(problems[2]);
  const [routeId, setRouteId] = useState(problems[2].routes[0].id);
  const [dashboard, setDashboard] = useState<PublicDashboard | null>(null);

  useEffect(() => {
    installGemFavicon(selected.gem);
  }, [selected.gem]);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`${import.meta.env.BASE_URL}data/dashboard.v1.json`, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`Snapshot request failed: ${response.status}`);
        return response.json() as Promise<unknown>;
      })
      .then((value) => setDashboard(parsePublicDashboard(value)))
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setDashboard(null);
      });
    return () => controller.abort();
  }, []);

  const stats = useMemo(
    () => new Map(dashboard?.problems.map((item) => [item.id, item]) ?? []),
    [dashboard],
  );
  function selectProblem(problem: Problem) {
    setSelected(problem);
    setRouteId(problem.routes[0].id);
  }

  if (window.self !== window.top) {
    return (
      <main className="frame-blocked">
        <p className="eyebrow">SECURITY BOUNDARY</p>
        <h1>Open Millennium directly.</h1>
        <p>The local Codex console is disabled while this page is embedded in another site.</p>
        <a href="https://littleseattlers.github.io/Millennium-UI/" rel="noreferrer" target="_top">Open the direct page ↗</a>
      </main>
    );
  }

  return (
    <div className="app-shell" id="top">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Millennium home">
          <span className="brand-lockup">
            <span className="brand-wordmark">
              <span className="brand-name">MILLENNIUM</span>
              <span className="brand-gems" aria-hidden="true">
                {problems.map((problem) => <Gem key={problem.id} kind={problem.gem} />)}
              </span>
            </span>
            <span className="brand-subtitle">OPEN RESEARCH NETWORK</span>
          </span>
        </a>
        <div className="topbar-tools">
          <p className="header-thesis">
            <span>Seven problems.</span>
            <i>One shared record.</i>
          </p>
          <div className="header-codex-slot" id="header-codex-slot" />
        </div>
      </header>

      <div className="mission-grid">
        <ProblemRail onSelect={selectProblem} selected={selected} stats={stats} />
        <ProblemWorkspace
          onRouteChange={setRouteId}
          problem={selected}
          routeId={routeId}
          stats={stats.get(selected.id)}
        />
      </div>

      <footer>
        <span>MILLENNIUM · PUBLIC NETWORK</span>
        <p>Counts measure durable attempts—not truth, novelty, review, or prize eligibility.</p>
        <a href={repositoryUrl} rel="noreferrer" target="_blank">SOURCE & DATA CONTRACT ↗</a>
      </footer>
    </div>
  );
}
