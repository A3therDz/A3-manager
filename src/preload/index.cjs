/**
 * Preload 桥:把主进程的 IPC 暴露成渲染进程的 window.api。
 *
 * 契约真源是 src/shared/types.ts 的 ApiSurface。
 * 这里只做转发与 Promise 拆包:
 *   主进程返回 { ok:true, data } / { ok:false, error }
 *   渲染进程拿到 data,失败则 throw Error(error) —— 前端可以用 try/catch。
 *
 * 所有方法白名单式显式列出,不做 Object.keys 泛化,
 * 免得主进程新增通道时前端在不知情的情况下拿到新方法。
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron');

/** 调用一个 IPC 通道并拆包统一返回值 */
async function call(channel, ...args) {
  const res = await ipcRenderer.invoke(channel, ...args);
  if (!res || typeof res !== 'object') return res;
  if (res.ok === true) return res.data;
  if (res.ok === false) throw new Error(res.error || '未知错误');
  return res;
}

const api = {
  // ---- 库管理
  listRoots: () => call('listRoots'),
  addRoot: (p, label) => call('addRoot', p, label),
  removeRoot: (id) => call('removeRoot', id),
  setRootEnabled: (id, enabled) => call('setRootEnabled', id, enabled),

  // ---- 扫描
  startScan: (rootIds, force) => call('startScan', rootIds, force),
  cancelScan: () => call('cancelScan'),
  getScanProgress: () => call('getScanProgress'),
  onScanProgress: (cb) => {
    const listener = (_evt, p) => cb(p);
    ipcRenderer.on('scan:progress', listener);
    return () => ipcRenderer.removeListener('scan:progress', listener);
  },

  // ---- 浏览
  queryImages: (query) => call('queryImages', query),
  getImage: (id) => call('getImage', id),
  getImagesByIds: (ids) => call('getImagesByIds', ids),
  getFolderTree: (rootId) => call('getFolderTree', rootId),
  getFolderPrefs: () => call('getFolderPrefs'),
  setFolderPref: (rootId, relDir, patch) => call('setFolderPref', rootId, relDir, patch),
  pickDirectory: () => call('pickDirectory'),
  pickImageFile: () => call('pickImageFile'),
  inspectFile: (p) => call('inspectFile', p),
  /**
   * 拖进来的 File 对象在渲染层只有 name/path 信息,拿不到真实绝对路径,
   * 必须走 Electron 的 webUtils.getPathForFile(新版已经没有 File.path 了)。
   */
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || '';
    } catch {
      return '';
    }
  },
  openUrl: (url) => call('openUrl', url),
  windowMinimize: () => call('windowMinimize'),
  windowToggleMaximize: () => call('windowToggleMaximize'),
  windowClose: () => call('windowClose'),
  isWindowMaximized: () => call('isWindowMaximized'),
  getBackgroundUrl: () => call('getBackgroundUrl'),
  getStats: (rootId) => call('getStats', rootId),
  getFilterOptions: () => call('getFilterOptions'),

  // ---- 用户自定义分类(不移动文件,只是索引层的集合归属)
  getCategoryTree: () => call('getCategoryTree'),
  createCategory: (input) => call('createCategory', input),
  updateCategory: (id, patch) => call('updateCategory', id, patch),
  deleteCategory: (id, deleteChildren) => call('deleteCategory', id, deleteChildren),
  setCategoryMembers: (categoryId, imageIds, member) =>
    call('setCategoryMembers', categoryId, imageIds, member),
  getImageCategories: (imageId) => call('getImageCategories', imageId),

  // ---- 操作
  setStarred: (id, starred) => call('setStarred', id, starred),
  revealInExplorer: (id) => call('revealInExplorer', id),
  openFolder: (relDir) => call('openFolder', relDir),
  openExternal: (id) => call('openExternal', id),
  copyPath: (id) => call('copyPath', id),
  copyText: (text) => call('copyText', text),
  deleteImage: (id) => call('deleteImage', id),
  moveImage: (id) => call('moveImage', id),
  renameImage: (id, newName) => call('renameImage', id, newName),
  copyImageToClipboard: (id) => call('copyImageToClipboard', id),
  copyImageWithoutMetadata: (id) => call('copyImageWithoutMetadata', id),
  copyImageToFolder: (id) => call('copyImageToFolder', id),
  deleteImages: (ids) => call('deleteImages', ids),
  moveImages: (ids, targetDir) => call('moveImages', ids, targetDir),
  copyImagesToFolder: (ids, targetDir) => call('copyImagesToFolder', ids, targetDir),

  // ---- 设置
  getSettings: () => call('getSettings'),
  setSettings: (patch) => call('setSettings', patch),

  // ---- 缩略图:同步返回 URL,直接塞进 <img src>
  // 注意:主机名必须是字母(thumb),id 放路径里。
  // cam-thumb 注册为 standard scheme,纯数字主机名(含 cam-thumb:///123 的
  // 空主机名形式)都会被 Chromium 规范化为 IPv4 地址(8061 -> 0.0.31.152),
  // 主进程解析不到 id,缩略图全部 400。
  getThumbUrl: (id) => `cam-thumb://thumb/${id}`,
  // 原图:详情预览要清晰度,缩略图只有几百像素
  getFileUrl: (id) => `cam-file://file/${id}`,

  // ---- 应用
  getAppInfo: () => call('getAppInfo'),
  setAutoLaunch: (enabled) => call('setAutoLaunch', enabled),
  quitApp: () => call('quitApp'),

  // ---- 工作小窗(桌宠)
  getPetState: () => call('getPetState'),
  setPetPosition: (position) => call('setPetPosition', position),
  setPetLayout: (patch) => call('setPetLayout', patch),
  focusMainWindow: () => call('focusMainWindow'),
  onPetStateChanged: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('pet:stateChanged', listener);
    return () => ipcRenderer.removeListener('pet:stateChanged', listener);
  },
  movePetWindow: (bounds) => call('movePetWindow', bounds),
  closePetWindow: () => call('closePetWindow'),
  setPetIgnoreMouse: (ignore) => call('setPetIgnoreMouse', ignore),
};

contextBridge.exposeInMainWorld('api', api);
