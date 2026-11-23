import path from 'node:path';

const env = process.env;

export const config = {
  port: Number(env.PORT || 3100),
  host: env.HOST || '127.0.0.1',
  dataDir: path.resolve(env.KEEPCRAWL_DATA_DIR || './data'),
  // Optional: protect the API and UI with a static key (Bearer token).
  apiKey: env.KEEPCRAWL_API_KEY || '',

  firecrawl: {
    apiKey: env.FIRECRAWL_API_KEY || '',
    // Point at a self-hosted Firecrawl instance if you run one.
    baseUrl: (env.FIRECRAWL_BASE_URL || 'https://api.firecrawl.dev').replace(/\/+$/, ''),
    screenshots: env.FIRECRAWL_SCREENSHOTS !== 'false',
    timeoutMs: Number(env.FIRECRAWL_TIMEOUT_MS || 60000),
  },

  // Any OpenAI-compatible endpoint. Defaults to a local FreeLLMAPI router.
  llm: {
    baseUrl: (env.LLM_BASE_URL || 'http://localhost:3001/v1').replace(/\/+$/, ''),
    apiKey: env.LLM_API_KEY || '',
    model: env.LLM_MODEL || 'auto',
    enabled: env.LLM_ENABLED !== 'false',
    maxInputChars: Number(env.LLM_MAX_INPUT_CHARS || 12000),
    language: env.LLM_LANGUAGE || 'the same language as the content',
  },

  worker: {
    concurrency: Number(env.WORKER_CONCURRENCY || 2),
    pollMs: Number(env.WORKER_POLL_MS || 1000),
    maxAttempts: Number(env.WORKER_MAX_ATTEMPTS || 3),
  },
};
