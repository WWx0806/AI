// Codex 知识库模块
// 管理人物、地点、设定，存储为 .lumin/codex.json
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

function uid() {
  return crypto.randomBytes(8).toString("hex");
}

function ensureLuminDir(bookPath) {
  const dir = path.join(bookPath, ".lumin");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function getCodexPath(bookPath) {
  return path.join(bookPath, ".lumin", "codex.json");
}

// 读取整本知识库，不存在则返回空结构
function loadCodex(bookPath) {
  const filePath = getCodexPath(bookPath);
  if (!fs.existsSync(filePath)) {
    return { characters: [], locations: [], rules: [] };
  }
  try {
    const text = fs.readFileSync(filePath, "utf8");
    const data = JSON.parse(text);
    return {
      characters: data.characters || [],
      locations: data.locations || [],
      rules: data.rules || []
    };
  } catch (e) {
    return { characters: [], locations: [], rules: [] };
  }
}

// 保存整本知识库（原子写入）
function saveCodex(bookPath, codex) {
  ensureLuminDir(bookPath);
  const filePath = getCodexPath(bookPath);
  const data = JSON.stringify({
    characters: codex.characters || [],
    locations: codex.locations || [],
    rules: codex.rules || []
  }, null, 2);
  const tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, data, "utf8");
  fs.renameSync(tmpPath, filePath);
}

// === 人物 CRUD ===

function addCharacter(bookPath, char) {
  const codex = loadCodex(bookPath);
  const entry = {
    id: char.id || ("char-" + uid()),
    name: char.name || "",
    aliases: char.aliases || [],
    description: char.description || "",
    tags: char.tags || [],
    relations: char.relations || [],
    createdAt: char.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  // 同名覆盖
  const idx = codex.characters.findIndex(function(c) { return c.id === entry.id; });
  if (idx >= 0) {
    codex.characters[idx] = entry;
  } else {
    codex.characters.push(entry);
  }
  saveCodex(bookPath, codex);
  return entry;
}

function updateCharacter(bookPath, id, updates) {
  const codex = loadCodex(bookPath);
  const idx = codex.characters.findIndex(function(c) { return c.id === id; });
  if (idx < 0) return null;
  Object.keys(updates).forEach(function(key) {
    if (key !== "id" && key !== "createdAt") {
      codex.characters[idx][key] = updates[key];
    }
  });
  codex.characters[idx].updatedAt = new Date().toISOString();
  saveCodex(bookPath, codex);
  return codex.characters[idx];
}

function deleteCharacter(bookPath, id) {
  const codex = loadCodex(bookPath);
  const before = codex.characters.length;
  codex.characters = codex.characters.filter(function(c) { return c.id !== id; });
  if (codex.characters.length === before) return false;
  // 清理其他人物对该人物的引用
  codex.characters.forEach(function(c) {
    if (c.relations) {
      c.relations = c.relations.filter(function(r) { return r.target !== id; });
    }
  });
  saveCodex(bookPath, codex);
  return true;
}

// === 地点 CRUD ===

function addLocation(bookPath, loc) {
  const codex = loadCodex(bookPath);
  const entry = {
    id: loc.id || ("loc-" + uid()),
    name: loc.name || "",
    description: loc.description || "",
    tags: loc.tags || [],
    createdAt: loc.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const idx = codex.locations.findIndex(function(l) { return l.id === entry.id; });
  if (idx >= 0) {
    codex.locations[idx] = entry;
  } else {
    codex.locations.push(entry);
  }
  saveCodex(bookPath, codex);
  return entry;
}

function updateLocation(bookPath, id, updates) {
  const codex = loadCodex(bookPath);
  const idx = codex.locations.findIndex(function(l) { return l.id === id; });
  if (idx < 0) return null;
  Object.keys(updates).forEach(function(key) {
    if (key !== "id" && key !== "createdAt") {
      codex.locations[idx][key] = updates[key];
    }
  });
  codex.locations[idx].updatedAt = new Date().toISOString();
  saveCodex(bookPath, codex);
  return codex.locations[idx];
}

function deleteLocation(bookPath, id) {
  const codex = loadCodex(bookPath);
  const before = codex.locations.length;
  codex.locations = codex.locations.filter(function(l) { return l.id !== id; });
  if (codex.locations.length === before) return false;
  saveCodex(bookPath, codex);
  return true;
}

// === 设定/规则 CRUD ===

function addRule(bookPath, rule) {
  const codex = loadCodex(bookPath);
  const entry = {
    id: rule.id || ("rule-" + uid()),
    title: rule.title || "",
    content: rule.content || "",
    tags: rule.tags || [],
    createdAt: rule.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const idx = codex.rules.findIndex(function(r) { return r.id === entry.id; });
  if (idx >= 0) {
    codex.rules[idx] = entry;
  } else {
    codex.rules.push(entry);
  }
  saveCodex(bookPath, codex);
  return entry;
}

function updateRule(bookPath, id, updates) {
  const codex = loadCodex(bookPath);
  const idx = codex.rules.findIndex(function(r) { return r.id === id; });
  if (idx < 0) return null;
  Object.keys(updates).forEach(function(key) {
    if (key !== "id" && key !== "createdAt") {
      codex.rules[idx][key] = updates[key];
    }
  });
  codex.rules[idx].updatedAt = new Date().toISOString();
  saveCodex(bookPath, codex);
  return codex.rules[idx];
}

function deleteRule(bookPath, id) {
  const codex = loadCodex(bookPath);
  const before = codex.rules.length;
  codex.rules = codex.rules.filter(function(r) { return r.id !== id; });
  if (codex.rules.length === before) return false;
  saveCodex(bookPath, codex);
  return true;
}

// === 查询 ===

// 按关键词搜索 Codex（匹配名称、描述、标签）
function searchCodex(bookPath, keyword) {
  const codex = loadCodex(bookPath);
  const kw = (keyword || "").toLowerCase();
  if (!kw) return { characters: codex.characters, locations: codex.locations, rules: codex.rules };

  function matches(entry) {
    if ((entry.name || "").toLowerCase().includes(kw)) return true;
    if ((entry.title || "").toLowerCase().includes(kw)) return true;
    if ((entry.description || "").toLowerCase().includes(kw)) return true;
    if ((entry.content || "").toLowerCase().includes(kw)) return true;
    if ((entry.tags || []).some(function(t) { return t.toLowerCase().includes(kw); })) return true;
    if ((entry.aliases || []).some(function(a) { return a.toLowerCase().includes(kw); })) return true;
    return false;
  }

  return {
    characters: codex.characters.filter(matches),
    locations: codex.locations.filter(matches),
    rules: codex.rules.filter(matches)
  };
}

// 根据文本内容提取相关 Codex 条目（匹配名称/别名）
function findRelevantCodex(bookPath, text) {
  const codex = loadCodex(bookPath);
  const t = (text || "").toLowerCase();
  if (!t) return { characters: [], locations: [], rules: [] };

  function nameMatches(entry) {
    const names = [entry.name, entry.title].concat(entry.aliases || []).filter(Boolean);
    return names.some(function(n) { return n.length > 0 && t.includes(n.toLowerCase()); });
  }

  return {
    characters: codex.characters.filter(nameMatches),
    locations: codex.locations.filter(nameMatches),
    rules: codex.rules.filter(nameMatches)
  };
}

// 构建 AI 上下文文本
function buildAIContext(bookPath, relevantText) {
  const relevant = findRelevantCodex(bookPath, relevantText);
  const parts = [];

  if (relevant.characters.length > 0) {
    parts.push("【相关人物】");
    relevant.characters.forEach(function(c) {
      var line = "- " + c.name;
      if (c.aliases.length > 0) line += "（别名：" + c.aliases.join("、") + "）";
      parts.push(line);
      if (c.description) parts.push("  " + c.description);
      if (c.relations && c.relations.length > 0) {
        var rels = c.relations.map(function(r) {
          var target = relevant.characters.find(function(cc) { return cc.id === r.target; });
          return r.type + "：[" + (target ? target.name : r.target) + "]";
        }).join("，");
        parts.push("  关系：" + rels);
      }
    });
    parts.push("");
  }

  if (relevant.locations.length > 0) {
    parts.push("【相关地点】");
    relevant.locations.forEach(function(l) {
      parts.push("- " + l.name);
      if (l.description) parts.push("  " + l.description);
    });
    parts.push("");
  }

  if (relevant.rules.length > 0) {
    parts.push("【相关设定/规则】");
    relevant.rules.forEach(function(r) {
      parts.push("- " + r.title);
      if (r.content) parts.push("  " + r.content);
    });
    parts.push("");
  }

  return parts.join("\n");
}

module.exports = {
  loadCodex: loadCodex,
  saveCodex: saveCodex,
  addCharacter: addCharacter,
  updateCharacter: updateCharacter,
  deleteCharacter: deleteCharacter,
  addLocation: addLocation,
  updateLocation: updateLocation,
  deleteLocation: deleteLocation,
  addRule: addRule,
  updateRule: updateRule,
  deleteRule: deleteRule,
  searchCodex: searchCodex,
  findRelevantCodex: findRelevantCodex,
  buildAIContext: buildAIContext
};