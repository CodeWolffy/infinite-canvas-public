import i18n from "i18next";
import { initReactI18next } from "react-i18next";

export type AppLocale = "zh-CN" | "en-US";

const LOCALE_STORAGE_KEY = "infinite-canvas:locale";
// 语言包按需加载：首屏只取当前语言，避免两份语言包都进入口 chunk。
const localeLoaders: Record<AppLocale, () => Promise<{ default: Record<string, unknown> }>> = {
    "zh-CN": () => import("@/i18n/locales/zh-CN"),
    "en-US": () => import("@/i18n/locales/en-US"),
};
const loadedLocales = new Set<AppLocale>();

export function currentAppLocale(): AppLocale {
    return localStorage.getItem(LOCALE_STORAGE_KEY) === "en-US" ? "en-US" : "zh-CN";
}

async function loadAppLocale(locale: AppLocale) {
    if (loadedLocales.has(locale)) return;
    const messages = (await localeLoaders[locale]()).default;
    i18n.addResourceBundle(locale, "translation", messages, true, true);
    loadedLocales.add(locale);
}

export async function initI18n() {
    const locale = currentAppLocale();
    let messages: Record<string, unknown> = {};
    try {
        messages = (await localeLoaders[locale]()).default;
        loadedLocales.add(locale);
    } catch {
        // 语言包加载失败时仍启动应用，界面显示文案键名，刷新可重试。
    }
    await i18n.use(initReactI18next).init({
        resources: { [locale]: { translation: messages } },
        lng: locale,
        fallbackLng: "zh-CN",
        supportedLngs: ["zh-CN", "en-US"],
        initAsync: false,
        interpolation: { escapeValue: false },
        react: { useSuspense: false },
    });
    // 英文界面缺词时回退中文，后台补载，不阻塞首屏渲染。
    if (locale !== "zh-CN") void loadAppLocale("zh-CN").catch(() => undefined);
}

export function changeAppLocale(locale: AppLocale) {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    // 语言包加载失败时保持当前语言，刷新后会按已保存的语言重新加载。
    return loadAppLocale(locale)
        .then(() => i18n.changeLanguage(locale))
        .catch(() => undefined);
}

export default i18n;
