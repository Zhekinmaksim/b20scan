// chain.js - B20 constants, ABIs, and decoders for the indexer.
const { ethers } = require("ethers");

const FACTORY = "0xB20f000000000000000000000000000000000000";
const POLICY_REGISTRY = "0x8453000000000000000000000000000000000002";

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
  "event Seized(address indexed caller, address indexed from, address indexed to, uint256 amount)",
  "event Announcement(address indexed caller, string id, string description, string uri)",
  "event EndAnnouncement(string id)",
  "event ExtraMetadataUpdated(string key, string value)",
  "function totalSupply() view returns (uint256)",
  "function supplyCap() view returns (uint256)",
]);
const TOKEN_TOPICS = [
  "Transfer", "Memo", "SupplyCapUpdated", "Paused", "Unpaused",
  "PolicyUpdated", "RoleGranted", "RoleRevoked", "BurnedBlocked", "Seized",
  "Announcement", "EndAnnouncement", "ExtraMetadataUpdated",
].map((n) => tokenIface.getEvent(n).topicHash);

const registryIface = new ethers.Interface([
  "event PolicyCreated(uint64 indexed policyId, address indexed creator, uint8 policyType)",
  "event CompositePolicyUpdated(uint64 indexed policyId, address indexed updater, uint64[] childPolicyIds)",
]);
const REGISTRY_TOPICS = ["PolicyCreated", "CompositePolicyUpdated"]
  .map((name) => registryIface.getEvent(name).topicHash);

const POLICY_SCOPES = Object.fromEntries([
  "TRANSFER_SENDER_POLICY", "TRANSFER_RECEIVER_POLICY", "TRANSFER_EXECUTOR_POLICY",
  "MINT_RECEIVER_POLICY", "SEIZE_EXEMPT_POLICY", "SEIZE_RECEIVER_POLICY",
].map((name) => [ethers.id(name).toLowerCase(), name]));
const PAUSE_FEATURES = ["TRANSFER", "MINT", "BURN", "SEIZE"];

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

function decodeLog(iface, log) {
  try {
    const d = iface.parseLog(log);
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

const decodeTokenLog = (log) => decodeLog(tokenIface, log);
const decodeRegistryLog = (log) => decodeLog(registryIface, log);

module.exports = {
  FACTORY, POLICY_REGISTRY, TOPIC_CREATED, TOKEN_TOPICS, REGISTRY_TOPICS,
  POLICY_SCOPES, PAUSE_FEATURES, factoryIface, tokenIface, registryIface,
  decodeCreated, decodeTokenLog, decodeRegistryLog,
};
