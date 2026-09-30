/** 内容校验：CI/手动跑，确保 content/** 全部通过 schema。 */
import { loadPaths } from "./load.ts";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// 基于本文件位置稳定解析仓库根（src/ → content-schema/ → packages/ → repo/），不受 cwd 影响
const here = dirname(fileURLToPath(import.meta.url));
const root = process.argv[2] ? resolve(process.argv[2]) : resolve(here, "../../../content");
const paths = loadPaths(root);
let cards = 0, cmds = 0, quiz = 0, modules = 0;
for (const p of paths) {
  for (const m of p.modules) {
    modules++;
    cards += m.flashcards.length; cmds += m.commands.length; quiz += m.quiz.length;
  }
}
console.log(`✓ 内容校验通过: ${paths.length} 路径 / ${modules} 模块 / ${cards} 闪卡 / ${cmds} 命令 / ${quiz} 面试`);
if (!paths.length) { console.error("✗ 未发现任何路径"); process.exit(1); }
