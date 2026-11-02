'use strict';
// Process entry point: validate configuration, then listen. Refuses to start in
// a state where every request would fail, or where a paid API key would be
// exposed beyond localhost without a token.

const { readConfig, describeStartupProblems, describeKeyState } = require('./src/config');
const { createApp } = require('./src/app');

function start(env = process.env) {
  const config = readConfig(env);

  const problems = describeStartupProblems(config);
  if (problems.length) {
    console.error('Cannot start Explain It Simply server:');
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error('Copy .env.example to .env and fill in the values.');
    process.exitCode = 1;
    return null;
  }

  const server = createApp(config).listen(config.port, config.host);

  server.on('error', (error) => {
    console.error(`Server failed to start: ${error.message}`);
    process.exitCode = 1;
  });

  server.on('listening', () => {
    const { port, address } = server.address();
    console.log(`Explain It Simply server on http://${address === '::' ? 'localhost' : address}:${port}`);
    console.log(`  provider ${config.providerId} · model ${config.model} · key ${describeKeyState(config)}`);
    if (config.modelNotice) console.log(`  note: ${config.modelNotice}`);
    console.log(`  rate limit ${config.rateLimit.requests}+${config.rateLimit.burst}/${Math.round(config.rateLimit.windowMs / 1000)}s per address`);
    if (config.allowedOrigins.length) console.log(`  cors allowed: ${config.allowedOrigins.join(', ')}`);
    if (config.accessToken) console.log('  access token required for /api');
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 3000).unref();
    });
  }

  return server;
}

if (require.main === module) {
  try {
    start();
  } catch (error) {
    console.error(`Configuration error: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { start };
