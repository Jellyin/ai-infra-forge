#!/usr/bin/env node
/**
 * 内容迁移：把 ai-infra-maas-trainer/js/data.js 的 COURSE
 * 转成 content/paths/ai-infra-engineer/ 下的结构化 path.yaml + modules/*。
 * 用法: node scripts/migrate-content.mjs
 */
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import yaml from "js-yaml";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataPath = "/Users/lv/ai-infra-maas-trainer/js/data.js";
const outRoot = join(root, "content", "paths", "ai-infra-engineer");

// 用 esm import 读 data.js（它有 export default）
const { default: COURSE } = await import(dataPath);
if (!COURSE?.days?.length) throw new Error("data.js 未导出有效 COURSE");

if (existsSync(outRoot)) rmSync(outRoot, { recursive: true, force: true });

const pad = (n) => String(n).padStart(2, "0");

// path.yaml
mkdirSync(outRoot, { recursive: true });
writeFileSync(
  join(outRoot, "path.yaml"),
  yaml.dump({
    id: "ai-infra-engineer",
    title: COURSE.title,
    subtitle: COURSE.subtitle,
    audience: "5年+ 传统运维 / DevOps 工程师",
    description: "从传统运维到 AI Infra / MaaS 平台工程师的 10 天实战路径：推理原理 + GPU 调度 + 高并发治理 + 可观测 + FinOps + 平台化。",
    version: "0.1.0",
  }, { lineWidth: -1 })
);

let totalCards = 0, totalCmds = 0, totalQuiz = 0;

for (const d of COURSE.days) {
  const id = `day${pad(d.day)}`;
  const dir = join(outRoot, "modules", id);
  mkdirSync(dir, { recursive: true });

  writeFileSync(join(dir, "module.yaml"), yaml.dump({
    id, title: d.title, goal: d.goal, order: d.day,
    read: d.read, lab: d.lab, concepts: d.concepts, checklist: d.checklist,
  }, { lineWidth: -1 }));

  // 该天的闪卡/命令/面试题（按 day 归组）
  const cards = COURSE.flashcards.filter((c) => c.day === d.day)
    .map((c, i) => ({ id: `${id}-c${i + 1}`, front: c.front, back: c.back }));
  const cmds = COURSE.commands.filter((c) => c.day === d.day)
    .map((c) => ({ hint: c.hint, cmd: c.cmd }));
  const quiz = (d.day === 10 ? COURSE.interview : []).map((q, i) => ({ id: `${id}-q${i + 1}`, q: q.q, a: q.a }));

  if (cards.length) writeFileSync(join(dir, "flashcards.yaml"), yaml.dump(cards, { lineWidth: -1 }));
  if (cmds.length) writeFileSync(join(dir, "commands.yaml"), yaml.dump(cmds, { lineWidth: -1 }));
  if (quiz.length) writeFileSync(join(dir, "quiz.yaml"), yaml.dump(quiz, { lineWidth: -1 }));

  // guide/lab 占位（正文后续从三份 md 精修填入）
  writeFileSync(join(dir, "guide.md"), `---\ntitle: ${d.title}\n---\n\n# Day ${d.day} · ${d.title}\n\n> 目标：${d.goal}\n\n（教程正文待从完整版教程精修填入）\n`);

  totalCards += cards.length; totalCmds += cmds.length; totalQuiz += quiz.length;
}

console.log(`✓ 迁移完成 → ${outRoot}`);
console.log(`  路径: 1, 模块: ${COURSE.days.length}, 闪卡: ${totalCards}, 命令: ${totalCmds}, 面试: ${totalQuiz}`);
