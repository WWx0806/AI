// 桌面端 AI 服务层
// 职责：统一管理云端/本地模型 Provider、加密存储 API Key、流式代理调用

const { safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const os = require('os');

const APP_DIR = path.join(os.homedir(), process.platform === 'win32' ? 'AppData/Roaming/Lumin' : 'Library/Application Support/Lumin');
const PROVIDERS_FILE = path.join(APP_DIR, 'providers.json');
const STATS_FILE = path.join(APP_DIR, 'ai-stats.json');
const SESSIONS_FILE = path.join(APP_DIR, 'chat-sessions.json');

let providers = {};
let activeProviderId = '';
let tokenStats = {
  tokensToday: 0,
  totalTokens: 0,
  totalCalls: 0,
  lastArchiveDate: new Date().toISOString().slice(0, 10)
};
let chatSessions = [];

// 已知模型列表
const knownModels = {
  anthropic: [
    { id: 'claude-opus-4-20250514', name: 'Claude Opus 4' },
    { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4' },
    { id: 'claude-haiku-4-20250514', name: 'Claude Haiku 4' }
  ],
  deepseek: [
    { id: 'deepseek-chat', name: 'DeepSeek Chat' },
    { id: 'deepseek-coder', name: 'DeepSeek Coder' },
    { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' }
  ],
  moonshot: [
    { id: 'moonshot-v1-8k', name: 'Kimi 8K' },
    { id: 'moonshot-v1-32k', name: 'Kimi 32K' },
    { id: 'moonshot-v1-128k', name: 'Kimi 128K' }
  ],
  qwen: [
    { id: 'qwen-max', name: 'Qwen Max' },
    { id: 'qwen-plus', name: 'Qwen Plus' },
    { id: 'qwen-turbo', name: 'Qwen Turbo' }
  ],
  openai: [
    { id: 'gpt-4o', name: 'GPT-4o' },
    { id: 'gpt-4-turbo', name: 'GPT-4 Turbo' },
    { id: 'gpt-3.5-turbo', name: 'GPT-3.5 Turbo' }
  ],
  gemini: [
    { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' }
  ],
  ollama: [
    { id: 'qwen2.5', name: 'Qwen 2.5' },
    { id: 'deepseek-r1:8b', name: 'DeepSeek R1 8B' },
    { id: 'llama3.2', name: 'Llama 3.2' }
  ]
};

function ensureDir() {
  if (!fs.existsSync(APP_DIR)) fs.mkdirSync(APP_DIR, { recursive: true });
}

function readJSON(file, defaultValue) {
  try {
    if (fs.existsSync(file)) {
      const text = fs.readFileSync(file, 'utf8');
      return JSON.parse(text);
    }
  } catch (e) {
    console.error('[ai-service] 读取 JSON 失败:', file, e.message);
  }
  return defaultValue;
}

function writeJSON(file, obj) {
  ensureDir();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function encryptKey(key) {
  if (!key) return '';
  if (!safeStorage.isEncryptionAvailable()) return key;
  try {
    return safeStorage.encryptString(key).toString('base64');
  } catch (e) {
    console.error('[ai-service] 加密失败:', e.message);
    return key;
  }
}

function decryptKey(encrypted) {
  if (!encrypted) return '';
  if (!safeStorage.isEncryptionAvailable()) return encrypted;
  try {
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
  } catch (e) {
    console.error('[ai-service] 解密失败:', e.message);
    return '';
  }
}

function loadProviders() {
  const data = readJSON(PROVIDERS_FILE, { providers: {}, activeProviderId: '' });
  providers = data.providers || {};
  activeProviderId = data.activeProviderId || '';
}

function saveProviders() {
  writeJSON(PROVIDERS_FILE, { providers, activeProviderId, updatedAt: new Date().toISOString() });
}

function loadStats() {
  tokenStats = readJSON(STATS_FILE, tokenStats);
  archiveTokensIfNeeded();
}

function saveStats() {
  writeJSON(STATS_FILE, tokenStats);
}

function archiveTokensIfNeeded() {
  const today = new Date().toISOString().slice(0, 10);
  if (tokenStats.lastArchiveDate !== today) {
    tokenStats.tokensToday = 0;
    tokenStats.lastArchiveDate = today;
    saveStats();
  }
}

function loadSessions() {
  chatSessions = readJSON(SESSIONS_FILE, []);
}

function saveSessions() {
  writeJSON(SESSIONS_FILE, chatSessions);
}

function init() {
  loadProviders();
  loadStats();
  loadSessions();
}

function getProvider(providerId) {
  const id = providerId || activeProviderId;
  if (!id || !providers[id]) {
    const ids = Object.keys(providers);
    if (ids.length === 0) return null;
    return providers[ids[0]];
  }
  return providers[id];
}

function getProviderKey(providerId) {
  const provider = getProvider(providerId);
  if (!provider) throw new Error('Provider not found');
  return decryptKey(provider.key);
}

function buildAuthHeaders(provider) {
  const headers = { 'Content-Type': 'application/json' };
  const type = provider.type || detectType(provider.url);
  const key = getProviderKey(provider.id);

  if (type === 'anthropic') {
    headers['x-api-key'] = key;
    headers['anthropic-version'] = '2023-06-01';
  } else if (key) {
    headers['Authorization'] = 'Bearer ' + key;
  }
  return headers;
}

function detectType(url) {
  const u = (url || '').toLowerCase();
  if (u.includes('api.anthropic.com') || u.includes('anthropic')) return 'anthropic';
  if (u.includes('googleapis.com') || u.includes('generativelanguage') || u.includes('gemini')) return 'gemini';
  if (u.includes('localhost') || u.includes('127.0.0.1') || u.includes('ollama')) return 'ollama';
  return 'openai';
}

function knownModelKey(url) {
  const u = (url || '').toLowerCase();
  if (u.includes('anthropic')) return 'anthropic';
  if (u.includes('deepseek')) return 'deepseek';
  if (u.includes('moonshot') || u.includes('kimi')) return 'moonshot';
  if (u.includes('dashscope') || u.includes('aliyun') || u.includes('qwen')) return 'qwen';
  if (u.includes('generativelanguage') || u.includes('gemini')) return 'gemini';
  if (u.includes('localhost') || u.includes('127.0.0.1') || u.includes('ollama')) return 'ollama';
  return 'openai';
}

function getPublicProviders() {
  return Object.values(providers).map(function (p) {
    return {
      id: p.id,
      name: p.name,
      url: p.url,
      defaultModel: p.defaultModel,
      active: p.id === activeProviderId,
      type: p.type || detectType(p.url),
      createdAt: p.createdAt
    };
  });
}

function saveProvider(provider) {
  if (!provider || !provider.id) throw new Error('缺少 provider id');
  const existing = providers[provider.id] || {};
  providers[provider.id] = {
    id: provider.id,
    name: provider.name || existing.name || '未命名',
    url: provider.url || existing.url || '',
    key: provider.key ? encryptKey(provider.key) : (existing.key || ''),
    defaultModel: provider.defaultModel || existing.defaultModel || '',
    type: provider.type || detectType(provider.url || existing.url),
    createdAt: existing.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  if (provider.active || Object.keys(providers).length === 1) {
    activeProviderId = provider.id;
  }
  saveProviders();
  return providers[provider.id];
}

function deleteProvider(id) {
  if (providers[id]) {
    delete providers[id];
    if (activeProviderId === id) activeProviderId = '';
    saveProviders();
    return true;
  }
  return false;
}

function setActiveProvider(id) {
  if (providers[id]) {
    activeProviderId = id;
    saveProviders();
    return true;
  }
  return false;
}

function getActiveProviderId() {
  return activeProviderId;
}

async function fetchModels(providerId) {
  const provider = getProvider(providerId);
  if (!provider) return [];

  const type = provider.type || detectType(provider.url);
  const fallbackKey = knownModelKey(provider.url);

  try {
    if (type === 'anthropic' || type === 'gemini') {
      return knownModels[fallbackKey] || [];
    }

    const url = (provider.url || '').replace(/\/$/, '') + '/v1/models';
    const response = await axios.get(url, {
      headers: buildAuthHeaders(provider),
      timeout: 15000
    });

    const data = response.data;
    if (data && data.data && Array.isArray(data.data)) {
      return data.data.slice(0, 30).map(function (m) {
        return { id: m.id, name: m.id };
      });
    }
    // Ollama /v1/models 返回 { models: [...] }
    if (data && Array.isArray(data.models)) {
      return data.models.slice(0, 30).map(function (m) {
        return { id: m.id || m.name || m.model, name: m.id || m.name || m.model };
      });
    }
    return [];
  } catch (err) {
    console.error('[ai-service] 获取模型列表失败:', err.message);
    return knownModels[fallbackKey] || knownModels.openai || [];
  }
}

async function streamOpenAI(provider, messages, options, onEvent) {
  const url = (provider.url || '').replace(/\/$/, '') + '/v1/chat/completions';
  const type = provider.type || detectType(provider.url);
  const body = {
    model: provider.defaultModel || 'gpt-4o',
    messages: messages,
    temperature: options.temperature !== undefined ? options.temperature : 0.8,
    top_p: options.topP !== undefined ? options.topP : 1.0,
    max_tokens: options.maxTokens || 4096,
    frequency_penalty: options.frequencyPenalty || 0,
    stream: true
  };
  // Ollama 等部分本地模型对 stream_options 支持不完整，仅对标准 OpenAI 端点启用
  if (type === 'openai') {
    body.stream_options = { include_usage: true };
  }

  const response = await axios.post(url, body, {
    headers: buildAuthHeaders(provider),
    responseType: 'stream',
    timeout: 300000
  });

  let usage = null;
  let ended = false;

  response.data.on('data', function (chunk) {
    if (ended) return;
    const lines = chunk.toString().split('\n').filter(function (l) { return l.startsWith('data:'); });
    for (const line of lines) {
      const data = line.replace(/^data:\s*/, '').trim();
      if (data === '[DONE]') {
        if (usage) {
          tokenStats.tokensToday += (usage.total_tokens || 0);
          tokenStats.totalTokens += (usage.total_tokens || 0);
          tokenStats.totalCalls++;
          saveStats();
          onEvent({ type: 'usage', usage: usage });
        }
        onEvent({ type: 'done' });
        ended = true;
        return;
      }
      try {
        const json = JSON.parse(data);
        if (json.usage) usage = json.usage;
        if (json.choices && json.choices[0]) {
          const delta = json.choices[0].delta;
          if (delta && delta.content) {
            onEvent({ type: 'content', content: delta.content });
          }
        }
      } catch (e) { /* 忽略 */ }
    }
  });

  response.data.on('end', function () {
    if (!ended) {
      ended = true;
      onEvent({ type: 'done' });
    }
  });

  response.data.on('error', function (err) {
    if (!ended) {
      ended = true;
      onEvent({ type: 'error', error: 'Stream interrupted: ' + err.message });
    }
  });

  return function stop() {
    if (!ended && response.data && !response.data.destroyed) {
      response.data.destroy();
      ended = true;
    }
  };
}

async function streamAnthropic(provider, messages, options, onEvent) {
  const url = (provider.url || '').replace(/\/$/, '') + '/v1/messages';
  const systemMsgs = messages.filter(function (m) { return m.role === 'system'; });
  const chatMsgs = messages.filter(function (m) { return m.role !== 'system'; });
  const system = systemMsgs.length > 0 ? systemMsgs.map(function (m) { return m.content; }).join('\n') : undefined;

  const body = {
    model: provider.defaultModel || 'claude-sonnet-4-20250514',
    max_tokens: options.maxTokens || 4096,
    temperature: options.temperature !== undefined ? options.temperature : 0.8,
    top_p: options.topP !== undefined ? options.topP : 1.0,
    messages: chatMsgs.map(function (m) { return { role: m.role, content: m.content }; }),
    stream: true
  };
  if (system) body.system = system;

  const response = await axios.post(url, body, {
    headers: buildAuthHeaders(provider),
    responseType: 'stream',
    timeout: 300000
  });

  let usage = null;
  let ended = false;

  response.data.on('data', function (chunk) {
    if (ended) return;
    const lines = chunk.toString().split('\n').filter(function (l) { return l.trim(); });
    for (const line of lines) {
      if (line.startsWith('event:')) continue;
      if (line.startsWith('data:')) {
        const data = line.replace(/^data:\s*/, '').trim();
        try {
          const json = JSON.parse(data);
          if (json.type === 'message_delta' && json.usage) {
            usage = {
              prompt_tokens: 0,
              completion_tokens: json.usage.output_tokens,
              total_tokens: json.usage.output_tokens
            };
          } else if (json.type === 'message_start' && json.message && json.message.usage) {
            usage = usage || {};
            usage.prompt_tokens = json.message.usage.input_tokens;
            usage.totalTokens = (usage.totalTokens || 0) + json.message.usage.input_tokens;
          }
          if (json.type === 'content_block_delta' && json.delta && json.delta.text) {
            onEvent({ type: 'content', content: json.delta.text });
          } else if (json.type === 'message_stop') {
            if (usage) {
              tokenStats.tokensToday += (usage.total_tokens || 0);
              tokenStats.totalTokens += (usage.total_tokens || 0);
              tokenStats.totalCalls++;
              saveStats();
              onEvent({ type: 'usage', usage: usage });
            }
            onEvent({ type: 'done' });
            ended = true;
            return;
          }
        } catch (e) { /* 忽略 */ }
      }
    }
  });

  response.data.on('end', function () {
    if (!ended) {
      ended = true;
      onEvent({ type: 'done' });
    }
  });

  response.data.on('error', function (err) {
    if (!ended) {
      ended = true;
      onEvent({ type: 'error', error: 'Stream interrupted: ' + err.message });
    }
  });

  return function stop() {
    if (!ended && response.data && !response.data.destroyed) {
      response.data.destroy();
      ended = true;
    }
  };
}

async function streamAI(params, onEvent) {
  const provider = getProvider(params.providerId);
  if (!provider) {
    onEvent({ type: 'error', error: '未找到可用的 AI Provider，请先在设置中配置' });
    onEvent({ type: 'done' });
    return function () {};
  }

  archiveTokensIfNeeded();

  const type = provider.type || detectType(provider.url);
  const options = params.options || {};

  try {
    if (type === 'anthropic') {
      return await streamAnthropic(provider, params.messages, options, onEvent);
    }
    return await streamOpenAI(provider, params.messages, options, onEvent);
  } catch (err) {
    console.error('[ai-service] 流式调用失败:', err.message);
    onEvent({ type: 'error', error: 'AI调用失败: ' + err.message });
    onEvent({ type: 'done' });
    return function () {};
  }
}

async function generateSync(params) {
  const provider = getProvider(params.providerId);
  if (!provider) throw new Error('未找到可用的AI Provider，请先在设置中配置');

  const type = provider.type || detectType(provider.url);
  const options = params.options || {};
  const model = provider.defaultModel || (type === 'anthropic' ? 'claude-sonnet-4-20250514' : 'gpt-4o');

  archiveTokensIfNeeded();

  try {
    let content = '';
    let usage = null;

    if (type === 'anthropic') {
      const systemMsgs = params.messages.filter(function (m) { return m.role === 'system'; });
      const chatMsgs = params.messages.filter(function (m) { return m.role !== 'system'; });
      const system = systemMsgs.length > 0 ? systemMsgs.map(function (m) { return m.content; }).join('\n') : undefined;

      const body = {
        model: model,
        max_tokens: options.maxTokens || 4096,
        temperature: options.temperature !== undefined ? options.temperature : 0.8,
        top_p: options.topP !== undefined ? options.topP : 1.0,
        messages: chatMsgs.map(function (m) { return { role: m.role, content: m.content }; })
      };
      if (system) body.system = system;

      const response = await axios.post((provider.url || '').replace(/\/$/, '') + '/v1/messages', body, {
        headers: buildAuthHeaders(provider),
        timeout: 300000
      });

      const data = response.data;
      if (data.content && Array.isArray(data.content)) {
        content = data.content.map(function (c) { return c.type === 'text' ? c.text : ''; }).join('');
      }
      if (data.usage) {
        usage = {
          prompt_tokens: data.usage.input_tokens || 0,
          completion_tokens: data.usage.output_tokens || 0,
          total_tokens: (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0)
        };
      }
    } else {
      const url = (provider.url || '').replace(/\/$/, '') + '/v1/chat/completions';
      const body = {
        model: model,
        messages: params.messages,
        temperature: options.temperature !== undefined ? options.temperature : 0.8,
        top_p: options.topP !== undefined ? options.topP : 1.0,
        max_tokens: options.maxTokens || 4096,
        frequency_penalty: options.frequencyPenalty || 0,
        stream: false
      };

      const response = await axios.post(url, body, {
        headers: buildAuthHeaders(provider),
        timeout: 300000
      });

      const data = response.data;
      if (data.choices && data.choices[0] && data.choices[0].message) {
        content = data.choices[0].message.content || '';
      }
      usage = data.usage || null;
    }

    if (usage) {
      tokenStats.tokensToday += (usage.total_tokens || 0);
      tokenStats.totalTokens += (usage.total_tokens || 0);
      tokenStats.totalCalls++;
      saveStats();
    }

    return { content: content, usage: usage };
  } catch (err) {
    console.error('[ai-service] generateSync 失败:', err.message);
    throw new Error('AI调用失败: ' + err.message);
  }
}

// 会话管理
function getSessions(projectId) {
  return chatSessions.filter(function (s) { return s.projectId === (projectId || 'default'); });
}

function getSessionMessages(sessionId) {
  const session = chatSessions.find(function (s) { return s.id === sessionId; });
  return session ? (session.messages || []) : [];
}

function saveSessionMessage(projectId, sessionId, role, content) {
  let session = chatSessions.find(function (s) { return s.id === sessionId; });
  if (!session) {
    session = {
      id: sessionId || ('sess-' + Date.now()),
      projectId: projectId || 'default',
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    chatSessions.push(session);
  }
  session.messages.push({ role: role, content: content, createdAt: new Date().toISOString() });
  session.updatedAt = new Date().toISOString();
  session.messageCount = session.messages.length;
  saveSessions();
  return session;
}

function getTokenStats() {
  archiveTokensIfNeeded();
  return {
    tokensToday: tokenStats.tokensToday,
    totalTokens: tokenStats.totalTokens,
    totalCalls: tokenStats.totalCalls,
    tokenHistory: tokenStats.tokenHistory || [0, 0, 0, 0, 0, 0, 0]
  };
}

module.exports = {
  init,
  getProviders: getPublicProviders,
  saveProvider,
  deleteProvider,
  setActiveProvider,
  getActiveProviderId,
  fetchModels,
  streamAI,
  generateSync,
  getTokenStats,
  getSessions,
  getSessionMessages,
  saveSessionMessage
};
