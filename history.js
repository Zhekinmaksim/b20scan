// history.js - read-only time-series API over the indexed B20 event log.
//
// This layer exposes what direct precompile readers cannot: historical issuer
// actions, seizure records, policy changes, role changes, disclosures, and
// supply flow.

const { ethers } = require("ethers");
const { PAUSE_FEATURES } = require("./chain.js");
const { policySnapshot, ALWAYS_BLOCK_ID } = require("./policy.js");

const CATEGORY = {
  admin: [
    "RoleGranted",
    "RoleRevoked",
    "SupplyCapUpdated",
    "Paused",
    "Unpaused",
    "PolicyUpdated",
    "PolicyCreated",
    "CompositePolicyUpdated",
    "Announcement",
    "EndAnnouncement",
    "ExtraMetadataUpdated",
  ],
  seizure: ["Seized", "BurnedBlocked"],
  policy: ["PolicyUpdated", "PolicyCreated", "CompositePolicyUpdated"],
  roles: ["RoleGranted", "RoleRevoked"],
  supply: ["SupplyCapUpdated"],
  transfers: ["Transfer"],
  memos: ["Memo"],
  disclosures: ["Announcement", "EndAnnouncement", "ExtraMetadataUpdated"],
};

const ROLE_LABELS = new Map([
  ["0x" + "00".repeat(32), "ADMIN"],
  [ethers.id("DEFAULT_ADMIN_ROLE"), "ADMIN"],
  [ethers.id("MINT_ROLE"), "MINT"],
  [ethers.id("MINTER_ROLE"), "MINT"],
  [ethers.id("BURN_ROLE"), "BURN"],
  [ethers.id("BURN_BLOCKED_ROLE"), "BURN BLOCKED"],
  [ethers.id("SEIZE_ROLE"), "SEIZE"],
  [ethers.id("PAUSE_ROLE"), "PAUSE"],
  [ethers.id("PAUSER_ROLE"), "PAUSE"],
  [ethers.id("UNPAUSE_ROLE"), "UNPAUSE"],
  [ethers.id("METADATA_ROLE"), "META"],
  [ethers.id("META_ROLE"), "META"],
  [ethers.id("OPERATOR_ROLE"), "OPERATOR"],
].map(([hash, label]) => [String(hash).toLowerCase(), label]));

const ZERO = "0x0000000000000000000000000000000000000000";
const BURN_BLOCKED_ROLE = ethers.id("BURN_BLOCKED_ROLE").toLowerCase();
const SEIZE_ROLE = ethers.id("SEIZE_ROLE").toLowerCase();
const SEIZE_EXEMPT_SCOPE = ethers.id("SEIZE_EXEMPT_POLICY").toLowerCase();
const SEIZE_RECEIVER_SCOPE = ethers.id("SEIZE_RECEIVER_POLICY").toLowerCase();
const TRANSFER_SENDER_SCOPE = ethers.id("TRANSFER_SENDER_POLICY").toLowerCase();

function seizureCapability(db, address) {
  const counts = db.prepare(`SELECT COUNT(*) total FROM events INDEXED BY idx_events_token WHERE token=?
    AND kind IN ('Seized','BurnedBlocked')`).get(address);
  const rows = db.prepare(`SELECT kind,args FROM events INDEXED BY idx_events_token WHERE token=?
    AND kind IN ('RoleGranted','RoleRevoked','PolicyUpdated','Paused','Unpaused')
    ORDER BY block,log_index`).all(address);
  const held = new Map();
  const policy = {};
  const paused = new Set();
  for (const row of rows) {
    const args = parseArgs(row);
    if (row.kind === "RoleGranted" || row.kind === "RoleRevoked") {
      const role = String(args.role).toLowerCase();
      const account = String(args.account).toLowerCase();
      if (!held.has(role)) held.set(role, new Set());
      if (row.kind === "RoleGranted") held.get(role).add(account);
      else held.get(role).delete(account);
    } else if (row.kind === "PolicyUpdated") {
      policy[String(args.policyScope).toLowerCase()] = String(args.newPolicyId);
    } else {
      for (const feature of args.features || []) {
        const label = PAUSE_FEATURES[Number(feature)];
        if (row.kind === "Paused") paused.add(label);
        else paused.delete(label);
      }
    }
  }
  const bound = (scope) => policy[scope] != null && policy[scope] !== "0";
  const seizeArmed = !!held.get(SEIZE_ROLE)?.size && bound(SEIZE_EXEMPT_SCOPE)
    && policy[SEIZE_RECEIVER_SCOPE] !== ALWAYS_BLOCK_ID && !paused.has("SEIZE");
  const burnArmed = !!held.get(BURN_BLOCKED_ROLE)?.size && bound(TRANSFER_SENDER_SCOPE) && !paused.has("BURN");
  const total = Number(counts.total);
  return {
    seizure_capable: total > 0 || seizeArmed || burnArmed,
    status: total > 0 ? "enforced" : seizeArmed || burnArmed ? "armed" : "none",
    currently_armed: seizeArmed || burnArmed,
    methods_armed: [seizeArmed ? "seize" : null, burnArmed ? "burnBlocked" : null].filter(Boolean),
    total_seizures: total,
  };
}

function labelRole(hash) {
  const key = String(hash || "").toLowerCase();
  return ROLE_LABELS.get(key) || (key ? `${key.slice(0, 10)}...` : "?");
}

function parseArgs(row) {
  return JSON.parse(row.args || "{}");
}

function formatWholeUnits(raw, decimals) {
  try {
    return ethers.formatUnits(raw || "0", Number(decimals || 0));
  } catch {
    return String(raw || "0");
  }
}

function mountHistory(app, db) {
  app.use("/api/token", (_, res, next) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Cache-Control", "public, max-age=10, stale-while-revalidate=20");
    next();
  });

  const tokenRow = db.prepare("SELECT * FROM tokens WHERE address=? COLLATE NOCASE");

  function requireToken(req, res) {
    const token = tokenRow.get(req.params.address);
    if (!token) {
      res.status(404).json({ error: "token not found" });
      return null;
    }
    return token;
  }

  function pageParams(req) {
    const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 200);
    const fromBlock = req.query.from_block ? Number(req.query.from_block) : null;
    const toBlock = req.query.to_block ? Number(req.query.to_block) : null;
    let curBlock = null;
    let curLog = null;
    if (req.query.cursor) {
      const [block, logIndex] = String(req.query.cursor).split(":").map(Number);
      if (Number.isFinite(block) && Number.isFinite(logIndex)) {
        curBlock = block;
        curLog = logIndex;
      }
    }
    return { limit, fromBlock, toBlock, curBlock, curLog };
  }

  function eventQuery(token, kinds, pp, extra = "") {
    const registryKinds = ["PolicyCreated", "CompositePolicyUpdated"];
    const includeRegistry = !kinds || kinds.some((kind) => registryKinds.includes(kind));
    // Shared policies are emitted at the singleton. Associate their history
    // with tokens that referenced the ID, without fabricating per-token logs.
    const source = includeRegistry ? `(
      SELECT kind,block,tx,log_index,ts,args FROM events INDEXED BY idx_events_token WHERE token=?
      UNION ALL
      SELECT kind,block,tx,log_index,ts,args FROM policy_events WHERE policy_id IN (
        SELECT CAST(json_extract(args,'$.newPolicyId') AS TEXT) FROM events INDEXED BY idx_events_token
        WHERE token=? AND kind='PolicyUpdated'
      )
    )` : "events INDEXED BY idx_events_token";
    const cond = includeRegistry ? [] : ["token=?"];
    const params = includeRegistry ? [token, token] : [token];
    if (kinds?.length) {
      cond.push(`kind IN (${kinds.map(() => "?").join(",")})`);
      params.push(...kinds);
    }
    if (pp.fromBlock != null) {
      cond.push("block >= ?");
      params.push(pp.fromBlock);
    }
    if (pp.toBlock != null) {
      cond.push("block <= ?");
      params.push(pp.toBlock);
    }
    if (pp.curBlock != null) {
      cond.push("(block < ? OR (block = ? AND log_index < ?))");
      params.push(pp.curBlock, pp.curBlock, pp.curLog);
    }
    if (extra) cond.push(extra);
    return {
      sql: `SELECT kind, block, tx, log_index, ts, args FROM ${source}
        ${cond.length ? "WHERE " + cond.join(" AND ") : ""}
        ORDER BY block DESC, log_index DESC LIMIT ?`,
      params: [...params, pp.limit + 1],
    };
  }

  function runPaged(query, mapRow) {
    const rows = db.prepare(query.sql).all(...query.params);
    const limit = query.params[query.params.length - 1] - 1;
    let nextCursor = null;
    if (rows.length > limit) {
      const last = rows[limit - 1];
      nextCursor = `${last.block}:${last.log_index}`;
      rows.length = limit;
    }
    return { items: rows.map(mapRow), nextCursor };
  }

  app.get("/api/token/:address/history", (req, res) => {
    const token = requireToken(req, res);
    if (!token) return;
    const category = req.query.category || null;
    const kinds = category ? CATEGORY[category] : null;
    if (category && !kinds) {
      return res.status(400).json({ error: "unknown category", categories: Object.keys(CATEGORY) });
    }
    const { items, nextCursor } = runPaged(eventQuery(token.address, kinds, pageParams(req)), (row) => ({
      kind: row.kind,
      block: row.block,
      tx: row.tx,
      log_index: row.log_index,
      ts: row.ts,
      args: parseArgs(row),
    }));
    res.json({ token: token.address, symbol: token.symbol, category: category || "all", count: items.length, nextCursor, items });
  });

  app.get("/api/token/:address/seizures", (req, res) => {
    const token = requireToken(req, res);
    if (!token) return;
    const capability = seizureCapability(db, token.address);
    const { items, nextCursor } = runPaged(eventQuery(token.address, CATEGORY.seizure, pageParams(req)), (row) => {
      const args = parseArgs(row);
      return {
        method: row.kind === "Seized" ? "seize" : "burnBlocked",
        block: row.block,
        tx: row.tx,
        log_index: row.log_index,
        ts: row.ts,
        caller: args.caller,
        from: args.from,
        to: row.kind === "Seized" ? args.to : null,
        amount: String(args.amount || "0"),
        amount_display: formatWholeUnits(args.amount, token.decimals),
      };
    });
    res.json({ token: token.address, symbol: token.symbol, ...capability, count: items.length, nextCursor, items });
  });

  app.get("/api/token/:address/roles/history", (req, res) => {
    const token = requireToken(req, res);
    if (!token) return;
    const { items, nextCursor } = runPaged(eventQuery(token.address, ["RoleGranted", "RoleRevoked"], pageParams(req)), (row) => {
      const args = parseArgs(row);
      return {
        block: row.block,
        tx: row.tx,
        log_index: row.log_index,
        ts: row.ts,
        action: row.kind === "RoleGranted" ? "grant" : "revoke",
        role: labelRole(args.role),
        role_hash: args.role,
        account: args.account,
        sender: args.sender,
      };
    });
    res.json({ token: token.address, symbol: token.symbol, count: items.length, nextCursor, items });
  });

  app.get("/api/token/:address/roles", (req, res) => {
    const token = requireToken(req, res);
    if (!token) return;
    const rows = db.prepare(
      "SELECT kind,args FROM events INDEXED BY idx_events_token WHERE token=? AND kind IN ('RoleGranted','RoleRevoked') ORDER BY block ASC, log_index ASC"
    ).all(token.address);
    const held = {};
    for (const row of rows) {
      const args = parseArgs(row);
      const label = labelRole(args.role);
      held[label] ||= new Set();
      const account = String(args.account).toLowerCase();
      if (row.kind === "RoleGranted") held[label].add(account);
      else held[label].delete(account);
    }
    const roles = Object.fromEntries(
      Object.entries(held)
        .map(([label, accounts]) => [label, [...accounts].filter(Boolean)])
        .filter(([, accounts]) => accounts.length)
    );
    res.json({ token: token.address, symbol: token.symbol, roles });
  });

  app.get("/api/token/:address/policy", (req, res) => {
    const token = requireToken(req, res);
    if (!token) return;
    const snapshot = policySnapshot(db, token.address);
    const { items: registryHistory, nextCursor } = runPaged(
      eventQuery(token.address, ["PolicyCreated", "CompositePolicyUpdated"], pageParams(req)),
      (row) => ({ ...row, args: parseArgs(row) })
    );
    res.json({ token: token.address, symbol: token.symbol, ...snapshot, registry_history: registryHistory, nextCursor });
  });

  app.get("/api/token/:address/supply/history", (req, res) => {
    const token = requireToken(req, res);
    if (!token) return;
    const pp = pageParams(req);
    const caps = db.prepare(
      "SELECT block,tx,log_index,ts,args FROM events INDEXED BY idx_events_token WHERE token=? AND kind='SupplyCapUpdated' ORDER BY block DESC, log_index DESC LIMIT ?"
    ).all(token.address, pp.limit).map((row) => {
      const args = parseArgs(row);
      return {
        type: "cap",
        block: row.block,
        tx: row.tx,
        log_index: row.log_index,
        ts: row.ts,
        new_cap: String(args.newSupplyCap || "0"),
        new_cap_display: formatWholeUnits(args.newSupplyCap, token.decimals),
      };
    });
    const flow = db.prepare(
      `SELECT block,tx,log_index,ts,args FROM events INDEXED BY idx_events_token WHERE token=? AND kind='Transfer'
       AND (json_extract(args,'$.from')=? OR json_extract(args,'$.to')=?)
       ORDER BY block DESC, log_index DESC LIMIT ?`
    ).all(token.address, ZERO, ZERO, pp.limit).map((row) => {
      const args = parseArgs(row);
      const isMint = String(args.from).toLowerCase() === ZERO;
      return {
        type: isMint ? "mint" : "burn",
        block: row.block,
        tx: row.tx,
        log_index: row.log_index,
        ts: row.ts,
        amount: String(args.amount || "0"),
        amount_display: formatWholeUnits(args.amount, token.decimals),
        counterparty: isMint ? args.to : args.from,
      };
    });
    const items = [...caps, ...flow]
      .sort((a, b) => (b.block - a.block) || ((b.log_index || 0) - (a.log_index || 0)))
      .slice(0, pp.limit);
    res.json({ token: token.address, symbol: token.symbol, count: items.length, items });
  });
}

module.exports = { mountHistory, CATEGORY, seizureCapability };
