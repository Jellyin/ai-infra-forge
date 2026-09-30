/**
 * 内容模式：类型定义 + zod 校验。
 * 内容即数据 —— 新学习路径 = 在 content/paths/ 下加一个目录，不改代码。
 */
import { z } from "zod";

/* ---------- 闪卡 ---------- */
export const FlashcardSchema = z.object({
  id: z.string().optional(),
  front: z.string().min(1),
  back: z.string().min(1),
  module: z.string().optional(),
});
export type Flashcard = z.infer<typeof FlashcardSchema>;

/* ---------- 命令训练 ---------- */
export const CommandSchema = z.object({
  id: z.string().optional(),          // 模块内唯一；缺省回退用 hint 作 key
  hint: z.string().min(1),
  cmd: z.string().min(1),
  module: z.string().optional(),
});
export type Command = z.infer<typeof CommandSchema>;

/* ---------- 面试/自测 ---------- */
export const QuizItemSchema = z.object({
  id: z.string().optional(),          // 模块内唯一；缺省回退用 q 作 key
  q: z.string().min(1),
  a: z.string().min(1),
  module: z.string().optional(),
});
export type QuizItem = z.infer<typeof QuizItemSchema>;

/* ---------- 模块（一天/一章） ---------- */
export const ModuleSchema = z.object({
  id: z.string().min(1),                 // day01
  title: z.string().min(1),
  goal: z.string().optional(),
  order: z.number().int().positive(),
  read: z.number().nonnegative().optional(),  // 建议阅读分钟
  lab: z.number().nonnegative().optional(),   // 建议动手分钟
  concepts: z.array(z.string()).default([]),
  checklist: z.array(z.string()).default([]),
});
export type Module = z.infer<typeof ModuleSchema>;

/* ---------- 路径 ---------- */
export const PathSchema = z.object({
  id: z.string().min(1),                 // ai-infra-engineer
  title: z.string().min(1),
  subtitle: z.string().optional(),
  description: z.string().optional(),
  audience: z.string().optional(),
  version: z.string().default("0.1.0"),
});
export type Path = z.infer<typeof PathSchema>;

/* ---------- 模块完整内容（schema 聚合后） ---------- */
export interface ModuleContent extends Module {
  guideMd: string;          // 教程正文 markdown
  labMd: string;            // 实验正文 markdown
  flashcards: Flashcard[];
  commands: Command[];
  quiz: QuizItem[];
}

export interface PathContent extends Path {
  modules: ModuleContent[];
}

export const Schemas = { FlashcardSchema, CommandSchema, QuizItemSchema, ModuleSchema, PathSchema };
