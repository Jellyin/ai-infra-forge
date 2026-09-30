/**
 * Vite 构建期插件：把 content/paths/** 编译成虚拟模块 `virtual:aiforge-content`，
 * 应用通过 `import { paths } from "virtual:aiforge-content"` 拿到类型安全数据。
 * 内容变化时触发重编译（dev 下 watch）。
 *
 * 注：这里用最小结构类型而非 import type { Plugin } from "vite"，
 * 让包保持零运行时依赖、typecheck 不要求装 vite（web 侧装了就有完整类型）。
 */
import { resolve } from "node:path";
import { loadPaths } from "./load.ts";

const VIRTUAL_ID = "virtual:aiforge-content";
const RESOLVED_ID = "\0" + VIRTUAL_ID;

interface MinimalPlugin {
  name: string;
  buildStart: (this: { info?: (msg: string) => void }) => void;
  resolveId: (id: string) => string | undefined;
  load: (id: string) => string | undefined;
  handleHotUpdate: (ctx: { file: string; server: { ws: { send: (m: { type: string }) => void } } }) => void;
}

export function contentPlugin(contentRoot: string = resolve(process.cwd(), "../../content")): MinimalPlugin {
  let data = "";
  const build = (): number => {
    const paths = loadPaths(contentRoot);
    data = `export const paths = ${JSON.stringify(paths)};\nexport default paths;`;
    return paths.length;
  };

  return {
    name: "aiforge-content",
    buildStart() {
      const n = build();
      this.info?.(`[aiforge-content] 加载 ${n} 条路径 (from ${contentRoot})`);
    },
    resolveId(id: string) {
      if (id === VIRTUAL_ID) return RESOLVED_ID;
      return undefined;
    },
    load(id: string) {
      if (id === RESOLVED_ID) return data;
      return undefined;
    },
    handleHotUpdate({ file, server }: { file: string; server: { ws: { send: (m: { type: string }) => void } } }) {
      if (file.includes("/content/")) { build(); server.ws.send({ type: "full-reload" }); }
    },
  };
}
