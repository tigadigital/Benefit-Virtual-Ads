/*
  VA Benefit Ploting v0.50
  - Firebase Realtime Database menjadi sumber data bersama secara realtime.
  - Firebase Authentication memakai username internal + password dengan direktori akun dinamis untuk karyawan dan PIC.
  - Tanggal operasional otomatis mengikuti tanggal hari ini saat aplikasi dibuka.
  - Filter periode memakai Tahun + Bulan, serta Report PIC memakai Tahun + Kuartal.
  - Performa awal dioptimalkan dengan render halaman aktif, cache aman per akun, dan sinkronisasi tanpa tulis ulang saat memuat data.
*/

import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  createUserWithEmailAndPassword,
  updateProfile,
  updateEmail,
  updatePassword,
  deleteUser,
  reauthenticateWithCredential,
  EmailAuthProvider
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js";
import { getDatabase, ref, onValue, update } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-database.js";

const LOCAL_SETTINGS_KEY = "va-benefit-ploting-v28-settings";
const LOCAL_CACHE_PREFIX = "va-benefit-ploting-v30-cache";
const CACHE_SCHEMA_VERSION = 30;
const REALTIME_DATABASE_ROOT = "vaBenefitPloting/shared";
const INTERNAL_AUTH_DOMAIN = "benefit-virtual-ads.app";

function normalizeAccountUsername(value) {
  return String(value ?? "")
    .trim()
    .toLocaleLowerCase("id-ID")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, ".")
    .replace(/[^a-z0-9._-]/g, "")
    .replace(/[._-]{2,}/g, ".")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 32);
}

function internalEmailFromUsername(value) {
  const username = normalizeAccountUsername(value);
  return username ? `${username}@${INTERNAL_AUTH_DOMAIN}` : "";
}

function usernameFromInternalEmail(value) {
  const email = String(value || "").trim().toLocaleLowerCase("id-ID");
  if (!email) return "";
  return normalizeAccountUsername(email.split("@")[0]);
}

function loginEmailFromIdentifier(value) {
  const identifier = String(value || "").trim().toLocaleLowerCase("id-ID");
  if (identifier.includes("@")) return identifier;
  return internalEmailFromUsername(identifier);
}

function validAccountUsername(value) {
  const username = normalizeAccountUsername(value);
  return username.length >= 2 && username.length <= 32;
}

// Akun lama dipakai sebagai fallback dan dimigrasikan otomatis ke direktori akun dinamis.
// Semua akun baru selanjutnya disimpan pada Realtime Database > teamAccounts.
const LEGACY_TEAM_ACCOUNTS = Object.freeze({
  rakha: Object.freeze({ id: "rakha", username: "rakha", name: "Rakha", email: "rakha@benefit-virtual-ads.app", avatar: "assets/profile-rakha.jpg", role: "admin", active: true }),
  adhi: Object.freeze({ id: "adhi", username: "adhi", name: "Adhi", email: "adhi@benefit-virtual-ads.app", avatar: "assets/profile-adhi.jpg", role: "admin", active: true }),
  rian: Object.freeze({ id: "rian", username: "rian", name: "Rian", email: "rian@benefit-virtual-ads.app", avatar: "assets/profile-rian.jpg", role: "admin", active: true })
});
const LEGACY_TEAM_ACCOUNT_BY_EMAIL = Object.freeze(
  Object.values(LEGACY_TEAM_ACCOUNTS).reduce((accounts, account) => {
    accounts[account.email] = account;
    return accounts;
  }, {})
);

// Konfigurasi Firebase untuk aplikasi Benefit Virtual Ads.
const firebaseConfig = {
  apiKey: "AIzaSyApt0vF8DdKcCrCllWzbJAbvmbJeW6TZVM",
  authDomain: "benefit-virtual-ads.firebaseapp.com",
  projectId: "benefit-virtual-ads",
  storageBucket: "benefit-virtual-ads.firebasestorage.app",
  messagingSenderId: "707145076476",
  appId: "1:707145076476:web:582aaac96143a22803d179",
  measurementId: "G-2T269QR6NS",
  // URL instance Realtime Database yang diverifikasi dari Firebase Console.
  databaseURL: "https://benefit-virtual-ads-default-rtdb.asia-southeast1.firebasedatabase.app"
};

const firebaseApp = initializeApp(firebaseConfig);
const firebaseAuth = getAuth(firebaseApp);
const realtimeDb = getDatabase(firebaseApp, firebaseConfig.databaseURL);
const realtimeRootRef = ref(realtimeDb, REALTIME_DATABASE_ROOT);
const realtimeConnectionRef = ref(realtimeDb, ".info/connected");
const realtimeMastersRef = ref(realtimeDb, `${REALTIME_DATABASE_ROOT}/masters`);
const realtimeSchedulesRef = ref(realtimeDb, `${REALTIME_DATABASE_ROOT}/schedules`);
const realtimeAuditLogsRef = ref(realtimeDb, `${REALTIME_DATABASE_ROOT}/auditLogs`);
const realtimeMessagesRef = ref(realtimeDb, `${REALTIME_DATABASE_ROOT}/messages`);
const realtimeRemindersRef = ref(realtimeDb, `${REALTIME_DATABASE_ROOT}/reminders`);
const realtimeTeamAccountsRef = ref(realtimeDb, `${REALTIME_DATABASE_ROOT}/teamAccounts`);
const getLocalIsoDate = () => {
  const now = new Date();
  const local = new Date(now.getTime() - (now.getTimezoneOffset() * 60_000));
  return local.toISOString().slice(0, 10);
};
const DEFAULT_OPERATION_DATE = getLocalIsoDate();
const AIRING_STATUSES = ["Planned", "Siap tayang", "On air", "Sudah tayang", "Tidak tayang", "Dibatalkan"];
const MONTH_OPTIONS = [
  ["01", "Januari"], ["02", "Februari"], ["03", "Maret"], ["04", "April"],
  ["05", "Mei"], ["06", "Juni"], ["07", "Juli"], ["08", "Agustus"],
  ["09", "September"], ["10", "Oktober"], ["11", "November"], ["12", "Desember"]
];
const QUARTER_OPTIONS = [
  ["Q1", "Q1 · Jan–Mar"], ["Q2", "Q2 · Apr–Jun"],
  ["Q3", "Q3 · Jul–Sep"], ["Q4", "Q4 · Okt–Des"]
];

// Generator pesan WhatsApp dibatasi sampai lima segment manual per program.
const WA_SEGMENT_OPTIONS = [1, 2, 3, 4, 5];

const MASTER_META = {
  advertisers: { label: "PT Advertiser", field: "advertiser", placeholder: "Contoh: PT Unilever Indonesia" },
  pods: { label: "POD", field: "pod", placeholder: "Contoh: POD 8" },
  units: { label: "Unit On Air", field: "unit", placeholder: "Contoh: RCTI" },
  formats: { label: "Format VA", field: "format", placeholder: "Contoh: SUPERIMPOSE" },
  durations: { label: "Durasi", field: "duration", placeholder: "Contoh: 15 detik" },
  gfx: { label: "Materi GFX", field: "gfx", placeholder: "Contoh: GFX Baru" },
  pics: { label: "PIC Ploting", field: "pic", placeholder: "Contoh: Nama PIC" }
};

const defaultMasters = {
  advertisers: [],
  pods: ["POD 1", "POD 2", "POD 3", "POD 4", "POD 5", "POD 6", "POD 7"],
  units: ["RCTI", "MNCTV", "GTV"],
  formats: ["FREEZE SCENE", "VA 2D + RT", "SUPERIMPOSE", "SQUEEZE FRAME", "ADLIB", "OTHER"],
  durations: ["5 detik", "10 detik", "10 + 10 detik", "15 detik", "20 detik", "30 detik"],
  gfx: ["GFX Lama", "GFX Baru", "Tidak perlu GFX"],
  pics: []
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));
const clone = (value) => JSON.parse(JSON.stringify(value));
const unique = (values) => [...new Set(values.filter(Boolean))];
const sum = (values) => values.reduce((total, value) => total + Number(value || 0), 0);
const nowIso = () => new Date().toISOString();
const sortText = (values) => [...values].sort((a, b) => a.localeCompare(b, "id"));
const escapeHTML = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));

const THEME_STORAGE_KEY = "va-benefit-color-theme";

function currentColorTheme() {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function savedColorTheme() {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    return saved === "dark" || saved === "light" ? saved : "";
  } catch (error) {
    return "";
  }
}

function updateThemeToggleControls(theme) {
  const darkModeActive = theme === "dark";
  const nextLabel = darkModeActive ? "Mode terang" : "Mode gelap";
  const actionLabel = darkModeActive ? "Aktifkan mode terang" : "Aktifkan mode gelap";
  $$('[data-theme-toggle]').forEach((button) => {
    button.setAttribute("aria-pressed", String(darkModeActive));
    button.setAttribute("aria-label", actionLabel);
    button.title = actionLabel;
    const label = button.querySelector("[data-theme-toggle-label]");
    if (label) label.textContent = nextLabel;
  });
}

function applyColorTheme(theme, persist = true) {
  const normalizedTheme = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = normalizedTheme;
  document.documentElement.style.colorScheme = normalizedTheme;
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  if (themeMeta) themeMeta.content = normalizedTheme === "dark" ? "#1C3555" : "#075AA8";
  updateThemeToggleControls(normalizedTheme);
  if (!persist) return;
  try { localStorage.setItem(THEME_STORAGE_KEY, normalizedTheme); } catch (error) { /* Theme persistence is optional. */ }
}

function bindThemeEvents() {
  applyColorTheme(currentColorTheme(), false);
  $$('[data-theme-toggle]').forEach((button) => {
    button.addEventListener("click", () => {
      applyColorTheme(currentColorTheme() === "dark" ? "light" : "dark");
    });
  });

  const themeMedia = window.matchMedia?.("(prefers-color-scheme: dark)");
  themeMedia?.addEventListener?.("change", (event) => {
    if (!savedColorTheme()) applyColorTheme(event.matches ? "dark" : "light", false);
  });
}

let state = loadState();
let activeView = "dashboard";
let filters = {
  plot: { query: "", year: "", month: "", unit: "", gfx: "", airing: "", page: 1, perPage: 20 },
  batch: { query: "", year: "", month: "", unit: "", page: 1, perPage: 20 },
  full: { year: "", month: "", unit: "", brand: "" },
  brand: { brand: "", year: "", month: "", unit: "", program: "", format: "" },
  pic: { pic: "", year: "", quarter: "" },
  audit: { query: "", actor: "", action: "" }
};
let toastSequence = 0;
let unsubscribeMasters = null;
let unsubscribeSchedules = null;
let unsubscribeAuditLogs = null;
let unsubscribeMessages = null;
let unsubscribeReminders = null;
let unsubscribeTeamAccounts = null;
let unsubscribeConnection = null;
let firebaseLoadTimeout = null;
let currentFirebaseUser = null;
let firebaseBootstrapComplete = false;
let firebaseMasterLoaded = false;
let firebaseSchedulesLoaded = false;
let firebaseSyncQueued = false;
let firebaseSyncInProgress = false;
let firebasePendingSync = false;
let remoteMasters = null;
let remotePlotings = new Map();
let firebaseInitialHydrationComplete = false;
let firebaseNeedsNameNormalizationSync = false;
let legacyImportSession = null;
let sheetJsLoadingPromise = null;
let html2CanvasLoadingPromise = null;
let legacyImportInProgress = false;
let auditLogs = [];
let teamMessages = [];
let teamReminders = [];
let teamChatReadSyncInProgress = false;
let activeIncomingReminderId = "";
let teamChatState = { selectedRecipientId: "", reminderComposerOpen: false, panelOpen: false };
let teamAccounts = {};
let teamAccountsLoaded = false;
let profileMenuOpen = false;
let profileActiveTab = "profile";
let profileAvatarDraft = "";
let accountDeletionInProgress = false;

// Pengaturan generator WA hanya berlaku selama sesi dan tidak mengubah data ploting utama.
let waGeneratorState = { selectedProgramKey: "", assignments: {} };

// Tanggal yang sedang dipilih pada kalender mobile. Hanya agenda tanggal ini yang ditampilkan.
const mobileCalendarSelections = { full: "", brand: "" };

// Report mobile dibuka bertahap agar halaman tidak memuat daftar panjang sekaligus.
const mobilePicReportState = {
  sections: { overview: true, scope: false, detail: false },
  detailLimit: 8
};

function isMobileAppLayout() {
  return Boolean(window.matchMedia?.("(max-width: 760px)")?.matches);
}

// Pemilih multi-tanggal hanya dipakai pada modal Tambah/Edit Ploting.
// Tanggal yang dipilih akan ditambahkan sebagai baris jadwal terpisah.
let multiDatePickerState = {
  open: false,
  year: Number(yearFromDate(DEFAULT_OPERATION_DATE)),
  month: Number(monthFromDate(DEFAULT_OPERATION_DATE)),
  selectedDates: new Set()
};

// Data Juli 2026 sudah lebih dulu diinput langsung ke aplikasi.
// Import data lama hanya mengambil periode Januari sampai Juni 2026.
const LEGACY_IMPORT_EXCLUDED_MONTHS = new Set(["2026-07"]);

function isExcludedLegacyImportMonth(isoDate) {
  return LEGACY_IMPORT_EXCLUDED_MONTHS.has(String(isoDate || "").slice(0, 7));
}

function legacyExcludedMonthLabel(isoDate) {
  const [year, month] = String(isoDate || "").slice(0, 7).split("-");
  const label = MONTH_OPTIONS.find(([value]) => value === month)?.[1] || month;
  return year && month ? `${label} ${year}` : "periode yang dikecualikan";
}

function realtimeCacheKey(user = currentFirebaseUser) {
  return user?.uid ? `${LOCAL_CACHE_PREFIX}:${user.uid}` : "";
}

function readRealtimeCache(user = currentFirebaseUser) {
  const key = realtimeCacheKey(user);
  if (!key) return null;
  try {
    const cached = JSON.parse(localStorage.getItem(key) || "null");
    if (!cached || !Array.isArray(cached.plotings)) return null;
    return cached;
  } catch (error) {
    return null;
  }
}

function hydrateRealtimeCache(user = currentFirebaseUser) {
  const cached = readRealtimeCache(user);
  if (!cached) return false;
  state.plotings = sortByDate(normalizePlotings(cached.plotings));
  state.masters = normalizeMasters(cached.masters || defaultMasters, state.plotings);
  return true;
}

function persistRealtimeCache() {
  const key = realtimeCacheKey();
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify({
      schemaVersion: CACHE_SCHEMA_VERSION,
      cachedAt: nowIso(),
      masters: state.masters,
      plotings: state.plotings
    }));
  } catch (error) {
    // Cache bersifat opsional. Kegagalan quota tidak boleh mengganggu aplikasi.
    console.warn("Cache lokal tidak dapat diperbarui.", error);
  }
}

function normalizeMasters(rawMasters, plotings) {
  // Gunakan data yang tersimpan sebagai sumber utama. Default dipakai hanya saat
  // database belum memiliki master sama sekali. Dengan ini item master yang
  // sudah dihapus tidak muncul kembali setelah render atau sinkronisasi realtime.
  const masters = {};
  Object.keys(MASTER_META).forEach((key) => {
    const supplied = Array.isArray(rawMasters?.[key]) ? rawMasters[key] : [];
    const field = MASTER_META[key].field;
    masters[key] = sortText(unique([
      ...supplied,
      ...plotings.map((plot) => plot[field])
    ]));
  });
  return masters;
}

function normalizeWhitespace(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

function formatProgramName(value) {
  return normalizeWhitespace(value).toLocaleUpperCase("id-ID");
}

function formatBrandName(value) {
  return normalizeWhitespace(value)
    .toLocaleLowerCase("id-ID")
    .replace(/(^|[\s\-/&+.()])(\p{L})/gu, (match, prefix, letter) => `${prefix}${letter.toLocaleUpperCase("id-ID")}`)
    .replace(/(\d)(\p{L})/gu, (match, digit, letter) => `${digit}${letter.toLocaleUpperCase("id-ID")}`);
}

function normalizePlotings(plotings) {
  return plotings.map((plot) => {
    const legacyScheduleNote = String(plot.scheduleNote ?? plot.note ?? "").trim();
    return {
      ...plot,
      brand: formatBrandName(plot.brand),
      program: formatProgramName(plot.program),
      pic: String(plot.pic || "Belum ditetapkan").trim() || "Belum ditetapkan",
      airingStatus: plot.airingStatus || "Planned",
      batchNote: String(plot.batchNote || "").trim(),
      scheduleNote: legacyScheduleNote
    };
  });
}

function loadState() {
  // Tanggal operasional selalu dibuka pada hari ini. Pengguna tetap dapat
  // memilih tanggal lain selama sesi berjalan melalui Date Picker.
  return {
    plotings: [],
    masters: normalizeMasters(defaultMasters, []),
    operationDate: DEFAULT_OPERATION_DATE
  };
}

function saveState() {
  // Tanggal operasional tidak disimpan agar pembukaan berikutnya kembali ke hari ini.
  // Cache data hanya dipakai untuk mempercepat tampilan awal akun yang sama.
  // Brand disimpan dalam Title Case, sedangkan Program disimpan dalam huruf kapital penuh.
  state.plotings = sortByDate(normalizePlotings(state.plotings));
  state.masters = normalizeMasters(state.masters, state.plotings);
  persistRealtimeCache();
  queueRealtimeDatabaseSync();
}

function formatDate(dateValue, options = { day: "2-digit", month: "short", year: "numeric" }) {
  if (!dateValue) return "-";
  const date = new Date(`${dateValue}T00:00:00`);
  if (Number.isNaN(date.getTime())) return dateValue;
  return new Intl.DateTimeFormat("id-ID", options).format(date);
}

function formatMonth(monthKey) {
  if (!monthKey) return "-";
  const [year, month] = monthKey.split("-").map(Number);
  return new Intl.DateTimeFormat("id-ID", { month: "long", year: "numeric" }).format(new Date(year, month - 1, 1));
}

function monthKey(dateValue) { return String(dateValue || "").slice(0, 7); }
function yearFromDate(dateValue) { return String(dateValue || "").slice(0, 4); }
function monthFromDate(dateValue) { return String(dateValue || "").slice(5, 7); }
function monthKeyFromPeriod(year, month) {
  if (!/^\d{4}$/.test(String(year || "")) || !/^\d{2}$/.test(String(month || ""))) return "";
  return `${year}-${month}`;
}
function matchesYearMonth(dateValue, year, month) {
  return (!year || yearFromDate(dateValue) === year) && (!month || monthFromDate(dateValue) === month);
}
function quarterFromDate(dateValue) {
  const month = Number(monthFromDate(dateValue));
  return month ? `Q${Math.ceil(month / 3)}` : "";
}
function matchesQuarter(dateValue, year, quarter) {
  return (!year || yearFromDate(dateValue) === year) && (!quarter || quarterFromDate(dateValue) === quarter);
}
function currentYear() { return yearFromDate(getLocalIsoDate()); }
function currentMonth() { return monthFromDate(getLocalIsoDate()); }
function currentQuarter() { return quarterFromDate(getLocalIsoDate()); }
function formatQuarter(year, quarter) {
  if (!year && !quarter) return "Semua periode";
  const label = QUARTER_OPTIONS.find(([value]) => value === quarter)?.[1] || quarter || "Semua kuartal";
  return [label, year].filter(Boolean).join(" ");
}
function availableYears() {
  return [...new Set([currentYear(), ...state.plotings.map((plot) => yearFromDate(plot.planAiring)).filter(Boolean)])]
    .sort((a, b) => Number(b) - Number(a));
}
function optionPairsMarkup(pairs, placeholder, selectedValue = "") {
  return `<option value="">${escapeHTML(placeholder)}</option>${pairs.map(([value, label]) => `<option value="${escapeHTML(value)}" ${String(value) === String(selectedValue) ? "selected" : ""}>${escapeHTML(label)}</option>`).join("")}`;
}
function setSelectPairs(selector, pairs, placeholder, selectedValue = "") {
  const element = $(selector);
  if (!element) return;
  element.innerHTML = optionPairsMarkup(pairs, placeholder, selectedValue);
}
function addDays(dateValue, days) { const date = new Date(`${dateValue}T00:00:00`); date.setDate(date.getDate() + days); return date.toISOString().slice(0, 10); }
function offsetIsoDate(dateValue, days) {
  const [year, month, day] = String(dateValue || "").split("-").map(Number);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return dateValue;
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}
function weekRangeFromDate(dateValue) {
  const [year, month, day] = String(dateValue || "").split("-").map(Number);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return { start: dateValue, end: dateValue };
  const date = new Date(Date.UTC(year, month - 1, day));
  const dayIndex = (date.getUTCDay() + 6) % 7;
  const start = offsetIsoDate(dateValue, -dayIndex);
  const end = offsetIsoDate(start, 6);
  return { start, end };
}
function isSameWeekDate(dateValue, referenceDate) {
  const range = weekRangeFromDate(referenceDate);
  return dateValue >= range.start && dateValue <= range.end;
}
function sortByDate(items) { return [...items].sort((a, b) => a.planAiring.localeCompare(b.planAiring) || a.id.localeCompare(b.id)); }
function unitSortIndex(unit) {
  const units = Array.isArray(state?.masters?.units) && state.masters.units.length ? state.masters.units : defaultMasters.units;
  const index = units.indexOf(unit);
  return index === -1 ? units.length : index;
}
function sortByUnitThenProgram(items) {
  return [...items].sort((a, b) =>
    unitSortIndex(a.unit) - unitSortIndex(b.unit) ||
    String(a.unit || "").localeCompare(String(b.unit || ""), "id") ||
    String(a.program || "").localeCompare(String(b.program || ""), "id") ||
    String(a.brand || "").localeCompare(String(b.brand || ""), "id") ||
    String(a.id || "").localeCompare(String(b.id || ""), "id")
  );
}
function badgeClass(status) {
  const text = String(status || "").toLowerCase();
  if (text.includes("siap")) return "ready";
  if (text.includes("sudah")) return "done";
  if (text.includes("on air")) return "onair";
  if (text.includes("batal") || text.includes("tidak")) return "cancel";
  return "pending";
}
function badge(status) { return `<span class="badge ${badgeClass(status)}">${escapeHTML(status)}</span>`; }

// Status ini bersifat final. Kalender memakai penanda visual khusus ketika
// seluruh jadwal dalam satu tanggal sudah berada pada status akhir.
const FINAL_AIRING_STATUSES = new Set(["Sudah tayang", "Tidak tayang", "Dibatalkan"]);
function isFinalAiringStatus(status) {
  return FINAL_AIRING_STATUSES.has(String(status || "").trim());
}
function allSchedulesFinal(plots) {
  return Array.isArray(plots) && plots.length > 0 && plots.every((plot) => isFinalAiringStatus(plot.airingStatus));
}

function isZeroSpot(spot) { return Number(spot) === 0; }
function isInactiveAiringStatus(status) {
  return ["Tidak tayang", "Dibatalkan"].includes(String(status || "").trim());
}
function isCompletedAiringStatus(status) {
  return ["On air", "Sudah tayang"].includes(String(status || "").trim());
}
function isPendingAiringStatus(status) {
  return !isCompletedAiringStatus(status) && !isInactiveAiringStatus(status);
}
function completedSpotSum(plots) {
  return sum((plots || []).filter((plot) => isCompletedAiringStatus(plot.airingStatus)).map((plot) => plot.spot));
}
function isAlertSpot(spot, airingStatus = "") {
  return isZeroSpot(spot) || isInactiveAiringStatus(airingStatus);
}
function spotClass(spot, airingStatus = "") {
  return isAlertSpot(spot, airingStatus) ? "spot-zero" : "";
}
function spotMarkup(spot, extraClass = "", airingStatus = "") {
  const classes = ["spot-value", spotClass(spot, airingStatus), isInactiveAiringStatus(airingStatus) ? "spot-status-alert" : "", extraClass].filter(Boolean).join(" ");
  return `<span class="${classes}">${Number(spot)} spot</span>`;
}
function plotSpotMarkup(plot, extraClass = "") {
  return spotMarkup(plot?.spot, extraClass, plot?.airingStatus);
}

const UNIT_LOGOS = {
  RCTI: "assets/rcti.webp",
  MNCTV: "assets/mnctv.webp",
  GTV: "assets/gtv.webp"
};

function unitLabelMarkup(unit, variant = "default") {
  const value = String(unit || "-");
  const safeUnit = escapeHTML(value);
  const src = UNIT_LOGOS[value];

  // Untuk unit yang memiliki logo, tampilkan logo saja agar label tidak berulang.
  // Nama unit tetap tersedia melalui alt, title, dan aria-label untuk aksesibilitas.
  if (src) {
    return `<span class="unit-label unit-label--${variant} unit-label--logo-only" title="${safeUnit}" aria-label="${safeUnit}"><img class="unit-logo" src="${src}" alt="${safeUnit}" loading="lazy" decoding="async" onerror="this.parentElement.classList.add('unit-label--fallback');this.remove();" /><span class="unit-label-text unit-logo-fallback">${safeUnit}</span></span>`;
  }

  return `<span class="unit-label unit-label--${variant}" title="${safeUnit}" aria-label="${safeUnit}"><span class="unit-text-mark">${escapeHTML(value.charAt(0).toUpperCase())}</span><span class="unit-label-text">${safeUnit}</span></span>`;
}

function accountAvatarMarkup(account, className = "") {
  const safeName = escapeHTML(account?.name || "Akun");
  const avatar = String(account?.avatar || "").trim();
  if (avatar) return `<span class="account-avatar ${className}"><img src="${escapeHTML(avatar)}" alt="${safeName}" decoding="async" loading="lazy" onerror="this.parentElement.classList.add('is-fallback');this.remove();"/></span>`;
  const initials = (account?.name || "A").split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word.charAt(0)).join("").toUpperCase();
  return `<span class="account-avatar account-avatar--initials ${className}" aria-label="${safeName}">${escapeHTML(initials || "A")}</span>`;
}

function activePicAccountNames() {
  return sortText(unique(allTeamAccounts().map((account) => account.name)));
}

function dashboardGreetingLabel() {
  const hour = new Date().getHours();
  if (hour >= 4 && hour < 11) return "pagi";
  if (hour >= 11 && hour < 15) return "siang";
  if (hour >= 15 && hour < 19) return "sore";
  return "malam";
}

function normalizeTeamAccountRecord(record = {}, key = "") {
  const email = normalizeWhitespace(record.email).toLocaleLowerCase("id-ID");
  const name = normalizeWhitespace(record.name || record.displayName || email.split("@")[0] || "Akun Tim");
  const legacy = LEGACY_TEAM_ACCOUNT_BY_EMAIL[email];
  const username = normalizeAccountUsername(record.username || legacy?.username || usernameFromInternalEmail(email) || record.id || name);
  return {
    uid: String(record.uid || key || ""),
    id: String(record.id || legacy?.id || key || username || email || name).trim(),
    username,
    name,
    email: email || internalEmailFromUsername(username),
    avatar: String(record.avatar || legacy?.avatar || "").trim(),
    role: record.role === "admin" || legacy?.role === "admin" ? "admin" : "pic",
    active: record.active !== false && !record.deletedAt,
    createdAt: String(record.createdAt || ""),
    updatedAt: String(record.updatedAt || ""),
    deletedAt: String(record.deletedAt || ""),
    picAliases: unique(Array.isArray(record.picAliases) ? record.picAliases.map(normalizeWhitespace) : []).filter(Boolean)
  };
}

function mergedTeamAccounts() {
  const merged = new Map();
  Object.values(LEGACY_TEAM_ACCOUNTS).forEach((account) => merged.set(account.id, normalizeTeamAccountRecord(account, account.id)));
  Object.entries(teamAccounts || {}).forEach(([key, raw]) => {
    const account = normalizeTeamAccountRecord(raw, key);
    const legacyByEmail = LEGACY_TEAM_ACCOUNT_BY_EMAIL[account.email];
    if (legacyByEmail && merged.has(legacyByEmail.id)) merged.delete(legacyByEmail.id);
    merged.set(account.id, account);
  });
  return [...merged.values()];
}

function allTeamAccounts({ includeInactive = false } = {}) {
  return mergedTeamAccounts()
    .filter((account) => includeInactive || account.active)
    .sort((a, b) => a.name.localeCompare(b.name, "id"));
}

function currentTeamAccount() {
  const uid = String(currentFirebaseUser?.uid || "");
  const email = String(currentFirebaseUser?.email || "").toLocaleLowerCase("id-ID");
  return allTeamAccounts({ includeInactive: true }).find((account) => (
    (uid && account.uid === uid) || (email && account.email === email)
  )) || null;
}

function currentTeamDisplayName() {
  return currentTeamAccount()?.name || currentFirebaseUser?.displayName || currentFirebaseUser?.email || "Tim VA";
}

function currentTeamAccountId() {
  return currentTeamAccount()?.id || "";
}

function teamAccountById(accountId, includeInactive = true) {
  return allTeamAccounts({ includeInactive }).find((account) => account.id === String(accountId || "")) || null;
}

function availableTeamRecipients() {
  const currentId = currentTeamAccountId();
  return allTeamAccounts().filter((account) => account.id !== currentId);
}

function ensureSelectedTeamRecipient() {
  const recipients = availableTeamRecipients();
  if (!recipients.some((account) => account.id === teamChatState.selectedRecipientId)) {
    teamChatState.selectedRecipientId = recipients[0]?.id || "";
  }
  return teamAccountById(teamChatState.selectedRecipientId, false);
}

function currentTeamPicName() {
  return currentTeamAccount()?.name || "";
}

function isCurrentTeamPic(plot) {
  const account = currentTeamAccount();
  const plotPic = normalizeWhitespace(plot?.pic).toLocaleLowerCase("id-ID");
  const names = unique([account?.name, ...(account?.picAliases || [])])
    .map((name) => normalizeWhitespace(name).toLocaleLowerCase("id-ID"))
    .filter(Boolean);
  return Boolean(plotPic && names.includes(plotPic));
}

function currentPicOverduePlannedPlots(referenceDate = getLocalIsoDate()) {
  return sortByDate(state.plotings.filter((plot) => (
    isCurrentTeamPic(plot) &&
    plot.airingStatus === "Planned" &&
    Boolean(plot.planAiring) &&
    plot.planAiring < referenceDate
  )));
}

function renderCurrentPicOverdueReminderCard() {
  const card = $("#picOverdueReminderCard");
  if (!card) return;

  const overduePlots = currentFirebaseUser ? currentPicOverduePlannedPlots() : [];
  if (!overduePlots.length) {
    card.hidden = true;
    card.innerHTML = "";
    document.body.classList.remove("has-pic-overdue-reminder");
    return;
  }

  const visiblePlots = overduePlots.slice(0, 4);
  const remainingCount = Math.max(0, overduePlots.length - visiblePlots.length);
  const overdueSpot = sum(overduePlots.map((plot) => plot.spot));
  const picName = currentTeamPicName();

  card.innerHTML = `
    <div class="pic-overdue-card-head">
      <span class="pic-overdue-card-icon" aria-hidden="true">!</span>
      <div>
        <p>REMINDER PIC</p>
        <h3>Planned melewati tanggal</h3>
      </div>
      <span class="pic-overdue-card-count" aria-label="${overduePlots.length} jadwal">${overduePlots.length}</span>
    </div>
    <p class="pic-overdue-card-summary"><strong>${escapeHTML(picName)}</strong> memiliki ${overduePlots.length} jadwal terlambat dengan total ${overdueSpot} spot.</p>
    <div class="pic-overdue-card-list">
      ${visiblePlots.map((plot) => `
        <article class="pic-overdue-card-item">
          <div>
            <strong>${escapeHTML(plot.brand)} · ${escapeHTML(plot.program)}</strong>
            <small>${formatDate(plot.planAiring)} · ${escapeHTML(plot.unit)} · ${Number(plot.spot)} spot</small>
          </div>
          <button class="pic-overdue-card-action" data-edit-schedule="${escapeHTML(plot.id)}" type="button">Atur</button>
        </article>
      `).join("")}
    </div>
    ${remainingCount ? `<p class="pic-overdue-card-more">+${remainingCount} jadwal terlambat lainnya</p>` : ""}
    <button class="pic-overdue-card-master" data-go-view="plotings" type="button">Buka Master Ploting</button>
  `;
  card.hidden = false;
  document.body.classList.add("has-pic-overdue-reminder");
}

function renderDashboardGreeting(todayPlots, upcomingPlots, attentionPlots) {
  const greetingMeta = $("#dashboardGreetingMeta");
  const greetingTitle = $("#dashboardGreetingTitle");
  const reminderLead = $("#dashboardReminderLead");
  const reminderList = $("#dashboardReminderList");
  if (!greetingMeta || !greetingTitle || !reminderLead || !reminderList) return;

  const operationDateLabel = formatDate(state.operationDate, { weekday: "long", day: "2-digit", month: "long", year: "numeric" });
  const todaySpot = sum(todayPlots.map((plot) => plot.spot));
  const todayBrandCount = unique(todayPlots.map((plot) => plot.brand)).length;
  const runningSpot = todayPlots.filter((plot) => !isInactiveAiringStatus(plot.airingStatus)).reduce((total, plot) => total + Number(plot.spot || 0), 0);

  const mobileGreeting = window.matchMedia?.("(max-width: 760px)")?.matches;
  const greetingName = currentTeamDisplayName();
  const greetingPeriod = dashboardGreetingLabel();
  greetingMeta.textContent = `Tanggal operasional — ${operationDateLabel}`;
  if (mobileGreeting) {
    greetingTitle.innerHTML = `<span class="mobile-greeting-name">Hi, ${escapeHTML(greetingName)}!</span><small class="mobile-greeting-period">selamat ${escapeHTML(greetingPeriod)}</small>`;
    reminderLead.textContent = todayPlots.length
      ? `Hari ini ada ${todayPlots.length} jadwal, ${todaySpot} spot, dan ${todayBrandCount} brand yang perlu dipantau.`
      : "Belum ada jadwal pada tanggal operasional. Cek input baru sebelum membuat laporan harian.";
  } else {
    greetingTitle.textContent = `Selamat ${greetingPeriod}, ${greetingName}.`;
    reminderLead.innerHTML = todayPlots.length
      ? `Hari ini ada <strong>${todayPlots.length} jadwal</strong>, <strong>${todaySpot} spot</strong>, dan <strong>${todayBrandCount} brand</strong> yang perlu dipantau.`
      : "Belum ada jadwal pada tanggal operasional. Cek input baru sebelum membuat laporan harian.";
  }

  const spotLabel = runningSpot ? `${runningSpot} spot berjalan hari ini` : "Belum ada spot berjalan hari ini";
  reminderList.innerHTML = `<article class="hero-reminder-item is-info"><strong>${escapeHTML(spotLabel)}</strong></article>`;
}
function batches() { return Object.values(state.plotings.reduce((acc, plot) => { (acc[plot.batchId] ||= []).push(plot); return acc; }, {})); }
function getBatch(batchId) { return sortByDate(state.plotings.filter((plot) => plot.batchId === batchId)); }
function uniqueBatchCount(plots) { return unique(plots.map((plot) => plot.batchId)).length; }
function nextId(prefix, source) {
  const max = source.reduce((current, item) => {
    const match = String(item.id || item.batchId || "").match(/(\d+)$/);
    return Math.max(current, match ? Number(match[1]) : 0);
  }, 0);
  return `${prefix}-${String(max + 1).padStart(6, "0")}`;
}
function optionMarkup(values, placeholder, selectedValue = "") {
  const all = unique([selectedValue, ...values]);
  return `<option value="">${escapeHTML(placeholder)}</option>${all.map((value) => `<option value="${escapeHTML(value)}" ${value === selectedValue ? "selected" : ""}>${escapeHTML(value)}</option>`).join("")}`;
}
function datalistMarkup(values, selectedValue = "") {
  return unique([selectedValue, ...values]).filter(Boolean)
    .map((value) => `<option value="${escapeHTML(value)}"></option>`)
    .join("");
}
function setSelectOptions(selector, values, placeholder, selectedValue = "") {
  const element = $(selector);
  if (!element) return;

  // Filter brand pada Timeline Brand dan Kalender Full memakai input + datalist
  // supaya daftar brand yang panjang tetap bisa dicari dengan mengetik.
  if (element instanceof HTMLInputElement) {
    const datalistId = element.getAttribute("list");
    const datalist = datalistId ? document.getElementById(datalistId) : null;
    if (datalist) datalist.innerHTML = datalistMarkup(values, selectedValue);
    element.placeholder = placeholder;
    element.value = selectedValue || "";
    return;
  }

  element.innerHTML = optionMarkup(values, placeholder, selectedValue);
}
function resolveBrandFilterValue(value) {
  const query = normalizeWhitespace(value).toLocaleLowerCase("id-ID");
  if (!query) return "";
  return sortText(unique(state.plotings.map((plot) => plot.brand)))
    .find((brand) => brand.toLocaleLowerCase("id-ID") === query) || "";
}
function applyBrandSearchFilter(scope, input, enforceSelection = false) {
  const typedValue = input.value;
  const matchedBrand = resolveBrandFilterValue(typedValue);

  if (scope === "full" && !normalizeWhitespace(typedValue)) {
    filters.full.brand = "";
    renderFullTimeline();
    return;
  }

  if (!matchedBrand) {
    if (enforceSelection) {
      input.value = scope === "full" ? filters.full.brand : filters.brand.brand;
      showToast("Pilih brand dari daftar yang tersedia.");
    }
    return;
  }

  input.value = matchedBrand;
  if (scope === "full") {
    if (filters.full.brand === matchedBrand) return;
    filters.full.brand = matchedBrand;
    renderFullTimeline();
    return;
  }

  if (filters.brand.brand === matchedBrand) return;
  filters.brand.brand = matchedBrand;
  populateSelects();
  renderBrand();
}
function bindBrandSearchFilter(selector, scope) {
  const input = $(selector);
  if (!input) return;
  input.addEventListener("input", () => applyBrandSearchFilter(scope, input));
  input.addEventListener("change", () => applyBrandSearchFilter(scope, input, true));
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    applyBrandSearchFilter(scope, input, true);
  });
}
function setSearchableBrandInput(inputSelector, datalistSelector, values, selectedValue = "") {
  const input = $(inputSelector);
  const datalist = $(datalistSelector);
  if (datalist) {
    datalist.innerHTML = values.map((value) => `<option value="${escapeHTML(value)}"></option>`).join("");
  }
  if (input) input.value = selectedValue || "";
}
const GOOEY_TOAST_META = Object.freeze({
  success: Object.freeze({ title: "Berhasil", icon: "check" }),
  error: Object.freeze({ title: "Terjadi kendala", icon: "error" }),
  warning: Object.freeze({ title: "Perlu diperhatikan", icon: "warning" }),
  info: Object.freeze({ title: "Informasi", icon: "info" })
});

const GOOEY_TOAST_ICONS = Object.freeze({
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.2 4.2L19 7"></path></svg>',
  error: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"></path></svg>',
  warning: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 7.5v6M12 17.2v.1"></path></svg>',
  info: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 10.5V17M12 6.8v.1"></path></svg>'
});

function inferToastType(message) {
  const normalized = String(message || "").toLocaleLowerCase("id-ID");
  if (/(gagal|error|ditolak|tidak dapat|tidak ditemukan|belum berhasil|belum tersimpan|tidak merespons|tidak tersedia|belum siap)/.test(normalized)) return "error";
  if (/(berhasil|tersimpan|disimpan|diperbarui|ditambahkan|dihapus|disalin|diunduh|diekspor|diexport|diimpor|diterapkan)/.test(normalized)) return "success";
  if (/(pilih|lengkapi|wajib|harus|minimal|tidak boleh|sudah ada|belum ada|tidak ada|isi tanggal|isi nilai)/.test(normalized)) return "warning";
  return "info";
}

function normalizeToastPayload(input, options = {}) {
  const supplied = input && typeof input === "object" && !Array.isArray(input)
    ? input
    : { message: input, ...options };
  const message = String(supplied.message ?? supplied.text ?? "").trim();
  const inferredType = inferToastType(message);
  const type = Object.prototype.hasOwnProperty.call(GOOEY_TOAST_META, supplied.type) ? supplied.type : inferredType;
  const durationValue = Number(supplied.duration);
  const defaultDuration = type === "error" ? 5600 : type === "warning" ? 4800 : 4200;
  return {
    type,
    title: String(supplied.title || GOOEY_TOAST_META[type].title),
    message,
    duration: Number.isFinite(durationValue) && durationValue >= 1200 ? durationValue : defaultDuration
  };
}

function dismissGooeyToast(toast, immediate = false) {
  if (!toast || toast.dataset.dismissed === "true") return;
  toast.dataset.dismissed = "true";
  if (toast._gooeyToastTimer) window.clearTimeout(toast._gooeyToastTimer);
  if (immediate) {
    toast.remove();
    return;
  }
  toast.classList.remove("is-visible");
  toast.classList.add("is-leaving");
  window.setTimeout(() => toast.remove(), 380);
}

function showGooeyToast(input, options = {}) {
  const region = $("#toast");
  if (!region) return null;

  const payload = normalizeToastPayload(input, options);
  if (!payload.message) return null;

  const duplicate = Array.from(region.querySelectorAll(".gooey-toast"))
    .find((item) => item.dataset.toastMessage === payload.message && item.dataset.dismissed !== "true");
  if (duplicate) {
    duplicate.classList.remove("is-pulsing");
    void duplicate.offsetWidth;
    duplicate.classList.add("is-pulsing");
    return duplicate;
  }

  while (region.children.length >= 4) {
    dismissGooeyToast(region.firstElementChild, true);
  }

  const meta = GOOEY_TOAST_META[payload.type];
  const toast = document.createElement("article");
  const toastId = `gooey-toast-${++toastSequence}`;
  toast.id = toastId;
  toast.className = `gooey-toast gooey-toast--${payload.type}`;
  toast.dataset.toastMessage = payload.message;
  toast.dataset.dismissed = "false";
  toast.setAttribute("role", payload.type === "error" || payload.type === "warning" ? "alert" : "status");
  toast.setAttribute("aria-labelledby", `${toastId}-title`);
  toast.setAttribute("aria-describedby", `${toastId}-message`);
  toast.style.setProperty("--toast-duration", `${payload.duration}ms`);

  const effects = document.createElement("span");
  effects.className = "gooey-toast-effects";
  effects.setAttribute("aria-hidden", "true");
  effects.innerHTML = '<i class="gooey-toast-blob gooey-toast-blob--main"></i><i class="gooey-toast-blob gooey-toast-blob--satellite"></i><i class="gooey-toast-blob gooey-toast-blob--trail"></i>';

  const icon = document.createElement("span");
  icon.className = "gooey-toast-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = GOOEY_TOAST_ICONS[meta.icon];

  const copy = document.createElement("span");
  copy.className = "gooey-toast-copy";
  const title = document.createElement("strong");
  title.id = `${toastId}-title`;
  title.textContent = payload.title;
  const message = document.createElement("span");
  message.id = `${toastId}-message`;
  message.textContent = payload.message;
  copy.append(title, message);

  const closeButton = document.createElement("button");
  closeButton.className = "gooey-toast-close";
  closeButton.type = "button";
  closeButton.setAttribute("aria-label", "Tutup notifikasi");
  closeButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 8 8 8M16 8l-8 8"></path></svg>';
  closeButton.addEventListener("click", () => dismissGooeyToast(toast));

  const progress = document.createElement("span");
  progress.className = "gooey-toast-progress";
  progress.setAttribute("aria-hidden", "true");

  toast.append(effects, icon, copy, closeButton, progress);
  region.appendChild(toast);

  let remaining = payload.duration;
  let startedAt = 0;
  const startTimer = () => {
    if (toast.dataset.dismissed === "true") return;
    startedAt = performance.now();
    toast._gooeyToastTimer = window.setTimeout(() => dismissGooeyToast(toast), remaining);
    progress.style.animationPlayState = "running";
  };
  const pauseTimer = () => {
    if (!toast._gooeyToastTimer || toast.dataset.dismissed === "true") return;
    window.clearTimeout(toast._gooeyToastTimer);
    toast._gooeyToastTimer = null;
    remaining = Math.max(0, remaining - (performance.now() - startedAt));
    progress.style.animationPlayState = "paused";
  };

  toast.addEventListener("mouseenter", pauseTimer);
  toast.addEventListener("mouseleave", startTimer);
  toast.addEventListener("focusin", pauseTimer);
  toast.addEventListener("focusout", (event) => {
    if (!toast.contains(event.relatedTarget)) startTimer();
  });

  requestAnimationFrame(() => {
    toast.classList.add("is-visible");
    startTimer();
  });
  return toast;
}

// Kompatibilitas untuk seluruh pemanggilan notifikasi yang sudah ada.
function showToast(message, options = {}) {
  return showGooeyToast(message, options);
}


function setFirebaseStatus(stateName, text) {
  const badge = $("#firebaseStatus");
  const label = $("#firebaseStatusText");
  if (!badge || !label) return;
  const message = String(text || "Status Firebase");
  badge.dataset.state = stateName;
  badge.title = `Status sinkronisasi Firebase Realtime Database: ${message}`;
  badge.setAttribute("aria-label", `Status sinkronisasi Firebase Realtime Database: ${message}`);
  label.textContent = message;
}

function updateAuthForm() {
  const signInButton = $("#passwordSignInButton");
  const usernameInput = $("#authUsernameInput");
  const passwordInput = $("#authPasswordInput");
  if (!signInButton) return;
  const rawIdentifier = String(usernameInput?.value || "").trim();
  const hasUsername = rawIdentifier.includes("@")
    ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawIdentifier)
    : validAccountUsername(rawIdentifier);
  const hasPassword = String(passwordInput?.value || "").length >= 6;
  signInButton.disabled = !firebaseBootstrapComplete || !hasUsername || !hasPassword;
  signInButton.textContent = firebaseBootstrapComplete ? "Masuk" : "Menyiapkan Firebase...";
}

function setAuthGate(open, message = "") {
  const gate = $("#authGate");
  const gateMessage = $("#authGateMessage");
  if (gate) {
    gate.hidden = !open;
    gate.classList.toggle("is-hidden", !open);
    gate.setAttribute("aria-hidden", String(!open));
  }
  if (gateMessage && message) gateMessage.textContent = message;
  updateAuthForm();
}

function setProfileMenuOpen(open) {
  const panel = $("#profileMenuPanel");
  const button = $("#profileMenuButton");
  profileMenuOpen = Boolean(open);
  if (panel) panel.hidden = !profileMenuOpen;
  if (button) button.setAttribute("aria-expanded", String(profileMenuOpen));
}

function updateUserChip(user) {
  const floatingChat = $("#floatingTeamChat");
  if (floatingChat) floatingChat.hidden = !user;
  if (!user && teamChatState.panelOpen) setFloatingTeamChatOpen(false);
  const button = $("#profileMenuButton");
  const initial = $("#authUserInitial");
  const name = $("#authUserName");
  if (!button || !initial || !name) return;
  if (!user) {
    button.hidden = true;
    initial.classList.remove("has-photo");
    initial.textContent = "V";
    setProfileMenuOpen(false);
    return;
  }
  const account = currentTeamAccount();
  const label = account?.name || user.displayName || user.email || "Akun Tim";
  if (account?.avatar) {
    initial.classList.add("has-photo");
    initial.innerHTML = `<img src="${escapeHTML(account.avatar)}" alt="${escapeHTML(label)}" decoding="async" loading="lazy"/>`;
  } else {
    initial.classList.remove("has-photo");
    initial.textContent = label.trim().charAt(0).toUpperCase() || "V";
  }
  name.textContent = label;
  button.hidden = false;
  const role = $("#profileMenuRole");
  if (role) role.textContent = account?.role === "admin" ? "Administrator" : "PIC";
  const manageButton = $("#openAccountManagementButton");
  if (manageButton) manageButton.hidden = account?.role !== "admin";
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function cleanFirebaseValue(value) {
  if (Array.isArray(value)) return value.map((item) => cleanFirebaseValue(item));
  if (value && typeof value === "object") {
    return Object.entries(value).reduce((acc, [key, item]) => {
      if (item !== undefined) acc[key] = cleanFirebaseValue(item);
      return acc;
    }, {});
  }
  return value;
}

const AUDIT_ACTION_META = Object.freeze({
  BATCH_CREATED: Object.freeze({ label: "Batch dibuat", tone: "create" }),
  BATCH_UPDATED: Object.freeze({ label: "Batch diperbarui", tone: "update" }),
  SCHEDULE_UPDATED: Object.freeze({ label: "Jadwal diperbarui", tone: "update" }),
  SCHEDULE_SLID: Object.freeze({ label: "Spot digeser", tone: "warning" }),
  SCHEDULE_DELETED: Object.freeze({ label: "Jadwal dihapus", tone: "delete" }),
  MASTER_CREATED: Object.freeze({ label: "Master ditambahkan", tone: "create" }),
  MASTER_DELETED: Object.freeze({ label: "Master dihapus", tone: "delete" }),
  LEGACY_IMPORTED: Object.freeze({ label: "Data lama diimpor", tone: "import" }),
  ACCOUNT_CREATED: Object.freeze({ label: "Akun dibuat", tone: "create" }),
  PROFILE_UPDATED: Object.freeze({ label: "Profil diperbarui", tone: "update" }),
  ACCOUNT_DEACTIVATED: Object.freeze({ label: "Akun dinonaktifkan", tone: "warning" }),
  ACCOUNT_REACTIVATED: Object.freeze({ label: "Akun diaktifkan", tone: "create" }),
  ACCOUNT_DELETED: Object.freeze({ label: "Akun dihapus", tone: "delete" })
});

// Chat dan reminder antar-PIC bersifat komunikasi internal, sehingga tidak
// disimpan maupun ditampilkan sebagai aktivitas operasional pada Audit Log.
const NON_AUDIT_ACTIONS = new Set([
  "CHAT_SENT",
  "REMINDER_SENT",
  "REMINDER_READ",
  "REMINDER_SNOOZED",
  "REMINDER_COMPLETED"
]);

function isExcludedFromAuditLog(entry = {}) {
  return NON_AUDIT_ACTIONS.has(String(entry.action || "")) ||
    ["message", "reminder"].includes(String(entry.entityType || "").toLowerCase());
}

const AUDIT_FIELD_LABELS = Object.freeze({
  advertiser: "PT Advertiser", brand: "Brand", sales: "Sales", pic: "PIC", unit: "Unit",
  program: "Program", pod: "POD", version: "Versi VA", format: "Format VA", duration: "Durasi",
  gfx: "Materi GFX", segmentation: "Segmentasi", batchNote: "Note Batch", planAiring: "Tanggal",
  spot: "Spot", airingStatus: "Status", scheduleNote: "Note Jadwal", scheduleCount: "Jumlah jadwal", scheduleDetail: "Detail jadwal"
});

function auditValue(value) {
  if (value === null || value === undefined || value === "") return "-";
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}

function auditChanges(before = {}, after = {}, fields = []) {
  return fields.reduce((changes, field) => {
    const previous = auditValue(before?.[field]);
    const next = auditValue(after?.[field]);
    if (previous !== next) changes.push({ field, label: AUDIT_FIELD_LABELS[field] || field, before: previous, after: next });
    return changes;
  }, []);
}

function batchAuditSnapshot(batch = []) {
  const first = batch[0] || {};
  return {
    advertiser: first.advertiser, brand: first.brand, sales: first.sales, pic: first.pic, unit: first.unit,
    program: first.program, pod: first.pod, version: first.version, format: first.format, duration: first.duration,
    gfx: first.gfx, segmentation: first.segmentation, batchNote: first.batchNote,
    scheduleCount: batch.length,
    planAiring: batch.map((plot) => plot.planAiring).filter(Boolean).sort().join(", "),
    spot: sum(batch.map((plot) => plot.spot)),
    airingStatus: unique(batch.map((plot) => plot.airingStatus)).join(", "),
    scheduleDetail: batch.map((plot) => [plot.planAiring, `${Number(plot.spot || 0)} spot`, plot.airingStatus, plot.scheduleNote].filter(Boolean).join(" · ")).join(" | ")
  };
}

function auditTargetFromPlot(plot = {}) {
  return [plot.brand, plot.program].filter(Boolean).join(" · ") || plot.batchId || plot.id || "Data ploting";
}

async function recordAuditLog(entry = {}) {
  if (!currentFirebaseUser || !entry.action || isExcludedFromAuditLog(entry)) return;
  const account = currentTeamAccount();
  const createdAt = nowIso();
  const id = `AUD-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  const record = cleanFirebaseValue({
    id,
    createdAt,
    actorId: account?.id || currentFirebaseUser.uid || "unknown",
    actorName: account?.name || currentFirebaseUser.displayName || currentFirebaseUser.email || "Akun Tim",
    actorEmail: currentFirebaseUser.email || "",
    action: entry.action,
    entityType: entry.entityType || "system",
    entityId: entry.entityId || "",
    target: entry.target || "Data aplikasi",
    summary: entry.summary || AUDIT_ACTION_META[entry.action]?.label || entry.action,
    changes: Array.isArray(entry.changes) ? entry.changes : [],
    metadata: entry.metadata || {}
  });

  try {
    await update(realtimeAuditLogsRef, { [id]: record });
  } catch (error) {
    console.error("Audit Log gagal dicatat.", error);
    showToast({ message: "Perubahan tersimpan, tetapi Audit Log gagal dicatat.", type: "warning" });
  }
}

function formatAuditDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("id-ID", {
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit"
  }).format(date);
}

function isAuditToday(value) {
  return String(value || "").slice(0, 10) === getLocalIsoDate();
}

function renderAuditLog() {
  const query = filters.audit.query.trim().toLocaleLowerCase("id-ID");
  // Sembunyikan juga log chat/reminder lama yang mungkin sudah tersimpan
  // sebelum kebijakan ini diterapkan, tanpa menghapus data Firebase lainnya.
  const operationalAuditLogs = auditLogs.filter((item) => !isExcludedFromAuditLog(item));
  const actors = sortText(unique(operationalAuditLogs.map((item) => item.actorName)));
  const actions = unique(operationalAuditLogs.map((item) => item.action)).sort((a, b) =>
    String(AUDIT_ACTION_META[a]?.label || a).localeCompare(String(AUDIT_ACTION_META[b]?.label || b), "id")
  );
  setSelectOptions("#auditActorFilter", actors, "Semua akun", filters.audit.actor);
  const actionSelect = $("#auditActionFilter");
  if (actionSelect) {
    actionSelect.innerHTML = `<option value="">Semua aktivitas</option>${actions.map((action) => `<option value="${escapeHTML(action)}" ${action === filters.audit.action ? "selected" : ""}>${escapeHTML(AUDIT_ACTION_META[action]?.label || action)}</option>`).join("")}`;
  }

  const filtered = operationalAuditLogs.filter((item) => {
    const haystack = [item.actorName, item.action, AUDIT_ACTION_META[item.action]?.label, item.target, item.summary, item.entityId]
      .join(" ").toLocaleLowerCase("id-ID");
    return (!query || haystack.includes(query)) &&
      (!filters.audit.actor || item.actorName === filters.audit.actor) &&
      (!filters.audit.action || item.action === filters.audit.action);
  });

  const currentActor = currentTeamDisplayName();
  const kpis = [
    ["Total aktivitas", operationalAuditLogs.length, "Seluruh riwayat operasional"],
    ["Aktivitas hari ini", operationalAuditLogs.filter((item) => isAuditToday(item.createdAt)).length, formatDate(getLocalIsoDate())],
    ["Aktivitas akun ini", operationalAuditLogs.filter((item) => item.actorName === currentActor).length, currentActor],
    ["Hasil filter", filtered.length, filters.audit.query || filters.audit.actor || filters.audit.action ? "Sesuai filter aktif" : "Semua aktivitas"]
  ];
  const kpiGrid = $("#auditLogKpis");
  if (kpiGrid) kpiGrid.innerHTML = kpis.map(([label, value, note]) => `<article class="mini-kpi"><p>${escapeHTML(label)}</p><strong>${value}</strong><small>${escapeHTML(note)}</small></article>`).join("");

  const count = $("#auditResultCount");
  if (count) count.textContent = filtered.length;
  const body = $("#auditLogBody");
  if (!body) return;
  body.innerHTML = filtered.length ? filtered.slice(0, 300).map((item) => {
    const meta = AUDIT_ACTION_META[item.action] || { label: item.action || "Aktivitas", tone: "update" };
    const changes = Array.isArray(item.changes) ? item.changes : [];
    const changeMarkup = (change) => `<span><b>${escapeHTML(change.label || change.field)}</b><del title="${escapeHTML(change.before)}">${escapeHTML(change.before)}</del><i aria-hidden="true">→</i><ins title="${escapeHTML(change.after)}">${escapeHTML(change.after)}</ins></span>`;
    const visibleChanges = changes.slice(0, 4);
    const hiddenChanges = changes.slice(4);
    const changesMarkup = changes.length
      ? `<div class="audit-change-list">${visibleChanges.map(changeMarkup).join("")}${hiddenChanges.length ? `<details class="audit-change-details"><summary>+${hiddenChanges.length} rincian perubahan lainnya</summary><div>${hiddenChanges.map(changeMarkup).join("")}</div></details>` : ""}</div>`
      : `<span class="cell-subtitle">Tidak ada rincian field.</span>`;
    return `<tr>
      <td><span class="cell-title">${escapeHTML(formatAuditDateTime(item.createdAt))}</span><span class="cell-subtitle">${escapeHTML(String(item.id || "").slice(-10))}</span></td>
      <td><span class="audit-actor"><b>${escapeHTML(item.actorName || "Akun Tim")}</b><small>${escapeHTML(item.actorEmail || "")}</small></span></td>
      <td><span class="audit-action-badge audit-action--${escapeHTML(meta.tone)}">${escapeHTML(meta.label)}</span></td>
      <td><span class="cell-title">${escapeHTML(item.target || "Data aplikasi")}</span><span class="cell-subtitle">${escapeHTML(item.entityType || "system")} · ${escapeHTML(item.entityId || "-")}</span></td>
      <td><span class="audit-summary">${escapeHTML(item.summary || meta.label)}</span></td>
      <td>${changesMarkup}</td>
    </tr>`;
  }).join("") : `<tr><td colspan="6" class="empty-row">Belum ada aktivitas yang sesuai dengan filter.</td></tr>`;
}


function formatTeamDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("id-ID", {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit"
  }).format(date);
}

function firebaseTeamStateKey(accountOrId = currentTeamAccount()) {
  const account = typeof accountOrId === "object" && accountOrId
    ? accountOrId
    : teamAccountById(accountOrId, true);
  const rawKey = String(account?.uid || account?.id || accountOrId || "");
  return rawKey.replace(/[.#$\[\]\/]/g, "_");
}

function groupTeamMessages() {
  return teamMessages.filter((message) => message.scope === "group" || message.chatType === "group");
}

function groupTeamReminders() {
  return teamReminders.filter((reminder) => reminder.scope === "group" || reminder.reminderType === "group");
}

function visibleTeamReminders() {
  const currentId = currentTeamAccountId();
  return teamReminders.filter((reminder) => (
    reminder.scope === "group" ||
    reminder.reminderType === "group" ||
    reminder.senderId === currentId ||
    reminder.recipientId === currentId
  ));
}

function groupMessageReadAt(message, account = currentTeamAccount()) {
  if (!message || !account) return "";
  const key = firebaseTeamStateKey(account);
  return String(message.readBy?.[key] || message.readBy?.[account.id] || "");
}

function teamReminderRecipientState(reminder, account = currentTeamAccount()) {
  if (!reminder || !account) return null;

  if (reminder.scope === "group" || reminder.reminderType === "group") {
    const states = reminder.recipientStates && typeof reminder.recipientStates === "object"
      ? reminder.recipientStates
      : {};
    const key = firebaseTeamStateKey(account);
    return states[key] || Object.values(states).find((state) => (
      state?.accountId === account.id || (account.uid && state?.uid === account.uid)
    )) || null;
  }

  if (reminder.recipientId !== account.id) return null;
  return {
    accountId: account.id,
    recipientName: account.name,
    status: reminder.status || "unread",
    remindAt: reminder.remindAt || reminder.createdAt,
    readAt: reminder.readAt || "",
    completedAt: reminder.completedAt || "",
    snoozedAt: reminder.snoozedAt || ""
  };
}

function teamReminderRecipientStates(reminder) {
  if (!reminder || !(reminder.scope === "group" || reminder.reminderType === "group")) return [];
  return Object.values(reminder.recipientStates || {}).filter(Boolean);
}

function unreadTeamMessageCount() {
  const current = currentTeamAccount();
  if (!current) return 0;
  return groupTeamMessages().filter((message) => (
    message.senderId !== current.id && !groupMessageReadAt(message, current)
  )).length;
}

function unreadTeamReminderCount() {
  const current = currentTeamAccount();
  if (!current) return 0;
  return visibleTeamReminders().filter((reminder) => {
    const state = teamReminderRecipientState(reminder, current);
    return state?.status === "unread";
  }).length;
}

function updateTeamChatBadges() {
  const total = unreadTeamMessageCount() + unreadTeamReminderCount();
  [["#teamChatNavBadge", total], ["#mobileTeamChatBadge", total], ["#teamChatTotalBadge", total], ["#floatingTeamChatBadge", total]].forEach(([selector, count]) => {
    const badge = $(selector);
    if (!badge) return;
    badge.textContent = count > 99 ? "99+" : String(count);
    badge.hidden = count <= 0;
  });
  const status = $("#teamChatHeaderStatus");
  if (status) status.textContent = total ? `${total} belum dibaca` : "Grup realtime";
}

function teamMessageStatusLabel(message) {
  if (message.senderId !== currentTeamAccountId()) return "";
  const recipients = allTeamAccounts().filter((account) => account.id !== message.senderId);
  const readCount = recipients.filter((account) => groupMessageReadAt(message, account)).length;
  return recipients.length ? `Dibaca ${readCount}/${recipients.length}` : "Terkirim";
}

function teamReminderStatusLabel(reminder) {
  if (reminder.scope === "group" || reminder.reminderType === "group") {
    const current = currentTeamAccount();
    const currentState = teamReminderRecipientState(reminder, current);
    if (currentState) {
      if (currentState.status === "completed") return "Selesai";
      if (currentState.status === "read") return "Dibaca";
      return "Belum dibaca";
    }
    const states = teamReminderRecipientStates(reminder);
    const completed = states.filter((state) => state.status === "completed").length;
    return states.length ? `${completed}/${states.length} selesai` : "Terkirim";
  }
  if (reminder.status === "completed") return "Selesai";
  if (reminder.status === "read") return "Dibaca";
  return "Belum dibaca";
}

function renderTeamChatContacts() {
  const participants = allTeamAccounts();
  const memberCount = $("#teamChatGroupMemberCount");
  const avatars = $("#teamChatGroupAvatars");
  if (memberCount) memberCount.textContent = `${participants.length} anggota aktif`;
  if (avatars) {
    const visible = participants.slice(0, 5);
    const remaining = Math.max(0, participants.length - visible.length);
    avatars.innerHTML = `${visible.map((account) => accountAvatarMarkup(account, "team-chat-group-member-avatar")).join("")}${remaining ? `<span class="team-chat-group-member-more">+${remaining}</span>` : ""}`;
  }
}

function renderTeamChatConversation() {
  const head = $("#teamChatConversationHead");
  const list = $("#teamChatMessageList");
  const chatForm = $("#teamChatForm");
  const conversation = $(".floating-team-chat-conversation");
  if (!head || !list || !chatForm) return;

  const participants = allTeamAccounts();
  chatForm.hidden = !currentTeamAccount();
  head.innerHTML = `<div class="team-chat-active-person"><span class="team-chat-group-avatar" aria-hidden="true">PIC</span><div><p class="section-label">GRUP TIM</p><h3>Semua PIC</h3><span>${participants.length} anggota · Pesan dan reminder diterima seluruh tim.</span></div></div>`;

  const currentId = currentTeamAccountId();
  const timeline = [
    ...groupTeamMessages().map((item) => ({ ...item, itemType: "message", sortAt: item.createdAt })),
    ...visibleTeamReminders().map((item) => ({ ...item, itemType: "reminder", sortAt: item.createdAt }))
  ].sort((a, b) => String(a.sortAt || "").localeCompare(String(b.sortAt || "")));

  list.innerHTML = timeline.length ? timeline.map((item) => {
    const outgoing = item.senderId === currentId;
    const sender = teamAccountById(item.senderId) || { name: item.senderName || "PIC" };
    if (item.itemType === "reminder") {
      const priority = ["normal", "important", "urgent"].includes(item.priority) ? item.priority : "normal";
      const state = teamReminderRecipientState(item);
      const canManage = Boolean(state && state.status !== "completed");
      const isGroup = item.scope === "group" || item.reminderType === "group";
      const audience = isGroup ? "untuk semua PIC" : `untuk ${escapeHTML(item.recipientName || "PIC")}`;
      return `<article class="team-chat-reminder-message ${outgoing ? "is-outgoing" : "is-incoming"} team-chat-reminder--${priority}">
        <div class="team-chat-reminder-top"><span>⏰ Reminder ${audience}</span><b>${escapeHTML(teamReminderStatusLabel(item))}</b></div>
        <strong class="team-chat-message-sender">${outgoing ? "Kamu" : escapeHTML(sender.name || "PIC")}</strong>
        <p>${escapeHTML(item.message || "")}</p>
        <small>${escapeHTML(formatTeamDateTime(item.createdAt))}</small>
        ${canManage ? `<div class="team-chat-reminder-actions"><button data-team-reminder-id="${escapeHTML(item.id)}" data-team-reminder-action="read" type="button">Tandai dibaca</button><button data-team-reminder-id="${escapeHTML(item.id)}" data-team-reminder-action="complete" type="button">Selesai</button></div>` : ""}
      </article>`;
    }
    return `<article class="team-chat-message ${outgoing ? "is-outgoing" : "is-incoming"}">
      <strong class="team-chat-message-sender">${outgoing ? "Kamu" : escapeHTML(sender.name || "PIC")}</strong>
      <p>${escapeHTML(item.text || "")}</p>
      <small>${escapeHTML(formatTeamDateTime(item.createdAt))}${teamMessageStatusLabel(item) ? ` · ${escapeHTML(teamMessageStatusLabel(item))}` : ""}</small>
    </article>`;
  }).join("") : `<div class="team-chat-empty team-chat-empty--conversation"><strong>Belum ada pesan di grup PIC.</strong><span>Kirim pesan atau buat reminder untuk seluruh tim.</span></div>`;

  const composer = $("#teamReminderComposer");
  if (composer) composer.hidden = !teamChatState.reminderComposerOpen;
  conversation?.classList.toggle("is-reminder-composer-open", teamChatState.reminderComposerOpen);
  chatForm.hidden = teamChatState.reminderComposerOpen || !currentTeamAccount();
  const composerTitle = $("#teamReminderComposerTitle");
  if (composerTitle) composerTitle.textContent = "Kirim reminder ke semua PIC";
  window.requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
}

function renderTeamChat() {
  renderTeamChatContacts();
  renderTeamChatConversation();
  updateTeamChatBadges();
  if (teamChatState.panelOpen) markGroupMessagesRead();
}

function setFloatingTeamChatOpen(open) {
  const panel = $("#teamChatPanel");
  const launcher = $("#teamChatLauncher");
  if (!panel || !launcher) return;

  teamChatState.panelOpen = Boolean(open);
  launcher.setAttribute("aria-expanded", String(teamChatState.panelOpen));
  launcher.setAttribute("aria-label", teamChatState.panelOpen ? "Tutup chat grup PIC" : "Buka chat grup PIC");

  if (teamChatState.panelOpen) {
    panel.hidden = false;
    panel.setAttribute("aria-hidden", "false");
    window.requestAnimationFrame(() => panel.classList.add("is-open"));
    renderTeamChat();
  } else {
    panel.classList.remove("is-open");
    panel.setAttribute("aria-hidden", "true");
    teamChatState.reminderComposerOpen = false;
    window.setTimeout(() => {
      if (!teamChatState.panelOpen) panel.hidden = true;
    }, 180);
  }
}

function toggleFloatingTeamChat() {
  setFloatingTeamChatOpen(!teamChatState.panelOpen);
}

async function sendTeamChatMessage(event) {
  event?.preventDefault();
  const sender = currentTeamAccount();
  const input = $("#teamChatMessageInput");
  const text = normalizeWhitespace(input?.value).slice(0, 1000);
  if (!sender || !text) {
    showToast({ message: "Tulis pesan terlebih dahulu.", type: "warning" });
    return;
  }
  const createdAt = nowIso();
  const id = `MSG-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  const senderStateKey = firebaseTeamStateKey(sender);
  const record = cleanFirebaseValue({
    id,
    scope: "group",
    senderId: sender.id,
    senderName: sender.name,
    text,
    createdAt,
    readBy: senderStateKey ? { [senderStateKey]: createdAt } : {}
  });
  try {
    await update(realtimeMessagesRef, { [id]: record });
    if (input) input.value = "";
  } catch (error) {
    console.error("Pesan tidak dapat dikirim.", error);
    showToast({ message: "Pesan belum terkirim. Periksa Firebase Rules dan koneksi internet.", type: "error" });
  }
}

async function sendTeamReminder(event) {
  event?.preventDefault();
  const sender = currentTeamAccount();
  const messageInput = $("#teamReminderMessageInput");
  const message = normalizeWhitespace(messageInput?.value).slice(0, 500);
  const priority = $("#teamReminderPriorityInput")?.value || "normal";
  const recipients = allTeamAccounts().filter((account) => account.id !== sender?.id);
  if (!sender || !message) {
    showToast({ message: "Isi pesan reminder terlebih dahulu.", type: "warning" });
    return;
  }
  if (!recipients.length) {
    showToast({ message: "Belum ada PIC lain yang dapat menerima reminder.", type: "warning" });
    return;
  }
  const createdAt = nowIso();
  const remindAt = createdAt;
  const id = `REM-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  const recipientStates = {};
  recipients.forEach((account) => {
    const key = firebaseTeamStateKey(account);
    if (!key) return;
    recipientStates[key] = cleanFirebaseValue({
      accountId: account.id,
      uid: account.uid || "",
      recipientName: account.name,
      status: "unread",
      remindAt,
      readAt: "",
      completedAt: "",
      snoozedAt: ""
    });
  });
  const record = cleanFirebaseValue({
    id,
    scope: "group",
    senderId: sender.id,
    senderName: sender.name,
    message,
    priority,
    createdAt,
    remindAt,
    recipientStates
  });
  try {
    await update(realtimeRemindersRef, { [id]: record });
    if (messageInput) messageInput.value = "";
    if ($("#teamReminderPriorityInput")) $("#teamReminderPriorityInput").value = "normal";
    teamChatState.reminderComposerOpen = false;
    renderTeamChatConversation();
    showToast({ message: `Reminder berhasil dikirim ke ${recipients.length} PIC.`, type: "success" });
  } catch (error) {
    console.error("Reminder tidak dapat dikirim.", error);
    showToast({ message: "Reminder belum terkirim. Periksa Firebase Rules dan koneksi internet.", type: "error" });
  }
}

async function markGroupMessagesRead() {
  const current = currentTeamAccount();
  if (!current || teamChatReadSyncInProgress) return;
  const unread = groupTeamMessages().filter((message) => (
    message.senderId !== current.id && !groupMessageReadAt(message, current)
  ));
  if (!unread.length) return;
  teamChatReadSyncInProgress = true;
  const readAt = nowIso();
  const stateKey = firebaseTeamStateKey(current);
  const updates = {};
  unread.forEach((message) => {
    updates[`messages/${message.id}/readBy/${stateKey}`] = readAt;
    message.readBy = { ...(message.readBy || {}), [stateKey]: readAt };
  });
  updateTeamChatBadges();
  try {
    await update(realtimeRootRef, updates);
  } catch (error) {
    console.error("Status baca chat grup gagal diperbarui.", error);
  } finally {
    teamChatReadSyncInProgress = false;
  }
}

function dueIncomingTeamReminders() {
  const current = currentTeamAccount();
  if (!current) return [];
  const now = Date.now();
  return visibleTeamReminders().filter((reminder) => {
    const state = teamReminderRecipientState(reminder, current);
    const due = new Date(state?.remindAt || reminder.remindAt || reminder.createdAt).getTime();
    return state?.status === "unread" && (!Number.isFinite(due) || due <= now);
  }).sort((a, b) => {
    const first = teamReminderRecipientState(a, current);
    const second = teamReminderRecipientState(b, current);
    return String(first?.remindAt || a.remindAt || a.createdAt || "")
      .localeCompare(String(second?.remindAt || b.remindAt || b.createdAt || ""));
  });
}

function closeIncomingTeamReminderModal() {
  const backdrop = $("#teamReminderModalBackdrop");
  if (!backdrop) return;
  backdrop.hidden = true;
  backdrop.classList.remove("is-open");
  backdrop.setAttribute("aria-hidden", "true");
  activeIncomingReminderId = "";
  document.body.classList.remove("team-reminder-modal-open");
}

function renderIncomingTeamReminderModal() {
  const backdrop = $("#teamReminderModalBackdrop");
  if (!backdrop || !currentFirebaseUser) {
    closeIncomingTeamReminderModal();
    return;
  }
  const reminder = dueIncomingTeamReminders()[0];
  if (!reminder) {
    closeIncomingTeamReminderModal();
    return;
  }
  const sender = teamAccountById(reminder.senderId);
  const state = teamReminderRecipientState(reminder);
  activeIncomingReminderId = reminder.id;
  const title = $("#teamReminderModalTitle");
  const message = $("#teamReminderModalMessage");
  const meta = $("#teamReminderModalMeta");
  const isGroup = reminder.scope === "group" || reminder.reminderType === "group";
  if (title) title.textContent = `${isGroup ? "Reminder grup" : "Reminder"} dari ${sender?.name || reminder.senderName || "PIC"}`;
  if (message) message.textContent = reminder.message || "";
  if (meta) meta.innerHTML = `<span class="team-reminder-priority team-reminder-priority--${escapeHTML(reminder.priority || "normal")}">${escapeHTML(reminder.priority === "urgent" ? "Mendesak" : reminder.priority === "important" ? "Penting" : "Biasa")}</span><span>${escapeHTML(formatTeamDateTime(state?.remindAt || reminder.remindAt || reminder.createdAt))}</span>${isGroup ? "<span>Untuk semua PIC</span>" : ""}`;
  backdrop.hidden = false;
  backdrop.classList.add("is-open");
  backdrop.setAttribute("aria-hidden", "false");
  document.body.classList.add("team-reminder-modal-open");
}

async function updateTeamReminderStatus(reminderId, action) {
  const reminder = teamReminders.find((item) => item.id === reminderId);
  const current = currentTeamAccount();
  const state = teamReminderRecipientState(reminder, current);
  if (!reminder || !current || !state) return;
  const now = nowIso();
  const patch = {};
  if (action === "complete") {
    patch.status = "completed";
    patch.readAt = state.readAt || now;
    patch.completedAt = now;
  } else if (action === "snooze") {
    patch.status = "unread";
    patch.remindAt = new Date(Date.now() + 10 * 60_000).toISOString();
    patch.snoozedAt = now;
  } else {
    patch.status = "read";
    patch.readAt = now;
  }

  closeIncomingTeamReminderModal();
  const updates = {};
  if (reminder.scope === "group" || reminder.reminderType === "group") {
    const key = firebaseTeamStateKey(current);
    reminder.recipientStates = { ...(reminder.recipientStates || {}) };
    reminder.recipientStates[key] = { ...(reminder.recipientStates[key] || state), ...patch };
    Object.entries(patch).forEach(([field, value]) => {
      updates[`reminders/${reminderId}/recipientStates/${key}/${field}`] = value;
    });
  } else {
    Object.assign(reminder, patch);
    Object.entries(patch).forEach(([field, value]) => {
      updates[`reminders/${reminderId}/${field}`] = value;
    });
  }

  updateTeamChatBadges();
  if (teamChatState.panelOpen) renderTeamChat();
  try {
    await update(realtimeRootRef, updates);
  } catch (error) {
    console.error("Status reminder gagal diperbarui.", error);
    showToast({ message: "Status reminder belum tersimpan. Muat ulang untuk melihat kondisi terbaru.", type: "error" });
  }
}

async function handleIncomingReminderModalAction(action) {
  const reminder = teamReminders.find((item) => item.id === activeIncomingReminderId);
  if (!reminder) return;
  if (action === "open") {
    await updateTeamReminderStatus(reminder.id, "read");
    setFloatingTeamChatOpen(true);
    return;
  }
  await updateTeamReminderStatus(reminder.id, action);
}


function currentAccountIsAdmin() {
  return currentTeamAccount()?.role === "admin";
}

function teamAccountFirebaseKey(account = currentTeamAccount()) {
  if (!account) return "";
  if (account.uid) return account.uid;
  const entry = Object.entries(teamAccounts || {}).find(([, raw]) => normalizeTeamAccountRecord(raw).id === account.id);
  return entry?.[0] || "";
}

function buildLegacyProfile(user, legacy) {
  return cleanFirebaseValue({
    uid: user.uid,
    id: legacy.id,
    username: legacy.username || usernameFromInternalEmail(user.email || legacy.email),
    name: legacy.name,
    email: String(user.email || legacy.email).toLocaleLowerCase("id-ID"),
    avatar: legacy.avatar || "",
    role: "admin",
    active: true,
    createdAt: nowIso(),
    updatedAt: nowIso()
  });
}

async function ensureCurrentTeamProfile() {
  if (!currentFirebaseUser || !teamAccountsLoaded) return;
  const account = currentTeamAccount();
  if (account && !account.active) {
    if (accountDeletionInProgress) return;
    await signOut(firebaseAuth);
    setAuthGate(true, "Akun ini sudah dinonaktifkan. Hubungi administrator.");
    return;
  }
  if (account?.uid === currentFirebaseUser.uid) return;

  const email = String(currentFirebaseUser.email || "").toLocaleLowerCase("id-ID");
  const legacy = LEGACY_TEAM_ACCOUNT_BY_EMAIL[email];
  const source = account || legacy;
  if (!source) {
    await signOut(firebaseAuth);
    setAuthGate(true, "Profil akun belum terdaftar di workspace. Hubungi administrator.");
    return;
  }
  try {
    const oldKey = account ? teamAccountFirebaseKey(account) : "";
    const record = cleanFirebaseValue({
      ...(account || buildLegacyProfile(currentFirebaseUser, legacy)),
      uid: currentFirebaseUser.uid,
      id: source.id,
      username: source.username || usernameFromInternalEmail(email),
      name: source.name,
      email,
      avatar: source.avatar || "",
      role: source.role || "pic",
      active: true,
      createdAt: source.createdAt || nowIso(),
      updatedAt: nowIso()
    });
    const updates = { [currentFirebaseUser.uid]: record };
    if (oldKey && oldKey !== currentFirebaseUser.uid) updates[oldKey] = null;
    await update(realtimeTeamAccountsRef, updates);
  } catch (error) {
    console.error("Profil akun tidak dapat disiapkan.", error);
    showToast({ message: "Profil akun belum dapat disiapkan. Periksa Firebase Rules untuk teamAccounts.", type: "warning" });
  }
}

function slugifyAccountId(name) {
  const base = normalizeWhitespace(name).toLocaleLowerCase("id-ID")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "pic";
  const used = new Set(allTeamAccounts({ includeInactive: true }).map((account) => account.id));
  let candidate = base;
  let index = 2;
  while (used.has(candidate)) candidate = `${base}-${index++}`;
  return candidate;
}

function profileImageToDataUrl(file) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type.startsWith("image/")) {
      reject(new Error("Pilih file gambar yang valid."));
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      reject(new Error("Ukuran foto maksimal 5 MB."));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Foto tidak dapat dibaca."));
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error("Format foto tidak didukung."));
      image.onload = () => {
        const size = 256;
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const context = canvas.getContext("2d");
        const scale = Math.max(size / image.width, size / image.height);
        const width = image.width * scale;
        const height = image.height * scale;
        context.drawImage(image, (size - width) / 2, (size - height) / 2, width, height);
        resolve(canvas.toDataURL("image/jpeg", 0.82));
      };
      image.src = String(reader.result || "");
    };
    reader.readAsDataURL(file);
  });
}

function renderProfileModal() {
  const account = currentTeamAccount();
  if (!account || !currentFirebaseUser) return;
  const preview = $("#profileAvatarPreview");
  if (preview) preview.innerHTML = accountAvatarMarkup({ ...account, avatar: profileAvatarDraft === "__REMOVE__" ? "" : (profileAvatarDraft || account.avatar) }, "profile-avatar-preview-image");
  if ($("#profileNameInput")) $("#profileNameInput").value = account.name || "";
  if ($("#profileUsernameInput")) $("#profileUsernameInput").value = account.username || usernameFromInternalEmail(account.email || currentFirebaseUser.email) || "";
  if ($("#profileRoleLabel")) $("#profileRoleLabel").textContent = account.role === "admin" ? "Administrator" : "PIC";
  const adminTab = $("#profileAccountsTabButton");
  if (adminTab) adminTab.hidden = !currentAccountIsAdmin();
  if (!currentAccountIsAdmin() && profileActiveTab === "accounts") profileActiveTab = "profile";
  $$("[data-profile-tab]").forEach((button) => {
    const active = button.dataset.profileTab === profileActiveTab;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
  });
  $$("[data-profile-panel]").forEach((panel) => { panel.hidden = panel.dataset.profilePanel !== profileActiveTab; });
  renderAccountManagementList();
}

function openProfileModal(tab = "profile") {
  profileActiveTab = tab === "accounts" && currentAccountIsAdmin() ? "accounts" : "profile";
  profileAvatarDraft = "";
  const backdrop = $("#profileModalBackdrop");
  if (!backdrop) return;
  backdrop.classList.add("open");
  backdrop.setAttribute("aria-hidden", "false");
  setProfileMenuOpen(false);
  renderProfileModal();
}

function closeProfileModal() {
  const backdrop = $("#profileModalBackdrop");
  if (!backdrop) return;
  backdrop.classList.remove("open");
  backdrop.setAttribute("aria-hidden", "true");
  profileAvatarDraft = "";
  $("#profileForm")?.reset();
  $("#deleteOwnAccountForm")?.reset();
}

async function reauthenticateCurrentUser(password) {
  const user = currentFirebaseUser;
  if (!user?.email || !password) throw new Error("Masukkan password saat ini.");
  const credential = EmailAuthProvider.credential(user.email, password);
  await reauthenticateWithCredential(user, credential);
}

async function saveCurrentProfile(event) {
  event?.preventDefault();
  const account = currentTeamAccount();
  const user = currentFirebaseUser;
  if (!account || !user) return;
  const name = normalizeWhitespace($("#profileNameInput")?.value).slice(0, 80);
  const username = normalizeAccountUsername($("#profileUsernameInput")?.value);
  const email = internalEmailFromUsername(username);
  const currentPassword = $("#profileCurrentPasswordInput")?.value || "";
  const newPassword = $("#profileNewPasswordInput")?.value || "";
  const confirmPassword = $("#profileConfirmPasswordInput")?.value || "";
  if (!name || !validAccountUsername(username)) {
    showToast({ message: "Lengkapi nama dan username minimal 2 karakter.", type: "warning" });
    return;
  }
  const duplicateUsername = allTeamAccounts({ includeInactive: true }).some((item) => (
    item.id !== account.id && normalizeAccountUsername(item.username || usernameFromInternalEmail(item.email)) === username
  ));
  if (duplicateUsername) {
    showToast({ message: "Username tersebut sudah digunakan akun lain.", type: "warning" });
    return;
  }
  if (newPassword && (newPassword.length < 6 || newPassword !== confirmPassword)) {
    showToast({ message: "Password baru minimal 6 karakter dan konfirmasinya harus sama.", type: "warning" });
    return;
  }
  const sensitiveChange = email !== String(user.email || "").toLocaleLowerCase("id-ID") || Boolean(newPassword);
  try {
    if (sensitiveChange) await reauthenticateCurrentUser(currentPassword);
    if (email !== String(user.email || "").toLocaleLowerCase("id-ID")) await updateEmail(user, email);
    if (newPassword) await updatePassword(user, newPassword);
    await updateProfile(user, { displayName: name });
    const key = teamAccountFirebaseKey(account) || user.uid;
    const previousName = account.name;
    const avatar = profileAvatarDraft === "__REMOVE__" ? "" : (profileAvatarDraft || account.avatar || "");
    await update(realtimeTeamAccountsRef, {
      [key]: cleanFirebaseValue({ ...account, uid: user.uid, id: account.id, username, name, email, avatar, active: true, picAliases: unique([...(account.picAliases || []), ...(previousName !== name ? [previousName] : [])]), updatedAt: nowIso() })
    });
    state.masters.pics = sortText(unique([...(state.masters.pics || []), name]));
    saveState();
    recordAuditLog({ action: "PROFILE_UPDATED", entityType: "account", entityId: account.id, target: name, summary: `Profil ${name} diperbarui.`, changes: [
      { field: "Nama", before: previousName, after: name },
      { field: "Username", before: account.username || usernameFromInternalEmail(account.email), after: username }
    ].filter((change) => change.before !== change.after) });
    profileAvatarDraft = "";
    if ($("#profileCurrentPasswordInput")) $("#profileCurrentPasswordInput").value = "";
    if ($("#profileNewPasswordInput")) $("#profileNewPasswordInput").value = "";
    if ($("#profileConfirmPasswordInput")) $("#profileConfirmPasswordInput").value = "";
    showToast({ message: "Profil berhasil diperbarui.", type: "success" });
  } catch (error) {
    console.error("Profil tidak dapat diperbarui.", error);
    const message = error?.code === "auth/requires-recent-login" || error?.code === "auth/invalid-credential"
      ? "Password saat ini tidak sesuai."
      : error?.code === "auth/email-already-in-use"
        ? "Username tersebut sudah digunakan akun lain."
        : "Profil belum dapat diperbarui. Periksa koneksi dan Firebase Rules.";
    showToast({ message, type: "error" });
  }
}

async function createTeamAccount(event) {
  event?.preventDefault();
  if (!currentAccountIsAdmin()) {
    showToast({ message: "Hanya administrator yang dapat menambah akun.", type: "error" });
    return;
  }
  const name = normalizeWhitespace($("#newAccountNameInput")?.value).slice(0, 80);
  const username = normalizeAccountUsername($("#newAccountUsernameInput")?.value);
  const email = internalEmailFromUsername(username);
  const password = $("#newAccountPasswordInput")?.value || "";
  const role = $("#newAccountRoleInput")?.value === "admin" ? "admin" : "pic";
  if (!name || !validAccountUsername(username) || password.length < 6) {
    showToast({ message: "Isi nama, username minimal 2 karakter, dan password sementara minimal 6 karakter.", type: "warning" });
    return;
  }
  if (allTeamAccounts({ includeInactive: true }).some((account) => normalizeAccountUsername(account.username || usernameFromInternalEmail(account.email)) === username)) {
    showToast({ message: "Username tersebut sudah terdaftar.", type: "warning" });
    return;
  }
  let secondaryApp = null;
  let createdSecondaryUser = null;
  try {
    secondaryApp = initializeApp(firebaseConfig, `account-creator-${Date.now()}`);
    const secondaryAuth = getAuth(secondaryApp);
    const credential = await createUserWithEmailAndPassword(secondaryAuth, email, password);
    createdSecondaryUser = credential.user;
    await updateProfile(credential.user, { displayName: name });
    const record = cleanFirebaseValue({
      uid: credential.user.uid,
      id: username,
      username,
      name,
      email,
      avatar: "",
      role,
      active: true,
      picAliases: [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
      createdBy: currentTeamAccountId()
    });
    await update(realtimeTeamAccountsRef, { [credential.user.uid]: record });
    await signOut(secondaryAuth);
    state.masters.pics = sortText(unique([...(state.masters.pics || []), name]));
    saveState();
    recordAuditLog({ action: "ACCOUNT_CREATED", entityType: "account", entityId: record.id, target: name, summary: `Akun ${name} dibuat sebagai ${role === "admin" ? "Administrator" : "PIC"}.`, changes: [] });
    $("#createAccountForm")?.reset();
    showToast({ message: `Akun ${name} berhasil dibuat dan otomatis masuk daftar PIC.`, type: "success" });
  } catch (error) {
    if (createdSecondaryUser) await deleteUser(createdSecondaryUser).catch(() => {});
    console.error("Akun baru tidak dapat dibuat.", error);
    const message = error?.code === "auth/email-already-in-use"
      ? "Username tersebut sudah digunakan di Firebase Authentication."
      : error?.code === "auth/weak-password"
        ? "Password sementara terlalu lemah."
        : "Akun belum dapat dibuat. Periksa Firebase Authentication dan Rules teamAccounts.";
    showToast({ message, type: "error" });
  } finally {
    if (secondaryApp) await deleteApp(secondaryApp).catch(() => {});
  }
}

function renderAccountManagementList() {
  const list = $("#teamAccountManagementList");
  if (!list) return;
  const currentId = currentTeamAccountId();
  const accounts = allTeamAccounts({ includeInactive: true });
  list.innerHTML = accounts.length ? accounts.map((account) => {
    const isSelf = account.id === currentId;
    const status = account.active ? "Aktif" : "Nonaktif";
    return `<article class="team-account-card ${account.active ? "is-active" : "is-inactive"}">
      ${accountAvatarMarkup(account, "team-account-avatar")}
      <div class="team-account-copy"><strong>${escapeHTML(account.name)}</strong><span>@${escapeHTML(account.username || usernameFromInternalEmail(account.email))}</span><small>${account.role === "admin" ? "Administrator" : "PIC"} · ${status}</small></div>
      <div class="team-account-actions">${isSelf ? `<span class="team-account-self">Akun kamu</span>` : `<button class="secondary-button" data-account-toggle="${escapeHTML(account.id)}" data-account-active="${String(account.active)}" type="button">${account.active ? "Nonaktifkan" : "Aktifkan"}</button>`}</div>
    </article>`;
  }).join("") : `<div class="team-account-empty">Belum ada akun tim.</div>`;
}

async function toggleTeamAccountActive(accountId, currentlyActive) {
  if (!currentAccountIsAdmin()) return;
  const account = teamAccountById(accountId, true);
  if (!account || account.id === currentTeamAccountId()) return;
  if (currentlyActive && account.role === "admin") {
    const activeAdmins = allTeamAccounts().filter((item) => item.role === "admin");
    if (activeAdmins.length <= 1) {
      showToast({ message: "Administrator terakhir tidak dapat dinonaktifkan.", type: "warning" });
      return;
    }
  }
  const key = teamAccountFirebaseKey(account) || account.uid;
  if (!key) {
    showToast({ message: "Akun belum memiliki profil Firebase yang dapat diubah.", type: "error" });
    return;
  }
  try {
    const active = !currentlyActive;
    await update(realtimeTeamAccountsRef, { [key]: cleanFirebaseValue({ ...account, active, updatedAt: nowIso(), deletedAt: "" }) });
    recordAuditLog({
      action: active ? "ACCOUNT_REACTIVATED" : "ACCOUNT_DEACTIVATED",
      entityType: "account",
      entityId: account.id,
      target: account.name,
      summary: `Akun ${account.name} ${active ? "diaktifkan kembali" : "dinonaktifkan"}.`,
      changes: [{ field: "Status", before: currentlyActive ? "Aktif" : "Nonaktif", after: active ? "Aktif" : "Nonaktif" }]
    });
    showToast({ message: `Akun ${account.name} ${active ? "diaktifkan" : "dinonaktifkan"}.`, type: "success" });
  } catch (error) {
    console.error("Status akun tidak dapat diubah.", error);
    showToast({ message: "Status akun belum dapat diubah. Periksa Firebase Rules.", type: "error" });
  }
}

async function deleteOwnAccountFromApp(event) {
  event?.preventDefault();
  const account = currentTeamAccount();
  const user = currentFirebaseUser;
  const password = $("#deleteAccountPasswordInput")?.value || "";
  const confirmation = normalizeWhitespace($("#deleteAccountConfirmationInput")?.value).toLocaleUpperCase("id-ID");
  if (!account || !user) return;
  if (confirmation !== "HAPUS") {
    showToast({ message: "Ketik HAPUS untuk mengonfirmasi penghapusan akun.", type: "warning" });
    return;
  }
  if (account.role === "admin" && allTeamAccounts().filter((item) => item.role === "admin").length <= 1) {
    showToast({ message: "Administrator terakhir tidak dapat menghapus akunnya.", type: "warning" });
    return;
  }
  const key = teamAccountFirebaseKey(account) || user.uid;
  try {
    await reauthenticateCurrentUser(password);
    accountDeletionInProgress = true;
    await recordAuditLog({ action: "ACCOUNT_DELETED", entityType: "account", entityId: account.id, target: account.name, summary: `Akun ${account.name} menghapus akunnya sendiri.`, changes: [] });
    await update(realtimeTeamAccountsRef, { [key]: cleanFirebaseValue({ ...account, active: false, deletedAt: nowIso(), updatedAt: nowIso() }) });
    await deleteUser(user);
    closeProfileModal();
  } catch (error) {
    console.error("Akun tidak dapat dihapus.", error);
    if (key && user) await update(realtimeTeamAccountsRef, { [key]: cleanFirebaseValue({ ...account, active: true, deletedAt: "", updatedAt: nowIso() }) }).catch(() => {});
    const message = error?.code === "auth/invalid-credential" ? "Password saat ini tidak sesuai." : "Akun belum dapat dihapus. Silakan login ulang lalu coba lagi.";
    showToast({ message, type: "error" });
  } finally {
    accountDeletionInProgress = false;
  }
}

function firebaseRecord(plot) {
  return cleanFirebaseValue({ ...plot });
}

function sameFirebaseValue(first, second) {
  return stableStringify(cleanFirebaseValue(first)) === stableStringify(cleanFirebaseValue(second));
}

function realtimeDatabaseReady() {
  return Boolean(currentFirebaseUser && firebaseMasterLoaded && firebaseSchedulesLoaded);
}

function queueRealtimeDatabaseSync() {
  firebasePendingSync = true;
  if (!realtimeDatabaseReady()) return;
  if (firebaseSyncQueued || firebaseSyncInProgress) return;
  firebaseSyncQueued = true;
  window.setTimeout(() => {
    firebaseSyncQueued = false;
    syncStateToRealtimeDatabase();
  }, 180);
}

async function syncStateToRealtimeDatabase() {
  if (!realtimeDatabaseReady()) return;
  if (firebaseSyncInProgress) {
    firebasePendingSync = true;
    return;
  }

  firebaseSyncInProgress = true;
  firebasePendingSync = false;
  setFirebaseStatus("saving", "Menyimpan");

  try {
    state.masters = normalizeMasters(state.masters, state.plotings);
    const updates = {};
    const currentById = new Map(state.plotings.map((plot) => [plot.id, firebaseRecord(plot)]));

    remotePlotings.forEach((_, id) => {
      if (!currentById.has(id)) updates[`schedules/${id}`] = null;
    });

    currentById.forEach((record, id) => {
      const remote = remotePlotings.get(id);
      if (!remote || !sameFirebaseValue(record, remote)) updates[`schedules/${id}`] = record;
    });

    if (!remoteMasters || !sameFirebaseValue(state.masters, remoteMasters)) {
      updates.masters = cleanFirebaseValue(state.masters);
    }

    if (!Object.keys(updates).length) {
      setFirebaseStatus("synced", "Tersimpan");
      return;
    }

    updates.schemaVersion = 30;
    updates.updatedAt = nowIso();
    await update(realtimeRootRef, updates);

    remotePlotings = new Map([...currentById.entries()].map(([id, record]) => [id, clone(record)]));
    remoteMasters = clone(state.masters);
    setFirebaseStatus("synced", "Tersimpan");
  } catch (error) {
    console.error("Gagal menyimpan ke Realtime Database.", error);
    setFirebaseStatus("error", "Gagal sinkronisasi");
    showToast("Data belum tersimpan. Periksa Realtime Database Rules, databaseURL, dan koneksi internet.");
    firebasePendingSync = true;
  } finally {
    firebaseSyncInProgress = false;
    if (firebasePendingSync) queueRealtimeDatabaseSync();
  }
}

function clearFirebaseLoadTimeout() {
  if (firebaseLoadTimeout) window.clearTimeout(firebaseLoadTimeout);
  firebaseLoadTimeout = null;
}

function startFirebaseLoadTimeout() {
  clearFirebaseLoadTimeout();
  firebaseLoadTimeout = window.setTimeout(() => {
    if (!realtimeDatabaseReady()) {
      setFirebaseStatus("error", "Database tidak merespons");
      showToast("Realtime Database belum merespons. Periksa databaseURL, Rules, atau koneksi internet.");
    }
  }, 15000);
}

function stopRealtimeDatabaseListeners() {
  if (unsubscribeMasters) unsubscribeMasters();
  if (unsubscribeSchedules) unsubscribeSchedules();
  if (unsubscribeAuditLogs) unsubscribeAuditLogs();
  if (unsubscribeMessages) unsubscribeMessages();
  if (unsubscribeReminders) unsubscribeReminders();
  if (unsubscribeTeamAccounts) unsubscribeTeamAccounts();
  if (unsubscribeConnection) unsubscribeConnection();
  clearFirebaseLoadTimeout();
  unsubscribeMasters = null;
  unsubscribeSchedules = null;
  unsubscribeAuditLogs = null;
  unsubscribeMessages = null;
  unsubscribeReminders = null;
  unsubscribeTeamAccounts = null;
  unsubscribeConnection = null;
  firebaseMasterLoaded = false;
  firebaseSchedulesLoaded = false;
  remoteMasters = null;
  remotePlotings = new Map();
  firebaseInitialHydrationComplete = false;
  firebaseNeedsNameNormalizationSync = false;
  teamAccountsLoaded = false;
}

function subscribeToRealtimeDatabase() {
  stopRealtimeDatabaseListeners();
  setFirebaseStatus("connecting", state.plotings.length ? "Memuat pembaruan" : "Memuat data");
  startFirebaseLoadTimeout();

  unsubscribeConnection = onValue(realtimeConnectionRef, (snapshot) => {
    if (realtimeDatabaseReady()) return;
    const connected = snapshot.val() === true;
    setFirebaseStatus("connecting", connected ? "Terhubung, memuat data" : "Menunggu koneksi");
  });

  unsubscribeMasters = onValue(realtimeMastersRef, (snapshot) => {
    const cloudMasters = snapshot.exists() ? snapshot.val() : defaultMasters;
    // Saat cache lokal sedang ditampilkan, master cloud tetap menjadi sumber utama.
    // Jadwal cache baru digabung setelah snapshot jadwal realtime diterima.
    state.masters = normalizeMasters(cloudMasters, firebaseSchedulesLoaded ? state.plotings : []);
    remoteMasters = snapshot.exists() ? clone(state.masters) : null;
    firebaseMasterLoaded = true;

    if (realtimeDatabaseReady()) finishRealtimeHydration();
  }, (error) => handleRealtimeDatabaseError(error));

  unsubscribeSchedules = onValue(realtimeSchedulesRef, (snapshot) => {
    const rawSchedules = snapshot.exists() ? snapshot.val() : {};
    const rawPlotings = Object.entries(rawSchedules || {}).map(([id, record]) => ({ id, ...(record || {}) }));
    const plotings = normalizePlotings(rawPlotings);
    firebaseNeedsNameNormalizationSync = rawPlotings.some((rawPlot, index) => {
      const normalizedPlot = plotings[index];
      return rawPlot.brand !== normalizedPlot.brand || rawPlot.program !== normalizedPlot.program;
    });
    state.plotings = sortByDate(plotings);
    state.masters = normalizeMasters(state.masters, state.plotings);
    remotePlotings = new Map(rawPlotings.map((plot) => [plot.id, firebaseRecord(plot)]));
    firebaseSchedulesLoaded = true;

    if (realtimeDatabaseReady()) finishRealtimeHydration();
  }, (error) => handleRealtimeDatabaseError(error));


  unsubscribeTeamAccounts = onValue(realtimeTeamAccountsRef, async (snapshot) => {
    const rawAccounts = snapshot.exists() ? snapshot.val() : {};
    teamAccounts = Object.entries(rawAccounts || {}).reduce((acc, [key, record]) => {
      acc[key] = normalizeTeamAccountRecord(record, key);
      return acc;
    }, {});
    teamAccountsLoaded = true;
    await ensureCurrentTeamProfile();
    if (currentFirebaseUser && currentTeamAccount()?.active) setAuthGate(false);
    updateUserChip(currentFirebaseUser);
    updateTeamChatBadges();
    if (teamChatState.panelOpen) renderTeamChat();
    if ($("#profileModalBackdrop")?.classList.contains("open")) renderProfileModal();
    populateSelects();
  }, (error) => {
    console.error("Direktori akun tim tidak dapat dimuat.", error);
    showToast({ message: "Direktori akun belum dapat dimuat. Periksa Firebase Rules untuk teamAccounts.", type: "warning" });
  });

  unsubscribeAuditLogs = onValue(realtimeAuditLogsRef, (snapshot) => {
    const rawLogs = snapshot.exists() ? snapshot.val() : {};
    auditLogs = Object.entries(rawLogs || {})
      .map(([id, record]) => ({ id, ...(record || {}) }))
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    if (activeView === "auditlog") renderAuditLog();
  }, (error) => {
    console.error("Audit Log tidak dapat dimuat.", error);
    if (activeView === "auditlog") showToast({ message: "Audit Log tidak dapat dimuat. Periksa Firebase Rules.", type: "warning" });
  });

  unsubscribeMessages = onValue(realtimeMessagesRef, (snapshot) => {
    const rawMessages = snapshot.exists() ? snapshot.val() : {};
    teamMessages = Object.entries(rawMessages || {})
      .map(([id, record]) => ({ id, ...(record || {}) }))
      .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
    updateTeamChatBadges();
    if (teamChatState.panelOpen) renderTeamChat();
  }, (error) => {
    console.error("Chat Tim tidak dapat dimuat.", error);
    if (teamChatState.panelOpen) showToast({ message: "Chat Tim tidak dapat dimuat. Periksa Firebase Rules.", type: "warning" });
  });

  unsubscribeReminders = onValue(realtimeRemindersRef, (snapshot) => {
    const rawReminders = snapshot.exists() ? snapshot.val() : {};
    teamReminders = Object.entries(rawReminders || {})
      .map(([id, record]) => ({ id, ...(record || {}) }))
      .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
    updateTeamChatBadges();
    if (teamChatState.panelOpen) renderTeamChat();
    renderIncomingTeamReminderModal();
  }, (error) => {
    console.error("Reminder Tim tidak dapat dimuat.", error);
    showToast({ message: "Reminder antar-PIC tidak dapat dimuat. Periksa Firebase Rules.", type: "warning" });
  });
}

function finishRealtimeHydration() {
  clearFirebaseLoadTimeout();
  const wasInitialLoad = !firebaseInitialHydrationComplete;
  firebaseInitialHydrationComplete = true;
  persistRealtimeCache();
  setFirebaseStatus("synced", "Tersimpan");

  // Render hanya halaman yang sedang dilihat. Kalender dan laporan lain baru
  // dirender ketika menu tersebut dibuka, sehingga halaman awal lebih cepat.
  renderAll();

  // Sinkronkan saat data lama atau data dari client lama hanya berbeda kapitalisasi Brand atau Program.
  if (firebaseNeedsNameNormalizationSync) {
    firebaseNeedsNameNormalizationSync = false;
    queueRealtimeDatabaseSync();
  }
}

function handleRealtimeDatabaseError(error) {
  console.error("Firebase Realtime Database tidak dapat diakses.", error);
  clearFirebaseLoadTimeout();
  const code = String(error?.code || "");
  const isPermissionError = code.includes("permission-denied");
  const message = isPermissionError
    ? "Akses database ditolak"
    : "Koneksi database gagal";
  const detail = isPermissionError
    ? "Rules Realtime Database menolak akun ini. Pastikan Rules sudah dipublish dan email login sama dengan Rules."
    : `Realtime Database tidak dapat diakses${code ? ` (${code})` : ""}. Periksa databaseURL dan koneksi internet.`;
  setFirebaseStatus("error", message);

  // Jangan kembalikan pengguna ke layar login jika Firebase Auth sudah sukses.
  // Kasus permission-denied biasanya berasal dari Realtime Database Rules, bukan
  // password salah. Tetap tampilkan aplikasi agar user tidak terlihat stuck.
  if (isPermissionError && !currentFirebaseUser) setAuthGate(true, detail);
  else if (isPermissionError) setAuthGate(false);

  showToast(detail);
}

async function signInWithPassword(event) {
  event?.preventDefault();
  const usernameInput = $("#authUsernameInput");
  const passwordInput = $("#authPasswordInput");
  const signInButton = $("#passwordSignInButton");
  const identifier = normalizeWhitespace(usernameInput?.value);
  const email = loginEmailFromIdentifier(identifier);
  const password = passwordInput?.value || "";

  if ((!identifier.includes("@") && !validAccountUsername(identifier)) || !email || password.length < 6) {
    setAuthGate(true, "Masukkan username dan password minimal 6 karakter.");
    return;
  }

  try {
    if (signInButton) {
      signInButton.disabled = true;
      signInButton.textContent = "Memeriksa akun...";
    }
    await signInWithEmailAndPassword(firebaseAuth, email, password);
    if (passwordInput) passwordInput.value = "";
    setAuthGate(true, "Login berhasil. Memeriksa profil akun...");
    setFirebaseStatus("connecting", "Memuat data");
  } catch (error) {
    console.error("Login akun tim gagal.", error);
    const loginMessage = error?.code === "auth/invalid-credential"
      ? "Username atau password tidak sesuai."
      : "Login belum berhasil. Pastikan metode Email/Password aktif di Firebase Authentication.";
    setAuthGate(true, loginMessage);
    showToast({ message: "Login belum berhasil.", type: "error" });
  } finally {
    updateAuthForm();
  }
}

async function signOutFromFirebase() {
  try {
    await signOut(firebaseAuth);
  } catch (error) {
    console.error("Gagal keluar dari Firebase.", error);
    showToast("Tidak dapat keluar dari akun Firebase.");
  }
}

function initializeFirebaseRealtime() {
  firebaseBootstrapComplete = true;
  setAuthGate(true, "Masukkan username dan password akun tim.");
  setFirebaseStatus("connecting", "Menunggu login");

  onAuthStateChanged(firebaseAuth, (user) => {
    currentFirebaseUser = user;
    updateUserChip(user);

    if (!user) {
      stopRealtimeDatabaseListeners();
      teamMessages = [];
      teamReminders = [];
      teamChatState = { selectedRecipientId: "", reminderComposerOpen: false, panelOpen: false };
      teamAccounts = {};
      teamAccountsLoaded = false;
      closeIncomingTeamReminderModal();
      updateTeamChatBadges();
      state.plotings = [];
      state.masters = normalizeMasters(defaultMasters, []);
      renderAll();
      setFirebaseStatus("connecting", "Menunggu login");
      setAuthGate(true, "Masukkan username dan password akun tim.");
      return;
    }

    ensureSelectedTeamRecipient();
    // Tampilkan cache akun ini lebih dulu agar dashboard tidak menunggu seluruh
    // snapshot database. Data cache langsung diganti oleh snapshot realtime terbaru.
    const restoredFromCache = hydrateRealtimeCache(user);
    setAuthGate(true, "Memeriksa profil akun...");
    if (restoredFromCache) {
      setFirebaseStatus("connecting", "Memuat pembaruan");
      renderAll();
    } else {
      setFirebaseStatus("connecting", "Menghubungkan");
    }
    subscribeToRealtimeDatabase();
  });
}

function populateSelects() {
  const years = availableYears();
  const yearPairs = years.map((year) => [year, year]);
  const brands = sortText(unique(state.plotings.map((plot) => plot.brand)));
  const pics = sortText(unique(state.plotings.map((plot) => plot.pic)));
  const defaultYear = currentYear();
  const defaultMonth = currentMonth();
  const defaultQuarter = currentQuarter();

  if (!filters.brand.brand || !brands.includes(filters.brand.brand)) filters.brand.brand = brands[0] || "";
  if (!filters.brand.year || !years.includes(filters.brand.year)) filters.brand.year = defaultYear;
  if (!filters.brand.month) filters.brand.month = defaultMonth;
  if (filters.brand.unit && !state.masters.units.includes(filters.brand.unit)) filters.brand.unit = "";

  const brandMonth = monthKeyFromPeriod(filters.brand.year, filters.brand.month);
  const brandScope = state.plotings.filter((plot) => (
    (!filters.brand.brand || plot.brand === filters.brand.brand) &&
    (!brandMonth || monthKey(plot.planAiring) === brandMonth) &&
    (!filters.brand.unit || plot.unit === filters.brand.unit)
  ));
  const brandPrograms = sortText(unique(brandScope.map((plot) => plot.program)));
  const brandFormats = sortText(unique(brandScope.map((plot) => plot.format)));
  if (filters.brand.program && !brandPrograms.includes(filters.brand.program)) filters.brand.program = "";
  if (filters.brand.format && !brandFormats.includes(filters.brand.format)) filters.brand.format = "";

  if (filters.pic.pic && !pics.includes(filters.pic.pic)) filters.pic.pic = "";
  if (!filters.pic.year || !years.includes(filters.pic.year)) filters.pic.year = defaultYear;
  if (!filters.pic.quarter) filters.pic.quarter = defaultQuarter;

  if (!filters.full.year || !years.includes(filters.full.year)) filters.full.year = defaultYear;
  if (!filters.full.month) filters.full.month = defaultMonth;
  if (filters.full.unit && !state.masters.units.includes(filters.full.unit)) filters.full.unit = "";
  if (filters.full.brand && !brands.includes(filters.full.brand)) filters.full.brand = "";

  if (filters.plot.year && !years.includes(filters.plot.year)) filters.plot.year = "";
  if (filters.batch.year && !years.includes(filters.batch.year)) filters.batch.year = "";
  if (filters.batch.unit && !state.masters.units.includes(filters.batch.unit)) filters.batch.unit = "";

  setSelectPairs("#plotYearFilter", yearPairs, "Semua tahun", filters.plot.year);
  setSelectPairs("#plotMonthFilter", MONTH_OPTIONS, "Semua bulan", filters.plot.month);
  setSelectOptions("#plotUnitFilter", state.masters.units, "Semua unit", filters.plot.unit);
  setSelectOptions("#plotGfxFilter", state.masters.gfx, "Semua materi GFX", filters.plot.gfx);
  setSelectOptions("#plotAiringFilter", AIRING_STATUSES, "Semua status tayang", filters.plot.airing);

  setSelectPairs("#batchYearFilter", yearPairs, "Semua tahun", filters.batch.year);
  setSelectPairs("#batchMonthFilter", MONTH_OPTIONS, "Semua bulan", filters.batch.month);
  setSelectOptions("#batchUnitFilter", state.masters.units, "Semua unit", filters.batch.unit);

  setSearchableBrandInput("#brandSelect", "#brandSelectOptions", brands, filters.brand.brand);
  setSelectPairs("#brandYearSelect", yearPairs, "Pilih tahun", filters.brand.year);
  setSelectPairs("#brandMonthSelect", MONTH_OPTIONS, "Pilih bulan", filters.brand.month);
  setSelectOptions("#brandUnitSelect", state.masters.units, "Semua unit", filters.brand.unit);
  setSelectOptions("#brandProgramSelect", brandPrograms, "Semua program", filters.brand.program);
  setSelectOptions("#brandFormatSelect", brandFormats, "Semua format VA", filters.brand.format);

  setSelectOptions("#picReportSelect", pics, "Semua PIC", filters.pic.pic);
  setSelectPairs("#picReportYearSelect", yearPairs, "Pilih tahun", filters.pic.year);
  setSelectPairs("#picReportQuarterSelect", QUARTER_OPTIONS, "Pilih kuartal", filters.pic.quarter);

  setSelectPairs("#fullTimelineYearSelect", yearPairs, "Pilih tahun", filters.full.year);
  setSelectPairs("#fullTimelineMonthSelect", MONTH_OPTIONS, "Pilih bulan", filters.full.month);
  setSelectOptions("#fullTimelineUnitSelect", state.masters.units, "Semua unit", filters.full.unit);
  setSearchableBrandInput("#fullTimelineBrandSelect", "#fullTimelineBrandOptions", brands, filters.full.brand);

  setSelectOptions("#plotAdvertiserInput", state.masters.advertisers, "Pilih PT Advertiser");
  setSelectOptions("#plotUnitInput", state.masters.units, "Pilih Unit On Air");
  setSelectOptions("#plotPodInput", state.masters.pods, "Pilih POD");
  setSelectOptions("#plotFormatInput", state.masters.formats, "Pilih Format VA");
  setSelectOptions("#plotDurationInput", state.masters.durations, "Pilih Durasi");
  setSelectOptions("#plotGfxInput", state.masters.gfx, "Pilih Materi GFX");
  setSelectOptions("#plotPicInput", activePicAccountNames(), "Pilih PIC Ploting");
}

function renderDashboard() {
  const operationDate = state.operationDate;
  const currentWeek = weekRangeFromDate(operationDate);
  const todayPlots = sortByUnitThenProgram(state.plotings.filter((plot) => plot.planAiring === operationDate));
  const allBatches = batches();
  const allCompletedSpot = completedSpotSum(state.plotings);
  const pendingSpot = sum(state.plotings.filter((plot) => isPendingAiringStatus(plot.airingStatus)).map((plot) => plot.spot));
  const upcoming = sortByDate(state.plotings.filter((plot) => isSameWeekDate(plot.planAiring, operationDate)));
  const attention = sortByDate(state.plotings.filter((plot) => plot.planAiring >= operationDate && plot.planAiring <= addDays(operationDate, 3) && plot.airingStatus === "Planned"));
  renderDashboardGreeting(todayPlots, upcoming, attention);
  const kpis = [
    ["Spot sudah tayang", allCompletedSpot, "Status On air/Sudah tayang"],
    ["Spot belum tayang", pendingSpot, "Planned dan Siap tayang"],
    ["Spot hari ini", sum(todayPlots.map((plot) => plot.spot)), `${todayPlots.length} jadwal pada ${formatDate(operationDate, { day: "2-digit", month: "short" })}`],
    ["Jadwal minggu ini", upcoming.length, `${sum(upcoming.map((plot) => plot.spot))} spot · ${formatDate(currentWeek.start, { day: "2-digit", month: "short" })} s/d ${formatDate(currentWeek.end, { day: "2-digit", month: "short" })}`]
  ];
  $("#kpiGrid").innerHTML = kpis.map(([label, value, note]) => `<article class="kpi-card"><p>${label}</p><strong>${value}</strong><small>${note}</small></article>`).join("");
  $("#dashboardTodayBody").innerHTML = todayPlots.length ? todayPlots.map((plot) => `<tr class="dashboard-today-row ${mobileCalendarStatusClass(plot)}">
    <td class="dashboard-today-unit">${unitLabelMarkup(plot.unit, "table")}</td>
    <td class="dashboard-today-copy">
      <span class="cell-title dashboard-today-program dashboard-today-desktop-title">${escapeHTML(plot.program)}</span>
      <span class="cell-subtitle dashboard-today-brand dashboard-today-desktop-subtitle">${escapeHTML(plot.brand)}<i aria-hidden="true">·</i>${escapeHTML(plot.pod)}</span>
      <span class="dashboard-today-mobile-copy">
        <strong>${escapeHTML(plot.brand)}</strong>
        <small class="dashboard-today-mobile-program">${escapeHTML(plot.program)}</small>
        <small class="dashboard-today-mobile-format">${escapeHTML(plot.format || "-")}</small>
      </span>
    </td>
    <td class="dashboard-today-format">${escapeHTML(plot.format)}</td>
    <td class="dashboard-today-spot">
      <span class="dashboard-today-desktop-spot">${plotSpotMarkup(plot)}</span>
      <span class="dashboard-today-mobile-spot ${spotClass(plot.spot, plot.airingStatus)}">${Number(plot.spot)}<small>spot</small></span>
    </td>
    <td class="dashboard-today-status">${badge(plot.airingStatus)}</td>
  </tr>`).join("") : `<tr><td colspan="5" class="empty-row">Belum ada jadwal pada tanggal operasional.</td></tr>`;

  $("#attentionList").innerHTML = attention.length ? attention.slice(0, 5).map((plot) => `<div class="attention-item"><div><strong>${escapeHTML(plot.brand)} · ${escapeHTML(plot.program)}</strong><p>${formatDate(plot.planAiring)} · ${escapeHTML(plot.unit)} · <span class="${spotClass(plot.spot, plot.airingStatus)}">${plot.spot} spot</span></p></div><button class="row-action" data-edit-batch="${escapeHTML(plot.batchId)}" type="button">Edit</button></div>`).join("") : `<div class="attention-item"><div><strong>Tidak ada jadwal Planned dalam 3 hari.</strong><p>Silakan cek timeline jika ada perubahan dari sales.</p></div></div>`;

  const recentBatches = allBatches.sort((a, b) => (b[0].updatedAt || "").localeCompare(a[0].updatedAt || "")).slice(0, 5);
  $("#recentBatchList").innerHTML = recentBatches.length ? recentBatches.map((batch) => {
    const first = batch[0];
    return `<div class="batch-item"><div><strong>${escapeHTML(first.brand)} · ${escapeHTML(first.advertiser)}</strong><p>${escapeHTML(first.batchId)} · PIC: ${escapeHTML(first.pic)} · ${batch.length} tanggal · ${sum(batch.map((plot) => plot.spot))} spot</p></div><button class="row-action" data-edit-batch="${escapeHTML(first.batchId)}" type="button">Edit</button></div>`;
  }).join("") : `<div class="batch-item"><div><strong>Belum ada batch</strong><p>Belum ada batch ploting pada sistem.</p></div></div>`;
  $("#upcomingList").innerHTML = upcoming.length ? upcoming.slice(0, 6).map((plot) => `<div class="upcoming-item"><div><strong>${escapeHTML(plot.brand)} · ${escapeHTML(plot.program)}</strong><p>${formatDate(plot.planAiring)} · ${escapeHTML(plot.unit)} · <span class="${spotClass(plot.spot, plot.airingStatus)}">${plot.spot} spot</span></p></div><span class="item-side">${escapeHTML(plot.format)}</span></div>`).join("") : `<div class="upcoming-item"><div><strong>Belum ada jadwal</strong><p>Tidak ada penayangan pada minggu ini.</p></div></div>`;
}

function filteredPlotings() {
  const filter = filters.plot;
  const query = filter.query.trim().toLowerCase();
  return sortByDate(state.plotings.filter((plot) => {
    const haystack = [plot.batchId, plot.advertiser, plot.brand, plot.sales, plot.pic, plot.unit, plot.program, plot.pod, plot.version, plot.format, plot.duration, plot.gfx, plot.batchNote, plot.scheduleNote].join(" ").toLowerCase();
    return (!query || haystack.includes(query)) && matchesYearMonth(plot.planAiring, filter.year, filter.month) && (!filter.unit || plot.unit === filter.unit) && (!filter.gfx || plot.gfx === filter.gfx) && (!filter.airing || plot.airingStatus === filter.airing);
  }));
}

function renderPlotings() {
  const plots = filteredPlotings();
  const perPage = Number(filters.plot.perPage) || 20;
  const totalPages = Math.max(1, Math.ceil(plots.length / perPage));
  filters.plot.page = Math.min(Math.max(1, Number(filters.plot.page) || 1), totalPages);
  const startIndex = (filters.plot.page - 1) * perPage;
  const pagePlots = plots.slice(startIndex, startIndex + perPage);
  const from = plots.length ? startIndex + 1 : 0;
  const to = Math.min(startIndex + pagePlots.length, plots.length);

  $("#plotResultCount").textContent = plots.length;
  $("#plotingsTableBody").innerHTML = pagePlots.length ? pagePlots.map((plot) => `<tr>
    <td><span class="cell-title">${formatDate(plot.planAiring)}</span><span class="cell-subtitle">${escapeHTML(plot.batchId)}</span></td>
    <td><span class="cell-title">${escapeHTML(plot.brand)}</span><span class="cell-subtitle">${escapeHTML(plot.advertiser)}</span></td>
    <td>${escapeHTML(plot.sales)}</td>
    <td><span class="pic-chip">${escapeHTML(plot.pic)}</span></td>
    <td><span class="cell-title cell-title-unit">${unitLabelMarkup(plot.unit, "table")}<span class="unit-program-separator" aria-hidden="true">·</span><span class="unit-program-name">${escapeHTML(plot.program)}</span></span><span class="cell-subtitle">${escapeHTML(plot.pod)} · ${escapeHTML(plot.segmentation || "Tanpa segmentasi")}</span></td>
    <td><span class="cell-title">${escapeHTML(plot.format)} · ${escapeHTML(plot.duration)}</span><span class="cell-subtitle">${escapeHTML(plot.version)}</span></td>
    <td>${plotSpotMarkup(plot)}</td>
    <td>${escapeHTML(plot.gfx)}</td>
    <td>${badge(plot.airingStatus)}</td>
    <td><button class="row-action" data-edit-schedule="${escapeHTML(plot.id)}" type="button">Atur Jadwal</button></td>
  </tr>`).join("") : `<tr><td colspan="10" class="empty-row">Tidak ada jadwal yang sesuai dengan filter.</td></tr>`;

  const pageButtons = Array.from({ length: totalPages }, (_, index) => index + 1).filter((page) => {
    const current = filters.plot.page;
    return totalPages <= 7 || page === 1 || page === totalPages || Math.abs(page - current) <= 1;
  });
  const pagesMarkup = pageButtons.map((page, index) => {
    const previous = pageButtons[index - 1];
    const gap = previous && page - previous > 1 ? `<span class="pagination-gap">…</span>` : "";
    return `${gap}<button class="pagination-page ${page === filters.plot.page ? "is-active" : ""}" data-plot-page="${page}" type="button" aria-label="Halaman ${page}" ${page === filters.plot.page ? 'aria-current="page"' : ""}>${page}</button>`;
  }).join("");

  $("#plotPagination").innerHTML = plots.length
    ? `<span class="pagination-summary">Menampilkan ${from}–${to} dari ${plots.length} jadwal</span>
       <div class="pagination-actions">
         <button class="pagination-nav" data-plot-page="${filters.plot.page - 1}" type="button" ${filters.plot.page === 1 ? "disabled" : ""}>← Sebelumnya</button>
         <div class="pagination-pages">${pagesMarkup}</div>
         <button class="pagination-nav" data-plot-page="${filters.plot.page + 1}" type="button" ${filters.plot.page === totalPages ? "disabled" : ""}>Berikutnya →</button>
       </div>`
    : "";
}


function batchPeriod(batch) {
  const dates = sortText(batch.map((plot) => plot.planAiring).filter(Boolean));
  const start = dates[0] || "";
  const end = dates[dates.length - 1] || "";
  return { start, end };
}

function batchStatusMarkup(batch) {
  const statuses = AIRING_STATUSES.filter((status) => batch.some((plot) => plot.airingStatus === status));
  const visible = statuses.slice(0, 2).map((status) => badge(status)).join(" ");
  const extra = statuses.length > 2 ? `<span class="cell-subtitle">+${statuses.length - 2} status lain</span>` : "";
  return (visible || badge("Planned")) + extra;
}

function filteredBatches() {
  const filter = filters.batch;
  const query = filter.query.trim().toLowerCase();
  return batches()
    .map((batch) => sortByDate(batch))
    .filter((batch) => {
      const haystack = batch.map((plot) => [
        plot.batchId, plot.advertiser, plot.brand, plot.sales, plot.pic, plot.unit,
        plot.program, plot.pod, plot.version, plot.format, plot.duration, plot.gfx,
        plot.batchNote, plot.scheduleNote
      ].join(" ")).join(" ").toLowerCase();
      const matchesQuery = !query || haystack.includes(query);
      const matchesPeriod = batch.some((plot) => matchesYearMonth(plot.planAiring, filter.year, filter.month));
      const matchesUnit = !filter.unit || batch.some((plot) => plot.unit === filter.unit);
      return matchesQuery && matchesPeriod && matchesUnit;
    })
    .sort((a, b) => {
      const firstA = a[0] || {};
      const firstB = b[0] || {};
      const periodA = batchPeriod(a);
      const periodB = batchPeriod(b);
      return String(firstB.updatedAt || "").localeCompare(String(firstA.updatedAt || "")) ||
        String(periodB.end || "").localeCompare(String(periodA.end || "")) ||
        String(firstA.brand || "").localeCompare(String(firstB.brand || ""), "id") ||
        String(firstA.batchId || "").localeCompare(String(firstB.batchId || ""), "id");
    });
}

function renderBatches() {
  const allBatches = filteredBatches();
  const perPage = Number(filters.batch.perPage) || 20;
  const totalPages = Math.max(1, Math.ceil(allBatches.length / perPage));
  filters.batch.page = Math.min(Math.max(1, Number(filters.batch.page) || 1), totalPages);
  const startIndex = (filters.batch.page - 1) * perPage;
  const pageBatches = allBatches.slice(startIndex, startIndex + perPage);
  const from = allBatches.length ? startIndex + 1 : 0;
  const to = Math.min(startIndex + pageBatches.length, allBatches.length);

  const resultCount = $("#batchResultCount");
  const tableBody = $("#batchTableBody");
  const pagination = $("#batchPagination");
  if (!resultCount || !tableBody || !pagination) return;

  resultCount.textContent = allBatches.length;
  tableBody.innerHTML = pageBatches.length ? pageBatches.map((batch) => {
    const first = batch[0];
    const totalSpot = sum(batch.map((plot) => plot.spot));
    const uniquePrograms = unique(batch.map((plot) => plot.program));
    const uniqueUnits = unique(batch.map((plot) => plot.unit));
    const benefitFormats = unique(batch.map((plot) => [plot.format, plot.duration].filter(Boolean).join(" · "))).filter(Boolean);
    const benefitVersions = unique(batch.map((plot) => plot.version).filter(Boolean));
    const benefitLabel = benefitFormats[0] || "Benefit belum diisi";
    const benefitSubtitle = [
      benefitFormats.length > 1 ? `+${benefitFormats.length - 1} benefit lain` : "",
      benefitVersions[0] || "Tanpa versi",
      first.gfx || ""
    ].filter(Boolean).join(" · ");
    return `<tr>
      <td><span class="cell-title">${escapeHTML(first.batchId)}</span><span class="cell-subtitle">${batch.length} jadwal · Update: ${formatDate(String(first.updatedAt || "").slice(0, 10))}</span></td>
      <td><span class="cell-title">${escapeHTML(first.brand)}</span><span class="cell-subtitle">${escapeHTML(first.advertiser)}</span></td>
      <td><span class="cell-title cell-title-unit">${unitLabelMarkup(first.unit, "table")}<span class="unit-program-separator" aria-hidden="true">·</span><span class="unit-program-name">${escapeHTML(first.program)}</span></span><span class="cell-subtitle">${uniqueUnits.length > 1 ? `${uniqueUnits.length} unit` : escapeHTML(first.pod)} · ${uniquePrograms.length} program</span></td>
      <td><span class="pic-chip">${escapeHTML(first.pic)}</span><span class="cell-subtitle">Sales: ${escapeHTML(first.sales)}</span></td>
      <td><span class="cell-title batch-benefit-title">${escapeHTML(benefitLabel)}</span><span class="cell-subtitle batch-benefit-subtitle">${escapeHTML(benefitSubtitle)}</span></td>
      <td>${batch.length}</td>
      <td>${spotMarkup(totalSpot)}</td>
      <td>${batchStatusMarkup(batch)}</td>
      <td><button class="row-action" data-edit-batch="${escapeHTML(first.batchId)}" type="button">Edit Batch</button></td>
    </tr>`;
  }).join("") : `<tr><td colspan="9" class="empty-row">Tidak ada batch yang sesuai dengan filter.</td></tr>`;

  const pageButtons = Array.from({ length: totalPages }, (_, index) => index + 1).filter((page) => {
    const current = filters.batch.page;
    return totalPages <= 7 || page === 1 || page === totalPages || Math.abs(page - current) <= 1;
  });
  const pagesMarkup = pageButtons.map((page, index) => {
    const previous = pageButtons[index - 1];
    const gap = previous && page - previous > 1 ? `<span class="pagination-gap">…</span>` : "";
    return `${gap}<button class="pagination-page ${page === filters.batch.page ? "is-active" : ""}" data-batch-page="${page}" type="button" aria-label="Halaman ${page}" ${page === filters.batch.page ? 'aria-current="page"' : ""}>${page}</button>`;
  }).join("");

  pagination.innerHTML = allBatches.length
    ? `<span class="pagination-summary">Menampilkan ${from}–${to} dari ${allBatches.length} batch</span>
       <div class="pagination-actions">
         <button class="pagination-nav" data-batch-page="${filters.batch.page - 1}" type="button" ${filters.batch.page === 1 ? "disabled" : ""}>← Sebelumnya</button>
         <div class="pagination-pages">${pagesMarkup}</div>
         <button class="pagination-nav" data-batch-page="${filters.batch.page + 1}" type="button" ${filters.batch.page === totalPages ? "disabled" : ""}>Berikutnya →</button>
       </div>`
    : "";
}

function renderDaily() {
  const date = state.operationDate;
  const plots = sortByUnitThenProgram(state.plotings.filter((plot) => plot.planAiring === date));
  $("#dailyDateInput").value = date;
  $("#dailyTimelineTitle").textContent = `Timeline ${formatDate(date)}`;
  $("#dailyTimelineCaption").textContent = `${plots.length} jadwal · ${sum(plots.map((plot) => plot.spot))} spot`;
  const metrics = [
    ["Total Program", unique(plots.map((plot) => plot.program)).length, "Program pada tanggal terpilih"],
    ["Total spot", sum(plots.map((plot) => plot.spot)), "Akumulasi spot"],
    ["Brand", unique(plots.map((plot) => plot.brand)).length, "Brand aktif"],
    ["Unit", unique(plots.map((plot) => plot.unit)).length, "Unit on air"]
  ];
  $("#dailyKpiGrid").innerHTML = metrics.map(([label, value, note]) => `<article class="mini-kpi"><p>${label}</p><strong>${value}</strong><small>${note}</small></article>`).join("");
  const byUnit = plots.reduce((acc, plot) => { (acc[plot.unit] ||= []).push(plot); return acc; }, {});
  $("#dailyTimelineList").innerHTML = Object.keys(byUnit).length ? Object.entries(byUnit).map(([unit, entries]) => `<div class="timeline-unit"><div class="timeline-unit-head"><strong>${unitLabelMarkup(unit, "timeline")}</strong><span>${entries.length} jadwal · ${sum(entries.map((plot) => plot.spot))} spot</span></div>${entries.map((plot) => `<div class="timeline-entry"><div><strong>${escapeHTML(plot.program)} · ${escapeHTML(plot.brand)}</strong><p>${escapeHTML(plot.advertiser)} · ${escapeHTML(plot.pod)}</p></div><div><strong>${escapeHTML(plot.format)} · ${escapeHTML(plot.duration)}</strong><p>${escapeHTML(plot.version)}</p></div><div>${plotSpotMarkup(plot)}<p>spot</p></div><div>${escapeHTML(plot.gfx)}<p>${escapeHTML(plot.segmentation || "Tanpa segmentasi")}</p></div><div>${badge(plot.airingStatus)}</div><div class="timeline-actions"><button class="row-action" data-edit-schedule="${escapeHTML(plot.id)}" type="button">Atur</button></div></div>`).join("")}</div>`).join("") : `<div class="empty-row">Belum ada ploting pada tanggal ini.</div>`;

  const days = Array.from({ length: 7 }, (_, index) => addDays(date, index));
  $("#sevenDayList").innerHTML = days.map((day) => {
    const daily = sortByDate(state.plotings.filter((plot) => plot.planAiring === day));
    const totalSpot = sum(daily.map((plot) => plot.spot));
    const dateObject = new Date(`${day}T00:00:00`);
    const weekdayLabel = new Intl.DateTimeFormat("id-ID", { weekday: "short" }).format(dateObject);
    const monthLabel = new Intl.DateTimeFormat("id-ID", { month: "short" }).format(dateObject);
    const eventMarkup = daily.length
      ? daily.slice(0, 3).map((plot) => `<button class="day-event" data-edit-schedule="${escapeHTML(plot.id)}" type="button" title="${escapeHTML(`${plot.brand} · ${Number(plot.spot)} spot`)}"><span class="day-event-brand">${escapeHTML(plot.brand)}</span><small class="${spotClass(plot.spot, plot.airingStatus)}">${Number(plot.spot)} spot</small></button>`).join("")
      : `<div class="day-column-empty">Tidak ada jadwal</div>`;
    const moreMarkup = daily.length > 3 ? `<div class="calendar-more">+${daily.length - 3} jadwal lain</div>` : "";
    return `<article class="day-column ${day === date ? "is-current" : ""}">
      <header class="day-column-head"><span>${escapeHTML(weekdayLabel)}</span><strong>${dateObject.getDate()}</strong><small>${escapeHTML(monthLabel)}</small></header>
      <div class="day-column-summary"><strong>${totalSpot}</strong><span>spot · ${daily.length} jadwal</span></div>
      <div class="day-column-events">${eventMarkup}${moreMarkup}</div>
    </article>`;
  }).join("");
}


function waEligiblePlot(plot) {
  const inactiveStatus = ["Tidak tayang", "Dibatalkan"];
  return plot.planAiring === state.operationDate && Number(plot.spot) > 0 && !inactiveStatus.includes(plot.airingStatus);
}

function normalizedWaUnit(unit) {
  return String(unit || "").toLocaleUpperCase("id-ID").replace(/[^A-Z0-9]/g, "");
}

function isMnctvUnit(unit) {
  return normalizedWaUnit(unit) === "MNCTV";
}

function getWaProgramGroups() {
  const grouped = new Map();
  const mnctvPlots = [];

  sortByDate(state.plotings.filter(waEligiblePlot)).forEach((plot) => {
    const program = String(plot.program || "Tanpa program").trim() || "Tanpa program";
    const unit = String(plot.unit || "Tanpa unit").trim() || "Tanpa unit";

    // MNCTV memakai satu pesan untuk seluruh program pada tanggal operasional.
    if (isMnctvUnit(unit)) {
      mnctvPlots.push(plot);
      return;
    }

    const key = `${state.operationDate}::${unit}::${program}`;
    if (!grouped.has(key)) grouped.set(key, { key, program, unit, plots: [], template: "default" });
    grouped.get(key).plots.push(plot);
  });

  if (mnctvPlots.length) {
    const key = `${state.operationDate}::MNCTV::ALL`;
    grouped.set(key, {
      key,
      program: "Semua Program",
      unit: "MNCTV",
      plots: mnctvPlots,
      template: "mnctv"
    });
  }

  return [...grouped.values()].sort((first, second) => {
    const firstPriority = first.template === "mnctv" ? -1 : 0;
    const secondPriority = second.template === "mnctv" ? -1 : 0;
    return firstPriority - secondPriority || first.unit.localeCompare(second.unit, "id") || first.program.localeCompare(second.program, "id");
  });
}

function getWaSpotItems(group) {
  if (!group) return [];
  return sortByUnitThenProgram(group.plots).flatMap((plot) => {
    const amount = Math.max(0, Math.floor(Number(plot.spot) || 0));
    return Array.from({ length: amount }, (_, index) => ({
      key: `${group.key}::${plot.id}::${index + 1}`,
      plot,
      spotIndex: index + 1,
      spotTotal: amount
    }));
  });
}

function formatWaDate(dateValue) {
  if (!dateValue) return "-";
  const date = new Date(`${dateValue}T00:00:00`);
  if (Number.isNaN(date.getTime())) return String(dateValue).toUpperCase();
  return new Intl.DateTimeFormat("id-ID", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric"
  }).format(date).toLocaleUpperCase("id-ID");
}

function formatWaFormat(format) {
  const value = String(format || "").trim();
  const normalized = value.toUpperCase();
  if (normalized === "FS" || normalized.includes("FREEZE SCENE")) return "FS";
  return value.replace(/^VA\s+/i, "").trim() || "VA";
}

function formatWaDuration(duration) {
  return String(duration || "").trim()
    .replace(/\s*detik\b/gi, "\"")
    .replace(/\s+\"/g, "\"") || "-";
}

function waSegmentNote(format) {
  const normalized = String(format || "").toUpperCase();
  if (/\b2D\b/.test(normalized)) return "(Naik di adegan positif, Tambah audio scene)";
  if (/\b3D\b/.test(normalized) || /\bFS\b/.test(normalized) || normalized.includes("FREEZE SCENE")) {
    return "(Naik di adegan positif, Ada audio gfx)";
  }
  return "";
}

function waSpotLine(plot, spot = 1) {
  return `• ${spot} Spot ${formatWaFormat(plot.format)} ${String(plot.brand || "-").trim()} Durasi ${formatWaDuration(plot.duration)}`
    .replace(/\s{2,}/g, " ")
    .trim();
}

function getWaSummaryItems(group) {
  const summary = new Map();
  sortByDate(group?.plots || []).forEach((plot) => {
    const key = [plot.brand, plot.format, plot.duration].map((value) => String(value || "").trim()).join("::");
    if (!summary.has(key)) summary.set(key, { plot, spot: 0 });
    summary.get(key).spot += Number(plot.spot) || 0;
  });
  return [...summary.values()];
}

function getSelectedWaGroup() {
  return getWaProgramGroups().find((group) => group.key === waGeneratorState.selectedProgramKey) || null;
}

function waAssignmentsComplete(items) {
  return Boolean(items.length) && items.every((item) => WA_SEGMENT_OPTIONS.includes(Number(waGeneratorState.assignments[item.key])));
}

function formatMnctvWaDate(dateValue) {
  if (!dateValue) return "-";
  const date = new Date(`${dateValue}T00:00:00`);
  if (Number.isNaN(date.getTime())) return String(dateValue).toLocaleUpperCase("id-ID");
  return new Intl.DateTimeFormat("id-ID", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric"
  }).format(date).replace(",", "").toLocaleUpperCase("id-ID");
}

function formatMnctvWaFormat(format) {
  const normalized = String(format || "").trim().toLocaleUpperCase("id-ID");
  const compact = normalized.replace(/\s+/g, "");
  if (compact === "FS" || normalized.includes("FREEZE SCENE")) return "FS";
  if (compact.includes("2D") && compact.includes("RT")) return "VA2D+RT";
  return normalized.replace(/\s*\+\s*/g, "+").replace(/\s+/g, " ") || "VA";
}

function formatMnctvWaMaterial(plot) {
  const brand = normalizeWhitespace(plot?.brand);
  const version = normalizeWhitespace(plot?.version);
  if (!version) return brand || "-";
  if (!brand) return version;

  const compactBrand = brand.toLocaleUpperCase("id-ID");
  const compactVersion = version.toLocaleUpperCase("id-ID");
  return compactVersion.includes(compactBrand) ? version : `${brand} ${version}`;
}

function buildMnctvWaMessage(group) {
  const items = getWaSpotItems(group);
  if (!group || !waAssignmentsComplete(items)) return "";

  // Urutan program mengikuti urutan jadwal yang sudah ada, lalu setiap format
  // dikelompokkan agar satu chat MNCTV tetap ringkas dan mudah diverifikasi.
  const programGroups = new Map();
  items.forEach((item) => {
    const program = String(item.plot.program || "Tanpa program").trim() || "Tanpa program";
    if (!programGroups.has(program)) programGroups.set(program, new Map());
    const formats = programGroups.get(program);
    const format = formatMnctvWaFormat(item.plot.format);
    if (!formats.has(format)) formats.set(format, []);
    formats.get(format).push(item);
  });

  const programBlocks = [...programGroups.entries()].map(([program, formats]) => {
    const formatBlocks = [...formats.entries()].map(([format, formatItems]) => {
      const detailLines = formatItems.map((item) => {
        const segment = Number(waGeneratorState.assignments[item.key]);
        return `- ${formatMnctvWaMaterial(item.plot)} *(Segmen ${segment})*`;
      });
      const notes = format === "FS"
        ? ["", "Note:", "- FS background diberi scene still & blur."]
        : [];
      return [`${formatItems.length} SPOT ${format}`, ...detailLines, ...notes].join("\n");
    }).join("\n\n");

    return [
      `*${program.toLocaleUpperCase("id-ID")}*`,
      "=================================",
      formatBlocks
    ].join("\n");
  });

  return [
    "Selamat Siang",
    "",
    "Terlampir Plan Virtual Ads MNCTV",
    `*${formatMnctvWaDate(state.operationDate)}*`,
    "=================================",
    programBlocks.join("\n\n=================================\n"),
    "",
    "Terima kasih"
  ].join("\n");
}

function buildWaMessage(group) {
  if (group?.template === "mnctv") return buildMnctvWaMessage(group);

  const items = getWaSpotItems(group);
  if (!group || !waAssignmentsComplete(items)) return "";

  const summaryLines = getWaSummaryItems(group).map(({ plot, spot }) => waSpotLine(plot, spot));
  const segmentBlocks = WA_SEGMENT_OPTIONS.map((segment) => {
    const segmentItems = items.filter((item) => Number(waGeneratorState.assignments[item.key]) === segment);
    if (!segmentItems.length) return "";
    const details = segmentItems.map((item) => {
      const note = waSegmentNote(item.plot.format);
      return [waSpotLine(item.plot), note, "TC :"].filter(Boolean).join("\n");
    }).join("\n\n");
    return `│ SEGMENT ${segment}\n\n${details}\n====================`;
  }).filter(Boolean);

  return [
    "PLAN & KOMPOSISI VIRTUAL ADS :",
    "",
    group.program.toLocaleUpperCase("id-ID"),
    formatWaDate(state.operationDate),
    "====================",
    "",
    ...summaryLines,
    "",
    `Total : ${items.length} Spot`,
    "",
    "====================",
    "",
    segmentBlocks.join("\n\n"),
    "",
    "Note :",
    "",
    "• FS background still scene blur 80%",
    "• Mohon dibantu video preview dan timecode setelah dipasang.",
    "",
    "Terima kasih 🙏"
  ].join("\n");
}

function renderWaGenerator() {
  const groups = getWaProgramGroups();
  if (!groups.some((group) => group.key === waGeneratorState.selectedProgramKey)) {
    waGeneratorState.selectedProgramKey = groups[0]?.key || "";
  }
  const group = getSelectedWaGroup();
  const items = getWaSpotItems(group);

  const programList = $("#waProgramList");
  const assignmentList = $("#waSpotAssignmentList");
  const dateLabel = $("#waGeneratorDateLabel");
  if (dateLabel) dateLabel.textContent = formatWaDate(state.operationDate);
  const preview = $("#waMessagePreview");
  const hint = $("#waAssignmentHint");
  const selectedTitle = $("#waSelectedProgramTitle");
  const selectedMeta = $("#waSelectedProgramMeta");
  const copyButton = $("#waCopyButton");
  const openButton = $("#waOpenButton");
  const resetButton = $("#waResetSegmentsButton");

  if (!groups.length) {
    programList.innerHTML = `<div class="wa-empty-list">Tidak ada jadwal aktif dengan spot pada tanggal operasional.</div>`;
    assignmentList.innerHTML = "";
    preview.textContent = "Belum ada program yang dapat dibuatkan pesan WhatsApp.";
    hint.textContent = "Tambahkan jadwal aktif pada tanggal operasional untuk menggunakan generator ini.";
    selectedTitle.textContent = "Pilih program";
    selectedMeta.textContent = formatDate(state.operationDate);
    copyButton.disabled = true;
    openButton.disabled = true;
    resetButton.disabled = true;
    return;
  }

  programList.innerHTML = groups.map((entry) => {
    const selected = entry.key === group.key;
    const spots = sum(entry.plots.map((plot) => plot.spot));
    const programCount = unique(entry.plots.map((plot) => String(plot.program || "").trim()).filter(Boolean)).length;
    const title = entry.template === "mnctv" ? "MNCTV · Semua program" : entry.program;
    const meta = entry.template === "mnctv"
      ? `${programCount} program · ${spots} spot · 1 chat`
      : `${entry.unit} · ${spots} spot · ${entry.plots.length} jadwal`;
    return `<button class="wa-program-button ${entry.template === "mnctv" ? "wa-program-button--mnctv" : ""} ${selected ? "is-selected" : ""}" data-wa-program="${encodeURIComponent(entry.key)}" type="button" aria-pressed="${selected}">
      <strong>${escapeHTML(title)}</strong>
      <span>${escapeHTML(meta)}</span>
    </button>`;
  }).join("");

  const complete = waAssignmentsComplete(items);
  const assignedCount = items.filter((item) => WA_SEGMENT_OPTIONS.includes(Number(waGeneratorState.assignments[item.key]))).length;
  const isMnctvTemplate = group.template === "mnctv";
  selectedTitle.textContent = isMnctvTemplate ? "MNCTV · Semua Program" : group.program;
  selectedMeta.textContent = isMnctvTemplate
    ? `${unique(group.plots.map((plot) => plot.program)).length} program · ${formatMnctvWaDate(state.operationDate)} · ${items.length} spot`
    : `${group.unit} · ${formatWaDate(state.operationDate)} · ${items.length} spot`;
  hint.textContent = complete
    ? `Semua ${items.length} spot sudah ditempatkan pada segment.${isMnctvTemplate ? " Pesan MNCTV akan digabung dalam satu chat." : ""}`
    : `${assignedCount} dari ${items.length} spot sudah ditempatkan. Pilih Segment 1 sampai Segment 5 untuk setiap spot.`;

  assignmentList.innerHTML = items.map((item) => {
    const selectedSegment = Number(waGeneratorState.assignments[item.key]) || "";
    const options = [`<option value="">Pilih segment</option>`, ...WA_SEGMENT_OPTIONS.map((segment) => `<option value="${segment}" ${selectedSegment === segment ? "selected" : ""}>Segment ${segment}</option>`)].join("");
    const assignmentTitle = isMnctvTemplate
      ? `${item.plot.program} · ${item.plot.brand}`
      : item.plot.brand;
    const assignmentMeta = isMnctvTemplate
      ? `${formatMnctvWaFormat(item.plot.format)} · ${formatMnctvWaMaterial(item.plot)} · Spot ${item.spotIndex} dari ${item.spotTotal}`
      : `${formatWaFormat(item.plot.format)} · Durasi ${formatWaDuration(item.plot.duration)} · Spot ${item.spotIndex} dari ${item.spotTotal}`;
    return `<article class="wa-assignment-item">
      <div class="wa-assignment-detail">
        <strong>${escapeHTML(assignmentTitle)}</strong>
        <span>${escapeHTML(assignmentMeta)}</span>
      </div>
      <label>Segment<select class="wa-segment-select" data-wa-spot-key="${encodeURIComponent(item.key)}" aria-label="Pilih segment untuk ${escapeHTML(item.plot.brand)} spot ${item.spotIndex}">${options}</select></label>
    </article>`;
  }).join("");

  preview.textContent = complete
    ? buildWaMessage(group)
    : "Pilih segment untuk seluruh spot terlebih dahulu. Preview pesan WhatsApp akan muncul setelah semua spot sudah ditempatkan.";
  copyButton.disabled = !complete;
  openButton.disabled = !complete;
  resetButton.disabled = !assignedCount;
}

async function copyWaMessage() {
  const group = getSelectedWaGroup();
  const message = buildWaMessage(group);
  if (!message) {
    showToast("Pilih segment untuk seluruh spot sebelum menyalin pesan.");
    return;
  }
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(message);
    } else {
      const field = document.createElement("textarea");
      field.value = message;
      field.setAttribute("readonly", "");
      field.style.position = "fixed";
      field.style.opacity = "0";
      document.body.appendChild(field);
      field.select();
      document.execCommand("copy");
      field.remove();
    }
    showToast("Teks WhatsApp sudah disalin.");
  } catch (error) {
    console.error("Gagal menyalin teks WhatsApp.", error);
    showToast("Teks belum dapat disalin. Coba salin langsung dari preview.");
  }
}

function openWaMessage() {
  const group = getSelectedWaGroup();
  const message = buildWaMessage(group);
  if (!message) {
    showToast("Pilih segment untuk seluruh spot sebelum membuka WhatsApp.");
    return;
  }
  window.open(`https://wa.me/?text=${encodeURIComponent(message)}`, "_blank", "noopener");
}

function resetWaSegments() {
  const group = getSelectedWaGroup();
  getWaSpotItems(group).forEach((item) => delete waGeneratorState.assignments[item.key]);
  renderWaGenerator();
}


function compactFullTimelineRows(dailyPlots) {
  return Object.values((dailyPlots || []).reduce((groups, plot) => {
    const key = [plot.unit, plot.brand, plot.program, plot.airingStatus].map((value) => String(value || "").trim()).join("::");
    if (!groups[key]) {
      groups[key] = {
        unit: plot.unit,
        brand: plot.brand,
        program: plot.program,
        airingStatus: plot.airingStatus,
        firstId: plot.id,
        spot: 0,
        count: 0,
        hasAlert: false,
        isFinal: true
      };
    }
    groups[key].spot += Number(plot.spot || 0);
    groups[key].count += 1;
    groups[key].hasAlert = groups[key].hasAlert || isAlertSpot(plot.spot, plot.airingStatus);
    groups[key].isFinal = groups[key].isFinal && isFinalAiringStatus(plot.airingStatus);
    return groups;
  }, {})).sort((a, b) => {
    const alertOrder = Number(b.hasAlert) - Number(a.hasAlert);
    return unitSortIndex(a.unit) - unitSortIndex(b.unit) ||
      String(a.unit || "").localeCompare(String(b.unit || ""), "id") ||
      String(a.program || "").localeCompare(String(b.program || ""), "id") ||
      String(a.brand || "").localeCompare(String(b.brand || ""), "id") ||
      alertOrder ||
      String(a.airingStatus || "").localeCompare(String(b.airingStatus || ""), "id");
  });
}

function mobileCalendarStatusClass(plot) {
  if (isInactiveAiringStatus(plot?.airingStatus) || isZeroSpot(plot?.spot)) return "is-alert";
  if (isCompletedAiringStatus(plot?.airingStatus)) return "is-complete";
  if (String(plot?.airingStatus || "").toLowerCase().includes("siap")) return "is-ready";
  return "is-planned";
}

function mobileMonthCalendarMarkup({ month, daysInMonth, startOffset, eventsByDate, scope, renderItems }) {
  const dates = Array.from({ length: daysInMonth }, (_, index) => `${month}-${String(index + 1).padStart(2, "0")}`);
  const activeDates = dates.filter((date) => (eventsByDate[date] || []).length);
  const savedSelection = mobileCalendarSelections[scope];
  const selectedDate = dates.includes(savedSelection)
    ? savedSelection
    : dates.includes(state.operationDate)
      ? state.operationDate
      : activeDates[0] || dates[0] || "";
  mobileCalendarSelections[scope] = selectedDate;

  const cells = [];
  for (let index = 0; index < startOffset; index += 1) cells.push('<span class="mobile-month-day is-empty" aria-hidden="true"></span>');
  dates.forEach((date, index) => {
    const events = eventsByDate[date] || [];
    const isToday = date === state.operationDate;
    const isSelected = date === selectedDate;
    const isComplete = allSchedulesFinal(events);
    const hasAlert = events.some((plot) => isAlertSpot(plot.spot, plot.airingStatus));
    const stateClass = [
      isToday ? "is-today" : "",
      isSelected ? "is-selected" : "",
      isComplete ? "is-complete" : "",
      hasAlert ? "has-alert" : "",
      events.length ? "has-events" : ""
    ].filter(Boolean).join(" ");
    const dots = events.slice(0, 3).map((plot) => `<i class="mobile-month-dot ${mobileCalendarStatusClass(plot)}"></i>`).join("");
    cells.push(`<button class="mobile-month-day ${stateClass}" type="button" data-mobile-calendar-scope="${escapeHTML(scope)}" data-mobile-calendar-date="${escapeHTML(date)}" aria-pressed="${String(isSelected)}" aria-label="${escapeHTML(`${formatDate(date, { weekday: "long", day: "numeric", month: "long" })}${events.length ? `, ${events.length} jadwal` : ", tidak ada jadwal"}`)}">
      <span class="mobile-month-day-number">${index + 1}</span>
      <span class="mobile-month-day-count">${events.length || ""}</span>
      <span class="mobile-month-dots">${dots}</span>
    </button>`);
  });
  const remainder = cells.length % 7;
  if (remainder) for (let index = remainder; index < 7; index += 1) cells.push('<span class="mobile-month-day is-empty" aria-hidden="true"></span>');

  const selectedEvents = eventsByDate[selectedDate] || [];
  const selectedSpot = sum(selectedEvents.map((plot) => plot.spot));
  const agenda = selectedEvents.length
    ? `<section class="mobile-agenda-day is-selected-agenda" id="mobile-${scope}-selected-date">
        <header class="mobile-agenda-day-head">
          <div><span>${escapeHTML(formatDate(selectedDate, { weekday: "long" }))}</span><strong>${escapeHTML(formatDate(selectedDate, { day: "2-digit", month: "long" }))}</strong></div>
          <small>${selectedEvents.length} jadwal · ${selectedSpot} spot</small>
        </header>
        <div class="mobile-agenda-list">${renderItems(selectedEvents, selectedDate)}</div>
      </section>`
    : `<section class="mobile-agenda-day is-selected-agenda">
        <header class="mobile-agenda-day-head">
          <div><span>${escapeHTML(formatDate(selectedDate, { weekday: "long" }))}</span><strong>${escapeHTML(formatDate(selectedDate, { day: "2-digit", month: "long" }))}</strong></div>
          <small>0 jadwal · 0 spot</small>
        </header>
        <div class="mobile-calendar-empty">Tidak ada jadwal pada tanggal yang dipilih.</div>
      </section>`;

  return `<div class="mobile-calendar-app">
    <div class="mobile-month-card">
      <div class="mobile-month-title"><strong>${escapeHTML(formatMonth(month))}</strong><span>Pilih tanggal untuk melihat spot</span></div>
      <div class="mobile-month-weekdays"><span>Sen</span><span>Sel</span><span>Rab</span><span>Kam</span><span>Jum</span><span>Sab</span><span>Min</span></div>
      <div class="mobile-month-grid">${cells.join("")}</div>
    </div>
    <div class="mobile-calendar-agenda">${agenda}</div>
  </div>`;
}

function renderFullTimeline() {
  const month = monthKeyFromPeriod(filters.full.year, filters.full.month) || monthKey(state.operationDate);
  const selectedUnit = filters.full.unit;
  const selectedBrand = filters.full.brand;
  const selectedMonthPlots = sortByDate(state.plotings.filter((plot) => monthKey(plot.planAiring) === month));
  const plots = selectedMonthPlots.filter((plot) =>
    (!selectedUnit || plot.unit === selectedUnit) && (!selectedBrand || plot.brand === selectedBrand)
  );

  const [year, monthNumber] = String(month || monthKey(state.operationDate)).split("-").map(Number);
  const daysInMonth = Number.isInteger(year) && Number.isInteger(monthNumber) ? new Date(year, monthNumber, 0).getDate() : 0;
  const firstWeekday = daysInMonth ? (new Date(year, monthNumber - 1, 1).getDay() + 6) % 7 : 0;
  const totalCells = Math.ceil((firstWeekday + daysInMonth) / 7) * 7;
  const dates = Array.from({ length: daysInMonth }, (_, index) => `${month}-${String(index + 1).padStart(2, "0")}`);
  const activeUnits = selectedUnit ? [selectedUnit] : sortText(unique(plots.map((plot) => plot.unit)));

  const metrics = [
    ["Total Program", unique(plots.map((plot) => plot.program)).length, "Program pada periode"],
    ["Total spot", sum(plots.map((plot) => plot.spot)), "Akumulasi semua unit"],
    ["Unit On Air", activeUnits.length, "Unit dengan penayangan"],
    ["Brand", unique(plots.map((plot) => plot.brand)).length, "Brand pada timeline"]
  ];
  $("#fullTimelineKpis").innerHTML = metrics.map(([label, value, note]) => `<article class="mini-kpi"><p>${label}</p><strong>${value}</strong><small>${note}</small></article>`).join("");

  const scope = [selectedUnit || "Semua unit", selectedBrand || "Semua brand"].join(" · ");
  $("#fullTimelineTitle").textContent = `Kalender ${formatMonth(month)}`;
  $("#fullTimelineCaption").textContent = `${scope} · ${plots.length} jadwal · ${sum(plots.map((plot) => plot.spot))} spot`;

  const eventsByDate = plots.reduce((acc, plot) => {
    (acc[plot.planAiring] ||= []).push(plot);
    return acc;
  }, {});

  const calendarCells = Array.from({ length: totalCells }, (_, index) => {
    const dateIndex = index - firstWeekday;
    if (dateIndex < 0 || dateIndex >= daysInMonth) {
      return `<div class="full-calendar-day full-calendar-muted" aria-hidden="true"></div>`;
    }

    const date = dates[dateIndex];
    const dailyPlots = sortByUnitThenProgram(eventsByDate[date] || []);
    const dailySpot = sum(dailyPlots.map((plot) => plot.spot));
    const weekday = new Date(`${date}T00:00:00`).getDay();
    const weekend = weekday === 0 || weekday === 6 ? " full-calendar-weekend" : "";
    const isToday = date === state.operationDate ? " full-calendar-today" : "";
    const isPast = date < state.operationDate;
    const isComplete = allSchedulesFinal(dailyPlots);
    const dayState = `${isPast ? " full-calendar-past" : ""}${isComplete ? " full-calendar-complete" : ""}`;
    const compactDailyRows = compactFullTimelineRows(dailyPlots);

    const eventMarkup = compactDailyRows.length
      ? `<div class="full-calendar-events full-calendar-events-all full-calendar-events-compact-visible">${compactDailyRows.map((item) => `<button class="full-calendar-event full-calendar-event-grid full-calendar-event-row ${item.hasAlert ? "is-zero-spot" : ""}${item.isFinal ? " is-complete" : ""}${isCompletedAiringStatus(item.airingStatus) && !item.hasAlert ? " is-aired" : ""}" data-edit-schedule="${escapeHTML(item.firstId)}" type="button" title="${escapeHTML(`${item.unit} · ${item.brand} · ${item.program} · ${item.spot} spot · ${item.count} jadwal · ${item.airingStatus}`)}">
          <span class="full-calendar-unit">${unitLabelMarkup(item.unit, "calendar")}</span>
          <span class="full-calendar-copy"><strong title="${escapeHTML(item.brand)}">${escapeHTML(item.brand)}</strong><small title="${escapeHTML(item.program)}">${escapeHTML(item.program)}</small></span>
          <span class="full-calendar-spot ${item.hasAlert ? "spot-zero" : ""}">${item.spot}</span>
        </button>`).join("")}</div>`
      : `<span class="full-calendar-empty">Tidak ada jadwal</span>`;

    return `<div class="full-calendar-day${weekend}${isToday}${dayState}">
      <div class="full-calendar-day-head"><strong>${dateIndex + 1}</strong>${dailyPlots.length ? `<span>${dailySpot} spot</span>` : ""}</div>
      ${eventMarkup}
    </div>`;
  }).join("");

  const mobileCalendar = mobileMonthCalendarMarkup({
    month,
    daysInMonth,
    startOffset: firstWeekday,
    eventsByDate,
    scope: "full",
    renderItems: (dailyPlots) => compactFullTimelineRows(dailyPlots).map((item) => `<button class="mobile-agenda-item ${item.hasAlert ? "is-alert" : ""}${item.isFinal ? " is-complete" : ""}" data-edit-schedule="${escapeHTML(item.firstId)}" type="button">
      <span class="mobile-agenda-unit">${unitLabelMarkup(item.unit, "calendar")}</span>
      <span class="mobile-agenda-copy"><strong>${escapeHTML(item.brand)}</strong><small>${escapeHTML(item.program)} · ${escapeHTML(item.airingStatus)}</small></span>
      <span class="mobile-agenda-spot ${item.hasAlert ? "spot-zero" : ""}">${item.spot}<small>spot</small></span>
    </button>`).join("")
  });

  $("#fullTimelineCalendar").innerHTML = `<div class="desktop-calendar-grid">${calendarCells}</div>${mobileCalendar}`;

  if (!activeUnits.length) {
    $("#fullTimelineUnitSummary").innerHTML = `<div class="full-summary-empty">Tidak ada ringkasan unit pada periode ini.</div>`;
    return;
  }

  $("#fullTimelineUnitSummary").innerHTML = activeUnits.map((unit) => {
    const unitPlots = plots.filter((plot) => plot.unit === unit);
    const brandTotals = Object.entries(unitPlots.reduce((acc, plot) => {
      acc[plot.brand] = (acc[plot.brand] || 0) + Number(plot.spot || 0);
      return acc;
    }, {})).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "id"));

    return `<article class="full-unit-summary-card">
      <div class="full-unit-summary-head"><strong>${unitLabelMarkup(unit, "summary")}</strong><span>${unitPlots.length} jadwal</span></div>
      <div class="full-brand-list">${brandTotals.map(([brand, spot]) => `<span>${escapeHTML(brand)} <b class="${isZeroSpot(spot) ? "spot-zero" : ""}">${spot}</b></span>`).join("")}</div>
      <div class="full-unit-total"><strong>${sum(unitPlots.map((plot) => plot.spot))}</strong><span>total spot</span></div>
    </article>`;
  }).join("");
}
function renderBrand() {
  const brand = filters.brand.brand;
  const month = monthKeyFromPeriod(filters.brand.year, filters.brand.month) || monthKey(state.operationDate);
  const unit = filters.brand.unit;
  const program = filters.brand.program;
  const format = filters.brand.format;
  const plots = sortByDate(state.plotings.filter((plot) => (
    plot.brand === brand &&
    monthKey(plot.planAiring) === month &&
    (!unit || plot.unit === unit) &&
    (!program || plot.program === program) &&
    (!format || plot.format === format)
  )));
  const titleParts = [brand, formatMonth(month), unit, program, format].filter(Boolean);
  $("#brandCalendarTitle").textContent = brand ? titleParts.join(" · ") : "Pilih brand";
  const detailPrograms = unique(plots.map((plot) => plot.program));
  const detailProgramLabel = program || (detailPrograms.length === 1 ? detailPrograms[0] : "Semua Program");
  const detailProgramTitle = detailProgramLabel === "Semua Program" ? detailProgramLabel : formatBrandName(detailProgramLabel);
  const detailTitle = brand
    ? `Benefit Virtual Ads ${brand} ${formatMonth(month)}${detailProgramTitle ? ` - ${detailProgramTitle}` : ""}`
    : "Benefit Virtual Ads";
  const detailTitleElement = $("#brandDetailSnapshotTitle");
  if (detailTitleElement) detailTitleElement.textContent = detailTitle;
  const stats = [
    ["Total Program", unique(plots.map((plot) => plot.program)).length, "Program pada periode"],
    ["Total spot", sum(plots.map((plot) => plot.spot)), "Periode terpilih"],
    ["Unit", unique(plots.map((plot) => plot.unit)).length, "Unit on air"],
    ["Tanggal Tayang", unique(plots.map((plot) => plot.planAiring)).length, "Tanggal aktif"]
  ];
  $("#brandStats").innerHTML = stats.map(([label, value, note]) => `<article class="mini-kpi"><p>${label}</p><strong>${value}</strong><small>${note}</small></article>`).join("");
  renderCalendar(month, plots);
  const totalSpot = sum(plots.map((plot) => plot.spot));
  $("#brandTotalSpot").textContent = `${totalSpot} spot`;
  const snapshotButton = $("#snapshotBrandDetailButton");
  if (snapshotButton) {
    snapshotButton.disabled = !plots.length;
    snapshotButton.title = plots.length
      ? "Simpan seluruh tabel Detail Brand sebagai gambar PNG"
      : "Pilih brand dan periode dengan jadwal terlebih dahulu";
  }
  $("#brandDetailBody").innerHTML = plots.length ? plots.map((plot) => `<tr>
    <td>${formatDate(plot.planAiring)}</td>
    <td><span class="cell-title cell-title-unit">${unitLabelMarkup(plot.unit, "table")}<span class="unit-program-separator" aria-hidden="true">·</span><span class="unit-program-name">${escapeHTML(plot.program)}</span></span><span class="cell-subtitle">${escapeHTML(plot.pod)} · ${escapeHTML(plot.segmentation || "Tanpa segmentasi")}</span></td>
    <td><span class="cell-title">${escapeHTML(plot.format)} · ${escapeHTML(plot.duration)}</span><span class="cell-subtitle">${escapeHTML(plot.version)}</span></td>
    <td>${plotSpotMarkup(plot)}</td>
    <td>${escapeHTML(plot.gfx)}</td>
    <td>${badge(plot.airingStatus)}</td>
    <td class="schedule-note-cell" title="${escapeHTML(plot.scheduleNote || "-")}">${plot.scheduleNote ? `<span class="schedule-note-text">${escapeHTML(plot.scheduleNote)}</span>` : `<span class="empty-note">-</span>`}</td>
    <td><button class="row-action" data-edit-schedule="${escapeHTML(plot.id)}" type="button">Atur Jadwal</button></td>
  </tr>`).join("") : `<tr><td colspan="8" class="empty-row">Tidak ada jadwal untuk brand dan periode ini.</td></tr>`;
}

function renderCalendar(month, plots) {
  const container = $("#brandCalendar");
  if (!month) { container.innerHTML = `<div class="empty-row">Pilih brand dan bulan terlebih dahulu.</div>`; return; }
  const [year, monthNumber] = month.split("-").map(Number);
  const first = new Date(year, monthNumber - 1, 1);
  const daysInMonth = new Date(year, monthNumber, 0).getDate();
  const startOffset = (first.getDay() + 6) % 7;
  const eventMap = plots.reduce((acc, plot) => { (acc[plot.planAiring] ||= []).push(plot); return acc; }, {});
  const cells = [];
  for (let index = 0; index < startOffset; index += 1) cells.push(`<div class="calendar-day muted-day"></div>`);
  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = `${month}-${String(day).padStart(2, "0")}`;
    const events = eventMap[date] || [];
    const todayClass = date === state.operationDate ? "today-day" : "";
    const isPast = date < state.operationDate;
    const isComplete = allSchedulesFinal(events);
    const dayClasses = [
      "calendar-day",
      todayClass,
      isPast ? "calendar-day--past" : "",
      isComplete ? "calendar-day--complete" : ""
    ].filter(Boolean).join(" ");
    cells.push(`<div class="${dayClasses}"><div class="calendar-day-number">${day}</div>${events.slice(0, 3).map((plot) => `<button class="calendar-event ${isFinalAiringStatus(plot.airingStatus) ? "calendar-event--complete" : ""}" data-edit-schedule="${escapeHTML(plot.id)}" type="button" title="${escapeHTML(`${plot.unit} · ${plot.program} · ${plot.spot} spot · ${plot.airingStatus}`)}"><span class="brand-calendar-unit-row">${unitLabelMarkup(plot.unit, "calendar")}</span><span class="calendar-program-title">${escapeHTML(plot.program)}</span><small class="brand-calendar-spot-row ${spotClass(plot.spot, plot.airingStatus)}">${plot.spot} spot</small></button>`).join("")}${events.length > 3 ? `<div class="calendar-more">+${events.length - 3} jadwal</div>` : ""}</div>`);
  }
  const remainder = cells.length % 7;
  if (remainder) for (let index = remainder; index < 7; index += 1) cells.push(`<div class="calendar-day muted-day"></div>`);

  const mobileCalendar = mobileMonthCalendarMarkup({
    month,
    daysInMonth,
    startOffset,
    eventsByDate: eventMap,
    scope: "brand",
    renderItems: (events) => sortByUnitThenProgram(events).map((plot) => `<button class="mobile-agenda-item ${mobileCalendarStatusClass(plot)}" data-edit-schedule="${escapeHTML(plot.id)}" type="button">
      <span class="mobile-agenda-unit">${unitLabelMarkup(plot.unit, "calendar")}</span>
      <span class="mobile-agenda-copy"><strong>${escapeHTML(plot.program)}</strong><small>${escapeHTML(plot.format)} · ${escapeHTML(plot.duration)} · ${escapeHTML(plot.airingStatus)}</small></span>
      <span class="mobile-agenda-spot ${spotClass(plot.spot, plot.airingStatus)}">${Number(plot.spot)}<small>spot</small></span>
    </button>`).join("")
  });

  container.innerHTML = `<div class="desktop-calendar-grid">${cells.join("")}</div>${mobileCalendar}`;
}

function syncMobilePicReportSections() {
  const mobile = isMobileAppLayout();
  $$('[data-mobile-report-section]').forEach((section) => {
    const key = section.dataset.mobileReportSection;
    section.classList.toggle("is-open", !mobile || Boolean(mobilePicReportState.sections[key]));
  });
  $$('[data-mobile-report-toggle]').forEach((button) => {
    const key = button.dataset.mobileReportToggle;
    const open = !mobile || Boolean(mobilePicReportState.sections[key]);
    button.classList.toggle("is-open", open);
    button.setAttribute("aria-expanded", String(open));
  });
}

function renderPicReport() {
  const mobileReport = isMobileAppLayout();
  const selectedPic = filters.pic.pic;
  const selectedYear = filters.pic.year;
  const selectedQuarter = filters.pic.quarter;
  const periodPlots = sortByDate(state.plotings.filter((plot) => matchesQuarter(plot.planAiring, selectedYear, selectedQuarter)));
  const selectedPlots = periodPlots.filter((plot) => !selectedPic || plot.pic === selectedPic);
  const selectedLabel = selectedPic || "Semua PIC";
  const periodLabel = formatQuarter(selectedYear, selectedQuarter);

  const metrics = [
    ["Spot tayang", completedSpotSum(selectedPlots), "Status On air/Sudah tayang"],
    ["Jadwal tayang", selectedPlots.length, "Tanggal terploting"],
    ["Total spot", sum(selectedPlots.map((plot) => plot.spot)), "Akumulasi spot"],
    ["Brand ditangani", unique(selectedPlots.map((plot) => plot.brand)).length, "Brand pada periode ini"],
    ["Program ditangani", unique(selectedPlots.map((plot) => plot.program)).length, "Program pada periode ini"]
  ];
  $("#picReportKpis").innerHTML = metrics.map(([label, value, note]) => `<article class="mini-kpi"><p>${label}</p><strong>${value}</strong><small>${note}</small></article>`).join("");

  const picNames = sortText(unique(periodPlots.map((plot) => plot.pic)));
  $("#picOverviewCaption").textContent = periodLabel;
  $("#picOverviewBody").innerHTML = picNames.length ? picNames.map((pic) => {
    const plots = periodPlots.filter((plot) => plot.pic === pic);
    return `<tr class="${pic === selectedPic ? "selected-pic-row" : ""}">
      <td><span class="pic-chip">${escapeHTML(pic)}</span></td>
      <td><strong>${completedSpotSum(plots)}</strong></td>
      <td>${plots.length}</td>
      <td><strong>${sum(plots.map((plot) => plot.spot))}</strong></td>
      <td>${unique(plots.map((plot) => plot.brand)).length}</td>
      <td>${unique(plots.map((plot) => plot.program)).length}</td>
      <td><button class="row-action" data-select-pic="${encodeURIComponent(pic)}" type="button">Lihat</button></td>
    </tr>`;
  }).join("") : `<tr><td colspan="7" class="empty-row">Belum ada ploting pada periode ini.</td></tr>`;

  $("#picScopeTitle").textContent = `${selectedLabel} · ${periodLabel}`;
  const summarizeScope = (field) => Object.entries(selectedPlots.reduce((acc, plot) => {
    const value = normalizeWhitespace(plot[field]) || "-";
    (acc[value] ||= []).push(plot);
    return acc;
  }, {})).map(([value, plots]) => ({
    value,
    count: plots.length,
    spot: sum(plots.map((plot) => plot.spot))
  })).sort((first, second) => second.count - first.count || second.spot - first.spot || first.value.localeCompare(second.value, "id"));

  const scopeGroups = [
    { label: "Brand yang ditangani", items: summarizeScope("brand"), type: "text" },
    { label: "Program yang ditangani", items: summarizeScope("program"), type: "text" },
    { label: "Unit On Air", items: summarizeScope("unit"), type: "unit" }
  ];
  const scopeMarkup = scopeGroups.map((group) => {
    const visibleItems = mobileReport ? group.items.slice(0, 6) : group.items;
    const remaining = Math.max(0, group.items.length - visibleItems.length);
    return `<article class="pic-scope-group">
      <div class="pic-scope-group-head"><strong>${escapeHTML(group.label)}</strong><span>${group.items.length} item</span></div>
      <div class="pic-scope-chip-grid">${visibleItems.map((item) => `<span class="pic-scope-chip">${group.type === "unit" ? unitLabelMarkup(item.value, "summary") : `<b title="${escapeHTML(item.value)}">${escapeHTML(item.value)}</b>`}<small>${item.count} jadwal · ${item.spot} spot</small></span>`).join("")}${remaining ? `<span class="pic-scope-more">+${remaining} lainnya</span>` : ""}</div>
    </article>`;
  }).join("");
  $("#picScopeList").innerHTML = selectedPlots.length ? scopeMarkup : `<div class="pic-scope-empty">Belum ada data untuk PIC dan kuartal yang dipilih.</div>`;

  $("#picDetailTitle").textContent = `Jadwal ${selectedLabel}`;
  $("#picDetailCaption").textContent = `${selectedPlots.length} jadwal · ${sum(selectedPlots.map((plot) => plot.spot))} spot · ${periodLabel}`;
  const mobileDetailCaption = $("#mobilePicDetailToggleCaption");
  if (mobileDetailCaption) mobileDetailCaption.textContent = `${selectedPlots.length} jadwal · ${sum(selectedPlots.map((plot) => plot.spot))} spot`;
  const visibleDetailPlots = mobileReport ? selectedPlots.slice(0, mobilePicReportState.detailLimit) : selectedPlots;
  $("#picDetailBody").innerHTML = visibleDetailPlots.length ? visibleDetailPlots.map((plot) => `<tr>
    <td>${formatDate(plot.planAiring)}</td>
    <td><span class="cell-title">${escapeHTML(plot.batchId)}</span><span class="cell-subtitle">${escapeHTML(plot.pic)}</span></td>
    <td><span class="cell-title">${escapeHTML(plot.brand)}</span><span class="cell-subtitle">${escapeHTML(plot.advertiser)}</span></td>
    <td><span class="cell-title cell-title-unit">${unitLabelMarkup(plot.unit, "table")}<span class="unit-program-separator" aria-hidden="true">·</span><span class="unit-program-name">${escapeHTML(plot.program)}</span></span><span class="cell-subtitle">${escapeHTML(plot.pod)} · ${escapeHTML(plot.segmentation || "Tanpa segmentasi")}</span></td>
    <td><span class="cell-title">${escapeHTML(plot.format)} · ${escapeHTML(plot.duration)}</span><span class="cell-subtitle">${escapeHTML(plot.version)}</span></td>
    <td>${plotSpotMarkup(plot)}</td>
    <td>${badge(plot.airingStatus)}</td>
    <td><button class="row-action" data-edit-schedule="${escapeHTML(plot.id)}" type="button">Atur Jadwal</button></td>
  </tr>`).join("") : `<tr><td colspan="8" class="empty-row">Tidak ada jadwal untuk PIC dan periode ini.</td></tr>`;
  const detailMore = $("#mobilePicDetailMore");
  if (detailMore) {
    const remaining = Math.max(0, selectedPlots.length - visibleDetailPlots.length);
    detailMore.innerHTML = mobileReport && remaining
      ? `<button class="secondary-button mobile-report-more-button" data-mobile-report-more type="button">Tampilkan ${Math.min(8, remaining)} jadwal berikutnya <span>${visibleDetailPlots.length}/${selectedPlots.length}</span></button>`
      : "";
  }
  syncMobilePicReportSections();
}

function renderMasters() {
  const summary = Object.entries(MASTER_META).map(([key, meta]) => `<div class="summary-tile"><strong>${state.masters[key].length}</strong><span>${escapeHTML(meta.label)}</span></div>`).join("");
  $("#masterSummary").innerHTML = summary;
  $("#masterGrid").innerHTML = Object.entries(MASTER_META).map(([key, meta]) => `<article class="panel master-card"><div class="master-card-head"><div><p class="section-label">MASTER</p><h4>${escapeHTML(meta.label)}</h4></div><span>${state.masters[key].length} item</span></div><div class="master-list">${state.masters[key].map((value) => `<div class="master-list-item"><span>${escapeHTML(value)}</span><button class="master-delete" data-master-delete="${key}" data-master-value="${encodeURIComponent(value)}" type="button">Hapus</button></div>`).join("")}</div></article>`).join("");
}

function renderActiveView() {
  const renderers = {
    dashboard: renderDashboard,
    plotings: renderPlotings,
    batches: renderBatches,
    daily: renderDaily,
    wagenerator: renderWaGenerator,
    fulltimeline: renderFullTimeline,
    brand: renderBrand,
    picreport: renderPicReport,
    masters: renderMasters,
    auditlog: renderAuditLog
  };
  renderers[activeView]?.();
}

function renderAll() {
  document.body.dataset.activeView = activeView;
  // Saat dashboard dibuka pertama kali, jangan isi semua filter halaman tersembunyi.
  // Dropdown besar seperti brand, PIC, program, dan format baru dibuat saat halamannya dibuka.
  if (!["dashboard", "guide", "auditlog"].includes(activeView)) populateSelects();
  $("#operationDate").value = state.operationDate;
  renderActiveView();
  renderCurrentPicOverdueReminderCard();
  updateTeamChatBadges();
  renderIncomingTeamReminderModal();
  updatePageTitle();
  updateNavState(activeView);
  queueMobileTableEnhancement();
}

function updatePageTitle() {
  const labels = {
    dashboard: ["OPERATIONS DASHBOARD", "Dashboard"],
    plotings: ["2026 VA DIGITAL", "Master Ploting VA"],
    batches: ["KELOLA BATCH", "Batch Ploting"],
    daily: ["PIVOT MASTER", "Timeline Harian"],
    wagenerator: ["SHARE OPERASIONAL", "Generator Pesan WhatsApp"],
    fulltimeline: ["TIMELINE BULANAN", "Kalender Full"],
    brand: ["TIMELINE BRAND", "Timeline Brand"],
    picreport: ["MONITORING PIC", "Report per PIC"],
    masters: ["DATABASE PILIHAN", "Master Data"],
    auditlog: ["RIWAYAT AKTIVITAS", "Audit Log"],
    guide: ["PANDUAN OPERASIONAL", "Alur Kerja"]
  };
  const [eyebrow, title] = labels[activeView] || labels.dashboard;
  $("#pageEyebrow").textContent = eyebrow;
  $("#pageTitle").textContent = title;
  document.title = `${title} | VA Benefit Ploting`;
}

function setNavGroupOpen(group, open) {
  if (!group) return;
  const toggle = group.querySelector(".nav-group-toggle");
  const submenu = group.querySelector(".nav-submenu");
  group.classList.toggle("is-open", open);
  if (toggle) toggle.setAttribute("aria-expanded", String(open));
  if (submenu) submenu.hidden = !open;
}

const MOBILE_BOTTOM_VIEWS = new Set(["dashboard", "daily", "fulltimeline"]);
let mobileTableEnhanceQueued = false;
let mobileTableObserver = null;

function setMobileMenuOpen(open) {
  const sheet = $("#mobileMenuSheet");
  const backdrop = $("#mobileMenuBackdrop");
  const trigger = $("#mobileMoreButton");
  if (!sheet || !backdrop || !trigger) return;
  sheet.classList.toggle("is-open", open);
  backdrop.classList.toggle("is-open", open);
  sheet.setAttribute("aria-hidden", String(!open));
  backdrop.setAttribute("aria-hidden", String(!open));
  trigger.setAttribute("aria-expanded", String(open));
  document.body.classList.toggle("mobile-menu-open", open);
}

function updateMobileNavState(view = activeView) {
  $$(".mobile-bottom-item[data-mobile-view]").forEach((button) => {
    const active = button.dataset.mobileView === view;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-current", active ? "page" : "false");
  });
  $$(".mobile-menu-item[data-mobile-view]").forEach((button) => {
    const active = button.dataset.mobileView === view;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-current", active ? "page" : "false");
  });
  const moreButton = $("#mobileMoreButton");
  if (moreButton) moreButton.classList.toggle("is-active", !MOBILE_BOTTOM_VIEWS.has(view));
}

function updateNavState(view = activeView) {
  $$(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  $$(".nav-group").forEach((group) => {
    const hasActiveChild = Array.from(group.querySelectorAll(".nav-item")).some((button) => button.dataset.view === view);
    group.classList.toggle("is-active", hasActiveChild);
  });
  updateMobileNavState(view);
}

function mobileTablePrimaryIndex(table, headers) {
  const classRules = [
    ["plotings-table", 1],
    ["batch-table", 1],
    ["brand-detail-table", 1],
    ["pic-overview-table", 0],
    ["pic-detail-table", 2],
    ["audit-log-table", 3]
  ];
  const matchedRule = classRules.find(([className]) => table.classList.contains(className));
  if (matchedRule) return matchedRule[1];
  const priorities = ["Program / Brand", "PT / Brand", "Brand", "Unit / Program", "PIC", "Batch"];
  const priorityIndex = priorities.map((label) => headers.findIndex((header) => header === label)).find((index) => index >= 0);
  return priorityIndex >= 0 ? priorityIndex : 0;
}

function enhanceMobileTables() {
  mobileTableEnhanceQueued = false;
  $$("table.data-table, table.compact-table").forEach((table) => {
    if (table.classList.contains("schedule-table")) return;
    // Dashboard today's schedule uses a dedicated compact list on mobile.
    // Do not apply the generic mobile table-card transformation here.
    if (table.classList.contains("dashboard-today-table") || table.closest("#dashboardView")) {
      table.classList.remove("mobile-card-table");
      table.querySelectorAll("tbody td, tfoot td").forEach((cell) => {
        delete cell.dataset.label;
        cell.classList.remove("mobile-card-primary", "mobile-card-meta", "mobile-card-compact", "mobile-card-action", "mobile-card-full");
      });
      return;
    }
    table.classList.add("mobile-card-table");
    const headers = Array.from(table.querySelectorAll("thead th")).map((cell) => normalizeWhitespace(cell.textContent));
    const primaryIndex = mobileTablePrimaryIndex(table, headers);
    table.querySelectorAll("tbody tr, tfoot tr").forEach((row) => {
      const cells = Array.from(row.children).filter((cell) => cell.tagName === "TD");
      row.classList.toggle("mobile-card-row", cells.length > 0);
      cells.forEach((cell, index) => {
        const isSpanning = Number(cell.colSpan || 1) > 1;
        const label = isSpanning ? "" : (headers[index] || "Detail");
        cell.dataset.label = label;
        cell.classList.remove("mobile-card-primary", "mobile-card-meta", "mobile-card-compact", "mobile-card-action", "mobile-card-full");
        if (isSpanning) cell.classList.add("mobile-card-full");
        if (!isSpanning && index === primaryIndex) cell.classList.add("mobile-card-primary");
        if (!isSpanning && /tanggal|batch/i.test(label) && index !== primaryIndex) cell.classList.add("mobile-card-meta");
        if (!isSpanning && /spot|status|tayang|jadwal|unit$/i.test(label)) cell.classList.add("mobile-card-compact");
        if (cell.querySelector("button") && (!label || index === cells.length - 1)) cell.classList.add("mobile-card-action");
      });
    });
  });
}

function queueMobileTableEnhancement() {
  if (mobileTableEnhanceQueued) return;
  mobileTableEnhanceQueued = true;
  window.requestAnimationFrame(enhanceMobileTables);
}

function initializeMobileTableObserver() {
  const main = $(".main-content");
  if (!main || mobileTableObserver) return;
  mobileTableObserver = new MutationObserver(queueMobileTableEnhancement);
  mobileTableObserver.observe(main, { childList: true, subtree: true });
  queueMobileTableEnhancement();
}

function createMobileFilterToggle(shell, label = "Filter") {
  if (!shell || shell.querySelector(":scope > [data-mobile-filter-toggle]")) return;
  shell.classList.add("mobile-filter-shell");
  const button = document.createElement("button");
  button.className = "mobile-filter-toggle";
  button.type = "button";
  button.dataset.mobileFilterToggle = "";
  button.setAttribute("aria-expanded", "false");
  button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M7 12h10M10 18h4"></path></svg><span>${escapeHTML(label)}</span><b aria-hidden="true">⌄</b>`;
  shell.prepend(button);
}

function initializeMobileFilterShells() {
  const plotToolbar = $("#plotingsView .toolbar-plotings");
  const batchToolbar = $("#batchesView .toolbar-batches");
  if (plotToolbar) plotToolbar.dataset.mobileFilterKind = "toolbar";
  if (batchToolbar) batchToolbar.dataset.mobileFilterKind = "toolbar";
  createMobileFilterToggle(plotToolbar, "Filter ploting");
  createMobileFilterToggle(batchToolbar, "Filter batch");

  [$("#fullTimelineView .filter-panel"), $("#brandView .filter-panel")].forEach((panel) => {
    if (!panel) return;
    panel.dataset.mobileFilterKind = "panel";
    createMobileFilterToggle(panel, "Tampilkan filter");
  });

  const reportActions = $("#picReportView .report-header-actions");
  if (reportActions) {
    reportActions.dataset.mobileFilterKind = "report";
    createMobileFilterToggle(reportActions, "Filter report");
  }
}

function bindMobileAppEvents() {
  $$("[data-mobile-view]").forEach((button) => {
    button.addEventListener("click", () => {
      setView(button.dataset.mobileView);
      setMobileMenuOpen(false);
    });
  });
  $("#mobileCreateButton")?.addEventListener("click", () => {
    setMobileMenuOpen(false);
    openPlotModal();
  });
  $("#mobileMoreButton")?.addEventListener("click", () => {
    const sheet = $("#mobileMenuSheet");
    setMobileMenuOpen(!sheet?.classList.contains("is-open"));
  });
  $("#mobileMenuClose")?.addEventListener("click", () => setMobileMenuOpen(false));
  $("#mobileMenuBackdrop")?.addEventListener("click", () => setMobileMenuOpen(false));
  document.addEventListener("click", (event) => {
    const toggle = event.target.closest("[data-mobile-filter-toggle]");
    if (!toggle) return;
    const shell = toggle.closest(".mobile-filter-shell");
    if (!shell) return;
    const open = !shell.classList.contains("is-open");
    shell.classList.toggle("is-open", open);
    toggle.setAttribute("aria-expanded", String(open));
    const label = toggle.querySelector("span");
    if (label) label.textContent = open ? "Tutup filter" : (shell.dataset.mobileFilterKind === "report" ? "Filter report" : shell.dataset.mobileFilterKind === "toolbar" ? "Tampilkan filter" : "Tampilkan filter");
  });
  document.addEventListener("click", (event) => {
    const dayButton = event.target.closest("[data-mobile-calendar-date]");
    if (!dayButton) return;
    const scope = dayButton.dataset.mobileCalendarScope;
    const date = dayButton.dataset.mobileCalendarDate;
    if (!scope || !date || !Object.prototype.hasOwnProperty.call(mobileCalendarSelections, scope)) return;
    mobileCalendarSelections[scope] = date;
    const scrollTop = window.scrollY;
    if (scope === "full") renderFullTimeline();
    if (scope === "brand") renderBrand();
    window.requestAnimationFrame(() => {
      window.scrollTo({ top: scrollTop, behavior: "auto" });
      document.querySelector(`#${scope === "full" ? "fullTimelineView" : "brandView"} .mobile-agenda-day`)?.classList.add("is-highlighted");
      window.setTimeout(() => document.querySelector(`#${scope === "full" ? "fullTimelineView" : "brandView"} .mobile-agenda-day`)?.classList.remove("is-highlighted"), 550);
    });
  });
}

function closeAllNavGroups(exceptGroup = null) {
  $$(".nav-group").forEach((group) => {
    if (group !== exceptGroup) setNavGroupOpen(group, false);
  });
}

function setView(view) {
  activeView = view;
  setMobileMenuOpen(false);
  document.body.dataset.activeView = view;
  closeAllNavGroups();
  updateNavState(view);
  $$("[data-view-panel]").forEach((panel) => panel.classList.toggle("active", panel.dataset.viewPanel === view));
  // Render halaman saat dibuka, bukan pada saat aplikasi pertama kali dimuat.
  if (!["dashboard", "guide", "auditlog"].includes(view)) populateSelects();
  renderActiveView();
  updatePageTitle();
  queueMobileTableEnhancement();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function resetFullTimelineFilters() {
  filters.full = { year: currentYear(), month: currentMonth(), unit: "", brand: "" };
  populateSelects();
  renderFullTimeline();
}

function resetBrandTimelineFilters() {
  const brands = sortText(unique(state.plotings.map((plot) => plot.brand)));
  filters.brand = {
    brand: brands[0] || "",
    year: currentYear(),
    month: currentMonth(),
    unit: "",
    program: "",
    format: ""
  };
  populateSelects();
  renderBrand();
}

function scheduleDatesInForm() {
  return new Set(
    $$("#scheduleRows .schedule-date-input")
      .map((input) => input.value)
      .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))
  );
}

function resetMultiDatePicker() {
  multiDatePickerState.open = false;
  multiDatePickerState.year = Number(yearFromDate(state.operationDate)) || Number(yearFromDate(DEFAULT_OPERATION_DATE));
  multiDatePickerState.month = Number(monthFromDate(state.operationDate)) || Number(monthFromDate(DEFAULT_OPERATION_DATE));
  multiDatePickerState.selectedDates = new Set();
}

function multiDatePickerMonthLabel(year, month) {
  return new Intl.DateTimeFormat("id-ID", { month: "long", year: "numeric" })
    .format(new Date(year, month - 1, 1));
}

function multiDatePickerIsoDate(year, month, day) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function renderMultiDatePicker() {
  const picker = $("#multiDatePicker");
  const toggle = $("#multiDatePickerToggle");
  if (!picker || !toggle) return;

  const { open, year, month, selectedDates } = multiDatePickerState;
  picker.hidden = !open;
  toggle.setAttribute("aria-expanded", String(open));
  toggle.innerHTML = open ? "Tutup kalender" : "▦ Pilih beberapa tanggal";

  if (!open) {
    picker.innerHTML = "";
    return;
  }

  const existingDates = scheduleDatesInForm();
  const daysInMonth = new Date(year, month, 0).getDate();
  const firstWeekday = (new Date(year, month - 1, 1).getDay() + 6) % 7;
  const totalCells = Math.ceil((firstWeekday + daysInMonth) / 7) * 7;
  const calendarCells = Array.from({ length: totalCells }, (_, index) => {
    const day = index - firstWeekday + 1;
    if (day < 1 || day > daysInMonth) {
      return '<span class="multi-date-picker-empty" aria-hidden="true"></span>';
    }

    const date = multiDatePickerIsoDate(year, month, day);
    const isExisting = existingDates.has(date);
    const isSelected = selectedDates.has(date);
    const isToday = date === state.operationDate;
    const classes = [
      "multi-date-day",
      isSelected ? "is-selected" : "",
      isExisting ? "is-existing" : "",
      isToday ? "is-operation-date" : ""
    ].filter(Boolean).join(" ");
    const label = isExisting
      ? `${formatDate(date)} sudah ada pada tabel jadwal`
      : `${isSelected ? "Batalkan pilihan" : "Pilih"} ${formatDate(date)}`;

    return `<button class="${classes}" data-multi-date-day="${date}" type="button" aria-label="${escapeHTML(label)}" aria-pressed="${isSelected}" ${isExisting ? "disabled" : ""}>${day}</button>`;
  }).join("");

  const selectedList = [...selectedDates].sort();
  const selectedSummary = selectedList.length
    ? selectedList.slice(0, 5).map((date) => `<span>${escapeHTML(formatDate(date, { day: "2-digit", month: "short" }))}</span>`).join("") + (selectedList.length > 5 ? `<span>+${selectedList.length - 5} lagi</span>` : "")
    : '<span class="multi-date-picker-none">Belum ada tanggal dipilih</span>';

  picker.innerHTML = `
    <div class="multi-date-picker-head">
      <div>
        <p class="section-label">PILIH TANGGAL</p>
        <strong>${escapeHTML(multiDatePickerMonthLabel(year, month))}</strong>
      </div>
      <div class="multi-date-picker-nav" aria-label="Navigasi bulan">
        <button class="icon-button" data-multi-date-action="previous" type="button" aria-label="Bulan sebelumnya">‹</button>
        <button class="icon-button" data-multi-date-action="next" type="button" aria-label="Bulan berikutnya">›</button>
      </div>
    </div>
    <div class="multi-date-weekdays" aria-hidden="true"><span>Sen</span><span>Sel</span><span>Rab</span><span>Kam</span><span>Jum</span><span>Sab</span><span>Min</span></div>
    <div class="multi-date-calendar" role="group" aria-label="Pilih beberapa tanggal pada ${escapeHTML(multiDatePickerMonthLabel(year, month))}">${calendarCells}</div>
    <div class="multi-date-picker-selection"><strong>${selectedList.length} tanggal dipilih</strong><div>${selectedSummary}</div></div>
    <div class="multi-date-picker-actions">
      <button class="text-button" data-multi-date-action="clear" type="button" ${selectedList.length ? "" : "disabled"}>Kosongkan pilihan</button>
      <div>
        <button class="secondary-button" data-multi-date-action="cancel" type="button">Batal</button>
        <button class="primary-button" data-multi-date-action="apply" type="button" ${selectedList.length ? "" : "disabled"}>+ Tambahkan ${selectedList.length || ""} tanggal</button>
      </div>
    </div>`;
}

function toggleMultiDatePicker() {
  multiDatePickerState.open = !multiDatePickerState.open;
  if (multiDatePickerState.open && (!Number.isInteger(multiDatePickerState.year) || !Number.isInteger(multiDatePickerState.month))) {
    multiDatePickerState.year = Number(yearFromDate(state.operationDate));
    multiDatePickerState.month = Number(monthFromDate(state.operationDate));
  }
  renderMultiDatePicker();
}

function shiftMultiDatePickerMonth(direction) {
  const next = new Date(multiDatePickerState.year, multiDatePickerState.month - 1 + direction, 1);
  multiDatePickerState.year = next.getFullYear();
  multiDatePickerState.month = next.getMonth() + 1;
  renderMultiDatePicker();
}

function toggleMultiDatePickerDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || scheduleDatesInForm().has(date)) return;
  if (multiDatePickerState.selectedDates.has(date)) multiDatePickerState.selectedDates.delete(date);
  else multiDatePickerState.selectedDates.add(date);
  renderMultiDatePicker();
}

function applyMultiDatePickerDates() {
  const existingDates = scheduleDatesInForm();
  const dates = [...multiDatePickerState.selectedDates]
    .filter((date) => !existingDates.has(date))
    .sort((first, second) => first.localeCompare(second));

  if (!dates.length) {
    showToast("Pilih minimal satu tanggal baru pada kalender.");
    return;
  }

  removeEmptyStarterScheduleRows();
  dates.forEach((date) => addScheduleRow(date, 1, "Planned", ""));
  multiDatePickerState.selectedDates = new Set();
  multiDatePickerState.open = false;
  renderMultiDatePicker();
  showToast(`${dates.length} tanggal ditambahkan ke jadwal.`);
}

function buildScheduleRow(date = state.operationDate, spot = 1, airingStatus = "Planned", scheduleNote = "") {
  // Spot 0 valid, misalnya ketika jadwal tetap dicatat tetapi tidak jadi tayang.
  const normalizedSpot = Number.isInteger(Number(spot)) && Number(spot) >= 0 ? Number(spot) : 1;
  const spotWarningClass = isAlertSpot(normalizedSpot, airingStatus) ? " zero-spot-input" : "";
  return `<tr class="schedule-row">
    <td class="schedule-card-field schedule-card-date"><label><span class="schedule-field-label">Tanggal tayang</span><input class="schedule-date-input" type="date" value="${escapeHTML(date)}" required /></label></td>
    <td class="schedule-card-field schedule-card-spot"><label><span class="schedule-field-label">Jumlah spot</span><input class="schedule-spot-input${spotWarningClass}" type="number" min="0" max="999" step="1" value="${normalizedSpot}" required /></label></td>
    <td class="schedule-card-field schedule-card-status"><label><span class="schedule-field-label">Status tayang</span><select class="schedule-status-input" required>${optionMarkup(AIRING_STATUSES, "Pilih status", airingStatus || "Planned")}</select></label></td>
    <td class="schedule-card-field schedule-card-note"><label><span class="schedule-field-label">Note tambahan</span><input class="schedule-note-input" maxlength="220" value="${escapeHTML(scheduleNote)}" placeholder="Note khusus tanggal ini" /></label></td>
    <td class="schedule-card-action"><button class="remove-schedule" data-remove-schedule type="button">Hapus jadwal</button></td>
  </tr>`;
}

function syncScheduleRowVisualState(row) {
  const spotInput = row?.querySelector(".schedule-spot-input");
  const statusInput = row?.querySelector(".schedule-status-input");
  if (!spotInput || !statusInput) return;
  spotInput.classList.toggle("zero-spot-input", isAlertSpot(Number(spotInput.value), statusInput.value));
}

function removeEmptyStarterScheduleRows() {
  $$("#scheduleRows .schedule-row").forEach((row) => {
    const date = row.querySelector(".schedule-date-input")?.value || "";
    const spot = Number(row.querySelector(".schedule-spot-input")?.value || 1);
    const status = row.querySelector(".schedule-status-input")?.value || "Planned";
    const note = row.querySelector(".schedule-note-input")?.value.trim() || "";
    if (!date && spot === 1 && status === "Planned" && !note) row.remove();
  });
}

function addScheduleRow(date = state.operationDate, spot = 1, airingStatus = "Planned", scheduleNote = "") {
  const rows = $("#scheduleRows");
  rows.insertAdjacentHTML("beforeend", buildScheduleRow(date, spot, airingStatus, scheduleNote));
  syncScheduleRowVisualState(rows.lastElementChild);
  updateScheduleRemoveButtons();
}

function updateScheduleRemoveButtons() {
  const buttons = $$("[data-remove-schedule]");
  buttons.forEach((button) => { button.disabled = buttons.length === 1; button.title = buttons.length === 1 ? "Minimal satu jadwal diperlukan" : "Hapus jadwal"; });
}

function setFormSelectValue(selector, values, placeholder, value) {
  setSelectOptions(selector, values, placeholder, value || "");
}

function openPlotModal(batchId = "") {
  const form = $("#plotForm");
  form.reset();
  $("#plotBatchIdInput").value = "";
  $("#scheduleRows").innerHTML = "";
  resetMultiDatePicker();
  setFormSelectValue("#plotAdvertiserInput", state.masters.advertisers, "Pilih PT Advertiser");
  setFormSelectValue("#plotUnitInput", state.masters.units, "Pilih Unit On Air");
  setFormSelectValue("#plotPodInput", state.masters.pods, "Pilih POD");
  setFormSelectValue("#plotFormatInput", state.masters.formats, "Pilih Format VA");
  setFormSelectValue("#plotDurationInput", state.masters.durations, "Pilih Durasi");
  setFormSelectValue("#plotGfxInput", state.masters.gfx, "Pilih Materi GFX");
  setFormSelectValue("#plotPicInput", state.masters.pics, "Pilih PIC Ploting");

  if (batchId) {
    const batch = getBatch(batchId);
    const first = batch[0];
    if (!first) return;
    $("#plotBatchIdInput").value = batchId;
    $("#plotBrandInput").value = first.brand;
    $("#plotSalesInput").value = first.sales;
    $("#plotProgramInput").value = first.program;
    $("#plotVersionInput").value = first.version;
    $("#plotSegmentationInput").value = first.segmentation || "";
    $("#plotBatchNoteInput").value = first.batchNote || "";
    setFormSelectValue("#plotAdvertiserInput", state.masters.advertisers, "Pilih PT Advertiser", first.advertiser);
    setFormSelectValue("#plotUnitInput", state.masters.units, "Pilih Unit On Air", first.unit);
    setFormSelectValue("#plotPodInput", state.masters.pods, "Pilih POD", first.pod);
    setFormSelectValue("#plotFormatInput", state.masters.formats, "Pilih Format VA", first.format);
    setFormSelectValue("#plotDurationInput", state.masters.durations, "Pilih Durasi", first.duration);
    setFormSelectValue("#plotGfxInput", state.masters.gfx, "Pilih Materi GFX", first.gfx);
    setFormSelectValue("#plotPicInput", state.masters.pics, "Pilih PIC Ploting", first.pic || "Belum ditetapkan");
    batch.forEach((plot) => addScheduleRow(plot.planAiring, plot.spot, plot.airingStatus, plot.scheduleNote));
    $("#plotModalTitle").textContent = `Edit Batch ${batchId}`;
  } else {
    addScheduleRow("", 1, "Planned", "");
    $("#plotModalTitle").textContent = "Tambah Ploting Benefit";
  }
  updateScheduleRemoveButtons();
  renderMultiDatePicker();
  $("#plotModalBackdrop").classList.add("open");
  $("#plotModalBackdrop").setAttribute("aria-hidden", "false");
  setTimeout(() => $("#plotAdvertiserInput").focus(), 40);
}

function closePlotModal() {
  resetMultiDatePicker();
  renderMultiDatePicker();
  $("#plotModalBackdrop").classList.remove("open");
  $("#plotModalBackdrop").setAttribute("aria-hidden", "true");
}

function readScheduleRows() {
  return $$("#scheduleRows .schedule-row").map((row) => ({
    date: row.querySelector(".schedule-date-input").value,
    spot: Number(row.querySelector(".schedule-spot-input").value),
    airingStatus: row.querySelector(".schedule-status-input").value,
    scheduleNote: row.querySelector(".schedule-note-input").value.trim()
  }));
}

function normalizePlotNameInputs() {
  const brandInput = $("#plotBrandInput");
  const programInput = $("#plotProgramInput");
  if (brandInput) brandInput.value = formatBrandName(brandInput.value);
  if (programInput) programInput.value = formatProgramName(programInput.value);
}

function formPayload() {
  normalizePlotNameInputs();
  return {
    advertiser: $("#plotAdvertiserInput").value,
    brand: formatBrandName($("#plotBrandInput").value),
    sales: $("#plotSalesInput").value.trim(),
    pic: $("#plotPicInput").value,
    unit: $("#plotUnitInput").value,
    program: formatProgramName($("#plotProgramInput").value),
    pod: $("#plotPodInput").value,
    version: $("#plotVersionInput").value.trim(),
    format: $("#plotFormatInput").value,
    duration: $("#plotDurationInput").value,
    gfx: $("#plotGfxInput").value,
    segmentation: $("#plotSegmentationInput").value.trim(),
    batchNote: $("#plotBatchNoteInput").value.trim()
  };
}

function savePlotFromForm(event) {
  event.preventDefault();
  const payload = formPayload();
  const required = [payload.advertiser, payload.brand, payload.sales, payload.pic, payload.unit, payload.program, payload.pod, payload.version, payload.format, payload.duration, payload.gfx];
  if (required.some((value) => !value)) { showToast("Lengkapi seluruh field wajib sebelum menyimpan."); return; }
  const schedules = readScheduleRows();
  if (!schedules.length || schedules.some((item) => !/^\d{4}-\d{2}-\d{2}$/.test(item.date) || !Number.isInteger(item.spot) || item.spot < 0 || !item.airingStatus)) {
    showToast("Setiap jadwal wajib memiliki tanggal, spot minimal 0, dan status tayang."); return;
  }
  const duplicateDate = unique(schedules.map((item) => item.date)).length !== schedules.length;
  if (duplicateDate) { showToast("Tanggal tayang dalam satu batch tidak boleh ganda."); return; }

  const existingBatchId = $("#plotBatchIdInput").value;
  const createdAt = nowIso();
  let auditEntry = null;
  if (existingBatchId) {
    const oldBatch = getBatch(existingBatchId);
    const beforeSnapshot = batchAuditSnapshot(oldBatch);
    const originalCreatedAt = oldBatch[0]?.createdAt || createdAt;
    state.plotings = state.plotings.filter((plot) => plot.batchId !== existingBatchId);
    schedules.sort((a, b) => a.date.localeCompare(b.date)).forEach((schedule) => state.plotings.push({
      id: nextId("SCH", state.plotings),
      batchId: existingBatchId,
      ...payload,
      planAiring: schedule.date,
      spot: schedule.spot,
      airingStatus: schedule.airingStatus,
      scheduleNote: schedule.scheduleNote,
      createdAt: originalCreatedAt,
      updatedAt: nowIso()
    }));
    const updatedBatch = getBatch(existingBatchId);
    auditEntry = {
      action: "BATCH_UPDATED", entityType: "batch", entityId: existingBatchId,
      target: auditTargetFromPlot(updatedBatch[0]),
      summary: `Batch ${existingBatchId} diperbarui untuk ${schedules.length} tanggal.`,
      changes: auditChanges(beforeSnapshot, batchAuditSnapshot(updatedBatch), ["advertiser", "brand", "sales", "pic", "unit", "program", "pod", "version", "format", "duration", "gfx", "segmentation", "batchNote", "scheduleCount", "planAiring", "spot", "airingStatus", "scheduleDetail"])
    };
    showToast(`Batch ${existingBatchId} diperbarui untuk ${schedules.length} tanggal.`);
  } else {
    const newBatchId = nextId("BEN", batches().map((batch) => ({ id: batch[0].batchId })));
    schedules.sort((a, b) => a.date.localeCompare(b.date)).forEach((schedule) => state.plotings.push({
      id: nextId("SCH", state.plotings),
      batchId: newBatchId,
      ...payload,
      planAiring: schedule.date,
      spot: schedule.spot,
      airingStatus: schedule.airingStatus,
      scheduleNote: schedule.scheduleNote,
      createdAt,
      updatedAt: createdAt
    }));
    const newBatch = getBatch(newBatchId);
    auditEntry = {
      action: "BATCH_CREATED", entityType: "batch", entityId: newBatchId,
      target: auditTargetFromPlot(newBatch[0]),
      summary: `Batch ${newBatchId} dibuat dengan ${schedules.length} jadwal dan ${sum(schedules.map((item) => item.spot))} spot.`,
      changes: auditChanges({}, batchAuditSnapshot(newBatch), ["advertiser", "brand", "sales", "pic", "unit", "program", "pod", "version", "format", "duration", "gfx", "scheduleCount", "planAiring", "spot", "airingStatus", "scheduleDetail"])
    };
    showToast(`Batch ${newBatchId} disimpan. ${schedules.length} jadwal dibuat otomatis.`);
  }
  state.masters = normalizeMasters(state.masters, state.plotings);
  saveState();
  closePlotModal();
  renderAll();
  recordAuditLog(auditEntry);
}

function appendScheduleNote(currentNote, addition) {
  const base = String(currentNote || "").trim();
  const extra = String(addition || "").trim();
  if (!extra || base.includes(extra)) return base;
  return base ? `${base}\n${extra}` : extra;
}

function syncScheduleSlideControls() {
  const status = $("#scheduleEditStatusInput").value;
  const spot = Number($("#scheduleEditSpotInput").value);
  const currentDate = $("#scheduleEditDateInput").value;
  const panel = $("#scheduleSlidePanel");
  const toggle = $("#scheduleSlideToggle");
  const fields = $("#scheduleSlideFields");
  const targetDate = $("#scheduleSlideDateInput");

  const isNotAiring = status === "Tidak tayang";
  panel.hidden = !isNotAiring;

  if (!isNotAiring) {
    toggle.checked = false;
    toggle.disabled = false;
    fields.hidden = true;
    targetDate.required = false;
    return;
  }

  const canSlide = Number.isInteger(spot) && spot > 0;
  toggle.disabled = !canSlide;
  if (!canSlide) {
    toggle.checked = false;
    fields.hidden = true;
    targetDate.required = false;
  } else if (toggle.checked) {
    fields.hidden = false;
    targetDate.required = true;
    if (!targetDate.value || targetDate.value === currentDate) targetDate.value = addDays(currentDate || state.operationDate, 1);
  } else {
    fields.hidden = true;
    targetDate.required = false;
  }

  $("#scheduleSlideSpotPreview").textContent = `${Number.isInteger(spot) && spot > 0 ? spot : 0} spot`;
  syncScheduleEditSpotWarning();
}

function syncScheduleEditSpotWarning() {
  const spotInput = $("#scheduleEditSpotInput");
  const statusInput = $("#scheduleEditStatusInput");
  if (!spotInput || !statusInput) return;
  spotInput.classList.toggle("zero-spot-input", isAlertSpot(Number(spotInput.value), statusInput.value));
}

function openScheduleModal(scheduleId) {
  const plot = state.plotings.find((item) => item.id === scheduleId);
  if (!plot) { showToast("Jadwal tidak ditemukan."); return; }
  $("#scheduleEditIdInput").value = plot.id;
  $("#scheduleEditContext").innerHTML = `<strong>${escapeHTML(plot.brand)} · ${escapeHTML(plot.program)}</strong><span>${escapeHTML(plot.batchId)} · ${escapeHTML(plot.unit)} · ${escapeHTML(plot.pod)}</span>`;
  $("#scheduleEditDateInput").value = plot.planAiring;
  $("#scheduleEditSpotInput").value = plot.spot;
  $("#scheduleEditSpotInput").classList.toggle("zero-spot-input", isAlertSpot(plot.spot, plot.airingStatus));
  setSelectOptions("#scheduleEditStatusInput", AIRING_STATUSES, "Pilih Status Tayang", plot.airingStatus || "Planned");
  $("#scheduleEditNoteInput").value = plot.scheduleNote || "";
  $("#scheduleSlideToggle").checked = false;
  $("#scheduleSlideDateInput").value = "";
  syncScheduleSlideControls();
  $("#scheduleModalBackdrop").classList.add("open");
  $("#scheduleModalBackdrop").setAttribute("aria-hidden", "false");
  setTimeout(() => $("#scheduleEditStatusInput").focus(), 40);
}

function closeScheduleModal() {
  $("#scheduleModalBackdrop").classList.remove("open");
  $("#scheduleModalBackdrop").setAttribute("aria-hidden", "true");
}

function saveScheduleFromForm(event) {
  event.preventDefault();
  const scheduleId = $("#scheduleEditIdInput").value;
  const plot = state.plotings.find((item) => item.id === scheduleId);
  if (!plot) { showToast("Jadwal tidak ditemukan."); closeScheduleModal(); return; }
  const beforePlot = clone(plot);

  const date = $("#scheduleEditDateInput").value;
  const spot = Number($("#scheduleEditSpotInput").value);
  const airingStatus = $("#scheduleEditStatusInput").value;
  const scheduleNote = $("#scheduleEditNoteInput").value.trim();
  const shouldSlide = airingStatus === "Tidak tayang" && $("#scheduleSlideToggle").checked;
  const slideDate = $("#scheduleSlideDateInput").value;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isInteger(spot) || spot < 0 || !airingStatus) {
    showToast("Isi tanggal, spot minimal 0, dan status tayang dengan benar."); return;
  }
  const duplicate = state.plotings.some((item) => item.id !== plot.id && item.batchId === plot.batchId && item.planAiring === date);
  if (duplicate) { showToast("Tanggal ini sudah ada pada batch yang sama."); return; }

  if (shouldSlide) {
    if (!Number.isInteger(spot) || spot <= 0) {
      showToast("Spot harus lebih dari 0 agar dapat digeser ke jadwal baru."); return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(slideDate)) {
      showToast("Pilih tanggal tayang pengganti untuk menggeser spot."); return;
    }
    if (slideDate === date) {
      showToast("Tanggal pengganti harus berbeda dari tanggal jadwal yang tidak tayang."); return;
    }
  }

  const updatedAt = nowIso();
  const movedSpot = spot;

  if (shouldSlide) {
    const existingTarget = state.plotings.find((item) => item.id !== plot.id && item.batchId === plot.batchId && item.planAiring === slideDate);
    if (existingTarget && ["Tidak tayang", "Dibatalkan"].includes(existingTarget.airingStatus)) {
      showToast("Tanggal pengganti sudah berstatus Tidak tayang atau Dibatalkan. Pilih tanggal lain."); return;
    }

    const sourceSlideNote = `Tidak tayang. ${movedSpot} spot digeser ke ${formatDate(slideDate)}.`;
    const targetSlideNote = `Slide ${movedSpot} spot dari ${formatDate(date)} karena tidak tayang.`;

    // Jadwal asal tetap tercatat sebagai Tidak tayang, tetapi spotnya menjadi 0 agar tidak dihitung dua kali.
    plot.planAiring = date;
    plot.spot = 0;
    plot.airingStatus = "Tidak tayang";
    plot.scheduleNote = appendScheduleNote(scheduleNote, sourceSlideNote);
    plot.updatedAt = updatedAt;

    if (existingTarget) {
      // Bila tanggal pengganti sudah ada di batch ini, sistem menjumlahkan spot pada jadwal tersebut.
      existingTarget.spot = Number(existingTarget.spot || 0) + movedSpot;
      existingTarget.scheduleNote = appendScheduleNote(existingTarget.scheduleNote, targetSlideNote);
      existingTarget.updatedAt = updatedAt;
    } else {
      const replacement = {
        ...plot,
        id: nextId("SCH", state.plotings),
        planAiring: slideDate,
        spot: movedSpot,
        airingStatus: "Planned",
        scheduleNote: targetSlideNote,
        createdAt: updatedAt,
        updatedAt
      };
      state.plotings.push(replacement);
    }

    saveState();
    closeScheduleModal();
    renderAll();
    showToast(`${movedSpot} spot digeser ke ${formatDate(slideDate)} dalam batch ${plot.batchId}.`);
    recordAuditLog({
      action: "SCHEDULE_SLID", entityType: "schedule", entityId: plot.id,
      target: auditTargetFromPlot(plot),
      summary: `${movedSpot} spot digeser dari ${formatDate(date)} ke ${formatDate(slideDate)} dalam ${plot.batchId}.`,
      changes: auditChanges(beforePlot, plot, ["planAiring", "spot", "airingStatus", "scheduleNote"]),
      metadata: { targetDate: slideDate, batchId: plot.batchId }
    });
    return;
  }

  plot.planAiring = date;
  plot.spot = spot;
  plot.airingStatus = airingStatus;
  plot.scheduleNote = scheduleNote;
  plot.updatedAt = updatedAt;
  saveState();
  closeScheduleModal();
  renderAll();
  showToast(`Jadwal ${formatDate(date)} diperbarui.`);
  recordAuditLog({
    action: "SCHEDULE_UPDATED", entityType: "schedule", entityId: plot.id,
    target: auditTargetFromPlot(plot),
    summary: `Jadwal ${formatDate(date)} pada ${plot.batchId} diperbarui.`,
    changes: auditChanges(beforePlot, plot, ["planAiring", "spot", "airingStatus", "scheduleNote"]),
    metadata: { batchId: plot.batchId }
  });
}

function deleteSchedule(scheduleId) {
  const plot = state.plotings.find((item) => item.id === scheduleId);
  if (!plot) { showToast("Jadwal tidak ditemukan."); closeScheduleModal(); return; }

  const batchSchedules = getBatch(plot.batchId);
  const isLastSchedule = batchSchedules.length === 1;
  const scheduleLabel = `${formatDate(plot.planAiring)} · ${plot.brand} · ${plot.program}`;
  const confirmation = isLastSchedule
    ? `Jadwal ini adalah satu-satunya jadwal dalam ${plot.batchId}. Menghapusnya akan menghapus batch tersebut dari timeline. Lanjut hapus?`
    : `Hapus jadwal ${scheduleLabel}? Jadwal lain dalam ${plot.batchId} tetap aman.`;

  if (!window.confirm(confirmation)) return;

  state.plotings = state.plotings.filter((item) => item.id !== scheduleId);
  saveState();
  closeScheduleModal();
  renderAll();
  showToast(isLastSchedule ? `Batch ${plot.batchId} dihapus karena tidak memiliki jadwal lagi.` : `Jadwal ${formatDate(plot.planAiring)} dihapus dari ${plot.batchId}.`);
  recordAuditLog({
    action: "SCHEDULE_DELETED", entityType: "schedule", entityId: plot.id,
    target: auditTargetFromPlot(plot),
    summary: isLastSchedule ? `Jadwal terakhir dihapus sehingga batch ${plot.batchId} ikut terhapus.` : `Jadwal ${formatDate(plot.planAiring)} dihapus dari ${plot.batchId}.`,
    changes: [{ field: "schedule", label: "Jadwal", before: `${formatDate(plot.planAiring)} · ${plot.spot} spot · ${plot.airingStatus}`, after: "Dihapus" }],
    metadata: { batchId: plot.batchId, removedBatch: isLastSchedule }
  });
}

function addMasterValue(event) {
  event.preventDefault();
  const key = $("#masterTypeInput").value;
  const value = $("#masterValueInput").value.trim();
  if (!MASTER_META[key] || !value) { showToast("Pilih jenis data dan isi nilai baru."); return; }
  const exists = state.masters[key].some((item) => item.toLowerCase() === value.toLowerCase());
  if (exists) { showToast("Nilai tersebut sudah ada pada Master Data."); return; }
  state.masters[key] = sortText([...state.masters[key], value]);
  $("#masterValueInput").value = "";
  saveState();
  renderAll();
  showToast(`${MASTER_META[key].label} ditambahkan ke Master Data.`);
  recordAuditLog({
    action: "MASTER_CREATED", entityType: "master", entityId: key,
    target: MASTER_META[key].label,
    summary: `${value} ditambahkan ke ${MASTER_META[key].label}.`,
    changes: [{ field: key, label: MASTER_META[key].label, before: "-", after: value }]
  });
}

function deleteMasterValue(key, encodedValue) {
  const meta = MASTER_META[key];
  let value = "";
  try {
    value = decodeURIComponent(encodedValue || "");
  } catch (error) {
    value = String(encodedValue || "");
  }
  if (!meta || !value || !Array.isArray(state.masters[key])) return;
  const used = state.plotings.some((plot) => plot[meta.field] === value);
  if (used) { showToast("Data ini sudah digunakan pada ploting sehingga tidak dapat dihapus."); return; }
  if (!window.confirm(`Hapus ${meta.label}: ${value}?`)) return;
  state.masters[key] = state.masters[key].filter((item) => item !== value);
  saveState();
  renderAll();
  showToast(`${meta.label} dihapus dari Master Data.`);
  recordAuditLog({
    action: "MASTER_DELETED", entityType: "master", entityId: key,
    target: meta.label,
    summary: `${value} dihapus dari ${meta.label}.`,
    changes: [{ field: key, label: meta.label, before: value, after: "Dihapus" }]
  });
}


// Import data lama dari file Excel 2026 VA. Library SheetJS dimuat hanya ketika
// pengguna memilih file, sehingga performa loading utama tidak terpengaruh.
const LEGACY_IMPORT_REQUIRED_FIELDS = ["brand", "sales", "pod", "unit", "program", "format", "planAiring"];
const LEGACY_IMPORT_ALIASES = {
  advertiser: ["ADVERTISER", "PT ADVERTISER", "PT"],
  brand: ["BRAND"],
  pod: ["POD"],
  sales: ["SALES NAME", "NAMA SALES", "SALES"],
  unit: ["UNIT ON AIR", "UNIT"],
  program: ["PROGRAM"],
  version: ["VERSI VA", "VERSION VA", "VERSI"],
  format: ["FORMAT VA", "FORMAT"],
  duration: ["DURASI", "DURATION"],
  gfx: ["MATERI GFX", "GFX", "MATERI"],
  spot: ["SPOT", "JUMLAH SPOT"],
  planAiring: ["PLAN AIRING", "TANGGAL TAYANG", "TANGGAL AIRING", "TANGGAL"],
  segmentation: ["SEGMENTASI", "SEGMENTATION"],
  note: ["NOTE", "CATATAN", "NOTES"]
};

function normalizeLegacyHeader(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ").toUpperCase();
}

function normalizeLegacyText(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

function normalizeLegacyDuration(value) {
  const text = normalizeLegacyText(value);
  const map = {
    '5"': '5 detik',
    '10"': '10 detik',
    '15"': '15 detik',
    '20"': '20 detik',
    '30"': '30 detik',
    '10" + 10"': '10 + 10 detik',
    '10"+10"': '10 + 10 detik'
  };
  return map[text] || text || 'Belum ada durasi';
}

function normalizeLegacySpot(value) {
  if (value === null || value === undefined || String(value).trim() === "") return 0;
  const parsed = Number(String(value).replace(/,/g, ".").trim());
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0;
}

function padNumber(value) {
  return String(value).padStart(2, "0");
}

function legacyDateToIso(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${value.getFullYear()}-${padNumber(value.getMonth() + 1)}-${padNumber(value.getDate())}`;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    const parsed = window.XLSX?.SSF?.parse_date_code?.(value);
    if (parsed?.y && parsed?.m && parsed?.d) return `${parsed.y}-${padNumber(parsed.m)}-${padNumber(parsed.d)}`;
    const excelOrigin = Date.UTC(1899, 11, 30);
    const date = new Date(excelOrigin + Math.round(value) * 86_400_000);
    if (!Number.isNaN(date.getTime())) return `${date.getUTCFullYear()}-${padNumber(date.getUTCMonth() + 1)}-${padNumber(date.getUTCDate())}`;
  }

  const text = normalizeLegacyText(value);
  if (!text) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const match = text.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
  if (match) return `${match[3]}-${padNumber(match[2])}-${padNumber(match[1])}`;
  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) return `${parsed.getFullYear()}-${padNumber(parsed.getMonth() + 1)}-${padNumber(parsed.getDate())}`;
  return "";
}

function simpleLegacyHash(value) {
  let hash = 2166136261;
  const text = String(value ?? "");
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function legacyImportStatus(spot, planAiring, options) {
  if (spot === 0) return "Tidak tayang";
  return planAiring < getLocalIsoDate() ? options.pastStatus : options.currentFutureStatus;
}

function legacyBatchSignature(record) {
  return [
    record.advertiser, record.brand, record.pod, record.sales, record.unit,
    record.program, record.version, record.format, record.duration, record.gfx,
    record.segmentation
  ].join("∥");
}

function maxIdNumber(prefix, values) {
  return values.reduce((max, value) => {
    const match = String(value || "").match(new RegExp(`^${prefix}-(\\d+)$`));
    return Math.max(max, match ? Number(match[1]) : 0);
  }, 0);
}

function importedId(prefix, serial) {
  return `${prefix}-${String(serial).padStart(6, "0")}`;
}

function getDefaultLegacyImportPic() {
  const activeName = currentTeamAccount()?.name;
  return state.masters.pics.includes(activeName) ? activeName : "Belum ditetapkan";
}

function ensureLegacyImportPicOptions(selectedValue = "") {
  const values = sortText(unique(["Belum ditetapkan", ...state.masters.pics]));
  setSelectOptions("#legacyImportPicInput", values, "Pilih PIC default", selectedValue || getDefaultLegacyImportPic());
}

function updateLegacyImportActions() {
  const importButton = $("#legacyImportConfirmButton");
  const session = legacyImportSession;
  const canImport = Boolean(session && session.records?.length && !session.duplicateRecords && realtimeDatabaseReady() && !legacyImportInProgress);
  if (importButton) importButton.disabled = !canImport;
}

function openLegacyImportModal() {
  legacyImportSession = null;
  legacyImportInProgress = false;
  $("#legacyImportFile").value = "";
  $("#legacyImportFileName").textContent = "Belum ada file dipilih";
  $("#legacyImportPreview").hidden = true;
  $("#legacyImportError").hidden = true;
  $("#legacyImportError").textContent = "";
  $("#legacyImportConfirmButton").textContent = "Import ke Realtime Database";
  ensureLegacyImportPicOptions();
  setSelectOptions("#legacyImportPastStatusInput", ["Sudah tayang", "On air", "Siap tayang", "Planned"], "Status tanggal lalu", "Sudah tayang");
  setSelectOptions("#legacyImportFutureStatusInput", ["Planned", "Siap tayang", "On air", "Sudah tayang"], "Status hari ini / mendatang", "Planned");
  $("#legacyImportModalBackdrop").classList.add("open");
  $("#legacyImportModalBackdrop").setAttribute("aria-hidden", "false");
  updateLegacyImportActions();
  setTimeout(() => $("#legacyImportFile")?.focus(), 40);
}

function closeLegacyImportModal() {
  if (legacyImportInProgress) return;
  $("#legacyImportModalBackdrop").classList.remove("open");
  $("#legacyImportModalBackdrop").setAttribute("aria-hidden", "true");
}

function loadHtml2Canvas() {
  if (window.html2canvas) return Promise.resolve(window.html2canvas);
  if (html2CanvasLoadingPromise) return html2CanvasLoadingPromise;

  html2CanvasLoadingPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js";
    script.async = true;
    script.onload = () => window.html2canvas
      ? resolve(window.html2canvas)
      : reject(new Error("Library snapshot tidak tersedia setelah dimuat."));
    script.onerror = () => reject(new Error("Library snapshot tidak dapat dimuat."));
    document.head.appendChild(script);
  });

  return html2CanvasLoadingPromise;
}

function prepareBrandDetailLogosForSnapshot(table) {
  const logos = [...table.querySelectorAll(".unit-logo")];

  return Promise.all(logos.map((image) => new Promise((resolve) => {
    const bounds = image.getBoundingClientRect();
    const width = Math.max(1, Math.round(bounds.width || 40));
    const height = Math.max(1, Math.round(bounds.height || 17));
    const label = image.alt || image.title || image.closest(".unit-label")?.getAttribute("aria-label") || "Unit";
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;

      // html2canvas kadang gagal membaca object-fit dan gambar yang tidak lolos CORS.
      // Logo diraster menjadi data URI. Jika gagal, snapshot tetap jalan dengan teks unit.
      if (!image.naturalWidth || !image.naturalHeight) {
        resolve({ src: "", width, height, label });
        return;
      }

      try {
        const density = 2;
        const canvas = document.createElement("canvas");
        canvas.width = width * density;
        canvas.height = height * density;
        const context = canvas.getContext("2d");
        if (!context) {
          resolve({ src: "", width, height, label });
          return;
        }

        const scale = Math.min(
          canvas.width / image.naturalWidth,
          canvas.height / image.naturalHeight
        );
        const drawWidth = image.naturalWidth * scale;
        const drawHeight = image.naturalHeight * scale;
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = "high";
        context.drawImage(
          image,
          (canvas.width - drawWidth) / 2,
          (canvas.height - drawHeight) / 2,
          drawWidth,
          drawHeight
        );
        resolve({ src: canvas.toDataURL("image/png"), width, height, label });
      } catch (error) {
        console.warn("Logo Unit On Air tidak dapat dipersiapkan untuk snapshot.", error);
        resolve({ src: "", width, height, label });
      }
    };

    if (image.complete) {
      finish();
      return;
    }

    image.addEventListener("load", finish, { once: true });
    image.addEventListener("error", finish, { once: true });
    window.setTimeout(finish, 1200);
  })));
}

function snapshotFileName() {
  const brand = filters.brand.brand || "semua-brand";
  const period = monthKeyFromPeriod(filters.brand.year, filters.brand.month) || monthKey(state.operationDate);
  return `${safeFileName(`snapshot-detail-brand-${brand}-${period}`)}.png`;
}

async function copyImageBlobToClipboard(imageBlob) {
  if (!window.isSecureContext || !navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    throw new Error("Clipboard gambar tidak didukung oleh browser ini.");
  }

  await navigator.clipboard.write([
    new ClipboardItem({ "image/png": imageBlob })
  ]);
}

function fallbackDownloadSnapshot(imageBlob) {
  downloadBlob(imageBlob, snapshotFileName());
}

function formatBrandSnapshotTimestamp(date = new Date()) {
  const formatterOptions = { timeZone: "Asia/Jakarta" };
  const time = new Intl.DateTimeFormat("id-ID", {
    ...formatterOptions,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date).replace(".", ":");
  const dateLabel = new Intl.DateTimeFormat("id-ID", {
    ...formatterOptions,
    day: "2-digit",
    month: "long",
    year: "numeric"
  }).format(date);
  return `${time} WIB - ${dateLabel}`;
}

async function snapshotBrandDetailTable() {
  const table = $("#brandDetailTable");
  const button = $("#snapshotBrandDetailButton");
  const hasRows = Boolean(table && [...table.querySelectorAll("#brandDetailBody tr")].some((row) => !row.querySelector(".empty-row")));

  if (!table || !hasRows) {
    showToast("Pilih brand dan periode dengan jadwal terlebih dahulu.");
    return;
  }

  const initialLabel = button?.textContent || "▣ Copy Snapshot";
  if (button) {
    button.disabled = true;
    button.textContent = "Menyiapkan snapshot...";
  }

  try {
    const html2canvas = await loadHtml2Canvas();
    if (document.fonts?.ready) await document.fonts.ready;

    const snapshotTimestamp = formatBrandSnapshotTimestamp();
    const tableBounds = table.getBoundingClientRect();
    const captureWidth = Math.ceil(Math.max(table.scrollWidth, tableBounds.width));
    const captureHeight = Math.ceil(Math.max(table.scrollHeight, tableBounds.height));
    const snapshotLogos = await prepareBrandDetailLogosForSnapshot(table);
    const canvas = await html2canvas(table, {
      backgroundColor: "#ffffff",
      scale: Math.min(2, window.devicePixelRatio || 2),
      useCORS: true,
      allowTaint: false,
      logging: false,
      width: captureWidth,
      height: captureHeight,
      windowWidth: captureWidth,
      windowHeight: Math.max(captureHeight, window.innerHeight || captureHeight),
      scrollX: 0,
      scrollY: 0,
      onclone: (clonedDocument) => {
        clonedDocument.body.classList.add("snapshot-capture-mode");
        const clonedTable = clonedDocument.querySelector("#brandDetailTable");
        if (!clonedTable) return;

        const clonedCaption = clonedTable.querySelector("#brandDetailSnapshotTitle");
        if (clonedCaption) {
          const timestamp = clonedDocument.createElement("span");
          timestamp.className = "brand-detail-snapshot-time";
          timestamp.textContent = snapshotTimestamp;
          clonedCaption.appendChild(timestamp);
        }

        // Kolom aksi hanya diperlukan saat mengelola jadwal di aplikasi dan tidak
        // relevan pada gambar yang dibagikan. Semua kolom data tetap dipertahankan.
        clonedTable.querySelectorAll("thead tr th:last-child, tbody tr td:last-child")
          .forEach((cell) => cell.remove());
        clonedTable.querySelector("colgroup col:last-child")?.remove();

        const footerSpacer = clonedTable.querySelector("tfoot tr td:last-child");
        if (footerSpacer) footerSpacer.colSpan = Math.max(1, Number(footerSpacer.colSpan || 1) - 1);

        const emptyCell = clonedTable.querySelector(".empty-row");
        if (emptyCell) emptyCell.colSpan = 7;

        clonedTable.style.width = `${captureWidth}px`;
        clonedTable.style.minWidth = `${captureWidth}px`;
        clonedTable.style.maxWidth = "none";
        clonedTable.style.borderCollapse = "collapse";
        clonedTable.querySelectorAll("th").forEach((cell) => {
          cell.style.position = "static";
          cell.style.top = "auto";
        });

        clonedTable.querySelectorAll(".unit-logo").forEach((image, index) => {
          const logo = snapshotLogos[index] || {};
          if (logo.src) {
            image.src = logo.src;
            image.style.width = `${logo.width || 40}px`;
            image.style.height = `${logo.height || 17}px`;
            image.style.maxWidth = `${logo.width || 40}px`;
            image.style.objectFit = "fill";
            image.style.objectPosition = "center";
            return;
          }

          const replacement = clonedDocument.createElement("span");
          replacement.className = "snapshot-unit-text";
          replacement.textContent = logo.label || image.alt || image.title || "Unit";
          image.replaceWith(replacement);
        });
      }
    });

    const imageBlob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!imageBlob) throw new Error("Gambar PNG tidak berhasil dibuat.");

    if (button) button.textContent = "Menyalin...";
    try {
      await copyImageBlobToClipboard(imageBlob);
      showToast("Snapshot Detail Brand sudah disalin. Tempel langsung di WhatsApp.");
    } catch (copyError) {
      console.warn("Clipboard gambar tidak tersedia. Snapshot disimpan sebagai PNG.", copyError);
      fallbackDownloadSnapshot(imageBlob);
      showToast("Clipboard gambar tidak tersedia. Snapshot PNG sudah diunduh.");
    }
  } catch (error) {
    console.error("Gagal membuat snapshot Detail Brand.", error);
    showToast("Snapshot belum berhasil dibuat. Periksa data brand dan coba lagi.");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = initialLabel;
    }
  }
}

function loadSheetJs() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (sheetJsLoadingPromise) return sheetJsLoadingPromise;

  sheetJsLoadingPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
    script.async = true;
    script.onload = () => window.XLSX ? resolve(window.XLSX) : reject(new Error("SheetJS tidak tersedia setelah dimuat."));
    script.onerror = () => reject(new Error("Library pembaca Excel tidak dapat dimuat."));
    document.head.appendChild(script);
  });
  return sheetJsLoadingPromise;
}

function getLegacyColumnMap(headerRow) {
  const indexedHeaders = headerRow.map((value, index) => ({ value: normalizeLegacyHeader(value), index }));
  return Object.entries(LEGACY_IMPORT_ALIASES).reduce((map, [field, aliases]) => {
    const match = indexedHeaders.find((header) => aliases.includes(header.value));
    if (match) map[field] = match.index;
    return map;
  }, {});
}

function legacyValueFromRow(row, columnMap, field) {
  const index = columnMap[field];
  return index === undefined ? "" : row[index];
}

function validateLegacyWorkbook(workbook) {
  const sheetName = workbook.SheetNames?.[0];
  if (!sheetName) throw new Error("Workbook tidak memiliki sheet yang dapat dibaca.");
  const sheet = workbook.Sheets[sheetName];
  const matrix = window.XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: true });
  const headerRowIndex = matrix.findIndex((row) => {
    const normalized = row.map(normalizeLegacyHeader);
    return normalized.includes("BRAND") && normalized.includes("PLAN AIRING");
  });
  if (headerRowIndex < 0) throw new Error("Header Excel tidak ditemukan. Pastikan file memakai kolom BRAND dan PLAN AIRING.");

  const columnMap = getLegacyColumnMap(matrix[headerRowIndex]);
  const missingColumns = LEGACY_IMPORT_REQUIRED_FIELDS.filter((field) => columnMap[field] === undefined);
  if (missingColumns.length) {
    const labels = missingColumns.map((field) => LEGACY_IMPORT_ALIASES[field][0]).join(", ");
    throw new Error(`Kolom wajib belum ditemukan: ${labels}.`);
  }
  return { sheetName, matrix, headerRowIndex, columnMap };
}

function buildLegacyImportSession(file, workbook, options) {
  const { sheetName, matrix, headerRowIndex, columnMap } = validateLegacyWorkbook(workbook);
  const fileKey = simpleLegacyHash(`${file.name}|${file.size}|${file.lastModified}`);
  const warnings = { blankAdvertiser: 0, blankVersion: 0, blankDuration: 0, blankGfx: 0, blankSpot: 0 };
  const skipped = [];
  const excluded = [];
  const prepared = [];

  matrix.slice(headerRowIndex + 1).forEach((row, index) => {
    const sourceRow = headerRowIndex + index + 2;
    const raw = {
      advertiser: legacyValueFromRow(row, columnMap, "advertiser"),
      brand: legacyValueFromRow(row, columnMap, "brand"),
      pod: legacyValueFromRow(row, columnMap, "pod"),
      sales: legacyValueFromRow(row, columnMap, "sales"),
      unit: legacyValueFromRow(row, columnMap, "unit"),
      program: legacyValueFromRow(row, columnMap, "program"),
      version: legacyValueFromRow(row, columnMap, "version"),
      format: legacyValueFromRow(row, columnMap, "format"),
      duration: legacyValueFromRow(row, columnMap, "duration"),
      gfx: legacyValueFromRow(row, columnMap, "gfx"),
      spot: legacyValueFromRow(row, columnMap, "spot"),
      planAiring: legacyValueFromRow(row, columnMap, "planAiring"),
      segmentation: legacyValueFromRow(row, columnMap, "segmentation"),
      note: legacyValueFromRow(row, columnMap, "note")
    };

    const isBlankRow = Object.values(raw).every((value) => normalizeLegacyText(value) === "");
    if (isBlankRow) return;

    const planAiring = legacyDateToIso(raw.planAiring);
    if (isExcludedLegacyImportMonth(planAiring)) {
      excluded.push({ sourceRow, planAiring, period: legacyExcludedMonthLabel(planAiring) });
      return;
    }

    const requiredText = {
      brand: formatBrandName(normalizeLegacyText(raw.brand)), pod: normalizeLegacyText(raw.pod), sales: normalizeLegacyText(raw.sales),
      unit: normalizeLegacyText(raw.unit), program: formatProgramName(normalizeLegacyText(raw.program)), format: normalizeLegacyText(raw.format), planAiring
    };
    const missing = LEGACY_IMPORT_REQUIRED_FIELDS.filter((field) => !requiredText[field]);
    if (missing.length) {
      skipped.push({ sourceRow, reason: `Kolom kosong: ${missing.map((field) => LEGACY_IMPORT_ALIASES[field][0]).join(", ")}` });
      return;
    }

    if (!normalizeLegacyText(raw.advertiser)) warnings.blankAdvertiser += 1;
    if (!normalizeLegacyText(raw.version)) warnings.blankVersion += 1;
    if (!normalizeLegacyText(raw.duration)) warnings.blankDuration += 1;
    if (!normalizeLegacyText(raw.gfx)) warnings.blankGfx += 1;
    if (raw.spot === "" || raw.spot === null || raw.spot === undefined) warnings.blankSpot += 1;

    const spot = normalizeLegacySpot(raw.spot);
    const record = {
      sourceRow,
      advertiser: normalizeLegacyText(raw.advertiser) || "Belum ada PT Advertiser",
      brand: requiredText.brand,
      pod: requiredText.pod,
      sales: requiredText.sales,
      unit: requiredText.unit,
      program: requiredText.program,
      version: normalizeLegacyText(raw.version) || "Belum ada versi",
      format: requiredText.format,
      duration: normalizeLegacyDuration(raw.duration),
      gfx: normalizeLegacyText(raw.gfx) || "Belum ada materi",
      spot,
      planAiring,
      segmentation: normalizeLegacyText(raw.segmentation),
      scheduleNote: normalizeLegacyText(raw.note),
      pic: options.pic || "Belum ditetapkan"
    };
    record.legacyFingerprint = simpleLegacyHash([
      record.sourceRow, record.advertiser, record.brand, record.pod, record.sales, record.unit,
      record.program, record.version, record.format, record.duration, record.gfx, record.spot,
      record.planAiring, record.segmentation, record.scheduleNote
    ].join("∥"));
    prepared.push(record);
  });

  if (!prepared.length) throw new Error("Tidak ada jadwal valid yang dapat diimpor dari file ini.");

  const existingFingerprints = new Set(state.plotings.map((plot) => plot.legacyFingerprint).filter(Boolean));
  const duplicateRecords = prepared.filter((record) => existingFingerprints.has(record.legacyFingerprint)).length;

  let batchSerial = maxIdNumber("BEN", state.plotings.map((plot) => plot.batchId));
  let scheduleSerial = maxIdNumber("SCH", state.plotings.map((plot) => plot.id));
  let activeSignature = "";
  let activeBatchId = "";
  let activeDates = new Set();
  const importedAt = nowIso();
  const records = [];

  prepared.forEach((record) => {
    const signature = legacyBatchSignature(record);
    if (!activeBatchId || signature !== activeSignature || activeDates.has(record.planAiring)) {
      batchSerial += 1;
      activeBatchId = importedId("BEN", batchSerial);
      activeSignature = signature;
      activeDates = new Set();
    }
    activeDates.add(record.planAiring);
    scheduleSerial += 1;
    records.push({
      id: importedId("SCH", scheduleSerial),
      batchId: activeBatchId,
      advertiser: record.advertiser,
      brand: record.brand,
      sales: record.sales,
      pic: record.pic,
      unit: record.unit,
      program: record.program,
      pod: record.pod,
      version: record.version,
      format: record.format,
      duration: record.duration,
      gfx: record.gfx,
      segmentation: record.segmentation,
      batchNote: "",
      planAiring: record.planAiring,
      spot: record.spot,
      airingStatus: legacyImportStatus(record.spot, record.planAiring, options),
      scheduleNote: record.scheduleNote,
      createdAt: importedAt,
      updatedAt: importedAt,
      legacyImport: true,
      legacySourceFile: file.name,
      legacySourceSheet: sheetName,
      legacySourceRow: record.sourceRow,
      legacyFingerprint: record.legacyFingerprint,
      legacyImportedAt: importedAt
    });
  });

  return {
    file,
    fileKey,
    sheetName,
    records,
    importedAt,
    warnings,
    skipped,
    excluded,
    duplicateRecords,
    batchCount: unique(records.map((record) => record.batchId)).length,
    dateRange: [records[0].planAiring, records.at(-1).planAiring].sort(),
    options
  };
}

function renderLegacyImportPreview(session) {
  const preview = $("#legacyImportPreview");
  const errorBox = $("#legacyImportError");
  errorBox.hidden = true;
  errorBox.textContent = "";
  preview.hidden = false;
  const totalSpot = sum(session.records.map((record) => record.spot));
  const zeroSpot = session.records.filter((record) => record.spot === 0).length;
  $("#legacyImportSummary").innerHTML = [
    ["Jadwal akan diimport", session.records.length], ["Batch dibuat", session.batchCount],
    ["Total spot", totalSpot], ["0 spot", zeroSpot],
    ["Dilewati: Juli 2026", session.excluded?.length || 0]
  ].map(([label, value]) => `<div><strong>${value}</strong><span>${label}</span></div>`).join("");
  $("#legacyImportRange").textContent = `${formatDate(session.dateRange[0])} s.d. ${formatDate(session.dateRange[1])} · Sheet: ${session.sheetName}`;

  const warningMessages = [];
  if (session.warnings.blankAdvertiser) warningMessages.push(`${session.warnings.blankAdvertiser} PT Advertiser kosong diisi “Belum ada PT Advertiser”.`);
  if (session.warnings.blankVersion) warningMessages.push(`${session.warnings.blankVersion} Versi VA kosong diisi “Belum ada versi”.`);
  if (session.warnings.blankDuration) warningMessages.push(`${session.warnings.blankDuration} Durasi kosong diisi “Belum ada durasi”.`);
  if (session.warnings.blankGfx) warningMessages.push(`${session.warnings.blankGfx} Materi GFX kosong diisi “Belum ada materi”.`);
  if (session.warnings.blankSpot) warningMessages.push(`${session.warnings.blankSpot} Spot kosong diisi 0 dan diberi status Tidak tayang.`);
  if (session.excluded?.length) warningMessages.push(`${session.excluded.length} jadwal pada Juli 2026 tidak akan diimport karena sudah ada di aplikasi.`);
  if (session.skipped.length) warningMessages.push(`${session.skipped.length} baris dilewati karena data wajib tidak lengkap.`);
  if (session.duplicateRecords) warningMessages.push(`${session.duplicateRecords} baris tampak sudah ada di database. Import diblokir untuk mencegah data ganda.`);
  $("#legacyImportWarnings").innerHTML = warningMessages.length
    ? warningMessages.map((message) => `<li>${escapeHTML(message)}</li>`).join("")
    : "<li>Data siap diimpor. Tidak ada kolom wajib yang terlewat.</li>";
  $("#legacyImportConfirmButton").textContent = session.duplicateRecords ? "Data sudah pernah diimpor" : `Import ${session.records.length} jadwal`;
  updateLegacyImportActions();
}

async function previewLegacyExcel(file) {
  if (!file) return;
  if (!/\.(xlsx|xls)$/i.test(file.name)) {
    $("#legacyImportError").hidden = false;
    $("#legacyImportError").textContent = "Pilih file Excel dengan ekstensi .xlsx atau .xls.";
    return;
  }
  if (!realtimeDatabaseReady()) {
    $("#legacyImportError").hidden = false;
    $("#legacyImportError").textContent = "Tunggu sampai Realtime Database berstatus Tersimpan sebelum mengimpor.";
    return;
  }

  $("#legacyImportFileName").textContent = `Membaca ${file.name}...`;
  $("#legacyImportPreview").hidden = true;
  $("#legacyImportError").hidden = true;
  try {
    const XLSX = await loadSheetJs();
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: "array", cellDates: true });
    const options = {
      pic: $("#legacyImportPicInput").value || "Belum ditetapkan",
      pastStatus: $("#legacyImportPastStatusInput").value || "Sudah tayang",
      currentFutureStatus: $("#legacyImportFutureStatusInput").value || "Planned"
    };
    legacyImportSession = buildLegacyImportSession(file, workbook, options);
    $("#legacyImportFileName").textContent = `${file.name} · ${Math.max(1, Math.round(file.size / 1024))} KB`;
    renderLegacyImportPreview(legacyImportSession);
  } catch (error) {
    console.error("Gagal membaca file legacy.", error);
    legacyImportSession = null;
    $("#legacyImportFileName").textContent = "File tidak dapat dibaca";
    $("#legacyImportError").hidden = false;
    $("#legacyImportError").textContent = error?.message || "File Excel tidak dapat diproses.";
    updateLegacyImportActions();
  }
}

async function commitLegacyImport() {
  const session = legacyImportSession;
  if (!session?.records?.length || session.duplicateRecords) return;
  if (!realtimeDatabaseReady()) { showToast("Realtime Database belum siap. Coba lagi setelah status Tersimpan."); return; }
  if (!window.confirm(`Import ${session.records.length} jadwal menjadi ${session.batchCount} batch ke Realtime Database? Data ini akan langsung terlihat oleh seluruh tim.`)) return;

  legacyImportInProgress = true;
  updateLegacyImportActions();
  $("#legacyImportConfirmButton").textContent = "Mengimpor data...";
  setFirebaseStatus("saving", "Mengimpor data lama");

  const previousState = clone(state);
  try {
    const importedRecords = normalizePlotings(session.records);
    state.plotings = sortByDate([...state.plotings, ...importedRecords]);
    state.masters = normalizeMasters(state.masters, state.plotings);

    const updates = { masters: cleanFirebaseValue(state.masters), schemaVersion: 30, updatedAt: nowIso() };
    importedRecords.forEach((record) => { updates[`schedules/${record.id}`] = firebaseRecord(record); });
    await update(realtimeRootRef, updates);

    importedRecords.forEach((record) => remotePlotings.set(record.id, firebaseRecord(record)));
    remoteMasters = clone(state.masters);
    persistRealtimeCache();
    setFirebaseStatus("synced", "Tersimpan");
    closeLegacyImportModal();
    renderAll();
    showToast(`${importedRecords.length} jadwal lama berhasil diimpor.`);
    recordAuditLog({
      action: "LEGACY_IMPORTED", entityType: "import", entityId: session.file?.name || "legacy-excel",
      target: session.file?.name || "File Excel data lama",
      summary: `${importedRecords.length} jadwal lama diimpor menjadi ${session.batchCount} batch.`,
      changes: [
        { field: "scheduleCount", label: "Jadwal", before: "0", after: String(importedRecords.length) },
        { field: "batchCount", label: "Batch", before: "0", after: String(session.batchCount) },
        { field: "spot", label: "Total Spot", before: "0", after: String(sum(importedRecords.map((record) => record.spot))) }
      ]
    });
  } catch (error) {
    console.error("Gagal mengimpor data lama ke Realtime Database.", error);
    state = previousState;
    renderAll();
    setFirebaseStatus("error", "Import gagal");
    showToast("Import gagal. Data tidak diterapkan ke tampilan. Periksa Rules dan koneksi, lalu coba lagi.");
  } finally {
    legacyImportInProgress = false;
    updateLegacyImportActions();
  }
}

function xmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function safeFileName(value) {
  return String(value || "export").replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, "-").replace(/-+/g, "-");
}

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function spreadsheetCell(value, numeric = false) {
  const number = Number(value);
  if (numeric && Number.isFinite(number)) {
    return `<Cell ss:StyleID="Number"><Data ss:Type="Number">${number}</Data></Cell>`;
  }
  return `<Cell ss:StyleID="Cell"><Data ss:Type="String">${xmlEscape(value)}</Data></Cell>`;
}

function spreadsheetSheet(sheet) {
  const headers = sheet.headers || [];
  const rows = sheet.rows || [];
  const numericColumns = new Set(sheet.numericColumns || []);
  const widths = sheet.widths || headers.map(() => 110);
  const columns = widths.map((width) => `<Column ss:AutoFitWidth="0" ss:Width="${Number(width) || 110}"/>`).join("");
  const headerRow = `<Row ss:StyleID="Header">${headers.map((header) => `<Cell><Data ss:Type="String">${xmlEscape(header)}</Data></Cell>`).join("")}</Row>`;
  const dataRows = rows.map((row) => `<Row>${headers.map((_, index) => spreadsheetCell(row[index], numericColumns.has(index))).join("")}</Row>`).join("");
  const title = String(sheet.name || "Sheet").slice(0, 31);
  return `<Worksheet ss:Name="${xmlEscape(title)}"><Table>${columns}${headerRow}${dataRows}</Table><WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel"><ProtectObjects>False</ProtectObjects><ProtectScenarios>False</ProtectScenarios></WorksheetOptions></Worksheet>`;
}

function exportExcelWorkbook(fileName, sheets) {
  const workbook = `<?xml version="1.0"?>\n<?mso-application progid="Excel.Sheet"?>\n<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet" xmlns:html="http://www.w3.org/TR/REC-html40">\n<Styles>\n<Style ss:ID="Default" ss:Name="Normal"><Alignment ss:Vertical="Center"/><Font ss:FontName="Calibri" ss:Size="10"/></Style>\n<Style ss:ID="Header"><Alignment ss:Horizontal="Center" ss:Vertical="Center" ss:WrapText="1"/><Font ss:FontName="Calibri" ss:Size="10" ss:Bold="1" ss:Color="#FFFFFF"/><Interior ss:Color="#145B64" ss:Pattern="Solid"/></Style>\n<Style ss:ID="Cell"><Alignment ss:Vertical="Top" ss:WrapText="1"/></Style>\n<Style ss:ID="Number"><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><NumberFormat ss:Format="0"/></Style>\n</Styles>\n${sheets.map(spreadsheetSheet).join("\n")}\n</Workbook>`;
  const blob = new Blob([workbook], { type: "application/vnd.ms-excel;charset=utf-8" });
  downloadBlob(blob, `${safeFileName(fileName)}.xls`);
}

function masterPlotingExportRows(plots) {
  return sortByDate(plots).map((plot, index) => [
    index + 1,
    formatDate(plot.planAiring),
    plot.batchId,
    plot.advertiser,
    plot.brand,
    plot.sales,
    plot.pic,
    plot.unit,
    plot.program,
    plot.pod,
    plot.version,
    plot.format,
    plot.duration,
    plot.gfx,
    Number(plot.spot || 0),
    plot.airingStatus,
    plot.segmentation || "",
    plot.batchNote || "",
    plot.scheduleNote || "",
    plot.createdAt ? new Date(plot.createdAt).toLocaleString("id-ID") : "",
    plot.updatedAt ? new Date(plot.updatedAt).toLocaleString("id-ID") : ""
  ]);
}

function exportPlotingsExcel() {
  const plots = filteredPlotings();
  if (!plots.length) { showToast("Tidak ada data Master Ploting untuk diexport."); return; }
  const headers = ["No", "Tanggal Tayang", "Batch ID", "PT Advertiser", "Brand", "Nama Sales", "PIC Ploting", "Unit On Air", "Program", "POD", "Versi VA", "Format VA", "Durasi", "Materi GFX", "Spot", "Status Tayang", "Segmentasi", "Catatan Benefit", "Note Tambahan", "Dibuat", "Diubah"];
  const plotPeriod = filters.plot.year || filters.plot.month ? [filters.plot.year || "semua-tahun", filters.plot.month ? (MONTH_OPTIONS.find(([value]) => value === filters.plot.month)?.[1] || filters.plot.month) : "semua-bulan"].join("-") : "semua-periode";
  const scope = [plotPeriod, filters.plot.unit || "semua-unit"].join("-");
  exportExcelWorkbook(`master-ploting-va-${scope}-${state.operationDate}`, [{
    name: "Master Ploting",
    headers,
    rows: masterPlotingExportRows(plots),
    numericColumns: [0, 14],
    widths: [42, 100, 90, 190, 120, 85, 100, 85, 160, 65, 220, 110, 90, 105, 50, 95, 120, 220, 220, 130, 130]
  }]);
  showToast(`${plots.length} jadwal Master Ploting diexport ke Excel.`);
}

function getPicExportData() {
  const selectedPic = filters.pic.pic;
  const selectedYear = filters.pic.year;
  const selectedQuarter = filters.pic.quarter;
  const periodPlots = sortByDate(state.plotings.filter((plot) => matchesQuarter(plot.planAiring, selectedYear, selectedQuarter)));
  const selectedPlots = periodPlots.filter((plot) => !selectedPic || plot.pic === selectedPic);
  const picNames = sortText(unique(periodPlots.map((plot) => plot.pic)));
  const summaryRows = picNames.map((pic, index) => {
    const plots = periodPlots.filter((plot) => plot.pic === pic);
    return [index + 1, pic, completedSpotSum(plots), plots.length, sum(plots.map((plot) => plot.spot)), unique(plots.map((plot) => plot.brand)).join(", "), unique(plots.map((plot) => plot.program)).join(", "), unique(plots.map((plot) => plot.unit)).join(", ")];
  });
  return { selectedPic, selectedYear, selectedQuarter, periodPlots, selectedPlots, summaryRows };
}

function exportPicExcel() {
  const { selectedPic, selectedYear, selectedQuarter, selectedPlots, summaryRows } = getPicExportData();
  if (!selectedPlots.length && !summaryRows.length) { showToast("Tidak ada data Report PIC untuk diexport."); return; }
  const period = formatQuarter(selectedYear, selectedQuarter);
  const periodFile = [selectedYear || "semua-tahun", selectedQuarter || "semua-kuartal"].join("-");
  const detailRows = masterPlotingExportRows(selectedPlots).map((row) => [row[0], row[1], row[2], row[6], row[3], row[4], row[7], row[8], row[9], row[11], row[12], row[14], row[15], row[16], row[18]]);
  exportExcelWorkbook(`report-pic-${selectedPic || "semua-pic"}-${periodFile}-${state.operationDate}`, [
    {
      name: "Ringkasan PIC",
      headers: ["No", "PIC Ploting", "Spot On Air/Sudah Tayang", "Jadwal", "Total Spot", "Brand Ditangani", "Program Ditangani", "Unit On Air"],
      rows: summaryRows,
      numericColumns: [0, 2, 3, 4],
      widths: [42, 110, 120, 60, 70, 220, 250, 120]
    },
    {
      name: "Detail PIC",
      headers: ["No", "Tanggal", "Batch ID", "PIC Ploting", "PT Advertiser", "Brand", "Unit On Air", "Program", "POD", "Format VA", "Durasi", "Spot", "Status Tayang", "Segmentasi", "Note Tambahan"],
      rows: detailRows,
      numericColumns: [0, 11],
      widths: [42, 100, 90, 110, 190, 120, 90, 160, 65, 115, 90, 55, 100, 130, 240]
    }
  ]);
  showToast(`Report PIC ${selectedPic || "semua PIC"} diexport ke Excel.`);
}

function bindAuthenticationEvents() {
  $("#authLoginForm")?.addEventListener("submit", signInWithPassword);
  $("#authUsernameInput")?.addEventListener("input", updateAuthForm);
  $("#authPasswordInput")?.addEventListener("input", updateAuthForm);
  $("#profileMenuButton")?.addEventListener("click", (event) => {
    event.stopPropagation();
    setProfileMenuOpen(!profileMenuOpen);
  });
  $("#openProfileButton")?.addEventListener("click", () => openProfileModal("profile"));
  $("#openAccountManagementButton")?.addEventListener("click", () => openProfileModal("accounts"));
  $("#profileSignOutButton")?.addEventListener("click", signOutFromFirebase);
  $("#profileForm")?.addEventListener("submit", saveCurrentProfile);
  $("#createAccountForm")?.addEventListener("submit", createTeamAccount);
  $("#deleteOwnAccountForm")?.addEventListener("submit", deleteOwnAccountFromApp);
  $("#profileAvatarInput")?.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      profileAvatarDraft = await profileImageToDataUrl(file);
      renderProfileModal();
    } catch (error) {
      showToast({ message: error.message || "Foto profil tidak dapat diproses.", type: "warning" });
    }
  });
  $("#removeProfileAvatarButton")?.addEventListener("click", () => {
    profileAvatarDraft = "__REMOVE__";
    const preview = $("#profileAvatarPreview");
    if (preview) preview.innerHTML = accountAvatarMarkup({ ...currentTeamAccount(), avatar: "" }, "profile-avatar-preview-image");
  });
}

function bindEvents() {
  $$(".nav-item").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
  $$(".nav-group-toggle").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const group = button.closest(".nav-group");
      const shouldOpen = !group?.classList.contains("is-open");
      closeAllNavGroups(group);
      setNavGroupOpen(group, shouldOpen);
    });
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".topnav-list")) closeAllNavGroups();
    if (!event.target.closest("#profileMenuButton") && !event.target.closest("#profileMenuPanel")) setProfileMenuOpen(false);
  });
  $("#primaryActionButton").addEventListener("click", () => openPlotModal());
  $("#addPlotInlineButton").addEventListener("click", () => openPlotModal());
  $("#addBatchInlineButton")?.addEventListener("click", () => openPlotModal());
  $("#legacyImportButton").addEventListener("click", openLegacyImportModal);
  $("#legacyImportFile").addEventListener("change", (event) => previewLegacyExcel(event.target.files?.[0]));
  $("#legacyImportPicInput").addEventListener("change", () => { if (legacyImportSession) previewLegacyExcel(legacyImportSession.file); });
  $("#legacyImportPastStatusInput").addEventListener("change", () => { if (legacyImportSession) previewLegacyExcel(legacyImportSession.file); });
  $("#legacyImportFutureStatusInput").addEventListener("change", () => { if (legacyImportSession) previewLegacyExcel(legacyImportSession.file); });
  $("#legacyImportConfirmButton").addEventListener("click", commitLegacyImport);
  $("#plotForm").addEventListener("submit", savePlotFromForm);
  $("#plotBrandInput").addEventListener("blur", normalizePlotNameInputs);
  $("#plotProgramInput").addEventListener("blur", normalizePlotNameInputs);
  $("#scheduleEditForm").addEventListener("submit", saveScheduleFromForm);
  $("#scheduleEditStatusInput").addEventListener("change", syncScheduleSlideControls);
  $("#scheduleEditSpotInput").addEventListener("input", syncScheduleSlideControls);
  $("#scheduleEditDateInput").addEventListener("change", syncScheduleSlideControls);
  $("#scheduleSlideToggle").addEventListener("change", syncScheduleSlideControls);
  $("#masterForm").addEventListener("submit", addMasterValue);
  $("#teamChatForm")?.addEventListener("submit", sendTeamChatMessage);
  $("#teamChatMessageInput")?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    if (!event.currentTarget.value.trim()) return;
    event.currentTarget.form?.requestSubmit();
  });
  $("#teamReminderForm")?.addEventListener("submit", sendTeamReminder);
  $("#teamChatLauncher")?.addEventListener("click", toggleFloatingTeamChat);
  $("#closeTeamChatPanel")?.addEventListener("click", () => setFloatingTeamChatOpen(false));
  $("#openTeamReminderComposerButton")?.addEventListener("click", () => {
    teamChatState.reminderComposerOpen = true;
    renderTeamChatConversation();
    $("#teamReminderMessageInput")?.focus();
  });
  $("#addScheduleButton").addEventListener("click", () => {
    addScheduleRow(addDays(state.operationDate, 1), 1, "Planned", "");
    if (!$("#multiDatePicker")?.hidden) renderMultiDatePicker();
  });
  $("#multiDatePickerToggle").addEventListener("click", toggleMultiDatePicker);
  $("#exportPlotingsExcelButton").addEventListener("click", exportPlotingsExcel);
  $("#exportPicExcelButton").addEventListener("click", exportPicExcel);
  $("#waCopyButton").addEventListener("click", copyWaMessage);
  $("#waOpenButton").addEventListener("click", openWaMessage);
  $("#waResetSegmentsButton").addEventListener("click", resetWaSegments);

  document.addEventListener("change", (event) => {
    const segmentSelect = event.target.closest("[data-wa-spot-key]");
    if (!segmentSelect) return;
    const key = decodeURIComponent(segmentSelect.dataset.waSpotKey || "");
    const segment = Number(segmentSelect.value);
    if (WA_SEGMENT_OPTIONS.includes(segment)) waGeneratorState.assignments[key] = segment;
    else delete waGeneratorState.assignments[key];
    renderWaGenerator();
  });

  document.addEventListener("change", (event) => {
    const scheduleStatus = event.target.closest(".schedule-status-input");
    if (scheduleStatus) syncScheduleRowVisualState(scheduleStatus.closest(".schedule-row"));
  });

  document.addEventListener("input", (event) => {
    const scheduleSpot = event.target.closest(".schedule-spot-input");
    if (scheduleSpot) syncScheduleRowVisualState(scheduleSpot.closest(".schedule-row"));
  });

  $("#operationDate").addEventListener("change", (event) => { state.operationDate = event.target.value || DEFAULT_OPERATION_DATE; saveState(); renderAll(); });
  $("#dailyDateInput").addEventListener("change", (event) => { state.operationDate = event.target.value || DEFAULT_OPERATION_DATE; saveState(); renderAll(); });
  $("#plotSearchInput").addEventListener("input", (event) => { filters.plot.query = event.target.value; filters.plot.page = 1; renderPlotings(); });
  $("#plotYearFilter").addEventListener("change", (event) => { filters.plot.year = event.target.value; filters.plot.page = 1; renderPlotings(); });
  $("#plotMonthFilter").addEventListener("change", (event) => { filters.plot.month = event.target.value; filters.plot.page = 1; renderPlotings(); });
  $("#plotUnitFilter").addEventListener("change", (event) => { filters.plot.unit = event.target.value; filters.plot.page = 1; renderPlotings(); });
  $("#plotGfxFilter").addEventListener("change", (event) => { filters.plot.gfx = event.target.value; filters.plot.page = 1; renderPlotings(); });
  $("#plotAiringFilter").addEventListener("change", (event) => { filters.plot.airing = event.target.value; filters.plot.page = 1; renderPlotings(); });
  $("#resetPlotFilterButton").addEventListener("click", () => {
    filters.plot = { query: "", year: "", month: "", unit: "", gfx: "", airing: "", page: 1, perPage: 20 };
    $("#plotSearchInput").value = "";
    populateSelects();
    renderPlotings();
  });
  $("#batchSearchInput")?.addEventListener("input", (event) => { filters.batch.query = event.target.value; filters.batch.page = 1; renderBatches(); });
  $("#batchYearFilter")?.addEventListener("change", (event) => { filters.batch.year = event.target.value; filters.batch.page = 1; renderBatches(); });
  $("#batchMonthFilter")?.addEventListener("change", (event) => { filters.batch.month = event.target.value; filters.batch.page = 1; renderBatches(); });
  $("#batchUnitFilter")?.addEventListener("change", (event) => { filters.batch.unit = event.target.value; filters.batch.page = 1; renderBatches(); });
  $("#resetBatchFilterButton")?.addEventListener("click", () => {
    filters.batch = { query: "", year: "", month: "", unit: "", page: 1, perPage: 20 };
    $("#batchSearchInput").value = "";
    populateSelects();
    renderBatches();
  });
  $("#fullTimelineYearSelect").addEventListener("change", (event) => { filters.full.year = event.target.value; renderFullTimeline(); });
  $("#fullTimelineMonthSelect").addEventListener("change", (event) => { filters.full.month = event.target.value; renderFullTimeline(); });
  $("#fullTimelineUnitSelect").addEventListener("change", (event) => { filters.full.unit = event.target.value; renderFullTimeline(); });
  bindBrandSearchFilter("#fullTimelineBrandSelect", "full");
  $("#fullTimelineResetButton")?.addEventListener("click", resetFullTimelineFilters);
  $("#snapshotBrandDetailButton").addEventListener("click", snapshotBrandDetailTable);
  bindBrandSearchFilter("#brandSelect", "brand");
  $("#brandFilterResetButton")?.addEventListener("click", resetBrandTimelineFilters);
  $("#brandYearSelect").addEventListener("change", (event) => { filters.brand.year = event.target.value; populateSelects(); renderBrand(); });
  $("#brandMonthSelect").addEventListener("change", (event) => { filters.brand.month = event.target.value; populateSelects(); renderBrand(); });
  $("#brandUnitSelect").addEventListener("change", (event) => { filters.brand.unit = event.target.value; populateSelects(); renderBrand(); });
  $("#brandProgramSelect").addEventListener("change", (event) => { filters.brand.program = event.target.value; renderBrand(); });
  $("#brandFormatSelect").addEventListener("change", (event) => { filters.brand.format = event.target.value; renderBrand(); });
  $("#picReportSelect").addEventListener("change", (event) => { filters.pic.pic = event.target.value; mobilePicReportState.detailLimit = 8; renderPicReport(); });
  $("#picReportYearSelect").addEventListener("change", (event) => { filters.pic.year = event.target.value; mobilePicReportState.detailLimit = 8; renderPicReport(); });
  $("#picReportQuarterSelect").addEventListener("change", (event) => { filters.pic.quarter = event.target.value; mobilePicReportState.detailLimit = 8; renderPicReport(); });
  $("#auditSearchInput")?.addEventListener("input", (event) => { filters.audit.query = event.target.value; renderAuditLog(); });
  $("#auditActorFilter")?.addEventListener("change", (event) => { filters.audit.actor = event.target.value; renderAuditLog(); });
  $("#auditActionFilter")?.addEventListener("change", (event) => { filters.audit.action = event.target.value; renderAuditLog(); });
  $("#resetAuditFilterButton")?.addEventListener("click", () => {
    filters.audit = { query: "", actor: "", action: "" };
    if ($("#auditSearchInput")) $("#auditSearchInput").value = "";
    renderAuditLog();
  });
  $("#masterTypeInput").addEventListener("change", (event) => { $("#masterValueInput").placeholder = MASTER_META[event.target.value].placeholder; });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && $("#profileModalBackdrop")?.classList.contains("open")) {
      closeProfileModal();
      return;
    }
    if (event.key === "Escape" && teamChatState.panelOpen && !document.body.classList.contains("team-reminder-modal-open")) {
      setFloatingTeamChatOpen(false);
    }
  });

  document.addEventListener("click", (event) => {
    const profileTab = event.target.closest("[data-profile-tab]");
    if (profileTab) {
      profileActiveTab = profileTab.dataset.profileTab || "profile";
      renderProfileModal();
      return;
    }
    const closeProfile = event.target.closest("[data-close-profile-modal]");
    if (closeProfile) {
      closeProfileModal();
      return;
    }
    const accountToggle = event.target.closest("[data-account-toggle]");
    if (accountToggle) {
      toggleTeamAccountActive(accountToggle.dataset.accountToggle || "", accountToggle.dataset.accountActive === "true");
      return;
    }
    const closeReminderComposer = event.target.closest("[data-close-team-reminder-composer]");
    if (closeReminderComposer) {
      teamChatState.reminderComposerOpen = false;
      renderTeamChatConversation();
      return;
    }
    const reminderAction = event.target.closest("[data-team-reminder-action]");
    if (reminderAction) {
      updateTeamReminderStatus(reminderAction.dataset.teamReminderId || "", reminderAction.dataset.teamReminderAction || "read");
      return;
    }
    const reminderModalAction = event.target.closest("[data-team-reminder-modal-action]");
    if (reminderModalAction) {
      handleIncomingReminderModalAction(reminderModalAction.dataset.teamReminderModalAction || "read");
      return;
    }
    const multiDateDay = event.target.closest("[data-multi-date-day]");
    if (multiDateDay && !multiDateDay.disabled) {
      toggleMultiDatePickerDate(multiDateDay.dataset.multiDateDay || "");
      return;
    }
    const multiDateAction = event.target.closest("[data-multi-date-action]");
    if (multiDateAction) {
      const action = multiDateAction.dataset.multiDateAction;
      if (action === "previous") shiftMultiDatePickerMonth(-1);
      if (action === "next") shiftMultiDatePickerMonth(1);
      if (action === "clear") { multiDatePickerState.selectedDates = new Set(); renderMultiDatePicker(); }
      if (action === "cancel") { multiDatePickerState.selectedDates = new Set(); multiDatePickerState.open = false; renderMultiDatePicker(); }
      if (action === "apply") applyMultiDatePickerDates();
      return;
    }
    const closeButton = event.target.closest("[data-close-modal]");
    if (closeButton) { closePlotModal(); return; }
    const closeScheduleButton = event.target.closest("[data-close-schedule-modal]");
    if (closeScheduleButton) { closeScheduleModal(); return; }
    const closeLegacyImportButton = event.target.closest("[data-close-legacy-import]");
    if (closeLegacyImportButton) { closeLegacyImportModal(); return; }
    const editSchedule = event.target.closest("[data-edit-schedule]");
    if (editSchedule) { openScheduleModal(editSchedule.dataset.editSchedule); return; }
    const editBatch = event.target.closest("[data-edit-batch]");
    if (editBatch) { openPlotModal(editBatch.dataset.editBatch); return; }
    const goView = event.target.closest("[data-go-view]");
    if (goView) { setView(goView.dataset.goView); return; }
    const waProgram = event.target.closest("[data-wa-program]");
    if (waProgram) {
      waGeneratorState.selectedProgramKey = decodeURIComponent(waProgram.dataset.waProgram || "");
      renderWaGenerator();
      return;
    }
    const plotPage = event.target.closest("[data-plot-page]");
    if (plotPage && !plotPage.disabled) {
      const nextPage = Number(plotPage.dataset.plotPage);
      if (Number.isFinite(nextPage)) {
        filters.plot.page = nextPage;
        renderPlotings();
      }
      return;
    }
    const batchPage = event.target.closest("[data-batch-page]");
    if (batchPage && !batchPage.disabled) {
      const nextPage = Number(batchPage.dataset.batchPage);
      if (Number.isFinite(nextPage)) {
        filters.batch.page = nextPage;
        renderBatches();
      }
      return;
    }
    const showDay = event.target.closest("[data-show-day]");
    if (showDay) {
      state.operationDate = showDay.dataset.showDay || state.operationDate;
      saveState();
      renderAll();
      setView("daily");
      return;
    }
    const mobileReportToggle = event.target.closest("[data-mobile-report-toggle]");
    if (mobileReportToggle) {
      const key = mobileReportToggle.dataset.mobileReportToggle;
      if (key && Object.prototype.hasOwnProperty.call(mobilePicReportState.sections, key)) {
        mobilePicReportState.sections[key] = !mobilePicReportState.sections[key];
        syncMobilePicReportSections();
      }
      return;
    }
    const mobileReportMore = event.target.closest("[data-mobile-report-more]");
    if (mobileReportMore) {
      mobilePicReportState.detailLimit += 8;
      renderPicReport();
      return;
    }
    const selectPic = event.target.closest("[data-select-pic]");
    if (selectPic) { filters.pic.pic = decodeURIComponent(selectPic.dataset.selectPic || ""); mobilePicReportState.detailLimit = 8; populateSelects(); renderPicReport(); return; }
    const removeSchedule = event.target.closest("[data-remove-schedule]");
    if (removeSchedule) {
      const rows = $$("#scheduleRows .schedule-row");
      if (rows.length > 1) removeSchedule.closest(".schedule-row").remove();
      updateScheduleRemoveButtons();
      if (!$("#multiDatePicker")?.hidden) renderMultiDatePicker();
      return;
    }
    const deleteScheduleButton = event.target.closest("[data-delete-schedule]");
    if (deleteScheduleButton) {
      deleteSchedule($("#scheduleEditIdInput").value);
      return;
    }
    const deleteMaster = event.target.closest("[data-master-delete]");
    if (deleteMaster) { deleteMasterValue(deleteMaster.dataset.masterDelete, deleteMaster.dataset.masterValue); }
  });
  // Backdrop sengaja tidak menutup modal. Pengguna hanya menutup lewat tombol Batal, ikon X, atau Escape.
  $("#plotModalBackdrop").addEventListener("click", () => {});
  $("#scheduleModalBackdrop").addEventListener("click", () => {});
  $("#legacyImportModalBackdrop").addEventListener("click", () => {});
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") { closePlotModal(); closeScheduleModal(); closeLegacyImportModal(); setMobileMenuOpen(false); } });
}

function watchOperationalDate() {
  let observedDate = getLocalIsoDate();
  window.setInterval(() => {
    const today = getLocalIsoDate();
    if (today !== observedDate) {
      observedDate = today;
      state.operationDate = today;
      renderAll();
      showToast("Tanggal operasional diperbarui ke hari ini.");
    }
    renderIncomingTeamReminderModal();
  }, 60_000);
}

try { localStorage.removeItem(LOCAL_SETTINGS_KEY); } catch (error) { /* Pengaturan lama boleh diabaikan. */ }
document.body.dataset.activeView = activeView;
bindThemeEvents();

// Autentikasi harus aktif lebih dulu. Kesalahan UI di halaman non-login tidak boleh
// membuat pilihan akun atau tombol Masuk berhenti bekerja.
initializeFirebaseRealtime();
bindAuthenticationEvents();

try {
  initializeMobileFilterShells();
  bindMobileAppEvents();
  initializeMobileTableObserver();
  bindEvents();
  renderAll();
  watchOperationalDate();
} catch (error) {
  console.error("Inisialisasi tampilan aplikasi gagal.", error);
  showToast("Sebagian tampilan belum siap. Login tetap dapat digunakan.");
}
