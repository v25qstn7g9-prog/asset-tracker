# 存股資產追蹤 V4.6 Personal v2

架構：Cloudflare Pages 靜態前端 + 同專案 Pages Function `/quote`。

## GitHub 專案結構

- `index.html`
- `manifest.webmanifest`
- `_routes.json`
- `functions/quote.js`

## 部署

1. 將以上檔案與資料夾放到 GitHub repo 根目錄。
2. Cloudflare Dashboard → Workers & Pages → Create → Pages → Connect to Git。
3. 選擇此 GitHub repo。若是純靜態專案，不需 Build command；輸出目錄設為 repo 根目錄（依 Cloudflare UI 實際欄位設定）。
4. 部署後開啟 `https://你的站名.pages.dev/quote`，應看到 JSON 報價。
5. 再開首頁，App 會以同網域 `/quote` 抓取 0050、0056、2330。

注意：Pages Functions 需透過 Git integration 或 Wrangler 部署；Cloudflare 官方文件目前說 Dashboard Direct Upload 不支援 Functions。
