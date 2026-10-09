// Fresh deployments do not imply that balances and policy history caught up.
function healthLag(chainHead, cursors) {
  const lags = Object.fromEntries([
    ['factory', 'factoryCursor'], ['event', 'eventCursor'], ['live', 'liveCursor'],
    ['registry', 'registryCursor'], ['seize', 'seizeCursor'],
  ].map(([name, key]) => [name + 'LagBlocks', Math.max(0, chainHead - Number(cursors[key] || 0))]));
  const lagBlocks = Math.max(...Object.values(lags));
  return { status: lagBlocks <= 60 ? 'synced' : lagBlocks <= 600 ? 'catching_up' : 'lagging', lagBlocks, ...lags };
}
module.exports = { healthLag };
