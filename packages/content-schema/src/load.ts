/**
 * 构建期内容加载器：扫描 content/paths/**，读 yaml/md，用 zod 校验后聚合。
 * 运行环境：构建期(Vite 插件 / node)，不在浏览器运行时执行。
 *
 * 两个出口：
 *   loadContent() —— 元数据与正文分离（虚拟模块用：正文可懒加载，不占首屏）
 *   loadPaths()   —— 含正文的完整结构（validate 校验脚本用）
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import {
  PathSchema, ModuleSchema, FlashcardSchema, CommandSchema, QuizItemSchema,
  type PathContent, type PathMeta, type ModuleContent, type ModuleMeta, type DocsMap,
} from "./schema.ts";

/** 读 YAML；解析失败时把**文件路径**带进错误信息——
 *  内容文件一多，只报「bad indentation」不说是哪个文件根本没法排查。 */
const readYaml = (p: string) => {
  if (!existsSync(p)) return undefined;
  try {
    return yaml.load(readFileSync(p, "utf8"));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`内容文件解析失败：${p}\n${msg}`);
  }
};
const readMd = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");

/** 扫描 + zod 校验。正文单独收进 docs map，不混进模块元数据 */
function walk(contentRoot: string): { paths: PathMeta[]; docs: DocsMap } {
  const pathsDir = join(contentRoot, "paths");
  const docs: DocsMap = {};
  if (!existsSync(pathsDir)) return { paths: [], docs };

  const paths: PathMeta[] = [];
  // 显式排序：多路径时顺序确定（readdirSync 顺序随文件系统不定）
  for (const pathId of readdirSync(pathsDir).sort()) {
    const pdir = join(pathsDir, pathId);
    const pathRaw = readYaml(join(pdir, "path.yaml"));
    if (!pathRaw) continue;
    const pathMeta = PathSchema.parse(pathRaw);

    const modulesDir = join(pdir, "modules");
    const modules: ModuleMeta[] = [];
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

        const guidePath = join(mdir, "guide.md");
        const labPath = join(mdir, "lab.md");
        docs[`${pathMeta.id}:${meta.id}`] = { guideMd: readMd(guidePath), labMd: readMd(labPath) };

        modules.push({
          ...meta,
          hasGuide: existsSync(guidePath),
          hasLab: existsSync(labPath),
          flashcards, commands, quiz,
        });
      }
    }
    modules.sort((a, b) => a.order - b.order);
    paths.push({ ...pathMeta, modules });
  }
  return { paths, docs };
}

/** 元数据 + 正文分离（虚拟模块用：路径元数据小、正文另走懒加载模块） */
export function loadContent(contentRoot: string): { paths: PathMeta[]; docs: DocsMap } {
  return walk(contentRoot);
}

/** 含正文的完整结构（校验脚本用） */
export function loadPaths(contentRoot: string): PathContent[] {
  const { paths, docs } = walk(contentRoot);
  return paths.map((p) => ({
    ...p,
    modules: p.modules.map((m): ModuleContent => ({
      ...m,
      ...(docs[`${p.id}:${m.id}`] ?? { guideMd: "", labMd: "" }),
    })),
  }));
}
