# B20SCAN

The explorer general-purpose explorers can't be: every token the B20 factory
has ever created, in one live list. BaseScan shows B20 tokens scattered among
thousands of contract ERC-20s; B20SCAN indexes the factory's `B20Created`
event directly, so it sees exactly the native set - filtered by variant,
with holders, transfers, memos, and the compliance surface.

Verified end-to-end on base-anvil: seed 9 tokens (asset + stablecoin), backfill
indexes all of them with decoded stablecoin currencies, live follower picks up
a new token within seconds, API and frontend serve it all.

## Stack

    chain.js      event ABIs + decoders (B20Created incl. stablecoin currency)
    db.js         SQLite (WAL), tokens / events / holders, BigInt-safe supplies
    indexer.js    backfill (chunked getLogs) + live head follower
    server.js     Express API + static frontend
    public/       single-page frontend, Base brand palette

## Run on Base mainnet

    npm install
    cp .env.example .env    # set RPC_URL to your provider

    node indexer.js         # backfill from activation, then follow head
    node server.js          # in a second terminal -> http://localhost:3020

To backfill deployers on an existing database that was indexed before creator
lookups were enabled:

    node indexer.js --fill-creators

`START_BLOCK=48372133` is the first Base block at or after B20 activation
(July 8, 2026, 18:00 UTC; block timestamp is 18:00:13 UTC on
[BaseScan](https://basescan.org/block/48372133)). It is the default in both
the indexer and `.env.example`. Do not set it to `0`: that makes a fresh
backfill scan hours of empty pre-activation history.

Public RPCs cap getLogs ranges and can throttle individual methods. The shared
`rpc.js` transport uses `RPC_URL` plus comma-separated `RPC_FALLBACK_URLS`,
checks chain ID, fails over on rate limits/timeouts, and limits concurrent
requests. Successful backups remain preferred for that method. Oversized
log requests split without advancing the cursor past an unsuccessful range.

The free Base endpoints in `deploy/free-rpc.env` were selected from
[Chainlist](https://chainlist.org/chain/8453) and verified for historical logs
on October 9, 2026. They require no account, API key, or paid plan. Public
availability is not guaranteed, which is why more than one endpoint is used.
On a VPS, install that file as `/etc/b20scan-rpc.env` and install
`deploy/free-rpc.conf` as a systemd drop-in for both services, then reload
systemd and restart. This preserves the original environment file.

`RPC_TIMEOUT_MS` bounds each upstream attempt (default 8000),
`RPC_WEB_TIMEOUT_MS` gives interactive API reads a shorter deadline (1000),
`RPC_COOLDOWN_MS` skips throttled endpoints (default 60000), and
`RPC_CONCURRENCY` bounds in-flight requests (default 4). Credentials must not
be committed. `EVENT_RANGES_PER_TICK` and `COBALT_RANGES_PER_TICK` control
catch-up work per follower tick; logs and balances are applied in order.
`/api/health` reports each stream's lag and uses the slowest stream for its
overall status, so a caught-up deployment feed cannot hide incomplete balances
or policy history.
The indexer discards non-B20 emitters from topic-scoped responses before
ethers formats logs. Registry requests remain separately address-scoped.
Token-event ranges commit atomically as a batch, avoiding a disk sync for
every individual transfer. Nested transfer transactions still preserve exact
balances, supply, deduplication and event ordering.
Confirmed live-cache Transfers are merged into each historical range before
its cursor advances. RPC log responses are checked against emitter, topics
and block bounds, and large result sets split conservatively.

For an existing cache with confirmed Transfers left unapplied, stop the
indexer and run `node repair-balances.js --from-block=N --dry-run`, then omit
`--dry-run` to apply. `DB_PATH` must be set. Only affected tokens are rebuilt
from their complete indexed ledger; inconsistent or negative ledgers abort.
Old and reconstructed holder/token state is saved in `backups/` beside the
database before a single atomic update. Raw event history is never deleted.
For large histories, `repair-chain-balances.js --from-block=N` can instead
read just affected participants and supply at the frozen confirmed cursor.
It verifies the complete holder sum, stores rollback JSON, and updates only
specific cached accounts and event markers. Both repair tools require the
follower to be stopped. Zero-value Transfers count as events, not new holders.

## VPS deployment

The included systemd units run the indexer and the web/API process separately.
The web service listens on port 80. Copy the project to `/opt/b20scan`, create
`/opt/b20scan/.env` from `.env.example`, then enable both units:

    systemctl enable --now b20scan-indexer b20scan-web

Check progress with `journalctl -u b20scan-indexer -f`; the explorer is usable
while its initial backfill is still running.

## Design notes

- Reorg safety: only blocks at depth >= CONFIRMATIONS (default 12) are indexed,
  so no unwind logic exists or is needed. Factory and token-event cursors resume
  independently: new deployments reach the explorer without waiting for the
  heavier transfer-history backfill.
- Idempotency: UNIQUE(tx, log_index) makes overlapping ranges harmless.
- Holder balances and total supply are computed in BigInt from Transfer events;
  SQLite never does arithmetic on them (int64 overflows at 18 decimals).
- Transfer application is atomic: the event insert, holder/supply updates,
  transfer counter update, and `applied=1` marker run in one SQLite
  transaction. If the process dies mid-write, a restart can safely re-apply
  any unapplied transfer.
- Stablecoin currency codes are decoded from `variantEventParams` in the
  creation event - no extra RPC call per token.
- Creator = tx.from of the creation transaction (one extra call per token,
  plus the `--fill-creators` helper for older databases).
- Memo events are correlated to the operation they annotate by `(tx,
  log_index - 1)`. The UI shows the decoded printable memo on the Transfer row
  and keeps the raw bytes32 in the tooltip.
- Controller addresses in issuer roles are typed through `eth_getCode`. Plain
  empty-code accounts show as `EOA`, EIP-7702 delegated wallets show as
  `SMART EOA`, normal bytecode accounts show as `CONTRACT`, and timeouts show
  as `UNKNOWN`.
- Token-level logs are fetched with address-array getLogs in batches of 100
  tokens; as the token set grows past ~1-2k, switch this to a topic-first
  strategy or a proper indexing service. This is the known v1 scaling limit.
- Factory logs are indexed before token logs in every block range. Therefore
  `holder_count` and `transfer_count` are complete even when a token's
  transfers occurred before it first appeared in the local index. To rebuild
  from scratch, delete `b20scan.db`; the cursor plus `(tx, log_index)` dedup
  make the backfill safe to resume.

## API

    GET /api/stats                          counts + cursor
    GET /api/health                         chain head, cursors, lag, last event
    GET /api/deploys                        all-time deploy histogram buckets
    GET /api/tokens?variant=&q=&limit=      paginated token lists
      filters: min_holders=2, non_mint=1, admin=active|renounced,
               admin_type=eoa|smart_eoa|contract
      sort: created|activity|holders|transfers
    GET /api/tokens/count?variant=&q=       count for the same token filters
    GET /api/tokens/:address                detail + full event history + top holders
    GET /api/tokens/:address/live           live name/symbol/supply/cap reads
    GET /api/names?addresses=0x...,0x...    Base names for visible addresses
    GET /api/account-types?addresses=...    EOA/SMART_EOA/CONTRACT/UNKNOWN labels
    GET /api/feed                           latest events across all tokens

## Frontend

Base brand: white field, Base Blue #0052FF, ink #0A0B0D, Space Grotesk display
+ IBM Plex Mono data. Signature element: every token address renders its
0xB200 prefix as a solid blue block - the standard's own visual DNA. Auto
refreshes every 10s; new tokens flash in. Variant filter runs on the indexed
variant field (stablecoins even carry their currency code in the chip).

Shareable token URLs are served by Express and hydrated by the single-page app:

    https://b20scan.live/token/0xB200...

Token cards are split into `overview`, `controls`, and `activity`. The controls
pane highlights active administration, minting, burn support, pause state,
metadata mutability, supply cap, and admin account type. The activity pane uses
the full indexed event history, paginated 20 events at a time, and includes
event, from, to, amount, memo, hash, and age columns with BaseScan links.
