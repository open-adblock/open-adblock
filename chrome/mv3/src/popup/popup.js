const app = document.getElementById("app");
const version = document.getElementById("version");
const hostname = document.getElementById("hostname");
const stateLabel = document.getElementById("stateLabel");
const siteToggle = document.getElementById("siteToggle");
const pageBlocked = document.getElementById("pageBlocked");
const pageBlockedSub = document.getElementById("pageBlockedSub");
const savedAmount = document.getElementById("savedAmount");
const savedUnit = document.getElementById("savedUnit");
const savedSub = document.getElementById("savedSub");
const lifetimeBlocked = document.getElementById("lifetimeBlocked");
const lifetimeSince = document.getElementById("lifetimeSince");
const bandwidthSaved = document.getElementById("bandwidthSaved");
const bandwidthUnit = document.getElementById("bandwidthUnit");
const timeSaved = document.getElementById("timeSaved");
const pagesSeen = document.getElementById("pagesSeen");
const settingsButton = document.getElementById("settingsButton");
const blockElementButton = document.getElementById("blockElementButton");
const reportButton = document.getElementById("reportButton");
const reportDialog = document.getElementById("reportDialog");
const reportForm = document.getElementById("reportForm");
const reportHost = document.getElementById("reportHost");
const reportCategory = document.getElementById("reportCategory");
const reportDetails = document.getElementById("reportDetails");
const reportIncludeUrl = document.getElementById("reportIncludeUrl");
const reportIncludeScreenshot = document.getElementById("reportIncludeScreenshot");
const reportCloseButton = document.getElementById("reportCloseButton");
const reportCancelButton = document.getElementById("reportCancelButton");
const reportSubmitButton = document.getElementById("reportSubmitButton");
const toast = document.getElementById("toast");

let state = null;
let toastTimer = null;

settingsButton.addEventListener("click", () => {
  sendMessage("OPEN_OPTIONS").catch((error) => showToast(error.message));
});

siteToggle.addEventListener("click", async () => {
  if (!state?.hostname) return;

  try {
    const response = await sendMessage("SET_SITE_PAUSED", {
      hostname: state.hostname,
      paused: !state.paused
    });
    state.paused = response.paused;
    render(state);
  } catch (error) {
    showToast(error.message);
  }
});

blockElementButton.addEventListener("click", async () => {
  try {
    await sendMessage("START_ELEMENT_PICKER");
    window.close();
  } catch (error) {
    showToast(error.message);
  }
});

reportButton.addEventListener("click", async () => {
  if (!state?.hostname) return;
  openReportDialog();
});

reportCloseButton.addEventListener("click", closeReportDialog);
reportCancelButton.addEventListener("click", closeReportDialog);

reportDialog.addEventListener("click", (event) => {
  if (event.target === reportDialog) {
    closeReportDialog();
  }
});

reportForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state?.hostname) return;

  reportSubmitButton.disabled = true;
  reportCancelButton.disabled = true;
  reportSubmitButton.textContent = "Sending";
  try {
    const report = await sendMessage("REPORT_BREAKAGE", {
      url: state.url,
      hostname: state.hostname,
      category: reportCategory.value,
      details: reportDetails.value,
      includeUrl: reportIncludeUrl.checked,
      includeScreenshot: reportIncludeScreenshot.checked
    });
    render(state);
    closeReportDialog();
    showReportToast(report);
  } catch (error) {
    showToast(error.message);
  } finally {
    reportSubmitButton.disabled = false;
    reportCancelButton.disabled = false;
    reportSubmitButton.textContent = "Send report";
  }
});

load();

async function load() {
  try {
    state = await sendMessage("GET_POPUP_STATE");
    render(state);
  } catch (error) {
    if (!hasRuntimeMessaging()) {
      state = getPreviewPopupState();
      render(state);
      showToast("Preview mode. Load mv3 as an unpacked extension for live data.");
      return;
    }
    showToast(error.message);
  }
}

function render(nextState) {
  const theme = resolveTheme(nextState.settings?.theme || "system");
  document.documentElement.dataset.theme = theme;

  version.textContent = formatVersion(nextState.version);
  hostname.textContent = nextState.hostname || "Unsupported page";
  stateLabel.textContent = nextState.paused ? "Paused" : "Protected";
  app.classList.toggle("is-paused", Boolean(nextState.paused));
  siteToggle.setAttribute("aria-checked", String(!nextState.paused));

  siteToggle.disabled = !nextState.supportedPage || !nextState.hostname;
  blockElementButton.disabled = !nextState.supportedPage || !nextState.hostname;
  reportButton.disabled = !nextState.supportedPage || !nextState.hostname;

  const blocked = Number(nextState.pageBlocked || 0);
  const pageBreakdown = estimatePageBreakdown(blocked);
  const saved = formatBytes(estimateSavedBytes(blocked));
  pageBlocked.textContent = formatNumber(blocked);
  pageBlockedSub.textContent = `${formatNumber(pageBreakdown.trackers)} trackers · ${formatNumber(pageBreakdown.ads)} ads · ${formatNumber(pageBreakdown.other)} other`;
  savedAmount.textContent = saved.value;
  savedUnit.textContent = saved.unit;
  savedSub.textContent = `${estimateLoadTimeSaved(blocked)}s faster load`;

  const lifetime = Number(nextState.stats?.lifetimeBlocked || 0);
  const startedAt = Number(nextState.stats?.startedAt || Date.now());
  const lifetimeBytes = Number(nextState.stats?.bandwidthSavedBytesEstimate || estimateSavedBytes(lifetime));
  const bandwidth = formatBytes(lifetimeBytes);
  lifetimeBlocked.textContent = formatNumber(lifetime);
  lifetimeSince.textContent = `blocked since ${formatShortDate(startedAt)}`;
  bandwidthSaved.textContent = bandwidth.value;
  bandwidthUnit.textContent = bandwidth.unit;
  timeSaved.textContent = formatHoursSaved(lifetime);
  pagesSeen.textContent = formatNumber(nextState.stats?.pagesSeen || 0);
}

function openReportDialog() {
  reportHost.textContent = state.hostname;
  reportCategory.value = "breakage";
  reportDetails.value = "";
  reportIncludeUrl.checked = true;
  reportIncludeScreenshot.checked = true;
  reportSubmitButton.disabled = false;
  reportCancelButton.disabled = false;
  reportSubmitButton.textContent = "Send report";
  reportDialog.showModal();
  reportDetails.focus();
}

function closeReportDialog() {
  if (reportDialog.open) {
    reportDialog.close();
  }
}

function resolveTheme(theme) {
  if (theme === "dark" || theme === "light") return theme;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatVersion(value) {
  const [major = "0", minor = "0"] = String(value || "0.0").split(".");
  return `v${major}.${minor}`;
}

function estimatePageBreakdown(blocked) {
  if (blocked <= 0) {
    return { trackers: 0, ads: 0, other: 0 };
  }

  const trackers = Math.round(blocked * 0.6);
  const ads = Math.max(0, Math.round(blocked * 0.35));
  const other = Math.max(0, blocked - trackers - ads);
  return { trackers, ads, other };
}

function estimateSavedBytes(blocked) {
  return Math.max(0, blocked) * 64 * 1024;
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024 * 1024) {
    return { value: trimDecimal(bytes / (1024 * 1024 * 1024)), unit: "GB" };
  }

  if (bytes >= 1024 * 1024) {
    return { value: trimDecimal(bytes / (1024 * 1024)), unit: "MB" };
  }

  return { value: formatNumber(Math.round(bytes / 1024)), unit: "KB" };
}

function trimDecimal(value) {
  return value >= 10 ? String(Math.round(value)) : value.toFixed(1);
}

function estimateLoadTimeSaved(blocked) {
  return (Math.max(0, blocked) * 0.035).toFixed(1);
}

function formatHoursSaved(blocked) {
  return (Math.max(0, blocked) * 0.000034).toFixed(1);
}

function formatShortDate(timestamp) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric"
  }).format(new Date(timestamp));
}

function showReportToast(report) {
  if (report?.status === "submitted" && report.issueUrl) {
    showToast("Report sent", {
      actionLabel: report.issueNumber ? `View #${report.issueNumber}` : "View details",
      actionUrl: report.issueUrl,
      duration: 5000
    });
    return;
  }

  if (report?.status === "submitted" && report.issueNumber) {
    showToast(`Report sent to GitHub #${report.issueNumber}`);
    return;
  }

  showToast("Report sent");
}

function showToast(message, { actionLabel = "", actionUrl = "", duration = 2200 } = {}) {
  clearTimeout(toastTimer);
  toast.replaceChildren();

  const messageNode = document.createElement("span");
  messageNode.className = "toast-message";
  messageNode.textContent = message;
  toast.append(messageNode);

  if (actionUrl && actionLabel) {
    const link = document.createElement("a");
    link.className = "toast-action";
    link.href = actionUrl;
    link.textContent = actionLabel;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.addEventListener("click", (event) => {
      event.preventDefault();
      openUrl(actionUrl);
    });
    toast.append(link);
  }

  toast.hidden = false;
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, duration);
}

function openUrl(url) {
  if (globalThis.chrome?.tabs?.create) {
    globalThis.chrome.tabs.create({ url });
    window.close();
    return;
  }

  window.open(url, "_blank", "noopener,noreferrer");
}

function sendMessage(type, payload = {}) {
  return new Promise((resolve, reject) => {
    const runtime = getRuntime();
    if (!runtime?.sendMessage) {
      reject(new Error("OpenAdBlock must be loaded as an unpacked extension to use this action."));
      return;
    }

    runtime.sendMessage({ type, ...payload }, (response) => {
      if (runtime.lastError) {
        reject(new Error(runtime.lastError.message));
        return;
      }

      if (!response?.ok) {
        reject(new Error(response?.error || "OpenAdBlock request failed"));
        return;
      }

      resolve(response.payload);
    });
  });
}

function hasRuntimeMessaging() {
  return Boolean(getRuntime()?.sendMessage);
}

function getRuntime() {
  return globalThis.chrome?.runtime;
}

function getPreviewPopupState() {
  return {
    version: "1.4.0",
    url: "https://www.nytimes.com/",
    hostname: "nytimes.com",
    supportedPage: true,
    paused: false,
    pageBlocked: 23,
    settings: { theme: "system" },
    stats: {
      lifetimeBlocked: 184302,
      pagesSeen: 1847,
      bandwidthSavedBytesEstimate: 2.4 * 1024 * 1024 * 1024,
      startedAt: new Date("2026-01-12T00:00:00").getTime()
    },
    filters: { remoteVersion: "Packaged" },
    userCosmeticRuleCount: 0
  };
}
