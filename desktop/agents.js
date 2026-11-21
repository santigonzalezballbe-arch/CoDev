// The AIs CoDev can open in a terminal, and how each one is started.
//
// Claude runs Claude Code. DeepSeek and local models run the DeepSeek Harness over ACP, so they need
// no Claude Code; ChatGPT runs OpenAI's Codex CLI. Each engine is started by the main process.

export const AGENTS = {
  claude: {
    id: 'claude',
    label: 'Claude',
    by: 'Anthropic',
    engine: 'claude',
    command: 'claude',
    install: 'npm i -g @anthropic-ai/claude-code',
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    by: 'DeepSeek Harness',
    engine: 'harness',
    command: 'dsh',
    install: 'npm i -g @deepseek-ai/dsh',
    needsKey: true,
    keyUrl: 'https://platform.deepseek.com/api_keys',
    models: ['deepseek-flash', 'deepseek-v4-pro'],
    defaultModel: 'deepseek-flash',
  },
  local: {
    id: 'local',
    label: 'Local',
    by: 'DeepSeek Harness + Ollama',
    engine: 'harness',
    command: 'dsh',
    install: 'npm i -g @deepseek-ai/dsh',
    ollama: true,
  },
  chatgpt: {
    id: 'chatgpt',
    label: 'ChatGPT',
    by: 'OpenAI Codex CLI',
    engine: 'codex',
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
  if (agent.engine === 'harness') throw new Error(`${agent.label} runs in the DeepSeek Harness.`);
  // Claude Code with another endpoint: an inherited ANTHROPIC_API_KEY would take over, so drop it.
  const unset = ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL'];
  switch (agent.id) {
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

/**
 * The DSH profile overlay for a Harness AI: which model answers, which CoDev rules it receives, and
 * (for Local) the Ollama route. The API key never goes in this file: it travels in the environment.
 */
export function harnessPatch(agentId, { model, rules = '' } = {}) {
  const agent = AGENTS[agentId] || AGENTS.deepseek;
  if (agent.engine !== 'harness') throw new Error(`${agent.label} does not run in the DeepSeek Harness.`);
  const m = agent.models?.includes(model) ? model : agent.defaultModel || model;
  const q = JSON.stringify;
  const provider = agentId === 'local' ? 'ollama' : 'deepseek-official';
  const persona = `You are a coding agent powered by the {{model}} model.\n\n${rules}`;
  const lines = [
    `- id: system-prompt`,
    `  name: '@deepseek-ai/dsh-system-prompt'`,
    `  config:`,
    `    personaPrefix: ${q(persona)}`,
  ];
  if (agentId === 'local') {
    lines.push(
      `- id: llm-pi-ai`,
      `  name: '@deepseek-ai/dsh-llm-pi-ai'`,
      `  config:`,
      `    providers:`,
      `      ollama:`,
      `        displayName: "Ollama"`,
      `        api: "openai-completions"`,
      `        baseURL: "http://localhost:11434/v1"`,
      `        apiKeyEnv: "OLLAMA_API_KEY"`,
      `        models:`,
      `          - id: ${q(m)}`,
      `            name: ${q(m)}`,
      `            contextWindow: 32768`,
      `            maxTokens: 8192`
    );
  } else {
    lines.push(
      `- id: llm-deepseek`,
      `  name: '@deepseek-ai/dsh-llm-deepseek-api-key'`,
      `  config:`,
      `    apiKeyEnv: "DEEPSEEK_API_KEY"`
    );
  }
  lines.push(
    `- id: agent-default-model`,
    `  name: '@deepseek-ai/dsh-agent-default-model'`,
    `  config:`,
    `    provider: ${q(provider)}`,
    `    model: ${q(m)}`,
    `- id: acp`,
    `  name: '@deepseek-ai/dsh-acp'`,
    `  inject:`,
    `    - acpAppStartup`,
    `  config:`,
    `    provider: ${q(provider)}`,
    `    model: ${q(m)}`
  );
  return { patch: lines.join('\n') + '\n', model: m, provider };
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
