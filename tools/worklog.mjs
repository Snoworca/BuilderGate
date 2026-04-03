#!/usr/bin/env node
/**
 * worklog CLI — JSONL 작업 로그 추가 도구
 *
 * Usage:
 *   node tools/worklog.mjs add \
 *     --request "사용자 요청 원문" \
 *     --analysis "문제 원인 분석" \
 *     --solution "해결 방법" \
 *     --files "file1.ts,file2.tsx" \
 *     --commit "abc1234 fix: 커밋 메시지"
 *
 *   node tools/worklog.mjs list          # 오늘 로그 출력
 *   node tools/worklog.mjs list 2026-04-03  # 특정 날짜 로그 출력
 */

import fs from 'fs';
import path from 'path';

const WORKLOG_DIR = path.resolve(import.meta.dirname, '..', 'docs', 'worklog');

function getDate(dateStr) {
  if (dateStr) return dateStr;
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function getFilePath(dateStr) {
  return path.join(WORKLOG_DIR, `${dateStr}.jsonl`);
}

function parseArgs(args) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--') && i + 1 < args.length) {
      const key = args[i].slice(2);
      result[key] = args[++i];
    }
  }
  return result;
}

function cmdAdd(args) {
  const opts = parseArgs(args);
  const required = ['request', 'analysis', 'solution', 'files', 'commit'];
  const missing = required.filter(k => !opts[k]);
  if (missing.length > 0) {
    console.error(`Missing required fields: ${missing.join(', ')}`);
    console.error('Usage: node tools/worklog.mjs add --request "..." --analysis "..." --solution "..." --files "f1,f2" --commit "hash msg"');
    process.exit(1);
  }

  const dateStr = getDate(opts.date);
  const filePath = getFilePath(dateStr);

  fs.mkdirSync(WORKLOG_DIR, { recursive: true });

  const entry = {
    timestamp: new Date().toISOString(),
    request: opts.request,
    analysis: opts.analysis,
    solution: opts.solution,
    files_changed: opts.files.split(',').map(f => f.trim()),
    commit: opts.commit,
  };

  const line = JSON.stringify(entry);
  fs.appendFileSync(filePath, line + '\n', 'utf-8');
  console.log(`Added to ${path.relative(process.cwd(), filePath)}`);
  console.log(line);
}

function cmdList(args) {
  const dateStr = getDate(args[0]);
  const filePath = getFilePath(dateStr);

  if (!fs.existsSync(filePath)) {
    console.log(`No worklog for ${dateStr}`);
    return;
  }

  const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n').filter(Boolean);
  console.log(`=== ${dateStr} (${lines.length} entries) ===\n`);

  lines.forEach((line, i) => {
    try {
      const entry = JSON.parse(line);
      console.log(`[${i + 1}] ${entry.timestamp}`);
      console.log(`    Request:  ${entry.request}`);
      console.log(`    Analysis: ${entry.analysis.substring(0, 80)}...`);
      console.log(`    Solution: ${entry.solution.substring(0, 80)}...`);
      console.log(`    Files:    ${entry.files_changed.join(', ')}`);
      console.log(`    Commit:   ${entry.commit}`);
      console.log('');
    } catch {
      console.log(`[${i + 1}] (parse error) ${line.substring(0, 100)}`);
    }
  });
}

// Main
const [cmd, ...rest] = process.argv.slice(2);

switch (cmd) {
  case 'add':
    cmdAdd(rest);
    break;
  case 'list':
    cmdList(rest);
    break;
  default:
    console.log('worklog CLI — JSONL 작업 로그 도구');
    console.log('');
    console.log('Commands:');
    console.log('  add   --request "..." --analysis "..." --solution "..." --files "f1,f2" --commit "hash msg"');
    console.log('  list  [yyyy-mm-dd]    오늘 또는 특정 날짜 로그 출력');
    break;
}
