const stocksEl = document.querySelector("#stocks");
const template = document.querySelector("#stockTemplate");
const addStockButton = document.querySelector("#addStock");
const updateAllButton = document.querySelector("#updateAll");
const cloudStatus = document.querySelector("#cloudStatus");
const cloudLoginButton = document.querySelector("#cloudLogin");
const cloudSignOut = document.querySelector("#cloudSignOut");
const loginModal = document.querySelector("#loginModal");
const loginStatus = document.querySelector("#loginStatus");
const closeLoginModalButton = document.querySelector("#closeLoginModal");
const saveCloudConfigButton = document.querySelector("#saveCloudConfig");
const sendLoginLinkButton = document.querySelector("#sendLoginLink");
const verifyLoginCodeButton = document.querySelector("#verifyLoginCode");
const syncNowButton = document.querySelector("#syncNow");
const tabButtons = [...document.querySelectorAll("[data-tab]")];
const tabPanels = [...document.querySelectorAll("[data-panel]")];

const cloudFields = {
  supabaseUrl: document.querySelector("#supabaseUrl"),
  supabaseAnonKey: document.querySelector("#supabaseAnonKey"),
  loginEmail: document.querySelector("#loginEmail"),
  loginCode: document.querySelector("#loginCode"),
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

const pnlTrend = {
  value: document.querySelector("#pnlTrendValue"),
  meta: document.querySelector("#pnlTrendMeta"),
  chart: document.querySelector("#pnlTrendChart"),
  grid: document.querySelector("#pnlTrendGrid"),
  bars: document.querySelector("#pnlTrendBars"),
  line: document.querySelector("#pnlTrendLine"),
  empty: document.querySelector("#pnlTrendEmpty"),
};

const storageKey = "stock-exit-portfolio-v3";
const cloudConfigKey = "stock-exit-supabase-config-v1";
const defaultCloudConfig = {
  supabaseUrl: "https://rdwfdxpwmccayzrrxqur.supabase.co",
  supabaseAnonKey: "sb_publishable_T9rVUpzsd7MvHYuo66_iRA_g-F_xj45",
};
const authStorageKey = "sb-rdwfdxpwmccayzrrxqur-auth-token";
const cloudSettingsSymbol = "__stock_exit_settings__";
const legacyAuthStorageKeys = ["stock-exit-auth-session-v1"];
const legacySupabaseUrls = new Set([
  "https://rdwfdxpmcccayzrrxqur.supabase.co",
]);
const stockDirectory = [
  ["1101", "台泥"],
  ["1216", "統一"],
  ["1301", "台塑"],
  ["1303", "南亞"],
  ["2002", "中鋼"],
  ["2303", "聯電"],
  ["2308", "台達電"],
  ["2317", "鴻海"],
  ["2330", "台積電"],
  ["2357", "華碩"],
  ["2382", "廣達"],
  ["2412", "中華電"],
  ["2454", "聯發科"],
  ["2881", "富邦金"],
  ["2882", "國泰金"],
  ["2884", "玉山金"],
  ["2886", "兆豐金"],
  ["2891", "中信金"],
  ["2892", "第一金"],
  ["3008", "大立光"],
  ["3060", "銘異"],
  ["3711", "日月光投控"],
  ["5871", "中租-KY"],
  ["5880", "合庫金"],
  ["8358", "金居"],
  ["6505", "台塑化"],
].map(([code, name]) => ({ code, name, label: `${code} ${name}` }));

let stocks = [];
let supabaseClient = null;
let currentUser = null;
let cloudReady = false;
let syncing = false;
let pullingCloud = false;
let hasLocalChanges = false;
let hasLoadedCloudOnce = false;
let cloudRefreshTimer = null;
let cloudChannel = null;
let cloudSettingsId = null;
let pnlHistory = [];
let remoteDeletedIds = new Set();
let cloudConfigSaveTimer = null;

function setActiveInfoTab(nextTab) {
  const currentTab = tabButtons.find((button) => button.classList.contains("is-active"))?.dataset.tab || "";
  const activeTab = currentTab === nextTab ? "" : nextTab;
  tabButtons.forEach((button) => {
    const isActive = button.dataset.tab === activeTab;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  });
  tabPanels.forEach((panel) => {
    panel.hidden = panel.dataset.panel !== activeTab;
    if (panel.matches("details") && panel.dataset.panel !== activeTab) panel.open = false;
  });
  const activePanel = tabPanels.find((panel) => panel.dataset.panel === activeTab);
  if (activePanel?.matches("details")) activePanel.open = true;
}
const stockLookupTimers = new Map();
const autoMarketFillTimers = new Map();
const stockLookupCache = new Map();
let tpexListingsPromise = null;

function migrateAuthSessionStorage() {
  try {
    if (localStorage.getItem(authStorageKey)) return;
    const legacyKey = legacyAuthStorageKeys.find((key) => localStorage.getItem(key));
    if (legacyKey) localStorage.setItem(authStorageKey, localStorage.getItem(legacyKey));
  } catch {
    // Some browsers can block storage; Supabase will fall back to an in-memory session.
  }
}

async function applySession(session) {
  currentUser = session?.user || null;
  cloudReady = Boolean(currentUser);
  cloudLoginButton.hidden = Boolean(currentUser);
  cloudSignOut.hidden = !currentUser;
  sendLoginLinkButton.hidden = Boolean(currentUser);
  verifyLoginCodeButton.hidden = Boolean(currentUser);
  cloudFields.loginCode.closest("label").hidden = Boolean(currentUser);

  if (!currentUser) {
    cloudSettingsId = null;
    remoteDeletedIds = new Set();
    setCloudStatus("尚未登入，資料目前只存在這台裝置。");
    return;
  }

  closeLoginModal();
  cloudFields.loginCode.value = "";
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

function compactCurrency(value) {
  if (!Number.isFinite(value)) return "-";
  const sign = value > 0 ? "+" : "";
  const abs = Math.abs(value);
  if (abs >= 100000000) return `${sign}${(value / 100000000).toFixed(2)}億`;
  if (abs >= 10000) return `${sign}${(value / 10000).toFixed(1)}萬`;
  return `${sign}${currency(value)}`;
}

function formatWan(value) {
  if (!Number.isFinite(value)) return "-";
  const wan = value / 10000;
  if (Math.abs(wan) >= 100) return wan.toFixed(0);
  if (Math.abs(wan) >= 10) return wan.toFixed(1).replace(/\.0$/, "");
  return wan.toFixed(2).replace(/\.?0+$/, "");
}

function percent(value) {
  if (!Number.isFinite(value)) return "-";
  return `${value.toFixed(2)}%`;
}

function todayKey(date = new Date()) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function addDays(date, amount) {
  const next = new Date(date);
  next.setDate(next.getDate() + amount);
  return next;
}

function parseStockNo(symbol) {
  return String(symbol || "").match(/\d{4,6}/)?.[0] || "";
}

function normalizeSymbol(value) {
  const text = String(value || "").trim();
  if (!text) return text;
  const match = findKnownStock(text);
  return match ? match.label : text;
}

function findKnownStock(value) {
  const text = String(value || "").trim();
  const code = parseStockNo(text);
  const normalizedName = text.replace(/\s/g, "");
  return stockDirectory.find((item) => (
    item.code === code || item.name === normalizedName || item.label.replace(/\s/g, "") === normalizedName
  ));
}

function previousMonthKeys(count) {
  const keys = [];
  const cursor = new Date();
  cursor.setDate(1);
  for (let index = 0; index < count; index += 1) {
    keys.push(toMonthKey(cursor));
    cursor.setMonth(cursor.getMonth() - 1);
  }
  return keys;
}

function parseListedSymbolTitle(stockNo, title) {
  const text = String(title || "").replace(/\s+/g, " ").trim();
  const match = text.match(new RegExp(`${stockNo}\\s+(.+?)\\s+(?:各日|每日|日成交)`));
  return match?.[1]?.trim() || "";
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

async function fetchTwseMonthPayload(stockNo, monthKey) {
  const url = `https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date=${monthKey}&stockNo=${stockNo}&response=json`;
  return fetchMarketJson("twse-stock-day", url, { stockNo, date: monthKey });
}

async function fetchTwseMonth(stockNo, monthKey) {
  const data = await fetchTwseMonthPayload(stockNo, monthKey);
  if (data.stat && data.stat !== "OK") return [];
  return Array.isArray(data.data) ? data.data : [];
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error("資料來源暫時無法連線");
  return response.json();
}

async function fetchMarketJson(source, directUrl, params = {}) {
  const supabaseUrl = (cloudFields.supabaseUrl.value || defaultCloudConfig.supabaseUrl || "").replace(/\/$/, "");
  if (supabaseUrl) {
    try {
      const query = new URLSearchParams({ source, ...params });
      const proxyUrl = `${supabaseUrl}/functions/v1/market-proxy?${query.toString()}`;
      const response = await fetch(proxyUrl);
      if (response.ok) return response.json();
    } catch {
      // Fall back to direct fetch; some browsers block market APIs without the proxy.
    }
  }
  return fetchJson(directUrl);
}

async function loadTpexListings() {
  if (!tpexListingsPromise) {
    tpexListingsPromise = Promise.all([
      fetchMarketJson("tpex-mainboard", "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes"),
      fetchMarketJson("tpex-emerging", "https://www.tpex.org.tw/openapi/v1/tpex_esb_latest_statistics"),
    ]).then(([mainboard, emerging]) => [
      ...mainboard.map((row) => ({
        code: String(row.SecuritiesCompanyCode || "").trim(),
        name: String(row.CompanyName || "").trim(),
        market: "otc",
        high: parseTwseNumber(row.High),
        current: parseTwseNumber(row.Close),
      })),
      ...emerging.map((row) => ({
        code: String(row.SecuritiesCompanyCode || "").trim(),
        name: String(row.CompanyName || "").trim(),
        market: "emerging",
        high: parseTwseNumber(row.Highest),
        current: parseTwseNumber(row.LatestPrice || row.Average),
      })),
    ].filter((item) => item.code && item.name)).catch(() => {
      tpexListingsPromise = null;
      throw new Error("瀏覽器無法直接讀取櫃買資料，請先手動輸入目前價，或啟用資料代理。");
    });
  }
  return tpexListingsPromise;
}

async function findTpexStock(stockNo) {
  const listings = await loadTpexListings();
  return listings.find((item) => item.code === stockNo) || null;
}

async function fetchListedSymbolLabel(stockNo) {
  if (stockLookupCache.has(stockNo)) return stockLookupCache.get(stockNo);

  for (const monthKey of previousMonthKeys(3)) {
    let data = null;
    try {
      data = await fetchTwseMonthPayload(stockNo, monthKey);
    } catch {
      continue;
    }
    if (data.stat && data.stat !== "OK") continue;
    const name = parseListedSymbolTitle(stockNo, data.title);
    if (name) {
      const label = `${stockNo} ${name}`;
      stockLookupCache.set(stockNo, label);
      return label;
    }
  }

  const tpexStock = await findTpexStock(stockNo);
  if (tpexStock) {
    const label = `${stockNo} ${tpexStock.name}`;
    stockLookupCache.set(stockNo, label);
    return label;
  }

  return "";
}

function scheduleSymbolLookup(id, rawValue) {
  const text = String(rawValue || "").trim();
  const stockNo = parseStockNo(text);
  if (!stockNo || findKnownStock(text)) return;

  window.clearTimeout(stockLookupTimers.get(id));
  stockLookupTimers.set(id, window.setTimeout(async () => {
    try {
      const label = await fetchListedSymbolLabel(stockNo);
      if (!label) return;
      const stock = stocks.find((item) => item.id === id);
      if (!stock) return;
      const currentText = String(stock.symbol || "").trim();
      const currentNo = parseStockNo(currentText);
      const canReplace = currentText === stockNo || currentText === text || (currentNo === stockNo && !currentText.includes(" "));
      if (!canReplace) return;
      stocks = stocks.map((item) => (item.id === id ? { ...item, symbol: label } : item));
      save();
      updateCardSymbolLabel(id, label);
      refreshResults();
      scheduleAutoMarketFill(id);
    } catch {
      // Keep the user's input when online lookup is unavailable.
    }
  }, 450));
}

function updateCardSymbolLabel(id, label) {
  const card = stocksEl.querySelector(`[data-id="${id}"]`);
  if (!card) return;
  const symbolInput = card.querySelector("[data-field='symbol']");
  if (symbolInput && document.activeElement !== symbolInput) symbolInput.value = label;
  if (symbolInput && document.activeElement === symbolInput) {
    symbolInput.value = label;
    symbolInput.setSelectionRange(label.length, label.length);
  }
  const summarySymbol = card.querySelector("[data-output='summarySymbol']");
  if (summarySymbol) summarySymbol.textContent = label || "未命名";
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
  let loadedMonths = 0;
  let confirmedListed = false;

  for (const monthKey of months) {
    let data = null;
    try {
      data = await fetchTwseMonthPayload(stockNo, monthKey);
    } catch {
      continue;
    }
    if (data.stat && data.stat !== "OK") continue;
    if (parseListedSymbolTitle(stockNo, data.title)) confirmedListed = true;
    loadedMonths += 1;
    const rows = Array.isArray(data.data) ? data.data : [];
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

  if (loadedMonths === 0) throw new Error("上市資料代理暫時無法連線，請稍後再試。");
  if (highest === null) {
    const error = new Error("查無這段期間的日成交資料");
    error.market = confirmedListed ? "listed" : "";
    throw error;
  }
  return { high: highest, current: latestClose, latestDate };
}

async function hasListedData(stockNo) {
  for (const monthKey of previousMonthKeys(3)) {
    try {
      const data = await fetchTwseMonthPayload(stockNo, monthKey);
      if (data.stat === "OK" && parseListedSymbolTitle(stockNo, data.title)) return true;
    } catch {
      continue;
    }
  }
  return false;
}

async function fetchTpexLatest(stock) {
  const stockNo = parseStockNo(stock.symbol);
  if (!stockNo) throw new Error("請輸入股票代號");
  const tpexStock = await findTpexStock(stockNo);
  if (!tpexStock) throw new Error("查無上市、上櫃或興櫃資料");
  if (!Number.isFinite(tpexStock.high) && !Number.isFinite(tpexStock.current)) {
    throw new Error("TPEx 目前沒有可用報價");
  }
  return {
    high: Number.isFinite(tpexStock.high) ? tpexStock.high : tpexStock.current,
    current: Number.isFinite(tpexStock.current) ? tpexStock.current : tpexStock.high,
    latestDate: new Date(),
    market: tpexStock.market,
  };
}

function realtimePriceFromPayload(payload) {
  const quote = Array.isArray(payload?.msgArray) ? payload.msgArray[0] : null;
  if (!quote) return null;
  const candidates = [quote.z, quote.pz, quote.a?.split("_")?.[0], quote.b?.split("_")?.[0], quote.y];
  const price = candidates.map(parseTwseNumber).find(Number.isFinite);
  if (!Number.isFinite(price) || price <= 0) return null;
  return {
    current: price,
    name: quote.n || "",
    time: [quote.d, quote.t || quote["%"]].filter(Boolean).join(" "),
  };
}

async function fetchRealtimeQuote(stockNo, preferredMarket = "") {
  const markets = preferredMarket ? [preferredMarket] : ["tse", "otc"];
  for (const market of markets) {
    try {
      const directUrl = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${market}_${stockNo}.tw&json=1&delay=0`;
      const payload = await fetchMarketJson("twse-realtime", directUrl, { stockNo, market });
      const quote = realtimePriceFromPayload(payload);
      if (quote) return { ...quote, market };
    } catch {
      continue;
    }
  }
  return null;
}

async function fetchMarketHigh(stock) {
  const stockNo = parseStockNo(stock.symbol);
  let data = null;
  try {
    data = await fetchListedHighSince(stock);
    const realtime = await fetchRealtimeQuote(stockNo, "tse");
    return realtime
      ? { ...data, current: realtime.current, note: "已更新高點與上市即時價" }
      : { ...data, note: "已更新高點，使用最新收盤價" };
  } catch (listedError) {
    if (/請先|不能晚於/.test(listedError.message)) throw listedError;
    if (listedError.market === "listed") throw listedError;
    let tpexData = null;
    try {
      tpexData = await fetchTpexLatest(stock);
    } catch (tpexError) {
      if (stockNo && await hasListedData(stockNo)) throw listedError;
      throw tpexError;
    }
    const realtime = await fetchRealtimeQuote(stockNo, tpexData.market === "otc" ? "otc" : "");
    return {
      ...tpexData,
      current: realtime?.current ?? tpexData.current,
      note: realtime
        ? "已更新高點與上櫃即時價"
        : tpexData.market === "emerging"
          ? "興櫃使用 TPEx 最新均價/成交資訊"
          : "上櫃使用 TPEx 最新收盤資訊",
      listedError,
    };
  }
}

function setUpdateStatus(id, text, state = "") {
  const card = stocksEl.querySelector(`[data-id="${id}"]`);
  if (!card) return;
  const label = card.querySelector("[data-output='updateStatus']");
  label.className = state;
  label.textContent = text;
}

function friendlyErrorMessage(error) {
  const message = String(error?.message || error || "");
  if (/timed out|逾時/i.test(message)) {
    return "更新逾時，已跳過這檔，請稍後再單獨更新。";
  }
  if (/FetchEvent|respondWith|response is null|Network request failed|Failed to fetch|Service Unavailable/i.test(message)) {
    return "資料來源暫時無法連線，請稍後再試。";
  }
  return message || "發生未知錯誤";
}

function withTimeout(promise, milliseconds, message = "更新逾時") {
  let timeoutId = null;
  const timeout = new Promise((_, reject) => {
    timeoutId = window.setTimeout(() => reject(new Error(message)), milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => window.clearTimeout(timeoutId));
}

function fetchMarketHighWithTimeout(stock) {
  return withTimeout(fetchMarketHigh(stock), 18000, "更新逾時");
}

function setCloudStatus(text) {
  cloudStatus.textContent = text;
}

function setLoginStatus(text, state = "") {
  if (!loginStatus) return;
  loginStatus.textContent = text;
  loginStatus.className = `login-status ${state}`.trim();
}

function openLoginModal() {
  setLoginStatus("");
  loginModal.hidden = false;
  window.setTimeout(() => cloudFields.loginEmail.focus(), 0);
}

function closeLoginModal() {
  loginModal.hidden = true;
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

function toSettingsRow() {
  return {
    id: cloudSettingsId,
    user_id: currentUser.id,
    symbol: cloudSettingsSymbol,
    entry_price: toDbNumber(settings.activationPercent.value),
    buy_date: null,
    current_price: null,
    high_price: toDbNumber(settings.pullbackPercent.value),
    shares: null,
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

function applyCloudSettings(row) {
  if (!row) return false;
  cloudSettingsId = row.id;
  const nextActivation = row.entry_price ?? "";
  const nextPullback = row.high_price ?? "";
  const changed = String(settings.activationPercent.value) !== String(nextActivation)
    || String(settings.pullbackPercent.value) !== String(nextPullback);
  settings.activationPercent.value = nextActivation;
  settings.pullbackPercent.value = nextPullback;
  if (changed) {
    saveLocalSnapshot();
    refreshResults();
  }
  return changed;
}

function calculateStock(stock) {
  const entry = numberValue(stock.entry);
  const current = numberValue(stock.current);
  const high = Math.max(numberValue(stock.high), current);
  const shares = numberValue(stock.shares);
  const activationRate = numberValue(settings.activationPercent.value) / 100;
  const pullbackRate = numberValue(settings.pullbackPercent.value) / 100;
  const currentGain = entry > 0 && current > 0 ? ((current - entry) / entry) * 100 : null;
  const profitPullbackRate = high > entry && current < high
    ? (high - current) / (high - entry)
    : 0;
  const isPullbackWarning = Number.isFinite(currentGain)
    && currentGain > 0
    && profitPullbackRate >= pullbackRate;

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
      currentGain,
      isPullbackWarning: false,
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
      currentGain,
      isPullbackWarning,
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
    currentGain,
    isPullbackWarning,
  };
}

function render() {
  const openIds = new Set(
    [...stocksEl.querySelectorAll(".stock-card.expanded")].map((card) => card.dataset.id),
  );
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
    if (openIds.has(stock.id)) setCardOpen(card, true);
  });

  refreshResults();
}

function setCardOpen(card, isOpen) {
  const details = card?.querySelector(".stock-details");
  const toggleButton = card?.querySelector("[data-action='toggle-details']");
  if (!details || !toggleButton) return;
  details.hidden = !isOpen;
  toggleButton.setAttribute("aria-expanded", String(isOpen));
  card.classList.toggle("expanded", isOpen);
}

function openStockForEditing(id) {
  const card = stocksEl.querySelector(`[data-id="${id}"]`);
  if (!card) return;
  setCardOpen(card, true);
  window.requestAnimationFrame(() => {
    card.scrollIntoView({ behavior: "smooth", block: "center" });
  });
  const symbolInput = card.querySelector("[data-field='symbol']");
  if (symbolInput) {
    symbolInput.focus();
    if (symbolInput.value) symbolInput.select();
  }
}

function recordDailyPnlSnapshot(value, count) {
  if (!Number.isFinite(value) || count <= 0) return false;
  const date = todayKey();
  const previousDate = todayKey(addDays(new Date(), -1));
  const roundedValue = Math.round(value * 100) / 100;
  let changed = false;
  if (pnlHistory.length === 0 || (pnlHistory.length === 1 && pnlHistory[0].date === date)) {
    if (!pnlHistory.some((item) => item.date === previousDate)) {
      pnlHistory.push({ date: previousDate, value: roundedValue, count });
      changed = true;
    }
  }
  const current = pnlHistory.find((item) => item.date === date);
  if (current) {
    changed = changed || current.value !== roundedValue || current.count !== count;
    current.value = roundedValue;
    current.count = count;
  } else {
    pnlHistory.push({ date, value: roundedValue, count });
    changed = true;
  }
  pnlHistory = pnlHistory
    .filter((item) => item.date && Number.isFinite(Number(item.value)))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-90);
  return changed;
}

function renderPnlTrend() {
  const points = pnlHistory.slice(-30);
  if (points.length === 0) {
    pnlTrend.value.textContent = "-";
    pnlTrend.value.classList.remove("down");
    pnlTrend.meta.textContent = "近 30 日";
    pnlTrend.chart.hidden = true;
    pnlTrend.empty.hidden = false;
    return;
  }

  const width = 640;
  const height = 220;
  const padding = { top: 16, right: 16, bottom: 38, left: 56 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const values = points.map((item) => Number(item.value));
  const minValue = Math.min(...values, 0);
  const maxValue = Math.max(...values, 0);
  const span = maxValue - minValue || 1;
  const tickCount = 4;
  const yFor = (value) => padding.top + ((maxValue - value) / span) * plotHeight;
  const zeroY = yFor(0);
  const slot = plotWidth / points.length;
  const barWidth = Math.max(8, Math.min(34, slot * 0.48));
  const tickValues = Array.from({ length: tickCount + 1 }, (_, index) => (
    minValue + (span / tickCount) * index
  ));
  const dateStep = Math.max(1, Math.ceil(points.length / 4));
  const last = points[points.length - 1];
  const first = points[0];

  pnlTrend.chart.hidden = false;
  pnlTrend.empty.hidden = true;
  pnlTrend.value.textContent = compactCurrency(Number(last.value));
  pnlTrend.value.classList.toggle("down", Number(last.value) < 0);
  pnlTrend.meta.textContent = `${first.date.slice(5).replace("-", "/")} - ${last.date.slice(5).replace("-", "/")} · 單位：萬 · ${last.count} 檔`;
  pnlTrend.grid.innerHTML = [
    ...tickValues.map((value) => {
      const y = yFor(value);
      return `<line x1="${padding.left}" x2="${width - padding.right}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"></line><text x="${padding.left - 8}" y="${(y + 4).toFixed(1)}">${formatWan(value)}</text>`;
    }),
    `<line class="zero" x1="${padding.left}" x2="${width - padding.right}" y1="${zeroY.toFixed(1)}" y2="${zeroY.toFixed(1)}"></line>`,
    `<text class="unit" x="8" y="15">(萬)</text>`,
  ].join("");
  const linePoints = points.map((item, index) => {
    const value = Number(item.value);
    const x = padding.left + index * slot + slot / 2;
    const y = yFor(value);
    return { x, y, value };
  });

  pnlTrend.bars.innerHTML = points.map((item, index) => {
    const value = Number(item.value);
    const x = padding.left + index * slot + (slot - barWidth) / 2;
    const y = value >= 0 ? yFor(value) : zeroY;
    const barHeight = Math.max(2, Math.abs(yFor(value) - zeroY));
    const dateLabel = item.date.slice(5).replace("-", "/");
    const showDate = index === 0 || index === points.length - 1 || index % dateStep === 0;
    return [
      `<rect class="${value < 0 ? "down" : "up"}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${barHeight.toFixed(1)}" rx="3"></rect>`,
      showDate ? `<text class="date" x="${(x + barWidth / 2).toFixed(1)}" y="${height - 12}">${dateLabel}</text>` : "",
    ].join("");
  }).join("");

  const path = linePoints.map((point, index) => (
    `${index === 0 ? "M" : "L"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`
  )).join(" ");
  pnlTrend.line.innerHTML = [
    `<path d="${path}"></path>`,
    ...linePoints.map((point) => (
      `<circle class="${point.value < 0 ? "down" : "up"}" cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="3.4"></circle>`
    )),
  ].join("");
}

function refreshResults() {
  const totals = { exit: 0, hold: 0, inactive: 0, profit: 0, dailyPnl: 0, dailyPnlCount: 0 };

  stocks.forEach((stock) => {
    const result = calculateStock(stock);
    if (result.state === "exit") totals.exit += 1;
    if (result.state === "hold") totals.hold += 1;
    if (result.state === "inactive") totals.inactive += 1;
    if (Number.isFinite(result.profit)) totals.profit += result.profit;
    const entry = numberValue(stock.entry);
    const current = numberValue(stock.current);
    const pnlShares = numberValue(stock.shares);
    if (entry > 0 && current > 0 && pnlShares > 0) {
      totals.dailyPnl += (current - entry) * pnlShares;
      totals.dailyPnlCount += 1;
    }

    const card = stocksEl.querySelector(`[data-id="${stock.id}"]`);
    if (!card) return;
    const status = card.querySelector("[data-output='status']");
    status.className = `badge ${result.state}`;
    status.textContent = result.label;
    card.querySelector("[data-output='summarySymbol']").textContent = stock.symbol || "未命名";
    const shares = numberValue(stock.shares);
    card.querySelector("[data-output='summaryShares']").textContent = shares > 0 ? shares.toLocaleString("zh-TW") : "-";
    card.querySelector("[data-output='summaryCurrent']").textContent = currency(numberValue(stock.current));
    const gainPercent = card.querySelector("[data-output='gainPercent']");
    gainPercent.textContent = percent(result.currentGain);
    gainPercent.className = result.isPullbackWarning
      ? "gain-warning"
      : Number.isFinite(result.currentGain)
        ? (result.currentGain >= 0 ? "gain-up" : "gain-down")
      : "";
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
  const trendChanged = recordDailyPnlSnapshot(totals.dailyPnl, totals.dailyPnlCount);
  renderPnlTrend();
  if (trendChanged) saveLocalSnapshot();
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
    pnlHistory,
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

function hasMeaningfulStock(stock) {
  return Boolean(parseStockNo(stock.symbol) || stock.symbol || stock.entry || stock.current || stock.high || stock.shares || stock.buyDate);
}

function sameValue(a, b) {
  return String(a ?? "") === String(b ?? "");
}

function isSeedDemoStock(stock) {
  return (
    sameValue(stock.symbol, "2330 台積電")
    && sameValue(stock.entry, 800)
    && sameValue(stock.buyDate, "2026-01-02")
    && sameValue(stock.current, 950)
    && sameValue(stock.high, 1000)
    && sameValue(stock.shares, 1000)
  ) || (
    sameValue(stock.symbol, "範例 B")
    && sameValue(stock.entry, 100)
    && sameValue(stock.buyDate, "2026-01-02")
    && sameValue(stock.current, 114)
    && sameValue(stock.high, 120)
    && sameValue(stock.shares, 1000)
  );
}

function mergeCloudStocks(cloudStocks) {
  const cloudIds = new Set(cloudStocks.map((stock) => stock.id));
  const localOnlyStocks = stocks.filter((stock) => (
    !cloudIds.has(stock.id)
    && !remoteDeletedIds.has(stock.id)
    && hasMeaningfulStock(stock)
    && !isSeedDemoStock(stock)
  ));
  return {
    mergedStocks: [...cloudStocks.filter((stock) => !isSeedDemoStock(stock)), ...localOnlyStocks],
    preservedCount: localOnlyStocks.length,
  };
}

function restore() {
  try {
    const data = JSON.parse(localStorage.getItem(storageKey) || "{}");
    if (data.settings) {
      settings.activationPercent.value = data.settings.activationPercent ?? settings.activationPercent.value;
      settings.pullbackPercent.value = data.settings.pullbackPercent ?? settings.pullbackPercent.value;
    }
    if (Array.isArray(data.stocks) && data.stocks.length > 0) {
      stocks = data.stocks
        .map((stock) => ({
          id: stock.id || crypto.randomUUID(),
          symbol: stock.symbol || "未命名",
          entry: stock.entry ?? "",
          buyDate: stock.buyDate ?? "",
          current: stock.current ?? "",
          high: stock.high ?? "",
          shares: stock.shares ?? "",
        }))
        .filter((stock) => !isSeedDemoStock(stock));
    }
    if (Array.isArray(data.pnlHistory)) {
      pnlHistory = data.pnlHistory
        .filter((item) => item?.date && Number.isFinite(Number(item.value)))
        .map((item) => ({
          date: item.date,
          value: Number(item.value),
          count: Number(item.count) || 0,
        }))
        .sort((a, b) => a.date.localeCompare(b.date))
        .slice(-90);
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

function scheduleCloudConfigSave() {
  window.clearTimeout(cloudConfigSaveTimer);
  cloudConfigSaveTimer = window.setTimeout(saveCloudConfig, 300);
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

  migrateAuthSessionStorage();
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
      (payload) => {
        if (payload.eventType === "DELETE" && payload.old?.id) remoteDeletedIds.add(payload.old.id);
        if (!hasLocalChanges) pullCloudPositions({ silent: true });
      },
    )
    .subscribe((status) => {
      if (status === "SUBSCRIBED") setCloudStatus(`已登入 ${currentUser.email}，即時同步已啟用。`);
    });
}

async function sendLoginCode() {
  const client = await initSupabase();
  const email = cloudFields.loginEmail.value.trim();
  if (!client || !email) {
    const message = "請先填 Supabase 設定和 Email。";
    setCloudStatus(message);
    setLoginStatus(message, "error");
    return;
  }
  if (!email.includes("@")) {
    const message = "請輸入有效的 Email。";
    setCloudStatus(message);
    setLoginStatus(message, "error");
    return;
  }
  sendLoginLinkButton.disabled = true;
  sendLoginLinkButton.textContent = "寄送中...";
  setLoginStatus("正在寄送驗證碼...");
  try {
    const { error } = await client.auth.signInWithOtp({
      email,
      options: {
        shouldCreateUser: true,
        emailRedirectTo: window.location.href.split("#")[0],
      },
    });
    if (error) {
      setCloudStatus(error.message);
      setLoginStatus(error.message, "error");
      return;
    }
    saveCloudConfig();
    const message = "驗證碼已寄出，請在這裡輸入 Email 裡的驗證碼。";
    setCloudStatus(message);
    setLoginStatus(message, "success");
    cloudFields.loginCode.focus();
  } catch (error) {
    const message = error?.message || "寄送失敗，請確認網路連線後再試一次。";
    setCloudStatus(message);
    setLoginStatus(message, "error");
  } finally {
    sendLoginLinkButton.disabled = false;
    sendLoginLinkButton.textContent = "寄驗證碼";
  }
}

async function verifyLoginCode() {
  const client = await initSupabase();
  const email = cloudFields.loginEmail.value.trim();
  const token = cloudFields.loginCode.value.trim().replace(/\s/g, "");
  if (!client || !email || !token) {
    const message = "請先填 Email 和驗證碼。";
    setCloudStatus(message);
    setLoginStatus(message, "error");
    return;
  }

  verifyLoginCodeButton.disabled = true;
  verifyLoginCodeButton.textContent = "驗證中...";
  setLoginStatus("正在驗證...");
  try {
    const { data, error } = await client.auth.verifyOtp({
      email,
      token,
      type: "email",
    });
    if (error) {
      setCloudStatus(error.message);
      setLoginStatus(error.message, "error");
      return;
    }

    saveCloudConfig();
    await applySession(data.session);
    setLoginStatus("登入成功。", "success");
  } catch (error) {
    const message = error?.message || "驗證失敗，請稍後再試。";
    setCloudStatus(message);
    setLoginStatus(message, "error");
  } finally {
    verifyLoginCodeButton.disabled = false;
    verifyLoginCodeButton.textContent = "驗證登入";
  }
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
  const rows = Array.isArray(data) ? data : [];
  const settingsRow = rows.find((row) => row.symbol === cloudSettingsSymbol);
  const positionRows = rows.filter((row) => row.symbol !== cloudSettingsSymbol);
  const demoRows = positionRows.filter((row) => isSeedDemoStock(fromPositionRow(row)));
  if (demoRows.length > 0) {
    supabaseClient
      .from("positions")
      .delete()
      .in("id", demoRows.map((row) => row.id))
      .then(({ error: cleanupError }) => {
        if (cleanupError && !silent) setCloudStatus(cleanupError.message);
      });
  }
  const realPositionRows = positionRows.filter((row) => !isSeedDemoStock(fromPositionRow(row)));
  if (settingsRow) applyCloudSettings(settingsRow);

  if (realPositionRows.length > 0 || hasLoadedCloudOnce) {
    const cloudStocks = realPositionRows.map(fromPositionRow);
    const { mergedStocks, preservedCount } = mergeCloudStocks(cloudStocks);
    if (stocksSignature(mergedStocks) !== stocksSignature()) {
      stocks = mergedStocks;
      saveLocalSnapshot();
      render();
    }
    if (preservedCount > 0) {
      hasLocalChanges = true;
      scheduleCloudSave();
    }
    hasLoadedCloudOnce = true;
    if (!silent) {
      setCloudStatus(preservedCount > 0
        ? `已更新雲端資料，並保留 ${preservedCount} 檔尚未上傳完成的本機標的。`
        : `已更新雲端資料，共 ${stocks.length} 檔標的。`);
    }
  } else if (stocks.length > 0) {
    await syncCloudNow();
    hasLoadedCloudOnce = true;
  }
}

async function ensureCloudSettingsId() {
  if (cloudSettingsId) return;
  const { data, error } = await supabaseClient
    .from("positions")
    .select("id")
    .eq("symbol", cloudSettingsSymbol)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  cloudSettingsId = data?.id || crypto.randomUUID();
}

async function syncCloudNow() {
  if (!supabaseClient || !currentUser || syncing) return;
  syncing = true;
  syncNowButton.disabled = true;
  syncNowButton.textContent = "同步中...";
  try {
    await ensureCloudSettingsId();
    const rows = [...stocks.filter((stock) => !isSeedDemoStock(stock)).map(toPositionRow), toSettingsRow()];
    if (rows.length > 0) {
      const { error } = await supabaseClient.from("positions").upsert(rows, { onConflict: "id" });
      if (error) throw error;
    }
    hasLocalChanges = false;
    setCloudStatus(`已自動同步 ${stocks.length} 檔標的與停利設定。`);
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
  const nextValue = field === "symbol" ? normalizeSymbol(value) : value;
  stocks = stocks.map((stock) => (
    stock.id === id ? { ...stock, [field]: nextValue } : stock
  ));
  save();
  refreshResults();
  return nextValue;
}

addStockButton.addEventListener("click", () => {
  const id = crypto.randomUUID();
  stocks = [
    ...stocks,
    { id, symbol: "", entry: "", buyDate: "", current: "", high: "", shares: "" },
  ];
  save();
  render();
  openStockForEditing(id);
});

async function updateHigh(id) {
  const stock = stocks.find((item) => item.id === id);
  if (!stock) return;
  setUpdateStatus(id, "更新中...");
  try {
    const data = await fetchMarketHighWithTimeout(stock);
    stocks = stocks.map((item) => (
      item.id === id
        ? { ...item, high: Math.max(numberValue(item.high), data.high), current: data.current ?? item.current }
        : item
    ));
    save();
    render();
    setUpdateStatus(id, data.note || `已更新至 ${data.latestDate?.toLocaleDateString("zh-TW") || "最新交易日"}`, "success");
  } catch (error) {
    setUpdateStatus(id, friendlyErrorMessage(error), "error");
  }
}

function shouldAutoFillMarketPrices(stock) {
  if (!stock || !parseStockNo(stock.symbol)) return false;
  if (numberValue(stock.entry) <= 0 || !stock.buyDate) return false;
  if (Number.isNaN(new Date(stock.buyDate).getTime())) return false;
  return numberValue(stock.current) <= 0 || numberValue(stock.high) <= 0;
}

function scheduleAutoMarketFill(id) {
  window.clearTimeout(autoMarketFillTimers.get(id));
  autoMarketFillTimers.set(id, window.setTimeout(() => {
    autoFillMarketPrices(id);
  }, 700));
}

async function autoFillMarketPrices(id) {
  const stock = stocks.find((item) => item.id === id);
  if (!shouldAutoFillMarketPrices(stock)) return;
  setUpdateStatus(id, "自動查詢現價與高點...");
  try {
    const data = await fetchMarketHighWithTimeout(stock);
    let changed = false;
    stocks = stocks.map((item) => {
      if (item.id !== id) return item;
      const next = { ...item };
      if (numberValue(next.current) <= 0 && data.current != null) {
        next.current = data.current;
        changed = true;
      }
      if (numberValue(next.high) <= 0 && Number.isFinite(data.high)) {
        next.high = data.high;
        changed = true;
      }
      return next;
    });
    if (!changed) return;
    save();
    render();
    setUpdateStatus(id, "已自動填入現價與高點。", "success");
  } catch (error) {
    setUpdateStatus(id, friendlyErrorMessage(error), "error");
  }
}

updateAllButton.addEventListener("click", async () => {
  const ids = stocks.map((stock) => stock.id);
  if (ids.length === 0) return;
  updateAllButton.disabled = true;
  updateAllButton.textContent = `更新中 0/${ids.length}`;
  const updates = new Map();
  const statuses = new Map();

  try {
    for (const [index, id] of ids.entries()) {
      const stock = stocks.find((item) => item.id === id);
      if (!stock) continue;
      setUpdateStatus(id, "更新中...");
      updateAllButton.textContent = `更新中 ${index + 1}/${ids.length}`;
      try {
        const data = await fetchMarketHighWithTimeout(stock);
        updates.set(id, data);
        statuses.set(id, {
          text: data.note || `已更新至 ${data.latestDate?.toLocaleDateString("zh-TW") || "最新交易日"}`,
          state: "success",
        });
      } catch (error) {
        statuses.set(id, { text: friendlyErrorMessage(error), state: "error" });
      }
    }

    if (updates.size > 0) {
      stocks = stocks.map((item) => {
        const data = updates.get(item.id);
        if (!data) return item;
        return { ...item, high: Math.max(numberValue(item.high), data.high), current: data.current ?? item.current };
      });
      save();
      render();
    }

    statuses.forEach((status, id) => setUpdateStatus(id, status.text, status.state));
  } finally {
    updateAllButton.disabled = false;
    updateAllButton.textContent = "更新全部高點";
  }
});

Object.values(settings).forEach((input) => {
  input.addEventListener("input", () => {
    save();
    refreshResults();
  });
});

tabButtons.forEach((button) => {
  button.setAttribute("aria-pressed", "false");
  button.addEventListener("click", () => setActiveInfoTab(button.dataset.tab));
});

stocksEl.addEventListener("input", (event) => {
  const input = event.target.closest("[data-field]");
  if (!input) return;
  const card = event.target.closest(".stock-card");
  const nextValue = updateStock(card.dataset.id, input.dataset.field, input.value);
  if (input.dataset.field === "symbol") {
    if (nextValue !== input.value) input.value = nextValue;
    scheduleSymbolLookup(card.dataset.id, nextValue);
  }
  if (["symbol", "entry", "buyDate"].includes(input.dataset.field)) {
    scheduleAutoMarketFill(card.dataset.id);
  }
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
    setCardOpen(card, details.hidden);
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

cloudLoginButton.addEventListener("click", openLoginModal);
closeLoginModalButton.addEventListener("click", closeLoginModal);
loginModal.addEventListener("click", (event) => {
  if (event.target === loginModal) closeLoginModal();
});

sendLoginLinkButton.addEventListener("click", sendLoginCode);
verifyLoginCodeButton.addEventListener("click", verifyLoginCode);

cloudFields.loginCode.addEventListener("keydown", (event) => {
  if (event.key === "Enter") verifyLoginCode();
});

cloudFields.loginEmail.addEventListener("input", scheduleCloudConfigSave);
cloudFields.loginEmail.addEventListener("blur", saveCloudConfig);

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
  cloudSettingsId = null;
  remoteDeletedIds = new Set();
  window.clearInterval(cloudRefreshTimer);
  cloudLoginButton.hidden = false;
  cloudSignOut.hidden = true;
  sendLoginLinkButton.hidden = false;
  verifyLoginCodeButton.hidden = false;
  cloudFields.loginCode.closest("label").hidden = false;
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
