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

Public RPCs cap getLogs ranges; CHUNK=2000 is safe for most. With a paid
endpoint (Alchemy/QuickNode) raise CHUNK to 10000 for a much faster backfill.

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
- Controller addresses in issuer roles are typed through `eth_getCode`, so the
  frontend can show `CONTRACT`, `EOA`, or `UNKNOWN` next to ADMIN/MINT/META/
  OPERATOR accounts.
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
    GET /api/tokens?variant=&q=&limit=      newest first
    GET /api/tokens/count?variant=&q=       count for paginated token lists
    GET /api/tokens/:address                detail + events + top holders
    GET /api/tokens/:address/live           live name/symbol/supply/cap reads
    GET /api/names?addresses=0x...,0x...    Base names for visible addresses
    GET /api/account-types?addresses=...    EOA/CONTRACT/UNKNOWN labels
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
metadata mutability, supply cap, and admin account type. The activity pane is
paginated 20 events at a time and includes event, from, to, amount, memo, hash,
and age columns with BaseScan links.
