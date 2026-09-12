/**
 * 渲染进程的全局类型声明。
 *
 * 为什么单独放一个文件而不是写在 api.d.ts:
 * `declare global` 要生效,文件必须被纳入编译图。把它放在 src/renderer/ 下的
 * .d.ts 里曾被 tsconfig 的 include 规则漏掉,导致整个渲染层出现
 * "Property 'api' does not exist on type 'Window'" 的级联报错。
 * 这里改成普通 .ts 模块 + 显式 import,确保一定进图。
 */

import type { ApiSurface } from '@shared/types';

declare global {
  interface Window {
    /** preload 通过 contextBridge 暴露的接口,签名与契约 ApiSurface 一致 */
    api: ApiSurface;
  }
}

export {};
