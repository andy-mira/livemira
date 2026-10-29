// SPDX-License-Identifier: Apache-2.0

import type { ArMessage, ArMessages, Translator, TranslatorOptions } from './api.ts';
import { EN, ZH_CN } from './messages.ts';

const TABLES: Readonly<Record<'zh-CN' | 'en', ArMessages>> = { 'zh-CN': ZH_CN, en: EN };

/** 'en' and 'en-*' → 'en'; everything else → 'zh-CN'. */
export function resolveLocale(locale: string | null | undefined): 'zh-CN' | 'en' {
  return typeof locale === 'string' && /^en(-|$)/i.test(locale) ? 'en' : 'zh-CN';
}

function format(message: ArMessage, params: Readonly<Record<string, string | number>> | undefined): string {
  const count = params?.count;
  const text = typeof message === 'string' ? message : count === 1 ? message.one : message.other;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => (params && name in params ? String(params[name]) : whole));
}

/** Host override, then the host table, then the built-in table of the locale, then Chinese, then the key itself. */
export function createTranslator(options: TranslatorOptions = {}): Translator {
  const locale = resolveLocale(options.locale);
  return {
    locale,
    t(key, params) {
      try {
        const own = options.translate?.(key, params, locale);
        if (typeof own === 'string') return own;
      } catch {
        // A failing host override falls back to the tables.
      }
      const message =
        options.messages?.[locale]?.[key] ??
        options.messages?.[options.locale ?? '']?.[key] ??
        TABLES[locale][key] ??
        ZH_CN[key];
      return message === undefined ? key : format(message, params);
    },
  };
}
