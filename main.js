const { app, BrowserWindow, ipcMain, dialog, shell, Menu, Tray, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const axios = require('axios');
const aiService = require('./ai-service');
const snapshotManager = require('./snapshots/manager');
const searchIndex = require('./search-index');
const codexService = require('./codex');
const exportService = require('./export');
const statsService = require('./stats');
const canvasService = require('./canvas');

// 保持窗口对象全局引用，防止被垃圾回收
let mainWindow = null;
let tray = null;
let isQuitting = false;
let canvasWindow = null;
const isDev = process.argv.includes('--dev');

// 默认工作区目录
function getDefaultWorkspacePath() {
  return path.join(os.homedir(), 'Documents', 'LuminWorkspace');
}

// ========== 文件格式工具 ==========

function countWords(t) {
  const cn = (t.match(/[一-鿿]/g) || []).length;
  const en = (t.match(/[a-zA-Z0-9]+/g) || []).length;
  return cn + en;
}

function sanitizeFileName(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'untitled';
}

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return { meta: {}, body: content };
  const metaText = match[1];
  const body = content.slice(match[0].length);
  const meta = {};
  metaText.split('\n').forEach(line => {
    const idx = line.indexOf(':');
    if (idx > 0) {
      const key = line.slice(0, idx).trim();
      const val = line.slice(idx + 1).trim();
      meta[key] = val;
    }
  });
  return { meta, body };
}

function stringifyFrontmatter(meta, body) {
  const lines = ['---'];
  Object.keys(meta).forEach(k => {
    lines.push(`${k}: ${meta[k]}`);
  });
  lines.push('---');
  return lines.join('\n') + '\n' + (body || '');
}

async function readJson(filePath) {
  const text = await fs.promises.readFile(filePath, 'utf8');
  return JSON.parse(text);
}

async function writeJson(filePath, obj) {
  const tempPath = `${filePath}.tmp`;
  await fs.promises.writeFile(tempPath, JSON.stringify(obj, null, 2), 'utf8');
  await fs.promises.rename(tempPath, filePath);
}

async function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    await fs.promises.mkdir(dirPath, { recursive: true });
  }
}

function ensureDirSync(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

// 生成时间戳
function nowIso() {
  return new Date().toISOString();
}

// 创建主窗口


// 创建系统托盘
function createTray() {
  if (tray) return;
  // 用 nativeImage 创建 16x16 紫色方块图标
  const iconSize = 16;
  const canvas = Buffer.alloc(iconSize * iconSize * 4);
  for (let i = 0; i < canvas.length; i += 4) {
    canvas[i] = 99;     // R
    canvas[i + 1] = 102; // G  
    canvas[i + 2] = 241; // B
    canvas[i + 3] = 255; // A
  }
  const icon = nativeImage.createFromBuffer(canvas, { width: iconSize, height: iconSize });

  tray = new Tray(icon);
  tray.setToolTip('Lumin - AI 写作');

  const trayMenu = Menu.buildFromTemplate([
    { label: '显示主窗口', click: function() { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
    { label: '专注模式', click: function() { if (mainWindow) mainWindow.webContents.send('app:menuAction', { action: 'focusMode' }); } },
    { type: 'separator' },
    { label: '退出 Lumin', click: function() { isQuitting = true; app.quit(); } }
  ]);
  tray.setContextMenu(trayMenu);

  tray.on('double-click', function() {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  });
}
// 创建画布窗口
function createCanvasWindow() {
  if (canvasWindow && !canvasWindow.isDestroyed()) {
    canvasWindow.focus();
    return;
  }
  canvasWindow = new BrowserWindow({
    width: 1200, height: 800, minWidth: 800, minHeight: 500,
    title: '故事画布 - Lumin',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  canvasWindow.loadFile(path.join(__dirname, 'canvas.html'));
  canvasWindow.on('close', function(event) { if (!isQuitting) { event.preventDefault(); canvasWindow.hide(); } });
  canvasWindow.on('closed', function() { canvasWindow = null; });
}
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Lumin — AI 智能写作',
    // show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });

  // 加载现有前端入口文件
  const indexPath = path.join(__dirname, '..', 'AI平台', 'index.html');

  mainWindow.loadFile(indexPath);


  // 打开开发者工具（开发模式）
  if (isDev) {
    mainWindow.webContents.openDevTools();
  }

  // 将渲染进程 console 转发到主进程终端
  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    const prefix = '[Renderer]';
    if (level === 0) console.log(prefix, message);
    else if (level === 1) console.info(prefix, message);
    else if (level === 2) console.warn(prefix, message);
    else if (level === 3) console.error(prefix, message);
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (isDev) mainWindow.focus();
  });

  mainWindow.on('close', (event) => { if (!isQuitting) { event.preventDefault(); mainWindow.hide(); } });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // 拦截外部链接，用系统默认浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// 应用菜单模板
function buildMenuTemplate() {
  const template = [
    {
      label: '文件',
      submenu: [
        {
          label: '打开工作区',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: async () => {
            const result = await dialog.showOpenDialog(mainWindow, {
              properties: ['openDirectory'],
              title: '选择 Lumin 工作区目录'
            });
            if (!result.canceled && result.filePaths.length > 0) {
              mainWindow.webContents.send('app:menuAction', {
                action: 'openWorkspace',
                payload: result.filePaths[0]
              });
            }
          }
        },
        {
          label: '新建书籍',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => {
            mainWindow.webContents.send('app:menuAction', { action: 'newBook' });
          }
        },
        { type: 'separator' },
        {
          label: '保存',
          accelerator: 'CmdOrCtrl+S',
          click: () => {
            mainWindow.webContents.send('app:menuAction', { action: 'save' });
          }
        },
        { type: 'separator' },
        {
          label: '退出',
          accelerator: process.platform === 'darwin' ? 'Cmd+Q' : 'Alt+F4',
          click: () => app.quit()
        }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
        { type: 'separator' },
        {
          label: '查找',
          accelerator: 'CmdOrCtrl+F',
          click: () => {
            mainWindow.webContents.send('app:menuAction', { action: 'find' });
          }
        }
      ]
    },
    {
      label: '视图',
      submenu: [
        { type: 'separator' },
        {
          label: '故事画布',
          accelerator: 'CmdOrCtrl+Shift+C',
          click: function() { createCanvasWindow(); }
        },{ 
          label: '专注模式',
          accelerator: 'CmdOrCtrl+B',
          click: () => {
            mainWindow.webContents.send('app:menuAction', { action: 'focusMode' });
          }
        },
        { type: 'separator' },
        { role: 'reload', label: '重新加载' },
        { role: 'forceReload', label: '强制重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { type: 'separator' },
        {
          label: '主题',
          submenu: themeService.getAllThemes().map(function(t) {
            return { label: themeName(t), type: 'radio', checked: t === themeService.getCurrent().theme, click: function() { switchTheme(t); } };
          })
        },
        { role: 'resetZoom', label: '重置缩放' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' }
      ]
    },
    {
      label: 'AI',
      submenu: [
        {
          label: '打开 AI 助手',
          accelerator: 'CmdOrCtrl+Shift+A',
          click: () => {
            mainWindow.webContents.send('app:menuAction', { action: 'toggleAI' });
          }
        },
        {
          label: 'AI 设置',
          click: () => {
            mainWindow.webContents.send('app:menuAction', { action: 'openAISettings' });
          }
        }
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '打开帮助',
          click: () => {
            mainWindow.webContents.send('app:menuAction', { action: 'help' });
          }
        },
        {
          label: '关于 Lumin',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: '关于 Lumin',
              message: 'Lumin — AI 智能写作',
              detail: `版本: 1.0.0\nElectron: ${process.versions.electron}\nNode.js: ${process.versions.node}`
            });
          }
        }
      ]
    }
  ];

  // macOS 需要第一个菜单为应用名
  if (process.platform === 'darwin') {
    template.unshift({
      label: app.getName(),
      submenu: [
        { role: 'about', label: '关于 Lumin' },
        { type: 'separator' },
        { role: 'quit', label: '退出' }
      ]
    });
  }

  return template;
}

// IPC 处理器
function registerIpcHandlers() {
  // 流式请求控制器，用于支持停止生成
  const activeStreams = new Map();

  function registerStream(channel, stopFn) {
    activeStreams.set(channel, stopFn);
  }

  function unregisterStream(channel) {
    activeStreams.delete(channel);
  }

  function stopStream(channel) {
    const stopFn = activeStreams.get(channel);
    if (typeof stopFn === 'function') {
      try { stopFn(); } catch (e) { console.error('[Main] 停止流失败:', e); }
      activeStreams.delete(channel);
      return true;
    }
    return false;
  }

  // Ollama 拉取任务控制器
  const activePulls = new Map();

  function registerPull(channel, cancelSource) {
    activePulls.set(channel, cancelSource);
  }

  function unregisterPull(channel) {
    activePulls.delete(channel);
  }

  function stopPull(channel) {
    const source = activePulls.get(channel);
    if (source) {
      try { source.cancel('用户取消拉取'); } catch (e) { console.error('[Main] 停止拉取失败:', e); }
      activePulls.delete(channel);
      return true;
    }
    return false;
  }

  // 检测运行环境
  ipcMain.handle('app:getRuntimeInfo', () => ({
    isDesktop: true,
    platform: process.platform,
    version: app.getVersion(),
    defaultWorkspace: getDefaultWorkspacePath()
  }));

  // 打开目录选择对话框
  ipcMain.handle('dialog:openDirectory', async (_, options = {}) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: options.title || '选择目录'
    });
    return result.canceled ? null : result.filePaths[0];
  });

  // 保存文件对话框
  ipcMain.handle('dialog:showSaveDialog', async (_, options = {}) => {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: options.title || '保存文件',
      defaultPath: options.defaultPath || '',
      filters: options.filters || [{ name: 'All Files', extensions: ['*'] }]
    });
    return result;
  });

  // 确保目录存在
  ipcMain.handle('fs:ensureDir', async (_, dirPath) => {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
    return true;
  });

  // 读取文件
  ipcMain.handle('fs:readFile', async (_, filePath) => {
    return fs.promises.readFile(filePath, 'utf8');
  });

  // 写入文件（带原子写入）
  ipcMain.handle('fs:writeFile', async (_, filePath, content) => {
    const tempPath = `${filePath}.tmp`;
    await fs.promises.writeFile(tempPath, content, 'utf8');
    await fs.promises.rename(tempPath, filePath);
    return true;
  });

  // 读取目录
  ipcMain.handle('fs:readDir', async (_, dirPath) => {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    return entries.map(entry => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
      isFile: entry.isFile()
    }));
  });

  // ========== 工作区 / 书籍 / 章节 IPC ==========

  // 确保工作区目录存在
  ipcMain.handle('workspace:ensure', async (_, workspacePath) => {
    await ensureDir(workspacePath);
    return workspacePath;
  });

  // 列出工作区中所有书籍
  ipcMain.handle('workspace:listBooks', async (_, workspacePath) => {
    await ensureDir(workspacePath);
    const entries = await fs.promises.readdir(workspacePath, { withFileTypes: true });
    const books = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const bookJsonPath = path.join(workspacePath, entry.name, '.lumin', 'book.json');
      if (fs.existsSync(bookJsonPath)) {
        try {
          const book = await readJson(bookJsonPath);
          books.push({
            id: book.id || entry.name,
            title: book.title || entry.name,
            genre: book.genre || '',
            path: path.join(workspacePath, entry.name),
            updatedAt: book.updatedAt || ''
          });
        } catch (e) {
          console.error(`读取书籍失败: ${bookJsonPath}`, e);
        }
      }
    }
    return books;
  });

  // 创建书籍
  ipcMain.handle('workspace:createBook', async (_, { workspacePath, id, title, genre, summary, chapters }) => {
    await ensureDir(workspacePath);
    const folderName = sanitizeFileName(title);
    const bookPath = path.join(workspacePath, folderName);
    if (fs.existsSync(bookPath)) {
      throw new Error('书籍目录已存在');
    }
    await ensureDir(path.join(bookPath, '.lumin'));
    const now = nowIso();

    // 如果调用方提供了初始章节，使用之；否则创建默认第1章
    const initialChapters = Array.isArray(chapters) && chapters.length > 0
      ? chapters
      : [{ id: 'ch-1', title: '第1章', file: '第1章.md', wordCount: 0, text: '' }];

    const bookChapters = initialChapters.map(function (ch, idx) {
      return {
        id: ch.id || ('ch-' + (idx + 1)),
        title: ch.title || ('第' + (idx + 1) + '章'),
        file: ch.file || ('第' + (idx + 1) + '章 ' + sanitizeFileName(ch.title || '') + '.md'),
        wordCount: ch.wordCount || 0
      };
    });

    const book = {
      id: id || folderName,
      title: title || folderName,
      genre: genre || 'scifi',
      summary: summary || '',
      createdAt: now,
      updatedAt: now,
      chapters: bookChapters
    };
    await writeJson(path.join(bookPath, '.lumin', 'book.json'), book);

    for (let i = 0; i < bookChapters.length; i++) {
      const ch = bookChapters[i];
      const chapterPath = path.join(bookPath, ch.file);
      const chapterContent = stringifyFrontmatter(
        {
          id: ch.id,
          title: ch.title,
          wordCount: ch.wordCount,
          createdAt: now,
          updatedAt: now
        },
        initialChapters[i].text || ''
      );
      await fs.promises.writeFile(chapterPath, chapterContent, 'utf8');
    }

    return { bookPath, book };
  });

  // 加载整本书
  ipcMain.handle('book:load', async (_, bookPath) => {
    const bookJsonPath = path.join(bookPath, '.lumin', 'book.json');
    const book = await readJson(bookJsonPath);
    const chapters = [];
    for (const ch of book.chapters || []) {
      const chapterPath = path.join(bookPath, ch.file);
      let text = '';
      if (fs.existsSync(chapterPath)) {
        const content = await fs.promises.readFile(chapterPath, 'utf8');
        const { body } = parseFrontmatter(content);
        text = body;
      }
        try { searchIndex.indexChapter(book.id, ch.id, ch.file, ch.title, book.title, text); } catch (e) {}
      chapters.push({
        num: chapters.length + 1,
        title: ch.title,
        words: parseInt(ch.wordCount || '0', 10),
        text: text,
        draft: false,
        file: ch.file,
        id: ch.id
      });
    }
    return {
      id: book.id,
      title: book.title,
      summary: book.summary || '',
      genre: book.genre || '',
      createdAt: book.createdAt,
      updatedAt: book.updatedAt,
      chapters: chapters
    };
  });

  // 保存整本书（包括 book.json 和所有章节文件）
  ipcMain.handle('book:save', async (_, { bookPath, bookData }) => {
    await ensureDir(path.join(bookPath, '.lumin'));
    const now = nowIso();
    const bookJson = {
      id: bookData.id,
      title: bookData.title,
      genre: bookData.genre,
      summary: bookData.summary || '',
      createdAt: bookData.createdAt || now,
      updatedAt: now,
      chapters: (bookData.chapters || []).map((ch, i) => ({
        id: ch.id || `ch-${i + 1}`,
        title: ch.title,
        file: ch.file || `第${i + 1}章 ${sanitizeFileName(ch.title)}.md`,
        wordCount: ch.words || 0
      }))
    };

    // 确保每个章节都有文件路径
    for (let i = 0; i < bookJson.chapters.length; i++) {
      const ch = bookJson.chapters[i];
      if (!ch.file) {
        ch.file = `第${i + 1}章 ${sanitizeFileName(ch.title)}.md`;
      }
    }

    await writeJson(path.join(bookPath, '.lumin', 'book.json'), bookJson);

    for (let i = 0; i < (bookData.chapters || []).length; i++) {
      const ch = bookData.chapters[i];
      const fileName = bookJson.chapters[i].file;
      const chapterPath = path.join(bookPath, fileName);
      const chapterContent = stringifyFrontmatter(
        {
          id: ch.id || `ch-${i + 1}`,
          title: ch.title,
          wordCount: ch.words || 0,
          createdAt: ch.createdAt || now,
          updatedAt: now
        },
        ch.text || ''
      );
      const tempPath = `${chapterPath}.tmp`;
      await fs.promises.writeFile(tempPath, chapterContent, 'utf8');
      await fs.promises.rename(tempPath, chapterPath);
    }

    return true;
  });

  // 删除书籍
  ipcMain.handle('book:delete', async (_, bookPath) => {
    await fs.promises.rm(bookPath, { recursive: true, force: true });
    return true;
  });

  // 读取单章（用于增量更新）
  ipcMain.handle('chapter:read', async (_, { bookPath, fileName }) => {
    const chapterPath = path.join(bookPath, fileName);
    const content = await fs.promises.readFile(chapterPath, 'utf8');
    const { meta, body } = parseFrontmatter(content);
    return { meta, body };
  });

  // 保存单章（保存前自动创建快照）
  ipcMain.handle('chapter:write', async (_, { bookPath, fileName, title, text, chapterId }) => {
    const chapterPath = path.join(bookPath, fileName);

    // 根据策略创建自动快照
    try {
      const policy = await snapshotManager.getPolicy(chapterPath);
      if (policy.snapshotOnSave && fs.existsSync(chapterPath)) {
        await snapshotManager.createSnapshot(chapterPath, 'auto');
      }
    } catch (e) {
      console.error('[Main] 自动快照失败:', e);
      // 不影响主写入流程
    }

    const wordCount = countWords(text || '');
    const now = nowIso();
    const content = stringifyFrontmatter(
      {
        id: chapterId || 'ch-1',
        title: title || '',
        wordCount: wordCount,
        updatedAt: now
      },
      text || ''
    );
    const tempPath = `${chapterPath}.tmp`;
    await fs.promises.writeFile(tempPath, content, 'utf8');
    await fs.promises.rename(tempPath, chapterPath);

    try { const bId = path.basename(bookPath); const bJson = JSON.parse(await fs.promises.readFile(path.join(bookPath, ".lumin", "book.json"), "utf8")); searchIndex.indexChapter(bId, chapterId || "ch-1", fileName, title || "", bJson.title || bId, text || ""); } catch (e) {}
    return { wordCount };
  });

  // 删除单章
  ipcMain.handle('chapter:delete', async (_, { bookPath, fileName }) => {
    const chapterPath = path.join(bookPath, fileName);
    try { const bJson = JSON.parse(await fs.promises.readFile(path.join(bookPath, ".lumin", "book.json"), "utf8")); const ch = (bJson.chapters || []).find(c => c.file === fileName); if (ch && ch.id) searchIndex.removeChapter(ch.id); } catch (e) {}

    if (fs.existsSync(chapterPath)) {
      await fs.promises.unlink(chapterPath);
    }
    return true;
  });

  // ========== 版本快照 IPC ==========

  // 列出某章节的所有快照
  ipcMain.handle('snapshots:list', async (_, chapterPath) => {
    try {
      const snapshots = await snapshotManager.listSnapshots(chapterPath);
      return { success: true, snapshots };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // 创建手动快照
  ipcMain.handle('snapshot:create', async (_, { chapterPath, label, type }) => {
    try {
      const snapshot = await snapshotManager.createSnapshot(chapterPath, type || 'manual', label);
      return { success: true, snapshot };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // 恢复快照
  ipcMain.handle('snapshot:restore', async (_, snapshotPath) => {
    try {
      const result = await snapshotManager.restoreSnapshot(snapshotPath);
      return { success: true, ...result };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // 删除快照
  ipcMain.handle('snapshot:delete', async (_, snapshotPath) => {
    try {
      await snapshotManager.deleteSnapshot(snapshotPath);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // 读取快照内容
  ipcMain.handle('snapshot:read', async (_, snapshotPath) => {
    try {
      const data = await snapshotManager.readSnapshot(snapshotPath);
      return { success: true, ...data };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // 对比两个快照
  ipcMain.handle('snapshot:diff', async (_, { aPath, bPath }) => {
    try {
      const diff = await snapshotManager.diffSnapshots(aPath, bPath);
      let added = 0, removed = 0;
      diff.forEach(part => {
        if (part.type === 'added') added++;
        if (part.type === 'removed') removed++;
      });
      return { success: true, lines: diff, added, removed };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // 导出快照
  ipcMain.handle('snapshot:export', async (_, { snapshotPath, outPath }) => {
    try {
      const result = await snapshotManager.exportSnapshot(snapshotPath, outPath);
      return { success: true, ...result };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // 获取快照策略
  ipcMain.handle('snapshot:policy:get', async (_, chapterPath) => {
    try {
      const policy = await snapshotManager.getPolicy(chapterPath);
      return { success: true, policy };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // 设置快照策略
  ipcMain.handle('snapshot:policy:set', async (_, { chapterPath, policy }) => {
    try {
      const updated = await snapshotManager.setPolicy(chapterPath, policy);
      return { success: true, policy: updated };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // ========== 主题 / 专注模式 IPC ==========

  ipcMain.handle('theme:set', async (_, themeName) => {
    try {
      themeService.setTheme(themeName);
      const css = themeService.getInjectedCSS();
      if (mainWindow && !mainWindow.isDestroyed()) {
        // 清除旧样式再注入新的
        mainWindow.webContents.insertCSS(css);
      }
      return { success: true, theme: themeService.getCurrent() };
    } catch (e) { return { success: false, error: e.message }; }
  });

  ipcMain.handle('theme:get', async () => {
    return { success: true, ...themeService.getCurrent() };
  });

  ipcMain.handle('theme:list', async () => {
    return { success: true, themes: themeService.getAllThemes() };
  });

  ipcMain.handle('theme:setFont', async (_, { fontSize, lineHeight, fontFamily }) => {
    try {
      themeService.setFont(fontSize, lineHeight, fontFamily);
      const css = themeService.getInjectedCSS();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.insertCSS(css);
      }
      return { success: true, ...themeService.getCurrent() };
    } catch (e) { return { success: false, error: e.message }; }
  });

  // 专注模式切换
  ipcMain.handle('theme:toggleFocus', async (_, force) => {
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        const js = 'if(window.__luminFocusMode){delete window.__luminFocusMode;document.body.classList.remove("lumin-focus")}else{window.__luminFocusMode=true;document.body.classList.add("lumin-focus")}';
        await mainWindow.webContents.executeJavaScript(js);
        return { success: true };
      }
      return { success: false, error: 'no window' };
    } catch (e) { return { success: false, error: e.message }; }
  });

  // ========== 导出 IPC ==========

  ipcMain.handle('export:md', async (_, { bookPath, outPath, options }) => {
    try {
      const r = exportService.exportMD(bookPath, outPath, options);
      return { success: true, ...r };
    } catch (e) { return { success: false, error: e.message }; }
  });

  ipcMain.handle('export:txt', async (_, { bookPath, outPath, options }) => {
    try {
      const r = exportService.exportTXT(bookPath, outPath, options);
      return { success: true, ...r };
    } catch (e) { return { success: false, error: e.message }; }
  });

  ipcMain.handle('export:wordCount', async (_, { bookPath }) => {
    try {
      return { success: true, total: exportService.getTotalWords(bookPath) };
    } catch (e) { return { success: false, error: e.message, total: 0 }; }
  });

  // ========== 写作统计 IPC ==========

  ipcMain.handle('stats:record', async (_, { bookPath, words, minutes }) => {
    try {
      const e = statsService.recordSession(bookPath, words || 0, minutes || 0);
      return { success: true, today: e };
    } catch (e) { return { success: false, error: e.message }; }
  });

  ipcMain.handle('stats:get', async (_, { bookPath }) => {
    try {
      return { success: true, ...statsService.getStats(bookPath) };
    } catch (e) { return { success: false, error: e.message, today: {}, daily: [] }; }
  });

  ipcMain.handle('stats:trend', async (_, { bookPath, days }) => {
    try {
      return { success: true, trend: statsService.getDailyTrend(bookPath, days) };
    } catch (e) { return { success: false, error: e.message, trend: [] }; }
  });

  // ========== 专注模式 IPC ==========

  ipcMain.handle('app:toggleFocus', async () => {
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        const js = 'if(window.__luminFocusMode){delete window.__luminFocusMode;document.body.classList.remove("lumin-focus")}else{window.__luminFocusMode=true;document.body.classList.add("lumin-focus")}';
        await mainWindow.webContents.executeJavaScript(js);
        return { success: true };
      }
      return { success: false, error: 'no window' };
    } catch (e) { return { success: false, error: e.message }; }
  });

  // ========== 故事画布 IPC ==========

  ipcMain.handle('canvas:load', async (_, bookPath) => {
    try {
      const canvas = canvasService.loadCanvas(bookPath);
      return { success: true, ...canvas };
    } catch (e) {
      return { success: false, error: e.message, nodes: [], edges: [] };
    }
  });

  ipcMain.handle('canvas:save', async (_, { bookPath, canvas }) => {
    try {
      canvasService.saveCanvas(bookPath, canvas);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('canvas:addNode', async (_, { bookPath, node }) => {
    try {
      return { success: true, node: canvasService.addNode(bookPath, node) };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('canvas:updateNode', async (_, { bookPath, id, updates }) => {
    try {
      const node = canvasService.updateNode(bookPath, id, updates);
      return { success: !!node, node: node };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('canvas:deleteNode', async (_, { bookPath, id }) => {
    try {
      return { success: canvasService.deleteNode(bookPath, id) };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('canvas:addEdge', async (_, { bookPath, edge }) => {
    try {
      return { success: true, edge: canvasService.addEdge(bookPath, edge) };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('canvas:updateEdge', async (_, { bookPath, id, updates }) => {
    try {
      const edge = canvasService.updateEdge(bookPath, id, updates);
      return { success: !!edge, edge: edge };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('canvas:deleteEdge', async (_, { bookPath, id }) => {
    try {
      return { success: canvasService.deleteEdge(bookPath, id) };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('canvas:getColors', async () => {
    return { success: true, colors: canvasService.getNodeColors() };
  });

  // ========== Codex 知识库 IPC ==========

  // 读取整本知识库
  ipcMain.handle('codex:load', async (_, bookPath) => {
    try {
      const codex = codexService.loadCodex(bookPath);
      return { success: true, ...codex };
    } catch (e) {
      return { success: false, error: e.message, characters: [], locations: [], rules: [] };
    }
  });

  // 保存整本知识库
  ipcMain.handle('codex:save', async (_, { bookPath, codex }) => {
    try {
      codexService.saveCodex(bookPath, codex);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // === 人物 ===

  ipcMain.handle('codex:addCharacter', async (_, { bookPath, char }) => {
    try {
      return { success: true, character: codexService.addCharacter(bookPath, char) };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('codex:updateCharacter', async (_, { bookPath, id, updates }) => {
    try {
      const result = codexService.updateCharacter(bookPath, id, updates);
      return { success: !!result, character: result };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('codex:deleteCharacter', async (_, { bookPath, id }) => {
    try {
      return { success: codexService.deleteCharacter(bookPath, id) };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // === 地点 ===

  ipcMain.handle('codex:addLocation', async (_, { bookPath, loc }) => {
    try {
      return { success: true, location: codexService.addLocation(bookPath, loc) };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('codex:updateLocation', async (_, { bookPath, id, updates }) => {
    try {
      const result = codexService.updateLocation(bookPath, id, updates);
      return { success: !!result, location: result };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('codex:deleteLocation', async (_, { bookPath, id }) => {
    try {
      return { success: codexService.deleteLocation(bookPath, id) };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // === 规则/设定 ===

  ipcMain.handle('codex:addRule', async (_, { bookPath, rule }) => {
    try {
      return { success: true, rule: codexService.addRule(bookPath, rule) };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('codex:updateRule', async (_, { bookPath, id, updates }) => {
    try {
      const result = codexService.updateRule(bookPath, id, updates);
      return { success: !!result, rule: result };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('codex:deleteRule', async (_, { bookPath, id }) => {
    try {
      return { success: codexService.deleteRule(bookPath, id) };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // 搜索知识库
  ipcMain.handle('codex:search', async (_, { bookPath, keyword }) => {
    try {
      const result = codexService.searchCodex(bookPath, keyword);
      return { success: true, ...result };
    } catch (e) {
      return { success: false, error: e.message, characters: [], locations: [], rules: [] };
    }
  });

  // 根据文本找相关条目
  ipcMain.handle('codex:findRelevant', async (_, { bookPath, text }) => {
    try {
      const result = codexService.findRelevantCodex(bookPath, text);
      return { success: true, ...result };
    } catch (e) {
      return { success: false, error: e.message, characters: [], locations: [], rules: [] };
    }
  });

  // 构建 AI 上下文
  ipcMain.handle('codex:buildAIContext', async (_, { bookPath, text }) => {
    try {
      const ctx = codexService.buildAIContext(bookPath, text);
      return { success: true, context: ctx };
    } catch (e) {
      return { success: false, error: e.message, context: '' };
    }
  });

  // ========== 全文搜索 IPC ==========

  ipcMain.handle('search:query', async (_, { query, bookId, limit, offset }) => {
    try {
      const result = searchIndex.search(query, { bookId, limit, offset });
      return { success: true, ...result };
    } catch (e) {
      return { success: false, error: e.message, total: 0, results: [] };
    }
  });

  ipcMain.handle('search:indexChapter', async (_, { bookId, chapterId, filePath, title, bookTitle, content }) => {
    try {
      searchIndex.indexChapter(bookId, chapterId, filePath, title, bookTitle, content);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('search:removeChapter', async (_, { chapterId }) => {
    try {
      searchIndex.removeChapter(chapterId);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('search:removeBook', async (_, { bookId }) => {
    try {
      searchIndex.removeBook(bookId);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('search:getStats', async () => {
    try {
      return { success: true, ...searchIndex.getStats() };
    } catch (e) {
      return { success: false, error: e.message, indexedChapters: 0 };
    }
  });

  ipcMain.handle('search:clearAll', async () => {
    try {
      searchIndex.clearAll();
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // ========== Ollama 本地模型管理 ==========
  function normalizeOllamaUrl(url) {
    let u = (url || 'http://127.0.0.1:11434').trim();
    if (u.endsWith('/')) u = u.slice(0, -1);
    return u;
  }

  // 检测 Ollama 是否可连接
  ipcMain.handle('ollama:check', async (_, baseUrl) => {
    const url = normalizeOllamaUrl(baseUrl);
    try {
      const res = await axios.get(`${url}/api/tags`, { timeout: 5000 });
      return { success: true, online: true, version: res.data?.version || 'unknown' };
    } catch (e) {
      return { success: true, online: false, error: e.message };
    }
  });

  // 列出已安装模型
  ipcMain.handle('ollama:list', async (_, baseUrl) => {
    const url = normalizeOllamaUrl(baseUrl);
    try {
      const res = await axios.get(`${url}/api/tags`, { timeout: 10000 });
      const models = (res.data?.models || []).map(m => ({
        name: m.name || m.model,
        size: m.size || 0,
        sizeHuman: formatBytes(m.size || 0),
        modifiedAt: m.modified_at,
        digest: m.digest || '',
        details: m.details || {}
      }));
      return { success: true, models };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // 获取模型详情
  ipcMain.handle('ollama:show', async (_, { baseUrl, modelName }) => {
    const url = normalizeOllamaUrl(baseUrl);
    try {
      const res = await axios.post(`${url}/api/show`, { name: modelName }, { timeout: 10000 });
      return { success: true, info: res.data };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // 删除模型
  ipcMain.handle('ollama:delete', async (_, { baseUrl, modelName }) => {
    const url = normalizeOllamaUrl(baseUrl);
    try {
      await axios.delete(`${url}/api/delete`, { data: { name: modelName }, timeout: 30000 });
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // 拉取模型（流式进度）
  ipcMain.handle('ollama:pull', async (_, { baseUrl, modelName, channel }) => {
    const url = normalizeOllamaUrl(baseUrl);
    const CancelToken = axios.CancelToken;
    const source = CancelToken.source();
    if (channel) registerPull(channel, source);

    try {
      const response = await axios({
        method: 'post',
        url: `${url}/api/pull`,
        data: { name: modelName },
        responseType: 'stream',
        timeout: 0,
        cancelToken: source.token
      });

      return new Promise((resolve) => {
        let lastStatus = '';
        response.data.on('data', (chunk) => {
          const text = chunk.toString('utf8');
          text.split('\n').filter(line => line.trim()).forEach(line => {
            try {
              const data = JSON.parse(line);
              lastStatus = data.status || lastStatus;
              if (mainWindow && channel) {
                mainWindow.webContents.send(channel, {
                  type: 'progress',
                  status: data.status,
                  completed: data.completed,
                  total: data.total,
                  percent: data.total ? Math.round((data.completed / data.total) * 100) : null
                });
              }
            } catch (e) {
              // ignore malformed lines
            }
          });
        });
        response.data.on('end', () => {
          unregisterPull(channel);
          if (mainWindow && channel) {
            mainWindow.webContents.send(channel, { type: 'done', status: lastStatus });
          }
          resolve({ success: true });
        });
        response.data.on('error', (err) => {
          unregisterPull(channel);
          if (mainWindow && channel) {
            mainWindow.webContents.send(channel, { type: 'error', error: err.message });
          }
          resolve({ success: false, error: err.message });
        });
      });
    } catch (e) {
      unregisterPull(channel);
      const isCancel = axios.isCancel(e);
      if (mainWindow && channel) {
        mainWindow.webContents.send(channel, { type: isCancel ? 'cancel' : 'error', error: e.message });
      }
      return { success: false, error: e.message, canceled: isCancel };
    }
  });

  // 停止 Ollama 拉取
  ipcMain.handle('ollama:stopPull', (_, channel) => {
    return { success: stopPull(channel) };
  });

  function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  // ========== 同步初始化 IPC（仅在应用启动时使用） ==========

  function loadBookSync(bookPath) {
    const bookJsonPath = path.join(bookPath, '.lumin', 'book.json');
    const book = JSON.parse(fs.readFileSync(bookJsonPath, 'utf8'));
    const chapters = [];
    for (const ch of book.chapters || []) {
      const chapterPath = path.join(bookPath, ch.file);
      let text = '';
      if (fs.existsSync(chapterPath)) {
        const content = fs.readFileSync(chapterPath, 'utf8');
        const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
        text = match ? content.slice(match[0].length) : content;
      }
      chapters.push({
        num: chapters.length + 1,
        title: ch.title,
        words: parseInt(ch.wordCount || '0', 10),
        text: text,
        draft: false,
        file: ch.file,
        id: ch.id
      });
    }
    return {
      id: book.id,
      title: book.title,
      summary: book.summary || '',
      genre: book.genre || '',
      createdAt: book.createdAt,
      updatedAt: book.updatedAt,
      chapters: chapters
    };
  }

  function saveBookSync(bookPath, bookData) {
    ensureDirSync(path.join(bookPath, '.lumin'));
    const now = nowIso();
    const bookJson = {
      id: bookData.id,
      title: bookData.title,
      genre: bookData.genre,
      summary: bookData.summary || '',
      createdAt: bookData.createdAt || now,
      updatedAt: now,
      chapters: (bookData.chapters || []).map((ch, i) => ({
        id: ch.id || `ch-${i + 1}`,
        title: ch.title,
        file: ch.file || `第${i + 1}章 ${sanitizeFileName(ch.title)}.md`,
        wordCount: ch.words || 0
      }))
    };

    fs.writeFileSync(path.join(bookPath, '.lumin', 'book.json'), JSON.stringify(bookJson, null, 2), 'utf8');

    for (let i = 0; i < (bookData.chapters || []).length; i++) {
      const ch = bookData.chapters[i];
      const fileName = bookJson.chapters[i].file;
      const chapterPath = path.join(bookPath, fileName);
      const chapterContent = stringifyFrontmatter(
        {
          id: ch.id || `ch-${i + 1}`,
          title: ch.title,
          wordCount: ch.words || 0,
          createdAt: ch.createdAt || now,
          updatedAt: now
        },
        ch.text || ''
      );
      fs.writeFileSync(chapterPath, chapterContent, 'utf8');
    }
  }

  function listBooksSync(workspacePath) {
    ensureDirSync(workspacePath);
    const entries = fs.readdirSync(workspacePath, { withFileTypes: true });
    const books = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const bookJsonPath = path.join(workspacePath, entry.name, '.lumin', 'book.json');
      if (fs.existsSync(bookJsonPath)) {
        try {
          const book = JSON.parse(fs.readFileSync(bookJsonPath, 'utf8'));
          books.push({
            id: book.id || entry.name,
            title: book.title || entry.name,
            genre: book.genre || '',
            path: path.join(workspacePath, entry.name),
            updatedAt: book.updatedAt || ''
          });
        } catch (e) {
          console.error(`读取书籍失败: ${bookJsonPath}`, e);
        }
      }
    }
    return books;
  }

  // 同步接口：迁移 localStorage 数据并加载所有书籍（启动时一次性调用）
  ipcMain.on('workspace:migrateAndLoadBooks', (event, genreBooksFromStorage) => {
    try {
      const workspacePath = getDefaultWorkspacePath();
      ensureDirSync(workspacePath);

      // 如果有 localStorage 数据，先迁移到文件
      if (genreBooksFromStorage && typeof genreBooksFromStorage === 'object') {
        const genres = Object.keys(genreBooksFromStorage);
        for (const genre of genres) {
          const book = genreBooksFromStorage[genre];
          if (!book || !book.chapters || book.chapters.length === 0) continue;
          const title = book.bookName || `${genre} 新作`;
          const folderName = sanitizeFileName(title);
          const bookPath = path.join(workspacePath, folderName);
          if (!fs.existsSync(bookPath)) {
            fs.mkdirSync(path.join(bookPath, '.lumin'), { recursive: true });
            const now = nowIso();
            const bookJson = {
              id: genre,
              title: title,
              genre: genre,
              summary: book.bookSummary || '',
              createdAt: now,
              updatedAt: now,
              chapters: book.chapters.map((ch, idx) => ({
                id: `ch-${idx + 1}`,
                title: ch.title || `第${idx + 1}章`,
                file: `第${idx + 1}章 ${sanitizeFileName(ch.title)}.md`,
                wordCount: ch.words || 0
              }))
            };
            fs.writeFileSync(path.join(bookPath, '.lumin', 'book.json'), JSON.stringify(bookJson, null, 2), 'utf8');

            for (let i = 0; i < book.chapters.length; i++) {
              const ch = book.chapters[i];
              const chapterPath = path.join(bookPath, bookJson.chapters[i].file);
              const chapterContent = stringifyFrontmatter(
                {
                  id: `ch-${i + 1}`,
                  title: ch.title || `第${i + 1}章`,
                  wordCount: ch.words || 0,
                  createdAt: now,
                  updatedAt: now
                },
                ch.text || ''
              );
              fs.writeFileSync(chapterPath, chapterContent, 'utf8');
            }
          }
        }
      }

      // 加载所有书籍为 genreBooks 格式
      const books = listBooksSync(workspacePath);
      const result = {};
      for (const bookInfo of books) {
        const data = loadBookSync(bookInfo.path);
        const genre = data.genre || bookInfo.id;
        result[genre] = {
          bookName: data.title || '',
          bookSummary: data.summary || '',
          chapters: data.chapters || [],
          chapterIdx: 0,
          bookPath: bookInfo.path
        };
      }

      event.returnValue = result;
    } catch (e) {
      console.error('[Main] migrateAndLoadBooks 失败:', e);
      event.returnValue = {};
    }
  });

  // 同步接口：获取工作区信息
  ipcMain.on('workspace:getInfoSync', (event) => {
    event.returnValue = {
      defaultWorkspace: getDefaultWorkspacePath(),
      platform: process.platform
    };
  });

  // 同步接口：保存所有书籍（用于退出前或手动保存）
  ipcMain.on('workspace:saveBooksSync', (event, genreBooks) => {
    try {
      const workspacePath = getDefaultWorkspacePath();
      for (const genre of Object.keys(genreBooks || {})) {
        const book = genreBooks[genre];
        if (!book || !book.chapters) continue;
        const title = book.bookName || `${genre} 新作`;
        const folderName = sanitizeFileName(title);
        let bookPath = book.bookPath || path.join(workspacePath, folderName);
        if (!fs.existsSync(bookPath)) {
          fs.mkdirSync(path.join(bookPath, '.lumin'), { recursive: true });
        }
        saveBookSync(bookPath, {
          id: genre,
          title: book.bookName || '',
          genre: genre,
          summary: book.bookSummary || '',
          chapters: book.chapters.map((ch, idx) => ({
            id: ch.id || `ch-${idx + 1}`,
            num: ch.num || (idx + 1),
            title: ch.title || `第${idx + 1}章`,
            words: ch.words || 0,
            text: ch.text || '',
            draft: !!ch.draft,
            file: ch.file || `第${idx + 1}章 ${sanitizeFileName(ch.title)}.md`,
            createdAt: ch.createdAt
          }))
        });
      }
      event.returnValue = true;
    } catch (e) {
      console.error('[Main] saveBooksSync 失败:', e);
      event.returnValue = false;
    }
  });

  // ========== AI IPC ==========

  ipcMain.handle('ai:getProviders', () => aiService.getProviders());

  ipcMain.handle('ai:saveProvider', async (_, provider) => {
    try {
      return { success: true, provider: aiService.saveProvider(provider) };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('ai:deleteProvider', async (_, id) => {
    return { success: aiService.deleteProvider(id) };
  });

  ipcMain.handle('ai:setActiveProvider', async (_, id) => {
    return { success: aiService.setActiveProvider(id) };
  });

  ipcMain.handle('ai:fetchModels', async (_, providerId) => {
    try {
      return { success: true, models: await aiService.fetchModels(providerId) };
    } catch (e) {
      return { success: false, error: e.message, models: [] };
    }
  });

  ipcMain.handle('ai:getStats', () => {
    return aiService.getTokenStats();
  });

  // 通用流式生成
  ipcMain.handle('ai:generate', (event, params) => {
    const webContents = event.sender;
    const channel = params.channel;
    if (!channel) return { success: false, error: '缺少 channel' };

    const stopFn = aiService.streamAI(params, function (data) {
      if (!webContents.isDestroyed()) {
        webContents.send(channel, data);
      }
      if (data.type === 'done' || data.type === 'error') {
        unregisterStream(channel);
      }
    });
    registerStream(channel, stopFn);
    return { success: true, channel };
  });

  // 停止通用流式生成
  ipcMain.handle('ai:stopGenerate', (_, channel) => {
    return { success: stopStream(channel) };
  });

  // 同步非流式生成
  ipcMain.handle('ai:generateSync', async (_, params) => {
    try {
      return { success: true, result: await aiService.generateSync(params) };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // AI Agent 聊天会话
  ipcMain.handle('ai:chat:sessions', (_, projectId) => {
    return { success: true, sessions: aiService.getSessions(projectId) };
  });

  ipcMain.handle('ai:chat:messages', (_, sessionId) => {
    return { success: true, messages: aiService.getSessionMessages(sessionId) };
  });

  ipcMain.handle('ai:chat', (event, body) => {
    const webContents = event.sender;
    const channel = body.channel;
    if (!channel) return { success: false, error: '缺少 channel' };

    const projectId = body.projectId || 'default';
    const sessionId = body.sessionId || ('sess-' + Date.now());
    const userMessage = body.message || '';

    if (!userMessage.trim()) {
      webContents.send(channel, { type: 'error', error: '请输入内容' });
      webContents.send(channel, { type: 'done' });
      return { success: false, error: '请输入内容' };
    }

    // 保存用户消息
    aiService.saveSessionMessage(projectId, sessionId, 'user', userMessage);

    const messages = [
      { role: 'system', content: '你是一位专业的小说创作助手，帮助用户进行写作、构思、修改。回答请用中文。' },
      { role: 'user', content: userMessage }
    ];

    let assistantContent = '';
    const stopFn = aiService.streamAI({ providerId: body.providerId, messages: messages, options: body.options || {} }, function (data) {
      if (!webContents.isDestroyed()) {
        if (data.type === 'content') {
          assistantContent += data.content;
          webContents.send(channel, { type: 'content', text: data.content });
        } else if (data.type === 'usage') {
          webContents.send(channel, { type: 'usage', usage: data.usage });
        } else if (data.type === 'error') {
          webContents.send(channel, { type: 'error', error: data.error });
        } else if (data.type === 'done') {
          if (assistantContent) {
            aiService.saveSessionMessage(projectId, sessionId, 'assistant', assistantContent);
          }
          webContents.send(channel, { type: 'done', sessionId: sessionId });
        }
      }
      if (data.type === 'done' || data.type === 'error') {
        unregisterStream(channel);
      }
    });
    registerStream(channel, stopFn);
    return { success: true, channel, sessionId };
  });

  // 停止 AI Agent 聊天流
  ipcMain.handle('ai:stopChat', (_, channel) => {
    return { success: stopStream(channel) };
  });
}

// 应用生命周期
app.whenReady().then(() => {

  // 开机自启动
  app.setLoginItemSettings({
    openAtLogin: true,
    path: process.execPath,
    args: []
  });


  // 初始化 AI 服务（读取 Provider、统计、会话）
  aiService.init();

  const menu = Menu.buildFromTemplate(buildMenuTemplate());
  Menu.setApplicationMenu(menu);

  registerIpcHandlers();
  createMainWindow();
  // createTray();

  // macOS 点击 Dock 图标时重新创建窗口
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
  // createTray();
    }
  });
});


app.on('will-quit', function() {
  // if (tray) { tray.destroy(); tray = null; }
});
app.on('window-all-closed', () => {
  // 不退出，保持在托盘
});
