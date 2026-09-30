/** 虚拟模块声明：内容由 Vite 插件在构建期注入 */
declare module "virtual:aiforge-content" {
  import type { PathContent } from "@aiforge/content-schema";
  export const paths: PathContent[];
  export default paths;
}
