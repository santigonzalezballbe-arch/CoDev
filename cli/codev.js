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
  codev note [--to <name>] <text>                  Send a message to a teammate's AI (or every AI)
  codev chat [--limit 40]                          Read the AIs' chat
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
  case 'publish-log': {
    // (internal) started in the background by the hook: commits and pushes the person's CoDev log.
    const { publishLog } = await import('./gitsync.js');
    const argv = process.argv.slice(3);
    const files = argv.flatMap((a, i) => (a === '--file' && argv[i + 1] ? [argv[i + 1]] : []));
    if (typeof args.root === 'string' && files.length) await publishLog(args.root, files, String(args.message || 'codev: update log'));
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
  // The same as the MCP tools codev_send_note and codev_read_chat, for an AI whose MCP tools are not
  // loaded: any AI with a shell can still talk to the room.
  case 'note':
  case 'chat': {
    const cfg = findConfig();
    if (!cfg) {
      console.error('No .codev.json found. Run `codev init`.');
      process.exit(1);
    }
    const { callTool } = await import('./mcp.js');
    try {
      if (cmd === 'note') {
        const text = (typeof args.text === 'string' ? args.text : args._.slice(1).join(' ')).trim();
        if (!text) {
          console.error('Usage: codev note [--to <name>] <text>');
          process.exit(1);
        }
        console.log(await callTool(cfg, 'codev_send_note', { text, to: typeof args.to === 'string' ? args.to : null }));
      } else {
        console.log(await callTool(cfg, 'codev_read_chat', { limit: Number(args.limit) || 40 }));
      }
    } catch (err) {
      console.error(`Could not reach the CoDev room: ${err.message}`);
      process.exit(1);
    }
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
