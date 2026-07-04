/*
  VA Benefit Ploting - deployed version checker
  Mengecek version.json setiap 60 detik. Bila deploy baru tersedia,
  halaman akan dimuat ulang saat pengguna tidak sedang mengisi form.
*/
(() => {
  "use strict";

  const VERSION_URL = "version.json";
  const CHECK_INTERVAL_MS = 60_000;
  const RETRY_INTERVAL_MS = 15_000;
  const SESSION_VERSION_KEY = "va-benefit-ploting-active-build";
  const NOTICE_ID = "appUpdateNotice";

  let activeVersion = "";
  let updatePending = false;
  let reloadScheduled = false;
  let retryTimer = null;

  function createNotice() {
    let notice = document.getElementById(NOTICE_ID);
    if (notice) return notice;

    notice = document.createElement("div");
    notice.id = NOTICE_ID;
    notice.className = "app-update-notice";
    notice.setAttribute("role", "status");
    notice.setAttribute("aria-live", "polite");
    document.body.appendChild(notice);
    return notice;
  }

  function showNotice(message) {
    const notice = createNotice();
    notice.textContent = message;
    notice.classList.add("show");
  }

  function isUserEditing() {
    const openModal = document.querySelector(".modal-backdrop.open");
    if (openModal) return true;

    const activeElement = document.activeElement;
    if (activeElement?.matches("input, textarea, select")) return true;

    const authGate = document.getElementById("authGate");
    const authPassword = document.getElementById("authPasswordInput");
    return Boolean(!authGate?.hidden && authPassword?.value);
  }

  async function fetchPublishedVersion() {
    const url = new URL(VERSION_URL, window.location.href);
    url.searchParams.set("t", String(Date.now()));

    const response = await fetch(url.href, {
      cache: "no-store",
      headers: { "Cache-Control": "no-cache" }
    });

    if (!response.ok) return "";
    const data = await response.json();
    return String(data?.version || "").trim();
  }

  function reloadForUpdate() {
    if (reloadScheduled) return;
    reloadScheduled = true;
    showNotice("Versi terbaru tersedia. Halaman sedang diperbarui...");

    window.setTimeout(() => {
      const destination = new URL(window.location.href);
      destination.searchParams.set("updated", Date.now().toString());
      window.location.replace(destination.href);
    }, 900);
  }

  function tryApplyUpdate() {
    if (!updatePending) return;
    if (isUserEditing()) {
      showNotice("Versi terbaru tersedia. Halaman akan diperbarui setelah form selesai digunakan.");
      if (!retryTimer) {
        retryTimer = window.setTimeout(() => {
          retryTimer = null;
          tryApplyUpdate();
        }, RETRY_INTERVAL_MS);
      }
      return;
    }

    updatePending = false;
    reloadForUpdate();
  }

  async function checkForUpdate() {
    try {
      const publishedVersion = await fetchPublishedVersion();
      if (!publishedVersion) return;

      const rememberedVersion = sessionStorage.getItem(SESSION_VERSION_KEY) || "";
      if (!activeVersion) {
        activeVersion = rememberedVersion || publishedVersion;
        if (!rememberedVersion) {
          sessionStorage.setItem(SESSION_VERSION_KEY, publishedVersion);
          return;
        }
      }

      if (publishedVersion === activeVersion) return;

      activeVersion = publishedVersion;
      sessionStorage.setItem(SESSION_VERSION_KEY, publishedVersion);
      updatePending = true;
      tryApplyUpdate();
    } catch (error) {
      // Gagal cek versi tidak boleh mengganggu proses login atau pekerjaan pengguna.
      console.warn("Pengecekan versi website gagal.", error);
    }
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      checkForUpdate();
      tryApplyUpdate();
    }
  });

  document.addEventListener("focusout", () => {
    window.setTimeout(tryApplyUpdate, 0);
  });

  window.addEventListener("online", checkForUpdate);
  window.setInterval(checkForUpdate, CHECK_INTERVAL_MS);
  checkForUpdate();
})();
