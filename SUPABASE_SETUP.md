# Supabase 同步設定

## 1. 建立 Supabase 專案

到 https://supabase.com 建立新專案。

## 2. 建立資料表

進入 Supabase 專案後，打開 SQL Editor，貼上 `supabase.sql` 的內容並執行。

這會建立 `positions` 資料表，並開啟 Row Level Security。每個登入者只能讀寫自己的股票標的。

## 3. 複製前端設定

在 Supabase 專案左側打開 Project Settings，進入 API 頁面，複製：

- Project URL
- anon public key

回到 app 的「雲端同步」區塊，貼到 `Supabase URL` 和 `Anon public key`，按「儲存設定」。

## 4. 設定登入轉址

如果你把 app 部署到公開網址，例如：

```text
https://your-name.github.io/stock-exit-app/
```

到 Supabase 的 Authentication > URL Configuration，把這個網址加入：

- Site URL
- Redirect URLs

本機測試時可加入：

```text
http://localhost:8765/
```

## 5. 登入與同步

在 app 輸入 Email，按「寄登入連結」，到信箱點登入連結。登入後按「立即同步」，手機和電腦用同一個 Email 登入就會看到同一份標的清單。

## 6. 啟用櫃買資料代理

GitHub Pages 是純前端網站，瀏覽器會擋掉部分櫃買中心資料 API 的跨網域讀取。若要讓上櫃/興櫃標的穩定更新高點，請部署 `supabase/functions/market-proxy`。

若使用 Supabase CLI：

```bash
supabase functions deploy market-proxy --no-verify-jwt
```

部署後 app 會自動優先使用：

```text
https://你的專案.supabase.co/functions/v1/market-proxy
```
