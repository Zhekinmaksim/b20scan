// chain.js - B20 constants, ABIs, and decoders for the indexer.
const { ethers } = require("ethers");

const FACTORY = "0xB20f000000000000000000000000000000000000";

const factoryIface = new ethers.Interface([
  "event B20Created(address indexed token, uint8 indexed variant, string name, string symbol, uint8 decimals, bytes variantEventParams)",
]);
const TOPIC_CREATED = factoryIface.getEvent("B20Created").topicHash;

const tokenIface = new ethers.Interface([
  "event Transfer(address indexed from, address indexed to, uint256 amount)",
  "event Memo(address indexed caller, bytes32 indexed memo)",
  "event SupplyCapUpdated(address indexed updater, uint256 oldSupplyCap, uint256 newSupplyCap)",
  "event Paused(address indexed updater, uint8[] features)",
  "event Unpaused(address indexed updater, uint8[] features)",
  "event PolicyUpdated(bytes32 indexed policyScope, uint64 oldPolicyId, uint64 newPolicyId)",
  "event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)",
  "event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender)",
  "event BurnedBlocked(address indexed caller, address indexed from, uint256 amount)",
  "function totalSupply() view returns (uint256)",
  "function supplyCap() view returns (uint256)",
]);
const TOKEN_TOPICS = [
  "Transfer", "Memo", "SupplyCapUpdated", "Paused", "Unpaused",
  "PolicyUpdated", "RoleGranted", "RoleRevoked", "BurnedBlocked",
].map((n) => tokenIface.getEvent(n).topicHash);

// Decodes B20Created; for the STABLECOIN variant also decodes the currency code
// out of variantEventParams (abi-encoded B20StablecoinEventParams{version,currency}).
function decodeCreated(log) {
  const d = factoryIface.parseLog(log);
  let currency = null;
  if (Number(d.args.variant) === 1 && d.args.variantEventParams !== "0x") {
    try {
      const [decoded] = ethers.AbiCoder.defaultAbiCoder().decode(
        ["tuple(uint8 version, string currency)"],
        d.args.variantEventParams
      );
      currency = decoded.currency;
    } catch { /* leave null if params shape differs */ }
  }
  return {
    token: d.args.token,
    variant: Number(d.args.variant),
    name: d.args.name,
    symbol: d.args.symbol,
    decimals: Number(d.args.decimals),
    currency,
  };
}

function decodeTokenLog(log) {
  try {
    const d = tokenIface.parseLog(log);
    const args = {};
    d.fragment.inputs.forEach((inp, i) => {
      const v = d.args[i];
      args[inp.name] = typeof v === "bigint" ? v.toString() : Array.isArray(v) ? v.map(String) : String(v);
    });
    return { kind: d.name, args };
  } catch {
    return null;
  }
}

module.exports = { FACTORY, TOPIC_CREATED, TOKEN_TOPICS, factoryIface, tokenIface, decodeCreated, decodeTokenLog };
