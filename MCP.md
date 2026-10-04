# B20SCAN MCP server

`mcp-server.js` exposes B20SCAN's history API as MCP tools so agents can query
B20 token history directly.

It is a thin layer over the REST endpoints in `history.js`; it does not
duplicate indexer logic.

## Tools

- `b20_token_overview` — current token profile and controls
- `b20_seizure_history` — legacy `BurnedBlocked` burns and Cobalt `Seized` reassignments, destinations and current configuration
- `b20_policy_timeline` — all policy scopes, global registry types, composite children and update history
- `b20_roles_history` — grant/revoke timeline for issuer roles
- `b20_current_roles` — current role holders folded from history
- `b20_supply_history` — supply-cap changes plus mint/burn flow
- `b20_history` — raw events by category with range and cursor pagination

## Run

```bash
B20SCAN_API=https://b20scan.live node mcp-server.js
```

`B20SCAN_API` defaults to `http://localhost:3020`.

## Claude Desktop config

```json
{
  "mcpServers": {
    "b20scan": {
      "command": "node",
      "args": ["/absolute/path/to/b20scan/mcp-server.js"],
      "env": {
        "B20SCAN_API": "https://b20scan.live"
      }
    }
  }
}
```

## REST endpoints

- `GET /api/token/:address/history`
- `GET /api/token/:address/seizures`
- `GET /api/token/:address/roles/history`
- `GET /api/token/:address/roles`
- `GET /api/token/:address/policy`
- `GET /api/token/:address/supply/history`

The `history` endpoint accepts:

- `category`: `admin`, `seizure`, `policy`, `roles`, `supply`, `transfers`, `memos`, `disclosures`
- `from_block`
- `to_block`
- `limit`
- `cursor`

The `supply` category intentionally returns only `SupplyCapUpdated`; mint/burn
flow is available from the dedicated `/supply/history` endpoint.

`status: enforced` means at least one seizure was indexed in the past;
`currently_armed` separately reports active seizure configuration. Revoked roles,
cleared policies and paused operations do not count as currently armed. It is a
configuration signal, not an authorization check for a particular holder.

`/policy` keeps the existing `current`/`history` fields and adds `current_scopes`,
`current_detail`, `composites`, and paginated `registry_history`. Policy IDs and
amounts are strings to preserve uint64/uint256 precision. See [COBALT.md](COBALT.md).
