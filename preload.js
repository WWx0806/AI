const { contextBridge, ipcRenderer } = require('electron');

// 暴露给渲染进程的安全 API
contextBridge.exposeInMainWorld('luminAPI', {
  // 运行时信息
  runtime: {
    getInfo: () => ipcRenderer.invoke('app:getRuntimeInfo')
  },

  // 文件系统（受限）
  fs: {
    ensureDir: (dirPath) => ipcRenderer.invoke('fs:ensureDir', dirPath),
    readFile: (filePath) => ipcRenderer.invoke('fs:readFile', filePath),
    writeFile: (filePath, content) => ipcRenderer.invoke('fs:writeFile', filePath, content),
    readDir: (dirPath) => ipcRenderer.invoke('fs:readDir', dirPath)
  },

  // 系统对话框
  dialog: {
    openDirectory: (options) => ipcRenderer.invoke('dialog:openDirectory', options),
    showSaveDialog: (options) => ipcRenderer.invoke('dialog:showSaveDialog', options)
  },

  // 应用菜单事件
  app: {
    onMenuAction: (callback) => {
      const listener = (_, data) => callback(data);
      ipcRenderer.on('app:menuAction', listener);
      // 返回取消订阅函数
      return () => ipcRenderer.off('app:menuAction', listener);
    }
  },

  // 工作区 / 书籍 / 章节
  workspace: {
    ensure: (workspacePath) => ipcRenderer.invoke('workspace:ensure', workspacePath),
    listBooks: (workspacePath) => ipcRenderer.invoke('workspace:listBooks', workspacePath),
    createBook: (params) => ipcRenderer.invoke('workspace:createBook', params),
    loadBook: (bookPath) => ipcRenderer.invoke('book:load', bookPath),
    saveBook: (bookPath, bookData) => ipcRenderer.invoke('book:save', { bookPath, bookData }),
    deleteBook: (bookPath) => ipcRenderer.invoke('book:delete', bookPath)
  },

  chapter: {
    read: (bookPath, fileName) => ipcRenderer.invoke('chapter:read', { bookPath, fileName }),
    write: (bookPath, fileName, title, text, chapterId) =>
      ipcRenderer.invoke('chapter:write', { bookPath, fileName, title, text, chapterId }),
    delete: (bookPath, fileName) => ipcRenderer.invoke('chapter:delete', { bookPath, fileName })
  },

  // 版本快照
  snapshots: {
    list: (chapterPath) => ipcRenderer.invoke('snapshots:list', chapterPath),
    create: (chapterPath, label, type = 'manual') =>
      ipcRenderer.invoke('snapshot:create', { chapterPath, label, type }),
    restore: (snapshotPath) => ipcRenderer.invoke('snapshot:restore', snapshotPath),
    delete: (snapshotPath) => ipcRenderer.invoke('snapshot:delete', snapshotPath),
    read: (snapshotPath) => ipcRenderer.invoke('snapshot:read', snapshotPath),
    diff: (aPath, bPath) => ipcRenderer.invoke('snapshot:diff', { aPath, bPath }),
    export: (snapshotPath, outPath) => ipcRenderer.invoke('snapshot:export', { snapshotPath, outPath }),
    getPolicy: (chapterPath) => ipcRenderer.invoke('snapshot:policy:get', chapterPath),
    setPolicy: (chapterPath, policy) => ipcRenderer.invoke('snapshot:policy:set', { chapterPath, policy })
  },

  // 同步初始化 API（仅在启动时使用）
  workspaceSync: {
    getInfo: () => ipcRenderer.sendSync('workspace:getInfoSync'),
    migrateAndLoadBooks: (genreBooksFromStorage) =>
      ipcRenderer.sendSync('workspace:migrateAndLoadBooks', genreBooksFromStorage),
    saveBooks: (genreBooks) =>
      ipcRenderer.sendSync('workspace:saveBooksSync', genreBooks)
  },

  // Ollama 本地模型管理
  ollama: {
    check: (baseUrl) => ipcRenderer.invoke('ollama:check', baseUrl),
    list: (baseUrl) => ipcRenderer.invoke('ollama:list', baseUrl),
    show: (baseUrl, modelName) => ipcRenderer.invoke('ollama:show', { baseUrl, modelName }),
    delete: (baseUrl, modelName) => ipcRenderer.invoke('ollama:delete', { baseUrl, modelName }),
    pull: (baseUrl, modelName, onEvent) => {
      const channel = 'ollama:pull:' + Date.now() + '_' + Math.random().toString(36).slice(2);
      const listener = (_, data) => onEvent && onEvent(data);
      ipcRenderer.on(channel, listener);
      ipcRenderer.invoke('ollama:pull', { baseUrl, modelName, channel });
      return {
        stop: () => ipcRenderer.invoke('ollama:stopPull', channel),
        unsubscribe: () => ipcRenderer.off(channel, listener)
      };
    }
  },

  // 专注模式
  focus: {
    toggle: () => ipcRenderer.invoke('app:toggleFocus')
  },
  // 导出
  export: {
    md: (bookPath, outPath, options) => ipcRenderer.invoke('export:md', { bookPath, outPath, options }),
    txt: (bookPath, outPath, options) => ipcRenderer.invoke('export:txt', { bookPath, outPath, options }),
    wordCount: (bookPath) => ipcRenderer.invoke('export:wordCount', { bookPath })
  },

  // 写作统计
  stats: {
    record: (bookPath, words, minutes) => ipcRenderer.invoke('stats:record', { bookPath, words, minutes }),
    get: (bookPath) => ipcRenderer.invoke('stats:get', { bookPath }),
    trend: (bookPath, days) => ipcRenderer.invoke('stats:trend', { bookPath, days })
  },
  // 故事画布
  canvas: {
    load: (bookPath) => ipcRenderer.invoke('canvas:load', bookPath),
    save: (bookPath, canvas) => ipcRenderer.invoke('canvas:save', { bookPath, canvas }),
    addNode: (bookPath, node) => ipcRenderer.invoke('canvas:addNode', { bookPath, node }),
    updateNode: (bookPath, id, updates) => ipcRenderer.invoke('canvas:updateNode', { bookPath, id, updates }),
    deleteNode: (bookPath, id) => ipcRenderer.invoke('canvas:deleteNode', { bookPath, id }),
    addEdge: (bookPath, edge) => ipcRenderer.invoke('canvas:addEdge', { bookPath, edge }),
    updateEdge: (bookPath, id, updates) => ipcRenderer.invoke('canvas:updateEdge', { bookPath, id, updates }),
    deleteEdge: (bookPath, id) => ipcRenderer.invoke('canvas:deleteEdge', { bookPath, id }),
    getColors: () => ipcRenderer.invoke('canvas:getColors')
  },
  // Codex 知识库
  codex: {
    load: (bookPath) => ipcRenderer.invoke('codex:load', bookPath),
    save: (bookPath, codex) => ipcRenderer.invoke('codex:save', { bookPath, codex }),
    addCharacter: (bookPath, char) => ipcRenderer.invoke('codex:addCharacter', { bookPath, char }),
    updateCharacter: (bookPath, id, updates) => ipcRenderer.invoke('codex:updateCharacter', { bookPath, id, updates }),
    deleteCharacter: (bookPath, id) => ipcRenderer.invoke('codex:deleteCharacter', { bookPath, id }),
    addLocation: (bookPath, loc) => ipcRenderer.invoke('codex:addLocation', { bookPath, loc }),
    updateLocation: (bookPath, id, updates) => ipcRenderer.invoke('codex:updateLocation', { bookPath, id, updates }),
    deleteLocation: (bookPath, id) => ipcRenderer.invoke('codex:deleteLocation', { bookPath, id }),
    addRule: (bookPath, rule) => ipcRenderer.invoke('codex:addRule', { bookPath, rule }),
    updateRule: (bookPath, id, updates) => ipcRenderer.invoke('codex:updateRule', { bookPath, id, updates }),
    deleteRule: (bookPath, id) => ipcRenderer.invoke('codex:deleteRule', { bookPath, id }),
    search: (bookPath, keyword) => ipcRenderer.invoke('codex:search', { bookPath, keyword }),
    findRelevant: (bookPath, text) => ipcRenderer.invoke('codex:findRelevant', { bookPath, text }),
    buildAIContext: (bookPath, text) => ipcRenderer.invoke('codex:buildAIContext', { bookPath, text })
  },
  // 全文搜索
  search: {
    query: (query, options) => ipcRenderer.invoke('search:query', { query, ...options }),
    indexChapter: (bookId, chapterId, filePath, title, bookTitle, content) => 
      ipcRenderer.invoke('search:indexChapter', { bookId, chapterId, filePath, title, bookTitle, content }),
    removeChapter: (chapterId) => ipcRenderer.invoke('search:removeChapter', { chapterId }),
    removeBook: (bookId) => ipcRenderer.invoke('search:removeBook', { bookId }),
    getStats: () => ipcRenderer.invoke('search:getStats'),
    clearAll: () => ipcRenderer.invoke('search:clearAll')
  },
  // AI 服务
  ai: {
    getProviders: () => ipcRenderer.invoke('ai:getProviders'),
    saveProvider: (provider) => ipcRenderer.invoke('ai:saveProvider', provider),
    deleteProvider: (id) => ipcRenderer.invoke('ai:deleteProvider', id),
    setActiveProvider: (id) => ipcRenderer.invoke('ai:setActiveProvider', id),
    fetchModels: (providerId) => ipcRenderer.invoke('ai:fetchModels', providerId),
    getStats: () => ipcRenderer.invoke('ai:getStats'),
    generateSync: (params) => ipcRenderer.invoke('ai:generateSync', params),
    generate: (params, onEvent) => {
      const channel = 'ai:stream:' + Date.now() + '_' + Math.random().toString(36).slice(2);
      const listener = (_, data) => onEvent && onEvent(data);
      ipcRenderer.on(channel, listener);
      ipcRenderer.invoke('ai:generate', { ...params, channel });
      return {
        stop: () => ipcRenderer.invoke('ai:stopGenerate', channel),
        unsubscribe: () => ipcRenderer.off(channel, listener)
      };
    },
    chat: (body, onEvent) => {
      const channel = 'ai:chat:stream:' + Date.now() + '_' + Math.random().toString(36).slice(2);
      const listener = (_, data) => onEvent && onEvent(data);
      ipcRenderer.on(channel, listener);
      ipcRenderer.invoke('ai:chat', { ...body, channel });
      return {
        stop: () => ipcRenderer.invoke('ai:stopChat', channel),
        unsubscribe: () => ipcRenderer.off(channel, listener)
      };
    },
    getSessions: (projectId) => ipcRenderer.invoke('ai:chat:sessions', projectId),
    getMessages: (sessionId) => ipcRenderer.invoke('ai:chat:messages', sessionId)
  }
});
