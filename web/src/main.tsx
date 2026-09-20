import React from "react";
import { createRoot } from "react-dom/client";
import "antd/dist/reset.css";
import "streamdown/styles.css";
import "./styles/globals.css";
import { RouterProvider } from "react-router-dom";

import { AppProviders } from "@/components/layout/app-providers";
import { initI18n } from "@/i18n";
import { initAnalytics } from "@/lib/analytics";
import { takeAffiliateCodeFromSearch } from "@/lib/affiliate";
import { router } from "@/router";

initAnalytics();

if (typeof window !== "undefined") {
    takeAffiliateCodeFromSearch(window.location.search);
}

document.body.style.fontFamily = '"SF Pro Display","SF Pro Text","PingFang SC","Microsoft YaHei","Helvetica Neue",sans-serif';

// 语言包改为按需加载，首屏渲染前先等当前语言就绪，业务模块拿到的 i18n 与之前一致。
void initI18n()
    .catch(() => undefined)
    .then(() => {
        createRoot(document.getElementById("root")!).render(
            <React.StrictMode>
                <AppProviders>
                    <RouterProvider router={router} />
                </AppProviders>
            </React.StrictMode>,
        );
    });
