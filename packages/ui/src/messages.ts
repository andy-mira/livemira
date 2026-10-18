/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Camera messages in Simplified Chinese (the default) and English. A notice is stored as a key and resolved when it is drawn, so a locale change re-renders the same session in place.

/** One message; `{name}` is replaced by the parameter of that name. `one`/`other` choose by the `count` parameter. */
export type ArMessage = string | { readonly one: string; readonly other: string };
export type ArMessages = Readonly<Record<string, ArMessage>>;

export const ZH_CN: ArMessages = Object.freeze({
  title: '扫描照片，看见视频',
  exit: '关闭相机',
  restart: '重新开始',
  reloadVideo: '重新加载视频',
  soundOn: '开启声音',
  soundOff: '关闭声音',
  skipped: '有 {count} 张照片不适合扫描，已跳过。',
  'status.preparingProgress': '正在准备照片（{done}/{total}）…',
  'status.preparing': '正在准备…',
  'status.viewport': '正在调整画面…',
  'status.starting': '正在打开相机…',
  'status.stopping': '正在停止…',
  'status.loading': '找到照片了，正在加载视频…',
  'status.playing': '正在播放',
  'status.lost': '照片移开了，重新对准即可继续。',
  'status.videoError': '视频暂时无法播放。',
  'status.searching': '请把相机对准要识别的照片。',
  'notice.noTargets': '没有完整的照片与视频可以扫描。',
  'notice.tooMany': '一次最多扫描 {max} 组照片与视频。',
  'notice.invalidTargets': '照片与视频的配置无效（编号缺失、重复或与识别数据不一致）。',
  'notice.allRejected': '这些照片都无法用于扫描，请换更清晰的照片。',
  'notice.startFailed': '扫描未能启动，请重试。',
  'notice.emptyVideo': '视频文件为空。',
  'notice.cameraDenied': '没有相机权限，请在浏览器设置中允许后重新开始。',
  'notice.cameraInterrupted': '相机已中断，请重新开始。',
  'notice.workerFailure': '识别组件出现问题，已停止扫描，请重新开始。',
  'notice.videoPlayFailed': '视频无法播放，可以点“重新加载视频”再试一次。',
  'notice.videoLoadFailed': '视频暂时无法加载，请检查网络后点“重新加载视频”。',
  'notice.autoplayBlocked': '浏览器阻止了视频自动播放。',
  'notice.soundRefused': '浏览器暂时没有允许播放声音，请再点一次。',
  'notice.backgrounded': '页面进入后台，已停止扫描，请重新开始。',
  'notice.photoLoadFailed': '照片加载失败，请检查网络后重试。',
  'notice.engineLoadFailed': '扫描组件加载失败，请检查网络后重试。',
  'notice.cameraOrEngine': '无法打开相机或识别组件，请确认已允许相机权限后重试。',
});

export const EN: ArMessages = Object.freeze({
  title: 'Scan a photo to see its video',
  exit: 'Close camera',
  restart: 'Start again',
  reloadVideo: 'Reload video',
  soundOn: 'Turn sound on',
  soundOff: 'Turn sound off',
  skipped: {
    one: '{count} photo is not suitable for scanning and was skipped.',
    other: '{count} photos are not suitable for scanning and were skipped.',
  },
  'status.preparingProgress': 'Preparing photos ({done}/{total})…',
  'status.preparing': 'Getting ready…',
  'status.viewport': 'Adjusting the view…',
  'status.starting': 'Opening the camera…',
  'status.stopping': 'Stopping…',
  'status.loading': 'Photo found. Loading its video…',
  'status.playing': 'Playing',
  'status.lost': 'The photo moved out of view. Point at it again to continue.',
  'status.videoError': 'The video cannot play right now.',
  'status.searching': 'Point the camera at a photo to scan.',
  'notice.noTargets': 'There are no complete photo and video pairs to scan.',
  'notice.tooMany': 'You can scan at most {max} pairs at a time.',
  'notice.invalidTargets':
    'The photo and video setup is invalid (a missing or duplicate id, or an id that does not match its target data).',
  'notice.allRejected': 'None of the photos can be used for scanning. Try clearer photos.',
  'notice.startFailed': 'Scanning could not start. Please try again.',
  'notice.emptyVideo': 'The video file is empty.',
  'notice.cameraDenied':
    'Camera access was not granted. Allow it in your browser settings, then start again.',
  'notice.cameraInterrupted': 'The camera was interrupted. Please start again.',
  'notice.workerFailure':
    'The recognition component ran into a problem and scanning stopped. Please start again.',
  'notice.videoPlayFailed': 'The video cannot play. Choose “Reload video” to try again.',
  'notice.videoLoadFailed':
    'The video cannot be loaded right now. Check your connection, then choose “Reload video”.',
  'notice.autoplayBlocked': 'Your browser blocked automatic video playback.',
  'notice.soundRefused': 'The browser did not allow sound yet. Please tap again.',
  'notice.backgrounded':
    'The page went to the background and scanning stopped. Please start again.',
  'notice.photoLoadFailed': 'The photos could not be loaded. Check your connection and try again.',
  'notice.engineLoadFailed':
    'The scanning component could not be loaded. Check your connection and try again.',
  'notice.cameraOrEngine':
    'The camera or recognition component could not be started. Make sure camera access is allowed, then try again.',
});

export const DEFAULT_LOCALE = 'zh-CN';

const TABLES: Readonly<Record<string, ArMessages>> = { 'zh-CN': ZH_CN, en: EN };

/** `en-US` → `en`; `zh`, `zh-TW`, `zh-Hans` → `zh-CN`; anything else → the default. */
export function resolveLocale(locale: string | null | undefined): 'zh-CN' | 'en' {
  const tag = (locale ?? '').toLowerCase();
  return tag === 'en' || tag.startsWith('en-') ? 'en' : DEFAULT_LOCALE;
}

export interface TranslatorOptions {
  readonly locale?: string;
  /** Per-locale additions or replacements, e.g. `{ en: { 'host.expired': '…' } }`. */
  readonly messages?: Readonly<Record<string, ArMessages>>;
  /** Wins whenever it returns a string; return nothing to fall back to the tables. */
  readonly translate?: (
    key: string,
    params: Readonly<Record<string, string | number>> | undefined,
    locale: string,
  ) => string | null | undefined | void;
}

export interface Translator {
  readonly locale: 'zh-CN' | 'en';
  t(key: string, params?: Readonly<Record<string, string | number>>): string;
}

const fill = (message: ArMessage, params?: Readonly<Record<string, string | number>>): string => {
  const text =
    typeof message === 'string' ? message : params?.['count'] === 1 ? message.one : message.other;
  return params
    ? text.replace(/\{(\w+)\}/g, (all, name: string) => String(params[name] ?? all))
    : text;
};

/** Host override, then the host table, then the built-in table of the locale, then Chinese, then the key itself. */
export function createTranslator(options: TranslatorOptions = {}): Translator {
  const locale = resolveLocale(options.locale);
  return {
    locale,
    t(key, params) {
      const own = options.translate?.(key, params, locale);
      if (typeof own === 'string') return own;
      const message =
        options.messages?.[locale]?.[key] ??
        TABLES[locale]![key] ??
        options.messages?.[DEFAULT_LOCALE]?.[key] ??
        ZH_CN[key] ??
        key;
      return fill(message, params);
    },
  };
}
