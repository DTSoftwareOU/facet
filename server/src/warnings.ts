// node:sqlite is stable enough for our use but still flagged experimental in Node 22.
// Silence only that warning; everything else is passed through.
const originalEmit = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const message = typeof warning === 'string' ? warning : warning?.message;
  const type = typeof rest[0] === 'string' ? rest[0] : (rest[0] as { type?: string } | undefined)?.type;
  const name = typeof warning === 'string' ? type : warning?.name;
  if (name === 'ExperimentalWarning' && typeof message === 'string' && message.includes('SQLite')) return;
  return (originalEmit as (...args: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;
