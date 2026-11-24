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

/*
 * AIs reached through a provider's API, in the DeepSeek Harness: its pi-ai adapter ships the route
 * (endpoint, protocol, model catalog) of each of these providers, so only the key is needed.
 *   route:  the pi-ai provider name;  keyEnv: the variable the key travels in (never written to disk)
 *   models: a fallback list, used when the installed catalog cannot be read
 */
const API_AGENTS = [
  {
    id: 'gemini',
    label: 'Gemini',
    by: 'Google Gemini API',
    route: 'google',
    keyEnv: 'GEMINI_API_KEY',
    keyUrl: 'https://aistudio.google.com/apikey',
    keySite: 'aistudio.google.com',
    keyHint: 'AIza...',
    models: ['gemini-pro-latest', 'gemini-flash-latest', 'gemini-2.5-pro', 'gemini-2.5-flash'],
    defaultModel: 'gemini-pro-latest',
  },
  {
    id: 'grok',
    label: 'Grok',
    by: 'xAI API',
    route: 'xai',
    keyEnv: 'XAI_API_KEY',
    keyUrl: 'https://console.x.ai',
    keySite: 'console.x.ai',
    keyHint: 'xai-...',
    models: ['grok-4.7', 'grok-4.6', 'grok-4.5', 'grok-4.3'],
    defaultModel: 'grok-4.7',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    by: 'OpenRouter: hundreds of models with one key',
    route: 'openrouter',
    keyEnv: 'OPENROUTER_API_KEY',
    keyUrl: 'https://openrouter.ai/keys',
    keySite: 'openrouter.ai',
    keyHint: 'sk-or-...',
    models: ['~google/gemini-pro-latest', '~x-ai/grok-latest', '~anthropic/claude-sonnet-latest', '~openai/gpt-mini-latest', '~moonshotai/kimi-latest', '~z-ai/glm-latest'],
    defaultModel: '~google/gemini-pro-latest',
  },
  {
    id: 'openai-api',
    label: 'OpenAI API',
    by: 'OpenAI API (pay per use, no ChatGPT plan)',
    route: 'openai',
    keyEnv: 'OPENAI_API_KEY',
    keyUrl: 'https://platform.openai.com/api-keys',
    keySite: 'platform.openai.com',
    keyHint: 'sk-...',
    models: ['gpt-5.5', 'gpt-5.4-mini', 'gpt-5.3-codex'],
    defaultModel: 'gpt-5.5',
  },
  {
    id: 'mistral',
    label: 'Mistral',
    by: 'Mistral AI API',
    route: 'mistral',
    keyEnv: 'MISTRAL_API_KEY',
    keyUrl: 'https://console.mistral.ai/api-keys',
    keySite: 'console.mistral.ai',
    keyHint: '',
    models: ['devstral-latest', 'mistral-large-latest', 'codestral-latest', 'mistral-medium-latest'],
    defaultModel: 'devstral-latest',
  },
  {
    id: 'kimi',
    label: 'Kimi',
    by: 'Moonshot AI API',
    route: 'moonshotai',
    keyEnv: 'MOONSHOT_API_KEY',
    keyUrl: 'https://platform.moonshot.ai/console/api-keys',
    keySite: 'platform.moonshot.ai',
    keyHint: 'sk-...',
    models: ['kimi-k3.1-pro', 'kimi-k3', 'kimi-k2.7-code'],
    defaultModel: 'kimi-k3.1-pro',
  },
  {
    id: 'groq',
    label: 'Groq',
    by: 'Groq API (very fast open models)',
    route: 'groq',
    keyEnv: 'GROQ_API_KEY',
    keyUrl: 'https://console.groq.com/keys',
    keySite: 'console.groq.com',
    keyHint: 'gsk_...',
    models: ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'llama-3.3-70b-versatile'],
    defaultModel: 'openai/gpt-oss-120b',
  },
];
for (const a of API_AGENTS) {
  AGENTS[a.id] = { ...a, engine: 'harness', command: 'dsh', install: 'npm i -g @deepseek-ai/dsh', needsKey: true, api: true };
}
AGENTS.deepseek.keySite = 'platform.deepseek.com';
AGENTS.deepseek.keyHint = 'sk-...';
AGENTS.deepseek.keyEnv = 'DEEPSEEK_API_KEY';

/** The order of the picker: Claude first, then the CLIs, then the APIs. */
export const AGENT_IDS = ['claude', 'deepseek', 'local', 'chatgpt', ...API_AGENTS.map((a) => a.id)];

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
export function spawnSpec(agentId, { model, key, codev = {}, runner, rules = '', mcpConfig = null } = {}) {
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
      // The CoDev MCP server given at launch too: registering it with `claude mcp add` can fail
      // (Claude Code not installed yet, not on the app's PATH), and then the AI could not talk to the room.
      return { command: 'claude', args: mcpConfig ? ['--mcp-config', mcpConfig] : [], env: {}, unset: [] };
  }
}

/**
 * The DSH profile overlay for a Harness AI: which model answers, which CoDev rules it receives, and
 * (for Local) the Ollama route. The API key never goes in this file: it travels in the environment.
 */
export function harnessPatch(agentId, { model, rules = '' } = {}) {
  const agent = AGENTS[agentId] || AGENTS.deepseek;
  if (agent.engine !== 'harness') throw new Error(`${agent.label} does not run in the DeepSeek Harness.`);
  // API providers: whatever model the user chose (their catalog may be newer than our list).
  const m = agent.api ? model || agent.defaultModel : agent.models?.includes(model) ? model : agent.defaultModel || model;
  if (!m) throw new Error(`Choose a ${agent.label} model.`);
  const q = JSON.stringify;
  const provider = agentId === 'local' ? 'ollama' : agent.api ? agent.route : 'deepseek-official';
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
  } else if (agent.api) {
    // A catalog route: pi-ai knows its endpoint, protocol and models; the key comes from the environment.
    lines.push(
      `- id: llm-pi-ai`,
      `  name: '@deepseek-ai/dsh-llm-pi-ai'`,
      `  config:`,
      `    providers:`,
      `      ${agent.route}:`,
      `        apiKeyEnv: ${q(agent.keyEnv)}`
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

/** Model ids that are not for coding chats (research agents, robots, batch-only, images…). */
const NOT_CHAT = /deep-research|computer-use|robotics|:batch$|image|tts|audio|embed|guard|safeguard|voxtral|pixtral/i;

/**
 * The chat models an API agent can use, from the pi-ai catalog the installed Harness ships
 * (`readCatalog(route)` returns the parsed catalog JSON, or null). Our suggested models come first.
 */
export function apiModels(agentId, readCatalog) {
  const a = AGENTS[agentId];
  if (!a?.api) return [];
  const ids = [];
  try {
    const data = readCatalog(a.route);
    for (const models of Object.values(data || {})) {
      for (const [k, m] of Object.entries(models || {})) {
        if (k.startsWith('chat:') && m?.id && m.tools !== false && !NOT_CHAT.test(m.id)) ids.push(m.id);
      }
    }
  } catch {}
  const known = new Set(ids);
  // Our suggestions only when the catalog has them (or when there is no catalog to ask).
  const first = (a.models || []).filter((id) => !ids.length || known.has(id));
  return [...new Set([...first, ...ids])];
}
