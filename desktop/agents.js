// The AIs CoDev can open in a terminal, and how each one is started.
//
// DeepSeek and local models run inside Claude Code (the same harness, so the same hooks, file locking,
// team context and replies): both speak Anthropic's API, so Claude Code only needs another endpoint.
// ChatGPT runs in OpenAI's Codex CLI, which has Claude-compatible hooks, MCP servers and instructions.

export const AGENTS = {
  claude: {
    id: 'claude',
    label: 'Claude',
    by: 'Anthropic',
    command: 'claude',
    install: 'npm i -g @anthropic-ai/claude-code',
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    by: 'DeepSeek API, in Claude Code',
    command: 'claude',
    install: 'npm i -g @anthropic-ai/claude-code',
    needsKey: true,
    keyUrl: 'https://platform.deepseek.com/api_keys',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    defaultModel: 'deepseek-chat',
  },
  local: {
    id: 'local',
    label: 'Local',
    by: 'Ollama, in Claude Code',
    command: 'claude',
    install: 'npm i -g @anthropic-ai/claude-code',
    ollama: true,
  },
  chatgpt: {
    id: 'chatgpt',
    label: 'ChatGPT',
    by: 'OpenAI Codex CLI',
    command: 'codex',
    install: 'npm i -g @openai/codex',
    login: 'codex login',
    experimental: true,
  },
};

/** The order of the picker: Claude first, then the other three. */
export const AGENT_IDS = ['claude', 'deepseek', 'local', 'chatgpt'];

/** The name shown in headers, chat and the picker. Anything unknown is Claude. */
export const agentLabel = (id) => (AGENTS[id] || AGENTS.claude).label;

export const OLLAMA_URL = 'http://localhost:11434';

const toml = (v) => JSON.stringify(v); // a JSON string is a valid TOML basic string

/**
 * What to run for an agent.
 *   codev:  the CODEV_* variables of this terminal (server, room, name, root, key)
 *   runner: how to run the CoDev CLI ({ exe, cli, env }) for the MCP server
 *   rules:  CoDev's instructions for the AI
 * Returns { command, args, env, unset } where `unset` lists inherited variables to drop.
 */
export function spawnSpec(agentId, { model, key, codev = {}, runner, rules = '' } = {}) {
  const agent = AGENTS[agentId] || AGENTS.claude;
  // Claude Code with another endpoint: an inherited ANTHROPIC_API_KEY would take over, so drop it.
  const unset = ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL'];
  switch (agent.id) {
    case 'deepseek': {
      if (!key) throw new Error('DeepSeek needs an API key.');
      const m = agent.models.includes(model) ? model : agent.defaultModel;
      return {
        command: 'claude',
        // Claude Code's tool search sends "tool_definition" blocks that DeepSeek's Anthropic endpoint
        // rejects (Claude Code >= 2.1.286): without this, DeepSeek answers but never gets to use tools.
        // "auto" lets it work agentically (edits and safe commands) with Claude Code's own safeguards.
        args: ['--permission-mode', 'auto'],
        unset,
        env: {
          ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
          ANTHROPIC_AUTH_TOKEN: key,
          ANTHROPIC_MODEL: m,
          ANTHROPIC_SMALL_FAST_MODEL: 'deepseek-chat',
          API_TIMEOUT_MS: '600000',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          ENABLE_TOOL_SEARCH: 'false',
          // Claude Code assumes 1M tokens for a model it does not know; DeepSeek's window is 128K.
          // Telling it the real window makes it compact in time instead of failing with "prompt is too long".
          CLAUDE_CODE_MAX_CONTEXT_TOKENS: '128000',
          CLAUDE_CODE_AUTO_COMPACT_WINDOW: '120000',
          CLAUDE_CODE_DISABLE_1M_CONTEXT: '1',
        },
      };
    }
    case 'local': {
      if (!model) throw new Error('Choose a local model.');
      return {
        command: 'claude',
        args: [],
        unset,
        env: {
          ANTHROPIC_BASE_URL: OLLAMA_URL,
          ANTHROPIC_AUTH_TOKEN: 'ollama',
          ANTHROPIC_MODEL: model,
          ANTHROPIC_SMALL_FAST_MODEL: model,
          API_TIMEOUT_MS: '3000000', // local models on a CPU can take minutes per answer
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          // Ollama's Anthropic endpoint does not implement tool search either.
          ENABLE_TOOL_SEARCH: 'false',
          // Most local models have a small context; Claude Code would otherwise assume 1M.
          CLAUDE_CODE_MAX_CONTEXT_TOKENS: '32768',
          CLAUDE_CODE_AUTO_COMPACT_WINDOW: '28000',
          CLAUDE_CODE_DISABLE_1M_CONTEXT: '1',
        },
      };
    }
    case 'chatgpt': {
      // The CoDev MCP server and CoDev's rules, passed at launch: the user's Codex config is not touched.
      const mcpEnv = { ...(runner?.env || {}), ...codev };
      const args = [
        '-c', `mcp_servers.codev.command=${toml(runner?.exe || 'node')}`,
        '-c', `mcp_servers.codev.args=[${[runner?.cli, 'mcp'].filter(Boolean).map(toml).join(', ')}]`,
        '-c', `mcp_servers.codev.env={ ${Object.entries(mcpEnv).map(([k, v]) => `${k} = ${toml(String(v))}`).join(', ')} }`,
      ];
      if (rules) args.push('-c', `developer_instructions=${toml(rules)}`);
      if (model) args.push('-m', model);
      return { command: 'codex', args, env: {}, unset: [] };
    }
    default:
      return { command: 'claude', args: [], env: {}, unset: [] };
  }
}

/** Models installed in the local Ollama, or null if Ollama is not running. */
export async function ollamaModels() {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(1500) });
    const { models = [] } = await res.json();
    return models.map((m) => ({ name: m.name, size: m.size, params: m.details?.parameter_size || '' }));
  } catch {
    return null;
  }
}
