#!/usr/bin/env node
// mcp-server.js - exposes B20SCAN history REST endpoints as MCP tools.
//
// Usage:
//   B20SCAN_API=https://b20scan.live node mcp-server.js
//
// The server speaks MCP over stdio using JSON-RPC 2.0. It intentionally avoids
// an SDK dependency because the needed surface is small: initialize, tools/list,
// and tools/call.

const http = require("http");
const https = require("https");
const { URL } = require("url");

const API_BASE = (process.env.B20SCAN_API || "http://localhost:3020").replace(/\/+$/, "");

function apiGet(path) {
  return new Promise((resolve, reject) => {
    const url = new URL(API_BASE + path);
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.get(url, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, json: JSON.parse(body) });
        } catch {
          resolve({
            status: res.statusCode,
            json: { error: "non-json response", status: res.statusCode, raw: body.slice(0, 500) },
          });
        }
      });
    });
    req.setTimeout(15_000, () => req.destroy(new Error("B20SCAN API timeout")));
    req.on("error", reject);
  });
}

function qs(values) {
  const params = Object.entries(values)
    .filter(([, value]) => value != null && value !== "")
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`);
  return params.length ? `?${params.join("&")}` : "";
}

function isAddress(value) {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

const TOOLS = [
  {
    name: "b20_token_overview",
    description: "Get the current profile of a B20 token: variant, name, symbol, decimals, supply, cap, issuer roles, pause state, policy state, disclosures, and recent events. Use for a current token snapshot.",
    schema: {
      type: "object",
      properties: { address: { type: "string", description: "B20 token address" } },
      required: ["address"],
    },
    run: async ({ address }) => (await apiGet(`/api/tokens/${address}`)).json,
  },
  {
    name: "b20_seizure_history",
    description: "Get freeze-and-seize history for a B20 token: capability status none/armed/enforced, seizure count, victim addresses, amounts, and timestamps. Use for issuer/custody risk analysis; direct precompile readers cannot answer historical 'has it ever seized funds?'.",
    schema: {
      type: "object",
      properties: {
        address: { type: "string" },
        limit: { type: "number", description: "Max records, default 50, max 200" },
        cursor: { type: "string", description: "Pagination cursor from nextCursor" },
      },
      required: ["address"],
    },
    run: async ({ address, limit, cursor }) =>
      (await apiGet(`/api/token/${address}/seizures${qs({ limit, cursor })}`)).json,
  },
  {
    name: "b20_policy_timeline",
    description: "Get transfer-policy history for a B20 token: whether a policy is currently bound and every policy attach/change over time. Use to determine whether and when a token became permissioned.",
    schema: {
      type: "object",
      properties: { address: { type: "string" } },
      required: ["address"],
    },
    run: async ({ address }) => (await apiGet(`/api/token/${address}/policy`)).json,
  },
  {
    name: "b20_roles_history",
    description: "Get full grant/revoke timeline of issuer roles for a B20 token. Use to see how token control changed over time: who received or lost MINT, BURN, BURN BLOCKED, PAUSE, META, OPERATOR, or ADMIN powers.",
    schema: {
      type: "object",
      properties: {
        address: { type: "string" },
        limit: { type: "number" },
        cursor: { type: "string" },
      },
      required: ["address"],
    },
    run: async ({ address, limit, cursor }) =>
      (await apiGet(`/api/token/${address}/roles/history${qs({ limit, cursor })}`)).json,
  },
  {
    name: "b20_current_roles",
    description: "Get the current issuer-role snapshot for a B20 token, folded from full grant/revoke history. Use to see who holds power now and whether admin has been renounced.",
    schema: {
      type: "object",
      properties: { address: { type: "string" } },
      required: ["address"],
    },
    run: async ({ address }) => (await apiGet(`/api/token/${address}/roles`)).json,
  },
  {
    name: "b20_supply_history",
    description: "Get supply history for a B20 token: supply-cap changes plus mint/burn flow from zero-address transfers. Use to inspect dilution and supply ceiling changes.",
    schema: {
      type: "object",
      properties: {
        address: { type: "string" },
        limit: { type: "number" },
      },
      required: ["address"],
    },
    run: async ({ address, limit }) =>
      (await apiGet(`/api/token/${address}/supply/history${qs({ limit })}`)).json,
  },
  {
    name: "b20_history",
    description: "Get raw B20 token event history filtered by category: admin, seizure, policy, roles, supply, transfers, memos, or disclosures. Supports block ranges and cursor pagination. Use when specialized tools do not fit.",
    schema: {
      type: "object",
      properties: {
        address: { type: "string" },
        category: {
          type: "string",
          enum: ["admin", "seizure", "policy", "roles", "supply", "transfers", "memos", "disclosures"],
        },
        from_block: { type: "number" },
        to_block: { type: "number" },
        limit: { type: "number" },
        cursor: { type: "string" },
      },
      required: ["address"],
    },
    run: async ({ address, category, from_block, to_block, limit, cursor }) =>
      (await apiGet(`/api/token/${address}/history${qs({ category, from_block, to_block, limit, cursor })}`)).json,
  },
];

const TOOL_BY_NAME = Object.fromEntries(TOOLS.map((tool) => [tool.name, tool]));

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function fail(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handle(message) {
  const { id, method, params } = message;
  if (method === "initialize") {
    return reply(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "b20scan", version: "1.0.0" },
    });
  }
  if (method === "notifications/initialized") return;
  if (method === "tools/list") {
    return reply(id, {
      tools: TOOLS.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.schema,
      })),
    });
  }
  if (method === "tools/call") {
    const tool = TOOL_BY_NAME[params?.name];
    if (!tool) return fail(id, -32602, `unknown tool: ${params?.name}`);
    const args = params.arguments || {};
    if (tool.schema.required?.includes("address") && !isAddress(args.address)) {
      return reply(id, {
        content: [{ type: "text", text: JSON.stringify({ error: "address must be a 0x-prefixed 40-hex address" }) }],
        isError: true,
      });
    }
    try {
      const data = await tool.run(args);
      return reply(id, { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
    } catch (error) {
      return reply(id, {
        content: [{ type: "text", text: JSON.stringify({ error: error.message }) }],
        isError: true,
      });
    }
  }
  if (id != null) return fail(id, -32601, `method not found: ${method}`);
}

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    handle(message).catch((error) => {
      if (message?.id != null) fail(message.id, -32603, error.message);
    });
  }
});

process.stderr.write(`b20scan MCP server ready (API: ${API_BASE})\n`);

module.exports = { TOOLS, handle };
