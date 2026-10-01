/**
 * Vite 构建期插件：把 content/paths/** 编译成虚拟模块 `virtual:aiforge-content`，
 * 应用通过 `import { paths } from "virtual:aiforge-content" }` 拿到类型安全数据。
 * dev 下内容变更：重建数据 → 失效虚拟模块缓存 → full-reload（真刷新，拿新数据）。
 *
 * 注：这里用最小结构类型而非 import type { Plugin } from "vite"，
 * 让包保持零运行时依赖、typecheck 不要求装 vite（web 侧装了就有完整类型）。
 */
import { resolve } from "node:path";
import { loadPaths } from "./load.ts";

const VIRTUAL_ID = "virtual:aiforge-content";
const RESOLVED_ID = "\0" + VIRTUAL_ID;

/** dev server 的最小结构类型（moduleGraph 失效缓存需要） */
interface DevServer {
  ws: { send: (m: { type: string }) => void };
  watcher: { add: (p: string) => void };
  moduleGraph: {
    getModuleById: (id: string) => unknown;
    invalidateModule: (mod: unknown) => void;
  };
}

interface MinimalPlugin {
  name: string;
  buildStart: (this: { info?: (msg: string) => void }) => void;
  resolveId: (id: string) => string | undefined;
  load: (id: string) => string | undefined;
  handleHotUpdate: (ctx: { file: string; server: DevServer }) => void;
  configureServer?: (server: DevServer) => void;
}

export function contentPlugin(contentRoot: string = resolve(process.cwd(), "../../content")): MinimalPlugin {
  const contentRootNorm = contentRoot.replaceAll("\\", "/");
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
    // dev 下把 content/ 纳入 watch（在 vite root 之外，默认不被监听）
    configureServer(server) {
      server.watcher.add(contentRoot);
    },
    resolveId(id: string) {
      if (id === VIRTUAL_ID) return RESOLVED_ID;
      return undefined;
    },
    load(id: string) {
      if (id === RESOLVED_ID) return data;
      return undefined;
    },
    handleHotUpdate({ file, server }) {
      const norm = file.replaceAll("\\", "/");
      // startsWith 精确匹配根目录，避免任何路径含 /content/ 的文件误触发
      if (!norm.startsWith(contentRootNorm + "/")) return;
      build();
      // 关键：失效 moduleGraph 里虚拟模块的 transform 缓存——
      // 只发 full-reload 而不失效缓存，浏览器 reload 后拿到的仍是旧数据（假刷新）
      const mod = server.moduleGraph.getModuleById(RESOLVED_ID);
      if (mod) server.moduleGraph.invalidateModule(mod);
      server.ws.send({ type: "full-reload" });
    },
  };
}
