/**
 * i18n.ts — minimal, honest localisation.
 *
 * Scope, stated up front: this is a dictionary + a lookup, not a
 * framework. There is no ICU plural parser, no locale fallback chain
 * beyond one level, and no lazy loading. What it does have:
 *
 *   - the language follows the browser/OS by default, so a user whose
 *     OS is Chinese gets Chinese without touching Settings;
 *   - an explicit choice persists and overrides the OS;
 *   - `t()` is total. A missing key returns the key itself, visibly,
 *     rather than an empty string — a half-translated UI is obvious,
 *     a silently-blank one is not.
 *
 * Why not a library: the whole app is ~250 strings. A dependency that
 * solves plural rules and date formatting is solving problems this
 * UI does not have, in exchange for a build-time weight and an API
 * surface to learn.
 */

export type Lang = 'en' | 'zh';

/** Keys are dotted paths; values are the English source strings.
 *  The English value doubles as the fallback AND as the key's
 *  identity, so a missing translation is the English sentence rather
 *  than a cryptic identifier. */
export const EN = {
  'app.name': 'Deqi',
  'app.tagline': 'The agent watches itself working.',

  'rail.newTask': 'New task',
  'rail.search': 'Search',
  'rail.schedule': 'Schedule',
  'rail.plugins': 'Plugins',
  'rail.web': 'Web',
  'rail.mobile': 'Mobile',
  'rail.feedback': 'Feedback',
  'rail.settings': 'Settings',
  'rail.recent': 'Recent',

  'chat.empty.title': 'Deqi',
  'chat.empty.hint': 'Type a task below to start. Deqi can read, write, edit, and run shell commands on your behalf.',
  'chat.you': 'you',
  'chat.busy': 'working…',
  'chat.thinking': 'thinking…',
  'chat.toolInput': 'input',
  'chat.toolOutput': 'output',
  'chat.toolOutputError': 'output (error)',
  'chat.copy': 'copy',
  'chat.copied': 'copied',
  'chat.diffTooLarge': 'Too large to show line by line.',
  'chat.diffTruncated': '… diff truncated.',
  'chat.reviewHeadline': 'turn review',
  'chat.memory': 'remembered',
  'chat.skills': 'suggested',

  'boundary.block': 'A message could not be displayed.',
  'boundary.stillRunning': 'The rest of the app is still running — this part could not be displayed.',
  'boundary.retry': 'Try again',
  'boundary.app': 'Deqi hit an error it could not recover from.',

  'status.connected': 'Connected',
  'status.connecting': 'Connecting…',
  'status.closed': 'Disconnected',
  'status.model': 'model:',
  'status.theme.light': 'Switch to light theme',
  'status.theme.dark': 'Switch to dark theme',
  'status.lang': 'Switch to 中文',

  'composer.placeholder': 'Ask Deqi to do something…',
  'composer.send': 'Send',
  'composer.stop': 'Stop',
} as const;

export type MsgKey = keyof typeof EN;

const ZH: Record<MsgKey, string> = {
  'app.name': 'Deqi',
  'app.tagline': '这个 agent 会观察自己的工作。',

  'rail.newTask': '新任务',
  'rail.search': '搜索',
  'rail.schedule': '日程',
  'rail.plugins': '插件',
  'rail.web': '网页',
  'rail.mobile': '移动',
  'rail.feedback': '反馈',
  'rail.settings': '设置',
  'rail.recent': '最近',

  'chat.empty.title': 'Deqi',
  'chat.empty.hint': '在下面输入一个任务开始。Deqi 可以替你读文件、写文件、编辑代码，以及执行 shell 命令。',
  'chat.you': '你',
  'chat.busy': '执行中…',
  'chat.thinking': '思考中…',
  'chat.toolInput': '入参',
  'chat.toolOutput': '输出',
  'chat.toolOutputError': '输出（出错）',
  'chat.copy': '复制',
  'chat.copied': '已复制',
  'chat.diffTooLarge': '改动太大，无法逐行显示。',
  'chat.diffTruncated': '… diff 已截断。',
  'chat.reviewHeadline': '本轮回顾',
  'chat.memory': '已回忆',
  'chat.skills': '已建议',

  'boundary.block': '这条消息无法显示。',
  'boundary.stillRunning': '其余部分仍在运行——只是这一块显示不出来。',
  'boundary.retry': '重试',
  'boundary.app': 'Deqi 遇到了无法恢复的错误。',

  'status.connected': '已连接',
  'status.connecting': '连接中…',
  'status.closed': '已断开',
  'status.model': '模型：',
  'status.theme.light': '切换到浅色主题',
  'status.theme.dark': '切换到深色主题',
  'status.lang': 'Switch to English',

  'composer.placeholder': '让 Deqi 去做点什么…',
  'composer.send': '发送',
  'composer.stop': '停止',
};

const DICT: Record<Lang, Record<MsgKey, string>> = { en: EN, zh: ZH };

const STORAGE_KEY = 'deqi.lang';

export function readStoredLang(): Lang | null {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    return raw === 'en' || raw === 'zh' ? raw : null;
  } catch {
    return null;
  }
}

export function storeLang(lang: Lang): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, lang);
  } catch { /* private mode — applies for this session only */ }
}

/** From the browser/OS, when it is one we have. */
export function detectLang(): Lang {
  try {
    for (const l of globalThis.navigator?.languages ?? []) {
      if (/^zh\b/i.test(l)) return 'zh';
      if (/^en\b/i.test(l)) return 'en';
    }
    if (/^zh\b/i.test(globalThis.navigator?.language ?? '')) return 'zh';
  } catch { /* no navigator */ }
  return 'en';
}

export function initialLang(): Lang {
  return readStoredLang() ?? detectLang();
}

export function applyLang(lang: Lang): void {
  try {
    const el = globalThis.document?.documentElement;
    el?.setAttribute('lang', lang === 'zh' ? 'zh-CN' : 'en');
  } catch { /* no DOM */ }
}

/**
 * Look a message up. `t()` here is a free function, not a hook, so a
 * component has to re-render on a language change for the new strings
 * to appear — which is why `useLang()` exists below.
 *
 * Total by construction. `DICT[lang][key]` throws when `lang` is a
 * value this build does not have — a stale stored preference, a typo,
 * a future locale added to storage before its dictionary ships — and
 * a throw here happens inside render, so it takes the whole view down
 * over a string. The dictionary is therefore indexed defensively and
 * every level falls back.
 */
export function translate(lang: Lang, key: MsgKey): string {
  const table = DICT[lang] ?? EN;
  return table[key] ?? EN[key] ?? key;
}
