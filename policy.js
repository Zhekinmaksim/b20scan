// Resolve global PolicyRegistry records for every policy scope bound to a token.
const { POLICY_SCOPES } = require("./chain.js");

const POLICY_TYPES = ["BLOCKLIST", "ALLOWLIST", "UNION", "INTERSECT"];
const ALWAYS_BLOCK_ID = ((1n << 56n) | 1n).toString();

function policySnapshot(db, address) {
  const rows = db.prepare(`SELECT block,tx,log_index,ts,args FROM events INDEXED BY idx_events_token
    WHERE token=? AND kind='PolicyUpdated' ORDER BY block,log_index`).all(address);
  const history = rows.map((row) => {
    const args = JSON.parse(row.args);
    return {
      block: row.block, tx: row.tx, log_index: row.log_index, ts: row.ts,
      scope: args.policyScope,
      scope_name: POLICY_SCOPES[String(args.policyScope).toLowerCase()] || args.policyScope,
      old_policy_id: String(args.oldPolicyId), new_policy_id: String(args.newPolicyId),
      bound: String(args.newPolicyId) !== "0",
    };
  });
  const lookup = db.prepare("SELECT * FROM policy_state WHERE policy_id=?");
  const resolved = new Map();
  function resolve(id) {
    const key = String(id);
    if (resolved.has(key)) return resolved.get(key);
    if (key === "0" || key === ALWAYS_BLOCK_ID) {
      const builtin = { policy_id: key, type: key === "0" ? "BLOCKLIST" : "ALLOWLIST", builtin: key === "0" ? "ALWAYS_ALLOW" : "ALWAYS_BLOCK", source: "builtin", composite: null };
      resolved.set(key, builtin);
      return builtin;
    }
    const row = lookup.get(key);
    const detail = {
      policy_id: key, type: POLICY_TYPES[row?.policy_type] || "unknown",
      source: row?.policy_type != null ? "indexed" : "not_indexed", composite: null,
    };
    resolved.set(key, detail);
    if (row?.child_policy_ids) {
      const children = JSON.parse(row.child_policy_ids).map((child) => {
        const simple = resolve(child);
        return { policy_id: String(child), type: simple.type, source: simple.source };
      });
      detail.composite = { kind: detail.type, children, updated_block: row.updated_block, updated_ts: row.updated_ts };
    }
    return detail;
  }
  const byScope = new Map();
  for (const item of history) byScope.set(String(item.scope).toLowerCase(), item);
  const currentScopes = [...byScope.values()].map((item) => ({ ...item, detail: resolve(item.new_policy_id) }));
  const current = history.at(-1) || null;
  const referenced = new Set(history.filter((item) => item.bound).map((item) => item.new_policy_id));
  const composites = [...referenced].map(resolve).filter((item) => item.composite);
  return {
    has_policy: currentScopes.some((item) => item.bound),
    current, current_detail: current?.bound ? resolve(current.new_policy_id) : null,
    current_scopes: currentScopes, history, composites,
  };
}

module.exports = { policySnapshot, ALWAYS_BLOCK_ID };
