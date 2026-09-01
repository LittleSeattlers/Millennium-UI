# Research frontier

`frontier.v1.json` is the human-curated starting graph for bounded Millennium work. It is deliberately a frontier, not a claim that the listed branches exhaust the mathematics.

Each task has a stable ID, problem and theorem direction, branch, task kind, bounded objective, useful-success and useful-failure conditions, a verification method, a suggested duration, and a priority. Every merged contribution records its selected task ID, but only local or explicitly trusted records can change the executable frontier.

The runner supports four selection modes:

- **Recommended** chooses a currently available task using priority and fit to the safe time allowance.
- **Browse frontier** lets the contributor choose any available curated branch.
- **Explore new direction** creates a stable branch ID from a contributor-supplied direction. It is not limited to this catalog.
- **Verify result** creates a linked, still-unreviewed review attempt for a trusted completed record without sending its research prose to the hosted browser.

The provider must leave `CONTRIBUTION.proposed.json` with zero to three possible successor tasks. The connector validates and publishes these as unreviewed data. After a normal reviewed commit adds the source attempt ID to `trusted-contributions.v1.json`, deterministic stable IDs can turn those proposals into frontier tasks; child tasks depend on a completed parent, alternatives form another branch, and verification proposals enter the review queue. A verification record stays unreviewed and linked—it does not automatically promote a mathematical claim.

Local leases remain under the gitignored `.millennium/private/` directory. Cross-machine claims are draft pull requests with machine-readable task IDs and expiration times. A connector rechecks claims immediately before starting; if simultaneous claims race, the lowest pull-request number wins. This is best-effort coordination rather than a perfectly atomic distributed lock, but it works without a maintained server and prevents the ordinary duplicate-start case.
