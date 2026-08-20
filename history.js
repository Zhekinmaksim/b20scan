// history.js - read-only time-series API over the indexed B20 event log.
//
// This layer exposes what direct precompile readers cannot: historical issuer
// actions, seizure records, policy changes, role changes, disclosures, and
// supply flow.

const { ethers } = require("ethers");

const CATEGORY = {
  admin: [
    "RoleGranted",
    "RoleRevoked",
    "SupplyCapUpdated",
    "Paused",
    "Unpaused",
    "PolicyUpdated",
    "Announcement",
    "EndAnnouncement",
    "ExtraMetadataUpdated",
  ],
  seizure: ["BurnedBlocked"],
  policy: ["PolicyUpdated"],
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
  [ethers.id("PAUSE_ROLE"), "PAUSE"],
  [ethers.id("PAUSER_ROLE"), "PAUSE"],
  [ethers.id("UNPAUSE_ROLE"), "UNPAUSE"],
  [ethers.id("METADATA_ROLE"), "META"],
  [ethers.id("META_ROLE"), "META"],
  [ethers.id("OPERATOR_ROLE"), "OPERATOR"],
].map(([hash, label]) => [String(hash).toLowerCase(), label]));

const ZERO = "0x0000000000000000000000000000000000000000";
const BURN_BLOCKED_ROLE = ethers.id("BURN_BLOCKED_ROLE").toLowerCase();

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
  const burnBlockedRoleParam = BURN_BLOCKED_ROLE;

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
    const cond = ["token=? COLLATE NOCASE"];
    const params = [token];
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
      sql: `SELECT kind, block, tx, log_index, ts, args FROM events
        WHERE ${cond.join(" AND ")}
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

  const seizureCapableStmt = db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM events WHERE token=? COLLATE NOCASE AND kind='BurnedBlocked') AS seizures,
       (SELECT COUNT(*) FROM events WHERE token=? COLLATE NOCASE AND kind='RoleGranted'
          AND lower(json_extract(args,'$.role'))=?) AS burn_blocked_grants,
       (SELECT COUNT(*) FROM events WHERE token=? COLLATE NOCASE AND kind='PolicyUpdated'
          AND json_extract(args,'$.newPolicyId') != '0') AS policy_binds`
  );

  function seizureCapability(address) {
    const row = seizureCapableStmt.get(address, address, burnBlockedRoleParam, address);
    const hasSeized = Number(row.seizures || 0) > 0;
    const armed = Number(row.burn_blocked_grants || 0) > 0 && Number(row.policy_binds || 0) > 0;
    return {
      seizure_capable: hasSeized || armed,
      status: hasSeized ? "enforced" : armed ? "armed" : "none",
      total_seizures: Number(row.seizures || 0),
    };
  }

  app.get("/api/token/:address/seizures", (req, res) => {
    const token = requireToken(req, res);
    if (!token) return;
    const capability = seizureCapability(token.address);
    const { items, nextCursor } = runPaged(eventQuery(token.address, ["BurnedBlocked"], pageParams(req)), (row) => {
      const args = parseArgs(row);
      return {
        block: row.block,
        tx: row.tx,
        log_index: row.log_index,
        ts: row.ts,
        caller: args.caller,
        from: args.from,
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
      "SELECT kind,args FROM events WHERE token=? COLLATE NOCASE AND kind IN ('RoleGranted','RoleRevoked') ORDER BY block ASC, log_index ASC"
    ).all(token.address);
    const held = {};
    for (const row of rows) {
      const args = parseArgs(row);
      const label = labelRole(args.role);
      held[label] ||= new Set();
      if (row.kind === "RoleGranted") held[label].add(args.account);
      else held[label].delete(args.account);
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
    const rows = db.prepare(
      "SELECT block,tx,log_index,ts,args FROM events WHERE token=? COLLATE NOCASE AND kind='PolicyUpdated' ORDER BY block ASC, log_index ASC"
    ).all(token.address);
    const history = rows.map((row) => {
      const args = parseArgs(row);
      return {
        block: row.block,
        tx: row.tx,
        log_index: row.log_index,
        ts: row.ts,
        scope: args.policyScope,
        old_policy_id: args.oldPolicyId,
        new_policy_id: args.newPolicyId,
        bound: String(args.newPolicyId) !== "0",
      };
    });
    const current = history.length ? history[history.length - 1] : null;
    res.json({ token: token.address, symbol: token.symbol, has_policy: !!current?.bound, current, history });
  });

  app.get("/api/token/:address/supply/history", (req, res) => {
    const token = requireToken(req, res);
    if (!token) return;
    const pp = pageParams(req);
    const caps = db.prepare(
      "SELECT block,tx,log_index,ts,args FROM events WHERE token=? COLLATE NOCASE AND kind='SupplyCapUpdated' ORDER BY block DESC, log_index DESC LIMIT ?"
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
      `SELECT block,tx,log_index,ts,args FROM events WHERE token=? COLLATE NOCASE AND kind='Transfer'
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

module.exports = { mountHistory, CATEGORY };
