/*
  VA Benefit Ploting v0.26
  - Firebase Realtime Database menjadi sumber data bersama secara realtime.
  - Firebase Authentication Email/Password membatasi akses tiga akun internal.
  - Pengaturan tanggal operasional tetap lokal pada browser masing-masing pengguna.
*/

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js";
import { getDatabase, ref, onValue, update } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-database.js";

const LOCAL_SETTINGS_KEY = "va-benefit-ploting-v26-settings";
const REALTIME_DATABASE_ROOT = "vaBenefitPloting/shared";

// Akun internal. Password sengaja tidak disimpan di kode website.
// Buat tiga akun ini di Firebase Authentication > Users sebelum aplikasi dipakai.
const TEAM_ACCOUNTS = Object.freeze({
  rakha: Object.freeze({ id: "rakha", name: "Rakha", email: "rakha@benefit-virtual-ads.app" }),
  adhi: Object.freeze({ id: "adhi", name: "Adhi", email: "adhi@benefit-virtual-ads.app" }),
  rian: Object.freeze({ id: "rian", name: "Rian", email: "rian@benefit-virtual-ads.app" })
});
const TEAM_ACCOUNT_BY_EMAIL = Object.freeze(
  Object.values(TEAM_ACCOUNTS).reduce((accounts, account) => {
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
  // Jika instance Realtime Database Anda memakai URL regional, ganti nilai ini
  // dengan URL persis dari Firebase Console > Realtime Database > Data.
  databaseURL: "https://benefit-virtual-ads-default-rtdb.firebaseio.com"
};

const firebaseApp = initializeApp(firebaseConfig);
const firebaseAuth = getAuth(firebaseApp);
const realtimeDb = getDatabase(firebaseApp, firebaseConfig.databaseURL);
const realtimeRootRef = ref(realtimeDb, REALTIME_DATABASE_ROOT);
const realtimeMastersRef = ref(realtimeDb, `${REALTIME_DATABASE_ROOT}/masters`);
const realtimeSchedulesRef = ref(realtimeDb, `${REALTIME_DATABASE_ROOT}/schedules`);
const getLocalIsoDate = () => {
  const now = new Date();
  const local = new Date(now.getTime() - (now.getTimezoneOffset() * 60_000));
  return local.toISOString().slice(0, 10);
};
const DEFAULT_OPERATION_DATE = getLocalIsoDate();
const AIRING_STATUSES = ["Planned", "Siap tayang", "On air", "Sudah tayang", "Tidak tayang", "Dibatalkan"];

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

let state = loadState();
let activeView = "dashboard";
let filters = {
  plot: { query: "", month: "", unit: "", gfx: "", airing: "", page: 1, perPage: 20 },
  full: { month: "", unit: "", brand: "" },
  brand: { brand: "", month: "", unit: "" },
  pic: { pic: "", month: "" }
};
let toastTimer;
let unsubscribeMasters = null;
let unsubscribeSchedules = null;
let currentFirebaseUser = null;
let firebaseBootstrapComplete = false;
let selectedTeamAccountId = "rakha";
let firebaseMasterLoaded = false;
let firebaseSchedulesLoaded = false;
let firebaseSyncQueued = false;
let firebaseSyncInProgress = false;
let firebasePendingSync = false;
let remoteMasters = null;
let remotePlotings = new Map();

function normalizeMasters(rawMasters, plotings) {
  const masters = clone(defaultMasters);
  Object.keys(MASTER_META).forEach((key) => {
    const supplied = Array.isArray(rawMasters?.[key]) ? rawMasters[key] : [];
    masters[key] = unique([...masters[key], ...supplied]);
    const field = MASTER_META[key].field;
    masters[key] = unique([...masters[key], ...plotings.map((plot) => plot[field])]);
    masters[key] = sortText(masters[key]);
  });
  return masters;
}

function normalizePlotings(plotings) {
  return plotings.map((plot) => {
    const legacyScheduleNote = String(plot.scheduleNote ?? plot.note ?? "").trim();
    return {
      ...plot,
      pic: String(plot.pic || "Belum ditetapkan").trim() || "Belum ditetapkan",
      airingStatus: plot.airingStatus || "Planned",
      batchNote: String(plot.batchNote || "").trim(),
      scheduleNote: legacyScheduleNote
    };
  });
}

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(LOCAL_SETTINGS_KEY));
    return {
      plotings: [],
      masters: normalizeMasters(defaultMasters, []),
      operationDate: saved?.operationDate || DEFAULT_OPERATION_DATE
    };
  } catch (error) {
    console.warn("Tidak dapat membaca pengaturan lokal.", error);
  }
  return {
    plotings: [],
    masters: normalizeMasters(defaultMasters, []),
    operationDate: DEFAULT_OPERATION_DATE
  };
}

function saveState() {
  try {
    localStorage.setItem(LOCAL_SETTINGS_KEY, JSON.stringify({ operationDate: state.operationDate }));
  } catch (error) {
    console.warn("Pengaturan lokal tidak dapat disimpan.", error);
  }
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
function addDays(dateValue, days) { const date = new Date(`${dateValue}T00:00:00`); date.setDate(date.getDate() + days); return date.toISOString().slice(0, 10); }
function sortByDate(items) { return [...items].sort((a, b) => a.planAiring.localeCompare(b.planAiring) || a.id.localeCompare(b.id)); }
function badgeClass(status) {
  const text = String(status || "").toLowerCase();
  if (text.includes("siap")) return "ready";
  if (text.includes("sudah")) return "done";
  if (text.includes("on air")) return "onair";
  if (text.includes("batal") || text.includes("tidak")) return "cancel";
  return "pending";
}
function badge(status) { return `<span class="badge ${badgeClass(status)}">${escapeHTML(status)}</span>`; }
function isZeroSpot(spot) { return Number(spot) === 0; }
function spotMarkup(spot, extraClass = "") {
  const classes = ["spot-value", isZeroSpot(spot) ? "spot-zero" : "", extraClass].filter(Boolean).join(" ");
  return `<span class="${classes}">${Number(spot)} spot</span>`;
}

const UNIT_LOGOS = {
  RCTI: "assets/rcti.png",
  MNCTV: "assets/mnctv.png",
  GTV: "assets/gtv.png"
};

function unitLabelMarkup(unit, variant = "default") {
  const value = String(unit || "-");
  const safeUnit = escapeHTML(value);
  const src = UNIT_LOGOS[value];

  // Untuk unit yang memiliki logo, tampilkan logo saja agar label tidak berulang.
  // Nama unit tetap tersedia melalui alt, title, dan aria-label untuk aksesibilitas.
  if (src) {
    return `<span class="unit-label unit-label--${variant} unit-label--logo-only" title="${safeUnit}" aria-label="${safeUnit}"><img class="unit-logo" src="${src}" alt="${safeUnit}" /></span>`;
  }

  return `<span class="unit-label unit-label--${variant}" title="${safeUnit}" aria-label="${safeUnit}"><span class="unit-text-mark">${escapeHTML(value.charAt(0).toUpperCase())}</span><span class="unit-label-text">${safeUnit}</span></span>`;
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
function setSelectOptions(selector, values, placeholder, selectedValue = "") {
  const element = $(selector);
  if (!element) return;
  element.innerHTML = optionMarkup(values, placeholder, selectedValue);
}
function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 3200);
}


function setFirebaseStatus(stateName, text) {
  const badge = $("#firebaseStatus");
  const label = $("#firebaseStatusText");
  if (!badge || !label) return;
  badge.dataset.state = stateName;
  label.textContent = text;
}

function getSelectedTeamAccount() {
  return TEAM_ACCOUNTS[selectedTeamAccountId] || TEAM_ACCOUNTS.rakha;
}

function updateAuthForm() {
  const signInButton = $("#passwordSignInButton");
  const selectedName = $("#authSelectedName");
  const passwordInput = $("#authPasswordInput");
  const account = getSelectedTeamAccount();

  if (selectedName) selectedName.textContent = account.name;
  $$(".auth-account-button").forEach((button) => {
    const selected = button.dataset.teamAccount === account.id;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });

  if (!signInButton) return;
  const hasPassword = Boolean(passwordInput?.value?.trim());
  signInButton.disabled = !firebaseBootstrapComplete || !hasPassword;
  signInButton.textContent = firebaseBootstrapComplete ? "Masuk" : "Menyiapkan Firebase...";
}

function selectTeamAccount(accountId, moveFocus = false) {
  if (!TEAM_ACCOUNTS[accountId]) return;
  selectedTeamAccountId = accountId;
  updateAuthForm();
  if (moveFocus) $("#authPasswordInput")?.focus();
}

function setAuthGate(open, message = "") {
  const gate = $("#authGate");
  const gateMessage = $("#authGateMessage");
  if (gate) gate.hidden = !open;
  if (gateMessage && message) gateMessage.textContent = message;
  updateAuthForm();
}

function updateUserChip(user) {
  const button = $("#signOutButton");
  const initial = $("#authUserInitial");
  const name = $("#authUserName");
  if (!button || !initial || !name) return;
  if (!user) {
    button.hidden = true;
    return;
  }
  const account = TEAM_ACCOUNT_BY_EMAIL[String(user.email || "").toLowerCase()];
  const label = account?.name || user.displayName || user.email || "Akun Tim";
  initial.textContent = label.trim().charAt(0).toUpperCase() || "V";
  name.textContent = label;
  button.hidden = false;
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
  }, 120);
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

    updates.schemaVersion = 26;
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

function stopRealtimeDatabaseListeners() {
  if (unsubscribeMasters) unsubscribeMasters();
  if (unsubscribeSchedules) unsubscribeSchedules();
  unsubscribeMasters = null;
  unsubscribeSchedules = null;
  firebaseMasterLoaded = false;
  firebaseSchedulesLoaded = false;
  remoteMasters = null;
  remotePlotings = new Map();
}

function subscribeToRealtimeDatabase() {
  stopRealtimeDatabaseListeners();
  setFirebaseStatus("connecting", "Memuat data");

  unsubscribeMasters = onValue(realtimeMastersRef, (snapshot) => {
    const cloudMasters = snapshot.exists() ? snapshot.val() : defaultMasters;
    state.masters = normalizeMasters(cloudMasters, state.plotings);
    remoteMasters = snapshot.exists() ? clone(state.masters) : null;
    firebaseMasterLoaded = true;
    if (realtimeDatabaseReady()) {
      renderAll();
      queueRealtimeDatabaseSync();
    }
  }, (error) => handleRealtimeDatabaseError(error));

  unsubscribeSchedules = onValue(realtimeSchedulesRef, (snapshot) => {
    const rawSchedules = snapshot.exists() ? snapshot.val() : {};
    const plotings = normalizePlotings(Object.entries(rawSchedules || {}).map(([id, record]) => ({ id, ...(record || {}) })));
    state.plotings = sortByDate(plotings);
    state.masters = normalizeMasters(state.masters, state.plotings);
    remotePlotings = new Map(state.plotings.map((plot) => [plot.id, firebaseRecord(plot)]));
    firebaseSchedulesLoaded = true;
    if (realtimeDatabaseReady()) {
      setFirebaseStatus("synced", "Tersimpan");
      renderAll();
      queueRealtimeDatabaseSync();
    }
  }, (error) => handleRealtimeDatabaseError(error));
}

function handleRealtimeDatabaseError(error) {
  console.error("Firebase Realtime Database tidak dapat diakses.", error);
  setFirebaseStatus("error", "Akses Firebase ditolak");
  setAuthGate(true, "Akses data ditolak. Pastikan akun tim sudah dibuat, databaseURL benar, dan Realtime Database Rules sudah dipublish.");
  showToast("Akses Realtime Database ditolak. Hubungi admin untuk memeriksa Rules atau databaseURL.");
}

async function signInWithPassword(event) {
  event?.preventDefault();
  const account = getSelectedTeamAccount();
  const passwordInput = $("#authPasswordInput");
  const signInButton = $("#passwordSignInButton");
  const password = passwordInput?.value || "";

  if (!account || password.trim().length < 6) {
    setAuthGate(true, "Masukkan password minimal 6 karakter.");
    passwordInput?.focus();
    return;
  }

  try {
    if (signInButton) {
      signInButton.disabled = true;
      signInButton.textContent = "Memeriksa akun...";
    }
    await signInWithEmailAndPassword(firebaseAuth, account.email, password);
    if (passwordInput) passwordInput.value = "";
  } catch (error) {
    console.error("Login akun tim gagal.", error);
    const loginMessage = error?.code === "auth/invalid-credential"
      ? "Password tidak sesuai. Periksa kembali password akun yang dipilih."
      : "Login belum berhasil. Pastikan Email/Password aktif dan akun tim sudah dibuat di Firebase.";
    setAuthGate(true, loginMessage);
    showToast("Login belum berhasil.");
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
  setAuthGate(true, "Pilih akun tim lalu masukkan password.");
  setFirebaseStatus("connecting", "Menunggu login");

  onAuthStateChanged(firebaseAuth, (user) => {
    currentFirebaseUser = user;
    updateUserChip(user);

    if (!user) {
      stopRealtimeDatabaseListeners();
      state.plotings = [];
      state.masters = normalizeMasters(defaultMasters, []);
      renderAll();
      setFirebaseStatus("connecting", "Menunggu login");
      setAuthGate(true, "Pilih akun tim lalu masukkan password.");
      return;
    }

    setAuthGate(false);
    setFirebaseStatus("connecting", "Menghubungkan");
    subscribeToRealtimeDatabase();
  });
}

function populateSelects() {
  const months = sortText(unique(state.plotings.map((plot) => monthKey(plot.planAiring))));
  const brands = sortText(unique(state.plotings.map((plot) => plot.brand)));
  const pics = sortText(unique(state.plotings.map((plot) => plot.pic)));
  if (!filters.brand.brand || !brands.includes(filters.brand.brand)) filters.brand.brand = brands[0] || "";
  if (!filters.brand.month || !months.includes(filters.brand.month)) filters.brand.month = months[0] || monthKey(state.operationDate);
  if (filters.brand.unit && !state.masters.units.includes(filters.brand.unit)) filters.brand.unit = "";
  if (!filters.pic.pic || !pics.includes(filters.pic.pic)) filters.pic.pic = pics[0] || "";
  if (!filters.pic.month || !months.includes(filters.pic.month)) filters.pic.month = months[0] || monthKey(state.operationDate);
  if (!filters.full.month || !months.includes(filters.full.month)) {
    filters.full.month = months.includes(monthKey(state.operationDate)) ? monthKey(state.operationDate) : (months[0] || monthKey(state.operationDate));
  }
  if (filters.full.unit && !state.masters.units.includes(filters.full.unit)) filters.full.unit = "";
  if (filters.full.brand && !brands.includes(filters.full.brand)) filters.full.brand = "";

  setSelectOptions("#plotMonthFilter", months, "Semua bulan", filters.plot.month);
  setSelectOptions("#plotUnitFilter", state.masters.units, "Semua unit", filters.plot.unit);
  setSelectOptions("#plotGfxFilter", state.masters.gfx, "Semua materi GFX", filters.plot.gfx);
  setSelectOptions("#plotAiringFilter", AIRING_STATUSES, "Semua status tayang", filters.plot.airing);
  setSelectOptions("#brandSelect", brands, "Pilih brand", filters.brand.brand);
  setSelectOptions("#brandMonthSelect", months, "Pilih bulan", filters.brand.month);
  setSelectOptions("#brandUnitSelect", state.masters.units, "Semua unit", filters.brand.unit);
  setSelectOptions("#picReportSelect", pics, "Pilih PIC", filters.pic.pic);
  setSelectOptions("#picReportMonthSelect", months, "Pilih bulan", filters.pic.month);
  setSelectOptions("#fullTimelineMonthSelect", months, "Pilih bulan", filters.full.month);
  setSelectOptions("#fullTimelineUnitSelect", state.masters.units, "Semua unit", filters.full.unit);
  setSelectOptions("#fullTimelineBrandSelect", brands, "Semua brand", filters.full.brand);

  setSelectOptions("#plotAdvertiserInput", state.masters.advertisers, "Pilih PT Advertiser");
  setSelectOptions("#plotUnitInput", state.masters.units, "Pilih Unit On Air");
  setSelectOptions("#plotPodInput", state.masters.pods, "Pilih POD");
  setSelectOptions("#plotFormatInput", state.masters.formats, "Pilih Format VA");
  setSelectOptions("#plotDurationInput", state.masters.durations, "Pilih Durasi");
  setSelectOptions("#plotGfxInput", state.masters.gfx, "Pilih Materi GFX");
  setSelectOptions("#plotPicInput", state.masters.pics, "Pilih PIC Ploting");
}

function renderDashboard() {
  const operationDate = state.operationDate;
  const todayPlots = sortByDate(state.plotings.filter((plot) => plot.planAiring === operationDate));
  const allBatches = batches();
  const upcoming = sortByDate(state.plotings.filter((plot) => plot.planAiring >= operationDate && plot.planAiring <= addDays(operationDate, 7)));
  const kpis = [
    ["Jadwal aktif", state.plotings.filter((plot) => !["Dibatalkan", "Tidak tayang"].includes(plot.airingStatus)).length, "Total tanggal tayang"],
    ["Batch benefit", allBatches.length, "Benefit unik"],
    ["Spot hari ini", sum(todayPlots.map((plot) => plot.spot)), `${todayPlots.length} jadwal pada ${formatDate(operationDate, { day: "2-digit", month: "short" })}`],
    ["Jadwal 7 hari", upcoming.length, `${sum(upcoming.map((plot) => plot.spot))} total spot`]
  ];
  $("#kpiGrid").innerHTML = kpis.map(([label, value, note]) => `<article class="kpi-card"><p>${label}</p><strong>${value}</strong><small>${note}</small></article>`).join("");
  $("#dashboardTodayBody").innerHTML = todayPlots.length ? todayPlots.map((plot) => `<tr><td>${unitLabelMarkup(plot.unit, "table")}</td><td><span class="cell-title">${escapeHTML(plot.program)}</span><span class="cell-subtitle">${escapeHTML(plot.brand)} · ${escapeHTML(plot.pod)}</span></td><td>${escapeHTML(plot.format)}</td><td>${plot.spot}</td><td>${badge(plot.airingStatus)}</td></tr>`).join("") : `<tr><td colspan="5" class="empty-row">Belum ada jadwal pada tanggal operasional.</td></tr>`;

  const attention = sortByDate(state.plotings.filter((plot) => plot.planAiring >= operationDate && plot.planAiring <= addDays(operationDate, 3) && plot.airingStatus === "Planned"));
  $("#attentionList").innerHTML = attention.length ? attention.slice(0, 5).map((plot) => `<div class="attention-item"><div><strong>${escapeHTML(plot.brand)} · ${escapeHTML(plot.program)}</strong><p>${formatDate(plot.planAiring)} · ${escapeHTML(plot.unit)} · <span class="${isZeroSpot(plot.spot) ? "spot-zero" : ""}">${plot.spot} spot</span></p></div><button class="row-action" data-edit-batch="${escapeHTML(plot.batchId)}" type="button">Edit</button></div>`).join("") : `<div class="attention-item"><div><strong>Tidak ada jadwal Planned dalam 3 hari.</strong><p>Silakan cek timeline jika ada perubahan dari sales.</p></div></div>`;

  const recentBatches = allBatches.sort((a, b) => (b[0].updatedAt || "").localeCompare(a[0].updatedAt || "")).slice(0, 5);
  $("#recentBatchList").innerHTML = recentBatches.length ? recentBatches.map((batch) => {
    const first = batch[0];
    return `<div class="batch-item"><div><strong>${escapeHTML(first.brand)} · ${escapeHTML(first.advertiser)}</strong><p>${escapeHTML(first.batchId)} · PIC: ${escapeHTML(first.pic)} · ${batch.length} tanggal · ${sum(batch.map((plot) => plot.spot))} spot</p></div><button class="row-action" data-edit-batch="${escapeHTML(first.batchId)}" type="button">Edit</button></div>`;
  }).join("") : `<div class="batch-item"><div><strong>Belum ada batch</strong><p>Belum ada batch ploting pada sistem.</p></div></div>`;
  $("#upcomingList").innerHTML = upcoming.length ? upcoming.slice(0, 6).map((plot) => `<div class="upcoming-item"><div><strong>${escapeHTML(plot.brand)} · ${escapeHTML(plot.program)}</strong><p>${formatDate(plot.planAiring)} · ${escapeHTML(plot.unit)} · <span class="${isZeroSpot(plot.spot) ? "spot-zero" : ""}">${plot.spot} spot</span></p></div><span class="item-side">${escapeHTML(plot.format)}</span></div>`).join("") : `<div class="upcoming-item"><div><strong>Belum ada jadwal</strong><p>Tidak ada penayangan dalam 7 hari berikutnya.</p></div></div>`;
}

function filteredPlotings() {
  const filter = filters.plot;
  const query = filter.query.trim().toLowerCase();
  return sortByDate(state.plotings.filter((plot) => {
    const haystack = [plot.batchId, plot.advertiser, plot.brand, plot.sales, plot.pic, plot.unit, plot.program, plot.pod, plot.version, plot.format, plot.duration, plot.gfx, plot.batchNote, plot.scheduleNote].join(" ").toLowerCase();
    return (!query || haystack.includes(query)) && (!filter.month || monthKey(plot.planAiring) === filter.month) && (!filter.unit || plot.unit === filter.unit) && (!filter.gfx || plot.gfx === filter.gfx) && (!filter.airing || plot.airingStatus === filter.airing);
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
    <td>${spotMarkup(plot.spot)}</td>
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

function renderDaily() {
  const date = state.operationDate;
  const plots = sortByDate(state.plotings.filter((plot) => plot.planAiring === date));
  $("#dailyDateInput").value = date;
  $("#dailyTimelineTitle").textContent = `Timeline ${formatDate(date)}`;
  $("#dailyTimelineCaption").textContent = `${plots.length} jadwal · ${sum(plots.map((plot) => plot.spot))} spot`;
  const metrics = [
    ["Jadwal", plots.length, "Tanggal terpilih"],
    ["Total spot", sum(plots.map((plot) => plot.spot)), "Akumulasi spot"],
    ["Brand", unique(plots.map((plot) => plot.brand)).length, "Brand aktif"],
    ["Unit", unique(plots.map((plot) => plot.unit)).length, "Unit on air"]
  ];
  $("#dailyKpiGrid").innerHTML = metrics.map(([label, value, note]) => `<article class="mini-kpi"><p>${label}</p><strong>${value}</strong><small>${note}</small></article>`).join("");
  const byUnit = plots.reduce((acc, plot) => { (acc[plot.unit] ||= []).push(plot); return acc; }, {});
  $("#dailyTimelineList").innerHTML = Object.keys(byUnit).length ? Object.entries(byUnit).map(([unit, entries]) => `<div class="timeline-unit"><div class="timeline-unit-head"><strong>${unitLabelMarkup(unit, "timeline")}</strong><span>${entries.length} jadwal · ${sum(entries.map((plot) => plot.spot))} spot</span></div>${entries.map((plot) => `<div class="timeline-entry"><div><strong>${escapeHTML(plot.program)} · ${escapeHTML(plot.brand)}</strong><p>${escapeHTML(plot.advertiser)} · ${escapeHTML(plot.pod)}</p></div><div><strong>${escapeHTML(plot.format)} · ${escapeHTML(plot.duration)}</strong><p>${escapeHTML(plot.version)}</p></div><div>${spotMarkup(plot.spot)}<p>spot</p></div><div>${escapeHTML(plot.gfx)}<p>${escapeHTML(plot.segmentation || "Tanpa segmentasi")}</p></div><div>${badge(plot.airingStatus)}</div><div class="timeline-actions"><button class="row-action" data-edit-schedule="${escapeHTML(plot.id)}" type="button">Atur</button></div></div>`).join("")}</div>`).join("") : `<div class="empty-row">Belum ada ploting pada tanggal ini.</div>`;

  const days = Array.from({ length: 7 }, (_, index) => addDays(date, index));
  $("#sevenDayList").innerHTML = days.map((day) => {
    const daily = sortByDate(state.plotings.filter((plot) => plot.planAiring === day));
    return `<div class="day-column"><h4>${formatDate(day, { weekday: "short", day: "2-digit", month: "short" })}<span>${daily.length} jadwal · ${sum(daily.map((plot) => plot.spot))} spot</span></h4>${daily.length ? daily.slice(0, 4).map((plot) => `<button class="day-event" data-edit-schedule="${escapeHTML(plot.id)}" type="button">${escapeHTML(plot.brand)}<small class="${isZeroSpot(plot.spot) ? "spot-zero" : ""}">${plot.spot} spot</small></button>`).join("") + (daily.length > 4 ? `<div class="calendar-more">+${daily.length - 4} lainnya</div>` : "") : `<span class="cell-subtitle">Tidak ada jadwal</span>`}</div>`;
  }).join("");
}

function renderFullTimeline() {
  const month = filters.full.month;
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
    ["Jadwal", plots.length, "Penayangan pada periode"],
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
    const dailyPlots = (eventsByDate[date] || []).sort((a, b) =>
      a.unit.localeCompare(b.unit, "id") || a.brand.localeCompare(b.brand, "id") || a.program.localeCompare(b.program, "id")
    );
    const dailySpot = sum(dailyPlots.map((plot) => plot.spot));
    const weekday = new Date(`${date}T00:00:00`).getDay();
    const weekend = weekday === 0 || weekday === 6 ? " full-calendar-weekend" : "";
    const isToday = date === state.operationDate ? " full-calendar-today" : "";
    const eventMarkup = dailyPlots.length
      ? `<div class="full-calendar-events full-calendar-events-all">${dailyPlots.map((plot) => `<button class="full-calendar-event full-calendar-event-grid ${isZeroSpot(plot.spot) ? "is-zero-spot" : ""}" data-edit-schedule="${escapeHTML(plot.id)}" type="button" title="${escapeHTML(`${plot.unit} · ${plot.brand} · ${plot.program} · ${plot.spot} spot`)}">
          <span class="full-calendar-event-top"><span class="full-calendar-unit">${unitLabelMarkup(plot.unit, "calendar")}</span><span class="full-calendar-spot ${isZeroSpot(plot.spot) ? "spot-zero" : ""}">${plot.spot}</span></span>
          <strong title="${escapeHTML(plot.brand)}">${escapeHTML(plot.brand)}</strong>
          <span class="full-calendar-program" title="${escapeHTML(plot.program)}">${escapeHTML(plot.program)}</span>
        </button>`).join("")}</div>`
      : `<span class="full-calendar-empty">Tidak ada jadwal</span>`;

    return `<div class="full-calendar-day${weekend}${isToday}">
      <div class="full-calendar-day-head"><strong>${dateIndex + 1}</strong>${dailyPlots.length ? `<span>${dailySpot} spot</span>` : ""}</div>
      ${eventMarkup}
    </div>`;
  }).join("");

  $("#fullTimelineCalendar").innerHTML = calendarCells || `<div class="full-calendar-empty-state">Tidak ada jadwal untuk filter yang dipilih.</div>`;

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
  const month = filters.brand.month;
  const unit = filters.brand.unit;
  const plots = sortByDate(state.plotings.filter((plot) => plot.brand === brand && monthKey(plot.planAiring) === month && (!unit || plot.unit === unit)));
  const titleParts = [brand, formatMonth(month), unit].filter(Boolean);
  $("#brandCalendarTitle").textContent = brand ? titleParts.join(" · ") : "Pilih brand";
  const stats = [
    ["Jadwal", plots.length, "Tanggal tayang"],
    ["Total spot", sum(plots.map((plot) => plot.spot)), "Periode terpilih"],
    ["Unit", unique(plots.map((plot) => plot.unit)).length, "Unit on air"],
    ["Program", unique(plots.map((plot) => plot.program)).length, "Program aktif"]
  ];
  $("#brandStats").innerHTML = stats.map(([label, value, note]) => `<article class="mini-kpi"><p>${label}</p><strong>${value}</strong><small>${note}</small></article>`).join("");
  renderCalendar(month, plots);
  const totalSpot = sum(plots.map((plot) => plot.spot));
  $("#brandTotalSpot").textContent = totalSpot;
  $("#brandDetailBody").innerHTML = plots.length ? plots.map((plot) => `<tr>
    <td>${formatDate(plot.planAiring)}</td>
    <td><span class="cell-title cell-title-unit">${unitLabelMarkup(plot.unit, "table")}<span class="unit-program-separator" aria-hidden="true">·</span><span class="unit-program-name">${escapeHTML(plot.program)}</span></span><span class="cell-subtitle">${escapeHTML(plot.pod)} · ${escapeHTML(plot.segmentation || "Tanpa segmentasi")}</span></td>
    <td><span class="cell-title">${escapeHTML(plot.format)} · ${escapeHTML(plot.duration)}</span><span class="cell-subtitle">${escapeHTML(plot.version)}</span></td>
    <td>${spotMarkup(plot.spot)}</td>
    <td>${escapeHTML(plot.gfx)}</td>
    <td>${badge(plot.airingStatus)}</td>
    <td class="schedule-note-cell">${plot.scheduleNote ? escapeHTML(plot.scheduleNote) : `<span class="empty-note">-</span>`}</td>
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
    cells.push(`<div class="calendar-day ${todayClass}"><div class="calendar-day-number">${day}</div>${events.slice(0, 3).map((plot) => `<button class="calendar-event" data-edit-schedule="${escapeHTML(plot.id)}" type="button">${unitLabelMarkup(plot.unit, "calendar")}<span class="calendar-program-title">${escapeHTML(plot.program)}</span><small class="${isZeroSpot(plot.spot) ? "spot-zero" : ""}">${plot.spot} spot</small></button>`).join("")}${events.length > 3 ? `<div class="calendar-more">+${events.length - 3} jadwal</div>` : ""}</div>`);
  }
  const remainder = cells.length % 7;
  if (remainder) for (let index = remainder; index < 7; index += 1) cells.push(`<div class="calendar-day muted-day"></div>`);
  container.innerHTML = cells.join("");
}

function renderPicReport() {
  const selectedPic = filters.pic.pic;
  const selectedMonth = filters.pic.month;
  const monthPlots = sortByDate(state.plotings.filter((plot) => !selectedMonth || monthKey(plot.planAiring) === selectedMonth));
  const selectedPlots = monthPlots.filter((plot) => !selectedPic || plot.pic === selectedPic);
  const selectedLabel = selectedPic || "Semua PIC";
  const monthLabel = selectedMonth ? formatMonth(selectedMonth) : "Semua periode";

  const metrics = [
    ["Batch benefit", uniqueBatchCount(selectedPlots), "Benefit unik"],
    ["Jadwal tayang", selectedPlots.length, "Tanggal terploting"],
    ["Total spot", sum(selectedPlots.map((plot) => plot.spot)), "Akumulasi spot"],
    ["Brand ditangani", unique(selectedPlots.map((plot) => plot.brand)).length, "Brand pada periode ini"],
    ["Program ditangani", unique(selectedPlots.map((plot) => plot.program)).length, "Program pada periode ini"]
  ];
  $("#picReportKpis").innerHTML = metrics.map(([label, value, note]) => `<article class="mini-kpi"><p>${label}</p><strong>${value}</strong><small>${note}</small></article>`).join("");

  const picNames = sortText(unique(monthPlots.map((plot) => plot.pic)));
  $("#picOverviewCaption").textContent = monthLabel;
  $("#picOverviewBody").innerHTML = picNames.length ? picNames.map((pic) => {
    const plots = monthPlots.filter((plot) => plot.pic === pic);
    return `<tr class="${pic === selectedPic ? "selected-pic-row" : ""}">
      <td><span class="pic-chip">${escapeHTML(pic)}</span></td>
      <td>${uniqueBatchCount(plots)}</td>
      <td>${plots.length}</td>
      <td><strong>${sum(plots.map((plot) => plot.spot))}</strong></td>
      <td>${unique(plots.map((plot) => plot.brand)).length}</td>
      <td>${unique(plots.map((plot) => plot.program)).length}</td>
      <td><button class="row-action" data-select-pic="${encodeURIComponent(pic)}" type="button">Lihat</button></td>
    </tr>`;
  }).join("") : `<tr><td colspan="7" class="empty-row">Belum ada ploting pada periode ini.</td></tr>`;

  $("#picScopeTitle").textContent = `${selectedLabel} · ${monthLabel}`;
  const scopeGroups = [
    { label: "Brand yang ditangani", values: unique(selectedPlots.map((plot) => plot.brand)) },
    { label: "Program yang ditangani", values: unique(selectedPlots.map((plot) => plot.program)) },
    { label: "Unit On Air", values: unique(selectedPlots.map((plot) => plot.unit)) }
  ];
  $("#picScopeList").innerHTML = selectedPlots.length ? scopeGroups.map((group) => `<div class="pic-scope-group"><strong>${escapeHTML(group.label)}</strong><div>${group.values.map((value) => `<span>${escapeHTML(value)}</span>`).join("")}</div></div>`).join("") : `<div class="empty-row">Belum ada data untuk PIC dan bulan yang dipilih.</div>`;

  $("#picDetailTitle").textContent = `Jadwal ${selectedLabel}`;
  $("#picDetailCaption").textContent = `${selectedPlots.length} jadwal · ${sum(selectedPlots.map((plot) => plot.spot))} spot · ${monthLabel}`;
  $("#picDetailBody").innerHTML = selectedPlots.length ? selectedPlots.map((plot) => `<tr>
    <td>${formatDate(plot.planAiring)}</td>
    <td><span class="cell-title">${escapeHTML(plot.batchId)}</span><span class="cell-subtitle">${escapeHTML(plot.pic)}</span></td>
    <td><span class="cell-title">${escapeHTML(plot.brand)}</span><span class="cell-subtitle">${escapeHTML(plot.advertiser)}</span></td>
    <td><span class="cell-title cell-title-unit">${unitLabelMarkup(plot.unit, "table")}<span class="unit-program-separator" aria-hidden="true">·</span><span class="unit-program-name">${escapeHTML(plot.program)}</span></span><span class="cell-subtitle">${escapeHTML(plot.pod)} · ${escapeHTML(plot.segmentation || "Tanpa segmentasi")}</span></td>
    <td><span class="cell-title">${escapeHTML(plot.format)} · ${escapeHTML(plot.duration)}</span><span class="cell-subtitle">${escapeHTML(plot.version)}</span></td>
    <td>${spotMarkup(plot.spot)}</td>
    <td>${badge(plot.airingStatus)}</td>
    <td><button class="row-action" data-edit-schedule="${escapeHTML(plot.id)}" type="button">Atur Jadwal</button></td>
  </tr>`).join("") : `<tr><td colspan="8" class="empty-row">Tidak ada jadwal untuk PIC dan periode ini.</td></tr>`;
}

function renderMasters() {
  const summary = Object.entries(MASTER_META).map(([key, meta]) => `<div class="summary-tile"><strong>${state.masters[key].length}</strong><span>${escapeHTML(meta.label)}</span></div>`).join("");
  $("#masterSummary").innerHTML = summary;
  $("#masterGrid").innerHTML = Object.entries(MASTER_META).map(([key, meta]) => `<article class="panel master-card"><div class="master-card-head"><div><p class="section-label">MASTER</p><h4>${escapeHTML(meta.label)}</h4></div><span>${state.masters[key].length} item</span></div><div class="master-list">${state.masters[key].map((value) => `<div class="master-list-item"><span>${escapeHTML(value)}</span><button class="master-delete" data-master-delete="${key}" data-master-value="${encodeURIComponent(value)}" type="button">Hapus</button></div>`).join("")}</div></article>`).join("");
}

function renderAll() {
  populateSelects();
  $("#operationDate").value = state.operationDate;
  renderDashboard();
  renderPlotings();
  renderDaily();
  renderFullTimeline();
  renderBrand();
  renderPicReport();
  renderMasters();
  updatePageTitle();
}

function updatePageTitle() {
  const labels = {
    dashboard: ["OPERATIONS DASHBOARD", "VA Benefit Ploting"],
    plotings: ["2026 VA DIGITAL", "Master Ploting VA"],
    daily: ["PIVOT MASTER", "Timeline Harian"],
    fulltimeline: ["TIMELINE BULANAN", "Kalender Full"],
    brand: ["TIMELINE BRAND", "Timeline Brand"],
    picreport: ["MONITORING PIC", "Report per PIC"],
    masters: ["DATABASE PILIHAN", "Master Data"],
    guide: ["PANDUAN OPERASIONAL", "Alur Kerja"]
  };
  const [eyebrow, title] = labels[activeView] || labels.dashboard;
  $("#pageEyebrow").textContent = eyebrow;
  $("#pageTitle").textContent = title;
}

function setView(view) {
  activeView = view;
  $$(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  $$("[data-view-panel]").forEach((panel) => panel.classList.toggle("active", panel.dataset.viewPanel === view));
  updatePageTitle();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function buildScheduleRow(date = state.operationDate, spot = 1, airingStatus = "Planned", scheduleNote = "") {
  // Spot 0 valid, misalnya ketika jadwal tetap dicatat tetapi tidak jadi tayang.
  const normalizedSpot = Number.isInteger(Number(spot)) && Number(spot) >= 0 ? Number(spot) : 1;
  return `<tr class="schedule-row">
    <td><input class="schedule-date-input" type="date" value="${escapeHTML(date)}" required /></td>
    <td><input class="schedule-spot-input" type="number" min="0" max="999" step="1" value="${normalizedSpot}" required /></td>
    <td><select class="schedule-status-input" required>${optionMarkup(AIRING_STATUSES, "Pilih status", airingStatus || "Planned")}</select></td>
    <td><input class="schedule-note-input" maxlength="220" value="${escapeHTML(scheduleNote)}" placeholder="Note khusus tanggal ini" /></td>
    <td><button class="remove-schedule" data-remove-schedule type="button">Hapus</button></td>
  </tr>`;
}

function addScheduleRow(date = state.operationDate, spot = 1, airingStatus = "Planned", scheduleNote = "") {
  $("#scheduleRows").insertAdjacentHTML("beforeend", buildScheduleRow(date, spot, airingStatus, scheduleNote));
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
    addScheduleRow(state.operationDate, 1, "Planned", "");
    $("#plotModalTitle").textContent = "Tambah Ploting Benefit";
  }
  updateScheduleRemoveButtons();
  $("#plotModalBackdrop").classList.add("open");
  $("#plotModalBackdrop").setAttribute("aria-hidden", "false");
  setTimeout(() => $("#plotAdvertiserInput").focus(), 40);
}

function closePlotModal() {
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

function formPayload() {
  return {
    advertiser: $("#plotAdvertiserInput").value,
    brand: $("#plotBrandInput").value.trim(),
    sales: $("#plotSalesInput").value.trim(),
    pic: $("#plotPicInput").value,
    unit: $("#plotUnitInput").value,
    program: $("#plotProgramInput").value.trim(),
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
  if (existingBatchId) {
    const oldBatch = getBatch(existingBatchId);
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
    showToast(`Batch ${newBatchId} disimpan. ${schedules.length} jadwal dibuat otomatis.`);
  }
  state.masters = normalizeMasters(state.masters, state.plotings);
  saveState();
  closePlotModal();
  renderAll();
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
}

function openScheduleModal(scheduleId) {
  const plot = state.plotings.find((item) => item.id === scheduleId);
  if (!plot) { showToast("Jadwal tidak ditemukan."); return; }
  $("#scheduleEditIdInput").value = plot.id;
  $("#scheduleEditContext").innerHTML = `<strong>${escapeHTML(plot.brand)} · ${escapeHTML(plot.program)}</strong><span>${escapeHTML(plot.batchId)} · ${escapeHTML(plot.unit)} · ${escapeHTML(plot.pod)}</span>`;
  $("#scheduleEditDateInput").value = plot.planAiring;
  $("#scheduleEditSpotInput").value = plot.spot;
  $("#scheduleEditSpotInput").classList.toggle("zero-spot-input", isZeroSpot(plot.spot));
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
}

function deleteMasterValue(key, encodedValue) {
  const meta = MASTER_META[key];
  const value = decodeURIComponent(encodedValue || "");
  if (!meta || !value) return;
  const used = state.plotings.some((plot) => plot[meta.field] === value);
  if (used) { showToast("Data ini sudah digunakan pada ploting sehingga tidak dapat dihapus."); return; }
  state.masters[key] = state.masters[key].filter((item) => item !== value);
  saveState();
  renderAll();
  showToast(`${meta.label} dihapus dari Master Data.`);
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
  const scope = [filters.plot.month ? formatMonth(filters.plot.month) : "semua-periode", filters.plot.unit || "semua-unit"].join("-");
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
  const selectedMonth = filters.pic.month;
  const monthPlots = sortByDate(state.plotings.filter((plot) => !selectedMonth || monthKey(plot.planAiring) === selectedMonth));
  const selectedPlots = monthPlots.filter((plot) => !selectedPic || plot.pic === selectedPic);
  const picNames = sortText(unique(monthPlots.map((plot) => plot.pic)));
  const summaryRows = picNames.map((pic, index) => {
    const plots = monthPlots.filter((plot) => plot.pic === pic);
    return [index + 1, pic, uniqueBatchCount(plots), plots.length, sum(plots.map((plot) => plot.spot)), unique(plots.map((plot) => plot.brand)).join(", "), unique(plots.map((plot) => plot.program)).join(", "), unique(plots.map((plot) => plot.unit)).join(", ")];
  });
  return { selectedPic, selectedMonth, monthPlots, selectedPlots, summaryRows };
}

function exportPicExcel() {
  const { selectedPic, selectedMonth, selectedPlots, summaryRows } = getPicExportData();
  if (!selectedPlots.length && !summaryRows.length) { showToast("Tidak ada data Report PIC untuk diexport."); return; }
  const period = selectedMonth ? formatMonth(selectedMonth) : "semua-periode";
  const detailRows = masterPlotingExportRows(selectedPlots).map((row) => [row[0], row[1], row[2], row[6], row[3], row[4], row[7], row[8], row[9], row[11], row[12], row[14], row[15], row[16], row[18]]);
  exportExcelWorkbook(`report-pic-${selectedPic || "semua-pic"}-${period}-${state.operationDate}`, [
    {
      name: "Ringkasan PIC",
      headers: ["No", "PIC Ploting", "Batch", "Jadwal", "Total Spot", "Brand Ditangani", "Program Ditangani", "Unit On Air"],
      rows: summaryRows,
      numericColumns: [0, 2, 3, 4],
      widths: [42, 110, 55, 60, 70, 220, 250, 120]
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

function bindEvents() {
  $$(".nav-item").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
  $("#primaryActionButton").addEventListener("click", () => openPlotModal());
  $("#addPlotInlineButton").addEventListener("click", () => openPlotModal());
  $("#plotForm").addEventListener("submit", savePlotFromForm);
  $("#scheduleEditForm").addEventListener("submit", saveScheduleFromForm);
  $("#scheduleEditStatusInput").addEventListener("change", syncScheduleSlideControls);
  $("#scheduleEditSpotInput").addEventListener("input", (event) => { event.target.classList.toggle("zero-spot-input", Number(event.target.value) === 0); syncScheduleSlideControls(); });
  $("#scheduleEditDateInput").addEventListener("change", syncScheduleSlideControls);
  $("#scheduleSlideToggle").addEventListener("change", syncScheduleSlideControls);
  $("#masterForm").addEventListener("submit", addMasterValue);
  $("#addScheduleButton").addEventListener("click", () => addScheduleRow(addDays(state.operationDate, 1), 1, "Planned", ""));
  $("#exportPlotingsExcelButton").addEventListener("click", exportPlotingsExcel);
  $("#exportPicExcelButton").addEventListener("click", exportPicExcel);
  $("#authLoginForm").addEventListener("submit", signInWithPassword);
  $$(".auth-account-button").forEach((button) => button.addEventListener("click", () => selectTeamAccount(button.dataset.teamAccount, true)));
  $("#authPasswordInput").addEventListener("input", updateAuthForm);
  $("#signOutButton").addEventListener("click", signOutFromFirebase);

  $("#operationDate").addEventListener("change", (event) => { state.operationDate = event.target.value || DEFAULT_OPERATION_DATE; saveState(); renderAll(); });
  $("#dailyDateInput").addEventListener("change", (event) => { state.operationDate = event.target.value || DEFAULT_OPERATION_DATE; saveState(); renderAll(); });
  $("#plotSearchInput").addEventListener("input", (event) => { filters.plot.query = event.target.value; filters.plot.page = 1; renderPlotings(); });
  $("#plotMonthFilter").addEventListener("change", (event) => { filters.plot.month = event.target.value; filters.plot.page = 1; renderPlotings(); });
  $("#plotUnitFilter").addEventListener("change", (event) => { filters.plot.unit = event.target.value; filters.plot.page = 1; renderPlotings(); });
  $("#plotGfxFilter").addEventListener("change", (event) => { filters.plot.gfx = event.target.value; filters.plot.page = 1; renderPlotings(); });
  $("#plotAiringFilter").addEventListener("change", (event) => { filters.plot.airing = event.target.value; filters.plot.page = 1; renderPlotings(); });
  $("#resetPlotFilterButton").addEventListener("click", () => {
    filters.plot = { query: "", month: "", unit: "", gfx: "", airing: "", page: 1, perPage: 20 };
    $("#plotSearchInput").value = "";
    populateSelects();
    renderPlotings();
  });
  $("#fullTimelineMonthSelect").addEventListener("change", (event) => { filters.full.month = event.target.value; renderFullTimeline(); });
  $("#fullTimelineUnitSelect").addEventListener("change", (event) => { filters.full.unit = event.target.value; renderFullTimeline(); });
  $("#fullTimelineBrandSelect").addEventListener("change", (event) => { filters.full.brand = event.target.value; renderFullTimeline(); });
  $("#brandSelect").addEventListener("change", (event) => { filters.brand.brand = event.target.value; renderBrand(); });
  $("#brandMonthSelect").addEventListener("change", (event) => { filters.brand.month = event.target.value; renderBrand(); });
  $("#brandUnitSelect").addEventListener("change", (event) => { filters.brand.unit = event.target.value; renderBrand(); });
  $("#picReportSelect").addEventListener("change", (event) => { filters.pic.pic = event.target.value; renderPicReport(); });
  $("#picReportMonthSelect").addEventListener("change", (event) => { filters.pic.month = event.target.value; renderPicReport(); });
  $("#masterTypeInput").addEventListener("change", (event) => { $("#masterValueInput").placeholder = MASTER_META[event.target.value].placeholder; });

  document.addEventListener("click", (event) => {
    const closeButton = event.target.closest("[data-close-modal]");
    if (closeButton) { closePlotModal(); return; }
    const closeScheduleButton = event.target.closest("[data-close-schedule-modal]");
    if (closeScheduleButton) { closeScheduleModal(); return; }
    const editSchedule = event.target.closest("[data-edit-schedule]");
    if (editSchedule) { openScheduleModal(editSchedule.dataset.editSchedule); return; }
    const editBatch = event.target.closest("[data-edit-batch]");
    if (editBatch) { openPlotModal(editBatch.dataset.editBatch); return; }
    const goView = event.target.closest("[data-go-view]");
    if (goView) { setView(goView.dataset.goView); return; }
    const plotPage = event.target.closest("[data-plot-page]");
    if (plotPage && !plotPage.disabled) {
      const nextPage = Number(plotPage.dataset.plotPage);
      if (Number.isFinite(nextPage)) {
        filters.plot.page = nextPage;
        renderPlotings();
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
    const selectPic = event.target.closest("[data-select-pic]");
    if (selectPic) { filters.pic.pic = decodeURIComponent(selectPic.dataset.selectPic || ""); populateSelects(); renderPicReport(); return; }
    const removeSchedule = event.target.closest("[data-remove-schedule]");
    if (removeSchedule) {
      const rows = $$("#scheduleRows .schedule-row");
      if (rows.length > 1) removeSchedule.closest(".schedule-row").remove();
      updateScheduleRemoveButtons();
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
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") { closePlotModal(); closeScheduleModal(); } });
}

bindEvents();
renderAll();
initializeFirebaseRealtime();
