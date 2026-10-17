/** 虚拟模块声明：内容由 Vite 插件在构建期注入 */

/** 元数据（模块列表、闪卡/命令/面试题），静态 import —— 首屏就需要 */
declare module "virtual:aiforge-content" {
  import type { PathMeta } from "@aiforge/content-schema";
  export const paths: PathMeta[];
  export default paths;
}

/** 正文（guide.md / lab.md），动态 import —— 只有展开某天并点「阅读教程」时才拉取 */
declare module "virtual:aiforge-content/docs" {
  import type { DocsMap } from "@aiforge/content-schema";
  export const docs: DocsMap;
  export default docs;
}
