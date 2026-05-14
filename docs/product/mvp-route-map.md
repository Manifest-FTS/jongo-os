# MVP Route and Layout Map

## Route Surface

- `/dashboard`
- `/organizations`
- `/sites`
- `/sites/[siteId]`
- `/staging`
- `/deployments`
- `/collaborators`
- `/sponsor`

## Layout Strategy

- shared app shell with top-level navigation
- card-based page sections for modular UI composition
- route-level placeholders that can be wired to live data incrementally

## First Wiring Targets

1. dashboard status cards from live environment/deployment data
2. sites list and site detail data loading
3. staging and deployment action handlers
4. collaborator role checks on protected actions
