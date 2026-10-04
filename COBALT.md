# B20SCAN Cobalt support

ABI and precompile constants are checked against official
[base-std a2954a8](https://github.com/base/base-std/tree/a2954a8d576fd1ccfc8dceed8801c555280662f8).

## Seizures

`Seized(address indexed caller,address indexed from,address indexed to,uint256 amount)`
records a reassignment. `BurnedBlocked` remains available for legacy burns.
`/api/token/:address/seizures` merges both, with `method: seize | burnBlocked`,
`to` (null for a burn), precise raw/display amounts, and cursor pagination.
Balances and supply are updated only by the associated `Transfer` event.

`status: enforced` is historical evidence. `currently_armed` separately checks
current roles, the relevant scope and pause state: `SEIZE_ROLE` +
`SEIZE_EXEMPT_POLICY` + unpaused SEIZE, or legacy `BURN_BLOCKED_ROLE` +
`TRANSFER_SENDER_POLICY` + unpaused BURN. Revoked roles and cleared scopes do
not count. An always-block receiver disables the new path. This describes
configuration; it does not prove any particular holder is seizable.

The token UI labels SEIZE roles, the SEIZE pause feature, seizure history and
both seizure policy scopes. Activity shows the actual destination for Seized
and the zero address for BurnedBlocked.

## Global PolicyRegistry indexing

The singleton `0x8453000000000000000000000000000000000002` emits:

- `PolicyCreated(uint64 indexed policyId,address indexed creator,uint8 policyType)`
- `CompositePolicyUpdated(uint64 indexed policyId,address indexed updater,uint64[] childPolicyIds)`

These are indexed in a separate address-filtered stream and `policy_events`
table. `policy_state` holds types and the latest complete child set. Policy IDs
remain strings, including values beyond JavaScript's safe integer range.
Backfill arriving after live updates cannot overwrite newer composite state.

`/api/token/:address/policy` returns each current scope, its resolved type and
UNION (OR) / INTERSECT (AND) children. It retains `current` and `history` and adds
`current_detail`, `current_scopes`, `composites` and paginated `registry_history`.
The policy history category joins relevant global events by policy ID.
Unbinding one scope does not hide policies still bound to other scopes.

## Migration and deployment

The database migration adds tables without altering existing event/holder data.
Deploy `chain.js`, `db.js`, `policy.js`, `history.js`, `indexer.js`, `server.js`,
`mcp-server.js` and `public/index.html`, then restart the web and indexer services.

The follower maintains independent `registry_cursor` and `seize_cursor` values.
Registry history starts at B20 activation. Seized history starts at Cobalt's
timestamp (mainnet 1790791200), located by block timestamp and cached in meta.
Existing factory/token cursors are preserved.

For a one-time additive catch-up alongside the follower:

```sh
node indexer.js --cobalt-backfill
```

`REGISTRY_CHUNK` / `SEIZE_CHUNK` default to 1,000 blocks; oversized RPC
responses, including HTTP 413, split recursively. `COBALT_START_BLOCK` and
`COBALT_TIMESTAMP` can be overridden for another network or local tests.
The manual backfill uses four concurrent ranges and advances its cursor only
after the whole group succeeds; live following uses one range per tick.

## Verification

`npm test` exercises canonical event topics, decoder precision, both seizure
methods, pagination, unchanged supply after reassignment, shared composite
state, out-of-order backfill, independent scopes, revoked roles and pauses.
It also drives the real indexer against a local JSON-RPC fixture, including
HTTP 413 splitting, and parses the frontend script.

After deployment, verify live service logs, both new cursors, `/api/health`,
token/history endpoints and the desktop/mobile controls UI. No transactions
or wallet connections are needed for these checks.
