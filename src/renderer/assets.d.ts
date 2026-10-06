/**
 * 静态资源导入的类型声明。
 *
 * Vite 把 `import x from './a.png'` 变成 URL 字符串,而 tsc 默认只认代码模块,
 * 所以这里补上声明 —— 放在单独的 .d.ts 里,不能写在普通 .ts 中
 * (那会被当成"模块增强",报 TS2664)。
 */

declare module '*.png' {
  const src: string;
  export default src;
}

declare module '*.svg' {
  const src: string;
  export default src;
}
