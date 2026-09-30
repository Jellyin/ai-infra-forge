/**
 * 构建期内容加载器：扫描 content/paths/**，读 yaml/md，
 * 用 zod 校验后聚合成类型安全的 PathContent[]。
 * 运行环境：构建期(Vite 插件 / node)，不在浏览器运行时执行。
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import {
  PathSchema, ModuleSchema, FlashcardSchema, CommandSchema, QuizItemSchema,
  type PathContent, type ModuleContent,
} from "./schema.ts";

const readYaml = (p: string) => (existsSync(p) ? yaml.load(readFileSync(p, "utf8")) : undefined);
const readMd = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");

export function loadPaths(contentRoot: string): PathContent[] {
  const pathsDir = join(contentRoot, "paths");
  if (!existsSync(pathsDir)) return [];

  const result: PathContent[] = [];
  for (const pathId of readdirSync(pathsDir)) {
    const pdir = join(pathsDir, pathId);
    const pathRaw = readYaml(join(pdir, "path.yaml"));
    if (!pathRaw) continue;
    const pathMeta = PathSchema.parse(pathRaw);

    const modulesDir = join(pdir, "modules");
    const modules: ModuleContent[] = [];
    if (existsSync(modulesDir)) {
      for (const modId of readdirSync(modulesDir).sort()) {
        const mdir = join(modulesDir, modId);
        const metaRaw = readYaml(join(mdir, "module.yaml"));
        if (!metaRaw) continue;
        const meta = ModuleSchema.parse(metaRaw);

        const flashcards = (readYaml(join(mdir, "flashcards.yaml")) as unknown[] ?? [])
          .map((c) => FlashcardSchema.parse(c));
        const commands = (readYaml(join(mdir, "commands.yaml")) as unknown[] ?? [])
          .map((c) => CommandSchema.parse(c));
        const quiz = (readYaml(join(mdir, "quiz.yaml")) as unknown[] ?? [])
          .map((q) => QuizItemSchema.parse(q));

        modules.push({
          ...meta,
          guideMd: readMd(join(mdir, "guide.md")),
          labMd: readMd(join(mdir, "lab.md")),
          flashcards, commands, quiz,
        });
      }
    }
    modules.sort((a, b) => a.order - b.order);
    result.push({ ...pathMeta, modules });
  }
  return result;
}
