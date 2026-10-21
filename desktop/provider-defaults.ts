/** Model and endpoint a provider uses when neither the launcher nor the environment names one. */
export const PROVIDER_DEFAULTS = {
  local: { model: 'gemini-3.7-flash', endpoint: 'http://127.0.0.1:8045/v1/chat/completions' },
  deepseek: { model: 'deepseek-flash', endpoint: 'https://api.deepseek.com/chat/completions' },
  ollama: { model: 'qwen3:4b', endpoint: 'http://127.0.0.1:11434/api/chat' },
} as const
