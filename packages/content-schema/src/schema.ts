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
  /** 所属轨道（可选）：多轨道路径用它分组展示，学习者可自行挑选先学哪条 */
  track: z.string().optional(),
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
  /** 学习单元的称量词：岗位类路径用「Day」，项目实践类可用「里程碑」「阶段」等。
   *  界面上的「Day 3 · …」会跟着它变，避免项目类路径被叫作「Day」。 */
  unit: z.string().default("Day"),
});
export type Path = z.infer<typeof PathSchema>;

/* ---------- 模块元数据（运行时实际需要的最小集合） ----------
 * guideMd/labMd 是体积主项（30 天正文 ≈ 全部内容的九成），拆到独立模块按需加载，
 * 首屏就不必为没打开的天数付出解析成本。 */
export interface ModuleMeta extends Module {
  hasGuide: boolean;        // 构建期探测（替代运行时判断 guideMd 是否为空）
  hasLab: boolean;
  flashcards: Flashcard[];
  commands: Command[];
  quiz: QuizItem[];
}

export interface PathMeta extends Path {
  modules: ModuleMeta[];
}

/** 正文：按 `${pathId}:${moduleId}` 索引，由虚拟模块 virtual:aiforge-content/docs 提供 */
export interface ModuleDocs { guideMd: string; labMd: string }
export type DocsMap = Record<string, ModuleDocs>;

/* ---------- 模块完整内容（含正文；校验脚本与工具链用） ---------- */
export interface ModuleContent extends ModuleMeta {
  guideMd: string;          // 教程正文 markdown
  labMd: string;            // 实验正文 markdown
}

export interface PathContent extends PathMeta {
  modules: ModuleContent[];
}

export const Schemas = { FlashcardSchema, CommandSchema, QuizItemSchema, ModuleSchema, PathSchema };
