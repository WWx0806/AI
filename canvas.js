// 故事画布模块
// 存储 .lumin/canvas.json，管理节点和连线，支持 AI 辅助提取
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

function uid() {
  return crypto.randomBytes(8).toString("hex");
}

function getCanvasPath(bookPath) {
  return path.join(bookPath, ".lumin", "canvas.json");
}

function ensureLuminDir(bookPath) {
  const dir = path.join(bookPath, ".lumin");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// 节点类型预设颜色
const NODE_COLORS = {
  character: "#6366f1",  // 靛蓝
  event: "#f59e0b",      // 琥珀
  location: "#10b981",   // 翠绿
  note: "#8b5cf6",        // 紫色
  chapter: "#ef4444"      // 红色
};

// 读取画布
function loadCanvas(bookPath) {
  const filePath = getCanvasPath(bookPath);
  if (!fs.existsSync(filePath)) {
    return { nodes: [], edges: [], updatedAt: "" };
  }
  try {
    const text = fs.readFileSync(filePath, "utf8");
    return JSON.parse(text);
  } catch (e) {
    return { nodes: [], edges: [], updatedAt: "" };
  }
}

// 保存画布（原子写入）
function saveCanvas(bookPath, canvas) {
  ensureLuminDir(bookPath);
  const filePath = getCanvasPath(bookPath);
  const data = JSON.stringify({
    nodes: canvas.nodes || [],
    edges: canvas.edges || [],
    updatedAt: new Date().toISOString()
  }, null, 2);
  const tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, data, "utf8");
  fs.renameSync(tmpPath, filePath);
}

// 添加节点
function addNode(bookPath, node) {
  const canvas = loadCanvas(bookPath);
  const n = {
    id: node.id || ("node-" + uid()),
    type: node.type || "note",
    label: node.label || "",
    x: typeof node.x === "number" ? node.x : 300,
    y: typeof node.y === "number" ? node.y : 200,
    description: node.description || "",
    color: node.color || NODE_COLORS[node.type] || "#8b5cf6",
    createdAt: new Date().toISOString()
  };
  canvas.nodes.push(n);
  saveCanvas(bookPath, canvas);
  return n;
}

// 更新节点
function updateNode(bookPath, id, updates) {
  const canvas = loadCanvas(bookPath);
  const idx = canvas.nodes.findIndex(function(n) { return n.id === id; });
  if (idx < 0) return null;
  Object.keys(updates).forEach(function(key) {
    if (key !== "id" && key !== "createdAt") {
      canvas.nodes[idx][key] = updates[key];
    }
  });
  saveCanvas(bookPath, canvas);
  return canvas.nodes[idx];
}

// 删除节点及关联连线
function deleteNode(bookPath, id) {
  const canvas = loadCanvas(bookPath);
  canvas.nodes = canvas.nodes.filter(function(n) { return n.id !== id; });
  canvas.edges = canvas.edges.filter(function(e) {
    return e.source !== id && e.target !== id;
  });
  saveCanvas(bookPath, canvas);
  return true;
}

// 添加连线
function addEdge(bookPath, edge) {
  const canvas = loadCanvas(bookPath);
  const e = {
    id: edge.id || ("edge-" + uid()),
    source: edge.source || "",
    target: edge.target || "",
    label: edge.label || "",
    type: edge.type || "relation",
    createdAt: new Date().toISOString()
  };
  canvas.edges.push(e);
  saveCanvas(bookPath, canvas);
  return e;
}

// 更新连线
function updateEdge(bookPath, id, updates) {
  const canvas = loadCanvas(bookPath);
  const idx = canvas.edges.findIndex(function(e) { return e.id === id; });
  if (idx < 0) return null;
  Object.keys(updates).forEach(function(key) {
    if (key !== "id" && key !== "createdAt") {
      canvas.edges[idx][key] = updates[key];
    }
  });
  saveCanvas(bookPath, canvas);
  return canvas.edges[idx];
}

// 删除连线
function deleteEdge(bookPath, id) {
  const canvas = loadCanvas(bookPath);
  canvas.edges = canvas.edges.filter(function(e) { return e.id !== id; });
  saveCanvas(bookPath, canvas);
  return true;
}

// 获取节点类型颜色映射
function getNodeColors() {
  return NODE_COLORS;
}

module.exports = {
  loadCanvas: loadCanvas,
  saveCanvas: saveCanvas,
  addNode: addNode,
  updateNode: updateNode,
  deleteNode: deleteNode,
  addEdge: addEdge,
  updateEdge: updateEdge,
  deleteEdge: deleteEdge,
  getNodeColors: getNodeColors,
  NODE_COLORS: NODE_COLORS
};