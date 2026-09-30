/** 进度 key 统一生成。
 *  背景（评审 M4）：此前 `${m.id}:${...}` 模式散落 4 个组件，任何一处改动不同步
 *  都会让 localStorage 旧进度静默失配。收敛到这一处，且带 path 维度——
 *  多路径上线时不同路径的进度天然隔离，无需迁移。
 *  注意：带 path 前缀后，旧格式（无前缀）的存量进度会失配——本项目尚无真实用户，可接受。 */
import type { Flashcard, Command, QuizItem } from "@aiforge/content-schema";

interface HasId { id: string }

export function checkKey(pathId: string, mod: HasId, index: number): string {
  return `${pathId}:${mod.id}:${index}`;
}

export function cardKey(pathId: string, mod: HasId, c: Flashcard): string {
  return `${pathId}:${mod.id}:${c.id ?? c.front.slice(0, 20)}`;
}

export function commandKey(pathId: string, mod: HasId, c: Command): string {
  return `${pathId}:${mod.id}:${c.id ?? c.hint}`;
}

export function quizKey(pathId: string, mod: HasId, q: QuizItem): string {
  return `${pathId}:${mod.id}:${q.id ?? q.q}`;
}
