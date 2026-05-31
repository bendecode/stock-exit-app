const stocksEl = document.querySelector("#stocks");
const template = document.querySelector("#stockTemplate");
const addStockButton = document.querySelector("#addStock");
const updateAllButton = document.querySelector("#updateAll");
const cloudStatus = document.querySelector("#cloudStatus");
const cloudSignOut = document.querySelector("#cloudSignOut");
const saveCloudConfigButton = document.querySelector("#saveCloudConfig");
const sendLoginLinkButton = document.querySelector("#sendLoginLink");
const syncNowButton = document.querySelector("#syncNow");

const cloudFields = {
  supabaseUrl: document.querySelector("#supabaseUrl"),
  supabaseAnonKey: document.querySelector("#supabaseAnonKey"),
  loginEmail: document.querySelector("#loginEmail"),
};

const settings = {
  activationPercent: document.querySelector("#activationPercent"),
  pullbackPercent: document.querySelector("#pullbackPercent"),
};

const summary = {
  exitCount: document.querySelector("#exitCount"),
  holdCount: document.querySelector("#holdCount"),
  inactiveCount: document.querySelector("#inactiveCount"),
  totalProfit: document.querySelector("#totalProfit"),
};

const storageKey = "stock-exit-portfolio-v3";
const cloudConfigKey = "stock-exit-supabase-config-v1";
const defaultCloudConfig = {
  supabaseUrl: "https://rdwfdxpwmccayzrrxqur.supabase.co",
  supabaseAnonKey: "sb_publishable_T9rVUpzsd7MvHYuo66_iRA_g-F_xj45",
};
const authStorageKey = "stock-exit-auth-session-v1";
const legacySupabaseUrls = new Set([
  "https://rdwfdxpmcccayzrrxqur.supabase.co",
]);

let stocks = [
  { id: crypto.randomUUID(), symbol: "2330 台積電", entry: 800, buyDate: "2026-01-02", current: 950, high: 1000, shares: 1000 },
  { id: crypto.randomUUID(), symbol: "範例 B", entry: 100, buyDate: "2026-01-02", current: 114, high: 120, shares: 1000 },
];
let supabaseClient = null;
let currentUser = null;
let cloudReady = false;
let syncing = false;
let pullingCloud = false;
let hasLocalChanges = false;
let hasLoadedCloudOnce = false;
let cloudRefreshTimer = null;
let cloudChannel = null;

async function applySession(session) {
  currentUser = session?.user || null;
  cloudReady = Boolean(currentUser);
  cloudSignOut.hidden = !currentUser;
  sendLoginLinkButton.hidden = Boolean(currentUser);

  if (!currentUser) {
    setCloudStatus("Supabase 已設定，請輸入 Email 並寄登入連結。");
    return;
  }

  setCloudStatus(`已登入 ${currentUser.email}，變更會即時同步。`);
  startCloudRealtime();
  startCloudAutoRefresh();
  await pullCloudPositions({ silent: true });
}

function numberValue(value) {
  return Number.parseFloat(value) || 0;
}

function currency(value) {
  if (!Number.isFinite(value)) return "-";
  return value.toLocaleString("zh-TW", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function percent(value) {
  if (!Number.isFinite(value)) return "-";
  return `${value.toFixed(2)}%`;
}

function parseStockNo(symbol) {
  return String(symbol || "").match(/\d{4,6}/)?.[0] || "";
}

function parseTwseNumber(value) {
  return Number.parseFloat(String(value || "").replace(/,/g, ""));
}

function parseTwseDate(value) {
  const parts = String(value || "").split("/").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 3 || parts.some(Number.isNaN)) return null;
  return new Date(parts[0] + 1911, parts[1] - 1, parts[2]);
}

function toMonthKey(date) {
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}01`;
}

function monthKeysBetween(startDate, endDate) {
  const keys = [];
  const cursor = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
  while (cursor <= endDate) {
    keys.push(toMonthKey(cursor));
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return keys;
}

async function fetchTwseMonth(stockNo, monthKey) {
  const url = `https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date=${monthKey}&stockNo=${stockNo}&response=json`;
  const response = await fetch(url);
  if (!response.ok) throw new Error("資料來源暫時無法連線");
  const data = await response.json();
  if (data.stat && data.stat !== "OK") return [];
  return Array.isArray(data.data) ? data.data : [];
}

async function fetchListedHighSince(stock) {
  const stockNo = parseStockNo(stock.symbol);
  const startDate = new Date(stock.buyDate);
  const endDate = new Date();
  if (!stockNo) throw new Error("請在名稱欄輸入上市股票代號，例如 2330");
  if (Number.isNaN(startDate.getTime())) throw new Error("請先輸入買進日期");
  if (startDate > endDate) throw new Error("買進日期不能晚於今天");

  let highest = null;
  let latestClose = null;
  let latestDate = null;
  const months = monthKeysBetween(startDate, endDate);

  for (const monthKey of months) {
    const rows = await fetchTwseMonth(stockNo, monthKey);
    rows.forEach((row) => {
      const rowDate = parseTwseDate(row[0]);
      if (!rowDate || rowDate < startDate || rowDate > endDate) return;
      const high = parseTwseNumber(row[4]);
      const close = parseTwseNumber(row[6]);
      if (Number.isFinite(high)) highest = highest === null ? high : Math.max(highest, high);
      if (Number.isFinite(close) && (!latestDate || rowDate > latestDate)) {
        latestDate = rowDate;
        latestClose = close;
      }
    });
  }

  if (highest === null) throw new Error("查無這段期間的日成交資料");
  return { high: highest, current: latestClose, latestDate };
}

function setUpdateStatus(id, text, state = "") {
  const card = stocksEl.querySelector(`[data-id="${id}"]`);
  if (!card) return;
  const label = card.querySelector("[data-output='updateStatus']");
  label.className = state;
  label.textContent = text;
}

function setCloudStatus(text) {
  cloudStatus.textContent = text;
}

function toDbNumber(value) {
  const number = numberValue(value);
  return number > 0 ? number : null;
}

function toPositionRow(stock) {
  return {
    id: stock.id,
    user_id: currentUser.id,
    symbol: stock.symbol || "",
    entry_price: toDbNumber(stock.entry),
    buy_date: stock.buyDate || null,
    current_price: toDbNumber(stock.current),
    high_price: toDbNumber(stock.high),
    shares: toDbNumber(stock.shares),
  };
}

function fromPositionRow(row) {
  return {
    id: row.id,
    symbol: row.symbol || "",
    entry: row.entry_price ?? "",
    buyDate: row.buy_date ?? "",
    current: row.current_price ?? "",
    high: row.high_price ?? "",
    shares: row.shares ?? "",
  };
}

function calculateStock(stock) {
  const entry = numberValue(stock.entry);
  const current = numberValue(stock.current);
  const high = Math.max(numberValue(stock.high), current);
  const shares = numberValue(stock.shares);
  const activationRate = numberValue(settings.activationPercent.value) / 100;
  const pullbackRate = numberValue(settings.pullbackPercent.value) / 100;

  if (entry <= 0 || current <= 0 || high <= 0) {
    return {
      state: "pending",
      label: "待輸入",
      message: "請輸入有效價格",
      activationPrice: null,
      highGain: null,
      exitPrice: null,
      distance: null,
      pullback: null,
      profit: null,
    };
  }

  const activationPrice = entry * (1 + activationRate);
  const highProfit = high - entry;
  const highGain = (highProfit / entry) * 100;
  const active = high >= activationPrice;

  if (!active) {
    return {
      state: "inactive",
      label: "未啟動",
      message: `高點需達 ${currency(activationPrice)}`,
      activationPrice,
      highGain,
      exitPrice: null,
      distance: null,
      pullback: null,
      profit: null,
    };
  }

  const pullback = Math.max(0, highProfit * pullbackRate);
  const exitPrice = high - pullback;
  const distance = current - exitPrice;
  const profitPerShare = exitPrice - entry;
  const profit = shares > 0 ? profitPerShare * shares : profitPerShare;
  const shouldExit = current <= exitPrice;

  return {
    state: shouldExit ? "exit" : "hold",
    label: shouldExit ? "出場" : "持有",
    message: shouldExit ? "已跌破移動停利價" : "尚未觸發出場",
    activationPrice,
    highGain,
    exitPrice,
    distance,
    pullback,
    profit,
  };
}

function render() {
  stocksEl.innerHTML = "";

  stocks.forEach((stock) => {
    const card = template.content.firstElementChild.cloneNode(true);
    card.dataset.id = stock.id;
    card.querySelector("[data-field='symbol']").value = stock.symbol;
    card.querySelector("[data-field='entry']").value = stock.entry;
    card.querySelector("[data-field='buyDate']").value = stock.buyDate || "";
    card.querySelector("[data-field='current']").value = stock.current;
    card.querySelector("[data-field='high']").value = stock.high;
    card.querySelector("[data-field='shares']").value = stock.shares;
    stocksEl.append(card);
  });

  refreshResults();
}

function refreshResults() {
  const totals = { exit: 0, hold: 0, inactive: 0, profit: 0 };

  stocks.forEach((stock) => {
    const result = calculateStock(stock);
    if (result.state === "exit") totals.exit += 1;
    if (result.state === "hold") totals.hold += 1;
    if (result.state === "inactive") totals.inactive += 1;
    if (Number.isFinite(result.profit)) totals.profit += result.profit;

    const card = stocksEl.querySelector(`[data-id="${stock.id}"]`);
    if (!card) return;
    const status = card.querySelector("[data-output='status']");
    status.className = `badge ${result.state}`;
    status.textContent = result.label;
    card.querySelector("[data-output='summarySymbol']").textContent = stock.symbol || "未命名";
    card.querySelector("[data-output='summaryCurrent']").textContent = currency(numberValue(stock.current));
    card.querySelector("[data-output='message']").textContent = result.message;
    card.querySelector("[data-output='exitPrice']").textContent = currency(result.exitPrice);
    card.querySelector("[data-output='activationPrice']").textContent = currency(result.activationPrice);
    card.querySelector("[data-output='highGain']").textContent = percent(result.highGain);
    card.querySelector("[data-output='distance']").textContent = currency(result.distance);
    card.querySelector("[data-output='pullback']").textContent = currency(result.pullback);
    card.querySelector("[data-output='profit']").textContent = currency(result.profit);
  });

  summary.exitCount.textContent = totals.exit;
  summary.holdCount.textContent = totals.hold;
  summary.inactiveCount.textContent = totals.inactive;
  summary.totalProfit.textContent = currency(totals.profit);
}

function save() {
  hasLocalChanges = true;
  saveLocalSnapshot();
  scheduleCloudSave();
}

function saveLocalSnapshot() {
  const data = {
    settings: {
      activationPercent: settings.activationPercent.value,
      pullbackPercent: settings.pullbackPercent.value,
    },
    stocks,
  };
  localStorage.setItem(storageKey, JSON.stringify(data));
}

function stocksSignature(items = stocks) {
  return JSON.stringify(items.map((stock) => ({
    id: stock.id,
    symbol: stock.symbol || "",
    entry: stock.entry ?? "",
    buyDate: stock.buyDate ?? "",
    current: stock.current ?? "",
    high: stock.high ?? "",
    shares: stock.shares ?? "",
  })));
}

function restore() {
  try {
    const data = JSON.parse(localStorage.getItem(storageKey) || "{}");
    if (data.settings) {
      settings.activationPercent.value = data.settings.activationPercent ?? settings.activationPercent.value;
      settings.pullbackPercent.value = data.settings.pullbackPercent ?? settings.pullbackPercent.value;
    }
    if (Array.isArray(data.stocks) && data.stocks.length > 0) {
      stocks = data.stocks.map((stock) => ({
        id: stock.id || crypto.randomUUID(),
        symbol: stock.symbol || "未命名",
        entry: stock.entry ?? "",
        buyDate: stock.buyDate ?? "",
        current: stock.current ?? "",
        high: stock.high ?? "",
        shares: stock.shares ?? "",
      }));
    }
  } catch {
    localStorage.removeItem(storageKey);
  }
}

function restoreCloudConfig() {
  try {
    const config = JSON.parse(localStorage.getItem(cloudConfigKey) || "{}");
    const savedUrl = config.supabaseUrl || "";
    cloudFields.supabaseUrl.value = legacySupabaseUrls.has(savedUrl)
      ? defaultCloudConfig.supabaseUrl
      : savedUrl || defaultCloudConfig.supabaseUrl;
    cloudFields.supabaseAnonKey.value = config.supabaseAnonKey || defaultCloudConfig.supabaseAnonKey;
    cloudFields.loginEmail.value = config.loginEmail || "";
  } catch {
    localStorage.removeItem(cloudConfigKey);
    cloudFields.supabaseUrl.value = defaultCloudConfig.supabaseUrl;
    cloudFields.supabaseAnonKey.value = defaultCloudConfig.supabaseAnonKey;
  }
}

function saveCloudConfig() {
  const config = {
    supabaseUrl: cloudFields.supabaseUrl.value.trim(),
    supabaseAnonKey: cloudFields.supabaseAnonKey.value.trim(),
    loginEmail: cloudFields.loginEmail.value.trim(),
  };
  localStorage.setItem(cloudConfigKey, JSON.stringify(config));
  return config;
}

async function initSupabase() {
  const config = saveCloudConfig();
  if (!config.supabaseUrl || !config.supabaseAnonKey) {
    cloudReady = false;
    setCloudStatus("尚未填 Supabase URL 和 anon key，資料目前只存在這台裝置。");
    return null;
  }
  if (!window.supabase?.createClient) {
    cloudReady = false;
    setCloudStatus("Supabase client 載入失敗，請確認網路連線。");
    return null;
  }

  supabaseClient = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storageKey: authStorageKey,
    },
  });
  supabaseClient.auth.onAuthStateChange((_event, session) => {
    applySession(session);
  });

  const { data, error } = await supabaseClient.auth.getSession();
  if (error) {
    cloudReady = false;
    setCloudStatus(error.message);
    return null;
  }

  await applySession(data.session);
  return supabaseClient;
}

function startCloudRealtime() {
  if (!supabaseClient || !currentUser) return;
  if (cloudChannel) supabaseClient.removeChannel(cloudChannel);

  cloudChannel = supabaseClient
    .channel(`positions:${currentUser.id}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "positions",
        filter: `user_id=eq.${currentUser.id}`,
      },
      () => {
        if (!hasLocalChanges) pullCloudPositions({ silent: true });
      },
    )
    .subscribe((status) => {
      if (status === "SUBSCRIBED") setCloudStatus(`已登入 ${currentUser.email}，即時同步已啟用。`);
    });
}

async function sendLoginLink() {
  const client = await initSupabase();
  const email = cloudFields.loginEmail.value.trim();
  if (!client || !email) {
    setCloudStatus("請先填 Supabase 設定和 Email。");
    return;
  }
  const { error } = await client.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.href.split("#")[0] },
  });
  if (error) {
    setCloudStatus(error.message);
    return;
  }
  saveCloudConfig();
  setCloudStatus("登入連結已寄出，請到 Email 點連結後回到這個 app。");
}

async function pullCloudPositions({ silent = false } = {}) {
  if (!supabaseClient || !currentUser || pullingCloud || syncing || hasLocalChanges) return;
  pullingCloud = true;
  const { data, error } = await supabaseClient
    .from("positions")
    .select("*")
    .order("created_at", { ascending: true });
  pullingCloud = false;
  if (error) {
    setCloudStatus(error.message);
    return;
  }
  if (Array.isArray(data) && (data.length > 0 || hasLoadedCloudOnce)) {
    const cloudStocks = data.map(fromPositionRow);
    if (stocksSignature(cloudStocks) !== stocksSignature()) {
      stocks = cloudStocks;
      saveLocalSnapshot();
      render();
    }
    hasLoadedCloudOnce = true;
    if (!silent) setCloudStatus(`已更新雲端資料，共 ${stocks.length} 檔標的。`);
  } else if (stocks.length > 0) {
    await syncCloudNow();
    hasLoadedCloudOnce = true;
  }
}

async function syncCloudNow() {
  if (!supabaseClient || !currentUser || syncing) return;
  syncing = true;
  syncNowButton.disabled = true;
  syncNowButton.textContent = "同步中...";
  try {
    const rows = stocks.map(toPositionRow);
    if (rows.length > 0) {
      const { error } = await supabaseClient.from("positions").upsert(rows, { onConflict: "id" });
      if (error) throw error;
    }
    hasLocalChanges = false;
    setCloudStatus(`已自動同步 ${stocks.length} 檔標的。`);
  } catch (error) {
    setCloudStatus(error.message);
  } finally {
    syncing = false;
    syncNowButton.disabled = false;
    syncNowButton.textContent = "立即同步";
  }
}

let cloudSaveTimer = null;

function scheduleCloudSave() {
  if (!cloudReady) return;
  window.clearTimeout(cloudSaveTimer);
  cloudSaveTimer = window.setTimeout(syncCloudNow, 300);
}

function startCloudAutoRefresh() {
  window.clearInterval(cloudRefreshTimer);
  cloudRefreshTimer = window.setInterval(() => {
    if (document.visibilityState === "visible") pullCloudPositions({ silent: true });
  }, 20000);
}

function updateStock(id, field, value) {
  stocks = stocks.map((stock) => (
    stock.id === id ? { ...stock, [field]: value } : stock
  ));
  save();
  refreshResults();
}

addStockButton.addEventListener("click", () => {
  stocks = [
    ...stocks,
    { id: crypto.randomUUID(), symbol: "新標的", entry: "", buyDate: "", current: "", high: "", shares: "" },
  ];
  save();
  render();
});

async function updateHigh(id) {
  const stock = stocks.find((item) => item.id === id);
  if (!stock) return;
  setUpdateStatus(id, "更新中...");
  try {
    const data = await fetchListedHighSince(stock);
    stocks = stocks.map((item) => (
      item.id === id
        ? { ...item, high: data.high, current: data.current ?? item.current }
        : item
    ));
    save();
    render();
    setUpdateStatus(id, `已更新至 ${data.latestDate?.toLocaleDateString("zh-TW") || "最新交易日"}`, "success");
  } catch (error) {
    setUpdateStatus(id, error.message, "error");
  }
}

updateAllButton.addEventListener("click", async () => {
  updateAllButton.disabled = true;
  updateAllButton.textContent = "更新中...";
  for (const stock of stocks) {
    await updateHigh(stock.id);
  }
  updateAllButton.disabled = false;
  updateAllButton.textContent = "更新全部高點";
});

Object.values(settings).forEach((input) => {
  input.addEventListener("input", () => {
    save();
    refreshResults();
  });
});

stocksEl.addEventListener("input", (event) => {
  const input = event.target.closest("[data-field]");
  if (!input) return;
  const card = event.target.closest(".stock-card");
  updateStock(card.dataset.id, input.dataset.field, input.value);
});

stocksEl.addEventListener("click", (event) => {
  const updateButton = event.target.closest("[data-action='update-high']");
  if (updateButton) {
    const card = event.target.closest(".stock-card");
    updateHigh(card.dataset.id);
    return;
  }

  const toggleButton = event.target.closest("[data-action='toggle-details']");
  if (toggleButton) {
    const card = event.target.closest(".stock-card");
    const details = card.querySelector(".stock-details");
    const isOpen = !details.hidden;
    details.hidden = isOpen;
    toggleButton.setAttribute("aria-expanded", String(!isOpen));
    card.classList.toggle("expanded", !isOpen);
    return;
  }

  const button = event.target.closest("[data-action='remove']");
  if (!button) return;
  const card = event.target.closest(".stock-card");
  const removedId = card.dataset.id;
  stocks = stocks.filter((stock) => stock.id !== card.dataset.id);
  save();
  render();
  if (supabaseClient && currentUser) {
    supabaseClient.from("positions").delete().eq("id", removedId).then(({ error }) => {
      if (error) setCloudStatus(error.message);
    });
  }
});

saveCloudConfigButton.addEventListener("click", async () => {
  await initSupabase();
});

sendLoginLinkButton.addEventListener("click", sendLoginLink);

syncNowButton.addEventListener("click", async () => {
  await initSupabase();
  if (hasLocalChanges) await syncCloudNow();
  await pullCloudPositions();
});

cloudSignOut.addEventListener("click", async () => {
  if (supabaseClient && cloudChannel) await supabaseClient.removeChannel(cloudChannel);
  cloudChannel = null;
  if (supabaseClient) await supabaseClient.auth.signOut();
  currentUser = null;
  cloudReady = false;
  hasLocalChanges = false;
  hasLoadedCloudOnce = false;
  window.clearInterval(cloudRefreshTimer);
  cloudSignOut.hidden = true;
  sendLoginLinkButton.hidden = false;
  setCloudStatus("已登出，資料目前只存在這台裝置。");
});

window.addEventListener("focus", () => {
  pullCloudPositions({ silent: true });
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") pullCloudPositions({ silent: true });
});

restore();
restoreCloudConfig();
render();
initSupabase();

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("service-worker.js");
}
