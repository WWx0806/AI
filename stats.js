// 写作统计模块
// 记录每日字数、写作时长，存储在 .lumin/stats.json
const path = require("path");
const fs = require("fs");

function getStatsPath(bookPath) {
  return path.join(bookPath, ".lumin", "stats.json");
}

function loadStats(bookPath) {
  const p = getStatsPath(bookPath);
  if (!fs.existsSync(p)) {
    return { daily: [], sessions: [], totalWords: 0, createdAt: new Date().toISOString() };
  }
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    return { daily: [], sessions: [], totalWords: 0, createdAt: new Date().toISOString() };
  }
}

function saveStats(bookPath, stats) {
  const luminDir = path.join(bookPath, ".lumin");
  if (!fs.existsSync(luminDir)) fs.mkdirSync(luminDir, { recursive: true });
  const p = getStatsPath(bookPath);
  const tmpPath = p + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(stats, null, 2), "utf8");
  fs.renameSync(tmpPath, p);
}

// 记录一次写作会话
function recordSession(bookPath, wordsWritten, durationMinutes) {
  const stats = loadStats(bookPath);
  const today = new Date().toISOString().slice(0, 10);
  
  // 更新每日统计
  var dailyEntry = stats.daily.find(function(d) { return d.date === today; });
  if (!dailyEntry) {
    dailyEntry = { date: today, wordsWritten: 0, wordsDeleted: 0, minutesActive: 0, sessions: 0 };
    stats.daily.push(dailyEntry);
  }
  dailyEntry.wordsWritten += (wordsWritten || 0);
  dailyEntry.minutesActive += (durationMinutes || 0);
  dailyEntry.sessions += 1;
  
  // 添加会话记录
  stats.sessions.push({
    date: new Date().toISOString(),
    words: wordsWritten || 0,
    minutes: durationMinutes || 0
  });
  // 保留最近 500 条会话
  if (stats.sessions.length > 500) {
    stats.sessions = stats.sessions.slice(-500);
  }
  
  // 更新总字数
  stats.totalWords = (stats.totalWords || 0) + (wordsWritten || 0);
  stats.updatedAt = new Date().toISOString();
  
  saveStats(bookPath, stats);
  return dailyEntry;
}

// 获取统计数据
function getStats(bookPath) {
  const stats = loadStats(bookPath);
  const today = new Date().toISOString().slice(0, 10);
  const todayEntry = stats.daily.find(function(d) { return d.date === today; }) || { date: today, wordsWritten: 0, wordsDeleted: 0, minutesActive: 0, sessions: 0 };
  
  // 本周统计
  const now = new Date();
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - now.getDay());
  const weekWords = stats.daily.filter(function(d) { return d.date >= weekStart.toISOString().slice(0, 10); }).reduce(function(s, d) { return s + d.wordsWritten; }, 0);
  
  // 计算总数
  const totalSessions = stats.sessions.length;
  const totalMinutes = stats.daily.reduce(function(s, d) { return s + d.minutesActive; }, 0);
  
  return {
    today: todayEntry,
    weekWords: weekWords,
    totalWords: stats.totalWords || 0,
    totalSessions: totalSessions,
    totalMinutes: totalMinutes,
    daily: stats.daily.slice(-30), // 最近 30 天
    updatedAt: stats.updatedAt || ""
  };
}

// 获取每日趋势（最近 N 天）
function getDailyTrend(bookPath, days) {
  const stats = loadStats(bookPath);
  days = days || 30;
  return stats.daily.slice(-days);
}

module.exports = { recordSession: recordSession, getStats: getStats, getDailyTrend: getDailyTrend };