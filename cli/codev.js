#!/usr/bin/env node
// CoDev CLI entry point.
import { findConfig, api, teamSummary } from './config.js';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      args[k] = v ?? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true);
    } else args._.push(a);
  }
  return args;
}

const HELP = `CoDev — code as a team with AI without stepping on each other

Commands:
  codev server [--port 4321] [--key <key>]         Start the server and the web view
  codev init --room <room> --name <name> [--server URL] [--key <key>]
                                                   Connect this project to a room (hooks + MCP)
  codev status                                     Show what your teammates are doing
  codev watch                                      Publish disk changes (for AIs without hooks)
  codev hook                                       (internal) run by the Claude Code hooks
  codev mcp                                        (internal) MCP server over stdio
`;

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];

switch (cmd) {
  case 'server': {
    const { startServer } = await import('../server/server.js');
    const port = Number(args.port || process.env.PORT || 4321);
    const key = typeof args.key === 'string' ? args.key : null;
    await startServer({ port, host: args.host || '0.0.0.0', key });
    console.log(`CoDev running at http://localhost:${port}${key ? ' (key required)' : ''}`);
    break;
  }
  case 'init': {
    const { runInit } = await import('./init.js');
    await runInit(args);
    break;
  }
  case 'hook': {
    const { runHook } = await import('./hook.js');
    await runHook();
    break;
  }
  case 'mcp': {
    const { runMcp } = await import('./mcp.js');
    runMcp();
    break;
  }
  case 'watch': {
    const { runWatch } = await import('./watch.js');
    runWatch();
    break;
  }
  case 'status': {
    const cfg = findConfig();
    if (!cfg) {
      console.error('No .codev.json found. Run `codev init`.');
      process.exit(1);
    }
    const state = await api(cfg, 'state');
    console.log(teamSummary(cfg, state, { maxEvents: 10 }) || 'There are no teammates in the room.');
    break;
  }
  default:
    console.log(HELP);
}
