// 全文搜索索引模块
// SQLite FTS5 实现，支持跨书籍全文搜索，返回带上下文的摘要
const path = require("path");
const os = require("os");
const Database = require("better-sqlite3");

const APP_DIR = path.join(
  os.homedir(),
  process.platform === "win32" ? "AppData/Roaming/Lumin" : "Library/Application Support/Lumin"
);
const DB_PATH = path.join(APP_DIR, "search-index.db");

let db = null;

function ensureDir() {
  const fs = require("fs");
  if (!fs.existsSync(APP_DIR)) {
    fs.mkdirSync(APP_DIR, { recursive: true });
  }
}

function open() {
  if (db) return db;
  ensureDir();
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  createTables();
  return db;
}

function createTables() {
  db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(book_id,chapter_id,file_path,title,book_title,content,tokenize='unicode61')");
}

function close() {
  if (db) {
    try { db.close(); } catch (e) {}
    db = null;
  }
}

// 索引单个章节：先删旧记录再插入
function indexChapter(bookId, chapterId, filePath, title, bookTitle, content) {
  const d = open();
  d.prepare("DELETE FROM search_index WHERE chapter_id = ?").run(chapterId);
  d.prepare("INSERT INTO search_index (book_id,chapter_id,file_path,title,book_title,content) VALUES (?,?,?,?,?,?)").run(bookId, chapterId, filePath, title || "", bookTitle || "", content || "");
}

// 删除某个章节的索引
function removeChapter(chapterId) {
  const d = open();
  d.prepare("DELETE FROM search_index WHERE chapter_id = ?").run(chapterId);
}

// 删除整本书的索引
function removeBook(bookId) {
  const d = open();
  d.prepare("DELETE FROM search_index WHERE book_id = ?").run(bookId);
}

// 全文搜索
function search(query, options) {
  options = options || {};
  const d = open();
  const limit = options.limit || 50;
  const offset = options.offset || 0;

  const terms = (query || "").trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return { total: 0, results: [] };

  let ftsQuery;
  if (terms.length === 1) {
    ftsQuery = '"' + terms[0] + '"*';
  } else {
    ftsQuery = terms.map(function(t) { return '"' + t + '"*'; }).join(" AND ");
  }

  let sql, params;
  if (options.bookId) {
    sql = "SELECT book_id,chapter_id,file_path,title,book_title,snippet(search_index,2,'<mark>','</mark>','...',40) AS snippet,rank FROM search_index WHERE search_index MATCH ? AND book_id=? ORDER BY rank LIMIT ? OFFSET ?";
    params = [ftsQuery, options.bookId, limit, offset];
  } else {
    sql = "SELECT book_id,chapter_id,file_path,title,book_title,snippet(search_index,2,'<mark>','</mark>','...',40) AS snippet,rank FROM search_index WHERE search_index MATCH ? ORDER BY rank LIMIT ? OFFSET ?";
    params = [ftsQuery, limit, offset];
  }

  const stmt = d.prepare(sql);
  const rows = stmt.all(...params);

  let countSql, countParams;
  if (options.bookId) {
    countSql = "SELECT COUNT(*) AS total FROM search_index WHERE search_index MATCH ? AND book_id=?";
    countParams = [ftsQuery, options.bookId];
  } else {
    countSql = "SELECT COUNT(*) AS total FROM search_index WHERE search_index MATCH ?";
    countParams = [ftsQuery];
  }
  const countStmt = d.prepare(countSql);
  const countResult = countStmt.get(...countParams);
  const total = countResult ? countResult.total : 0;

  return {
    total: total,
    results: rows.map(function(r) {
      return {
        bookId: r.book_id,
        chapterId: r.chapter_id,
        filePath: r.file_path,
        title: r.title,
        bookTitle: r.book_title,
        snippet: r.snippet
      };
    }),
    query: query,
    limit: limit,
    offset: offset
  };
}

function getStats() {
  const d = open();
  const row = d.prepare("SELECT COUNT(*) AS total FROM search_index").get();
  return { indexedChapters: row ? row.total : 0 };
}

function clearAll() {
  const d = open();
  d.prepare("DELETE FROM search_index").run();
}

module.exports = { open: open, close: close, indexChapter: indexChapter, removeChapter: removeChapter, removeBook: removeBook, search: search, getStats: getStats, clearAll: clearAll };