// 导出模块
// 将书籍章节导出为 MD / TXT 格式
const path = require("path");
const fs = require("fs");

// 解析 frontmatter
function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { meta: {}, body: content };
  const meta = {};
  match[1].split("\n").forEach(function(line) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  });
  return { meta: meta, body: content.slice(match[0].length) };
}

// 导出为单个 MD 文件（合并所有章节）
function exportMD(bookPath, outPath, options) {
  options = options || {};
  const bookJsonPath = path.join(bookPath, ".lumin", "book.json");
  if (!fs.existsSync(bookJsonPath)) throw new Error("book.json 不存在");
  const book = JSON.parse(fs.readFileSync(bookJsonPath, "utf8"));
  
  const lines = [];
  lines.push("# " + (book.title || "未命名"));
  if (book.summary) lines.push("> " + book.summary);
  lines.push("");
  
  const chapters = book.chapters || [];
  for (var i = 0; i < chapters.length; i++) {
    const ch = chapters[i];
    const chapterPath = path.join(bookPath, ch.file);
    if (!fs.existsSync(chapterPath)) continue;
    const content = fs.readFileSync(chapterPath, "utf8");
    const parsed = parseFrontmatter(content);
    lines.push("## " + (parsed.meta.title || ch.title || ("第" + (i + 1) + "章")));
    lines.push("");
    lines.push(parsed.body.trim());
    lines.push("");
    lines.push("---");
    lines.push("");
  }
  
  fs.writeFileSync(outPath, lines.join("\n"), "utf8");
  return { outPath: outPath, chapters: chapters.length, format: "md" };
}

// 导出为 TXT（纯文本，无格式）
function exportTXT(bookPath, outPath, options) {
  options = options || {};
  const bookJsonPath = path.join(bookPath, ".lumin", "book.json");
  if (!fs.existsSync(bookJsonPath)) throw new Error("book.json 不存在");
  const book = JSON.parse(fs.readFileSync(bookJsonPath, "utf8"));
  
  const lines = [];
  if (!options.noTitle) {
    lines.push(book.title || "未命名");
    lines.push("=".repeat(Math.max(20, (book.title || "").length + 10)));
    lines.push("");
  }
  
  const chapters = book.chapters || [];
  for (var i = 0; i < chapters.length; i++) {
    const ch = chapters[i];
    const chapterPath = path.join(bookPath, ch.file);
    if (!fs.existsSync(chapterPath)) continue;
    const content = fs.readFileSync(chapterPath, "utf8");
    const parsed = parseFrontmatter(content);
    if (!options.noChapterTitles) {
      lines.push((parsed.meta.title || ch.title || ("第" + (i + 1) + "章")));
      lines.push("-".repeat(30));
      lines.push("");
    }
    lines.push(parsed.body.trim());
    lines.push("");
    lines.push("");
  }
  
  fs.writeFileSync(outPath, lines.join("\n"), "utf8");
  return { outPath: outPath, chapters: chapters.length, format: "txt" };
}

// 获取总字数
function getTotalWords(bookPath) {
  const bookJsonPath = path.join(bookPath, ".lumin", "book.json");
  if (!fs.existsSync(bookJsonPath)) return 0;
  const book = JSON.parse(fs.readFileSync(bookJsonPath, "utf8"));
  let total = 0;
  (book.chapters || []).forEach(function(ch) { total += (ch.wordCount || 0); });
  return total;
}

function countChineseWords(text) {
  const cn = (text.match(/[\\u4e00-\\u9fa5]/g) || []).length;
  const en = (text.match(/[a-zA-Z0-9]+/g) || []).length;
  return cn + en;
}

module.exports = { exportMD: exportMD, exportTXT: exportTXT, getTotalWords: getTotalWords, countWords: countChineseWords };