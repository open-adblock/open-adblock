const version = document.getElementById("version");
const navItems = [...document.querySelectorAll(".nav-item")];
const views = [...document.querySelectorAll(".view")];
const themeControl = document.getElementById("themeControl");
const runUpdate = document.getElementById("runUpdate");
const remoteVersion = document.getElementById("remoteVersion");
const remoteUpdatedAt = document.getElementById("remoteUpdatedAt");
const cosmeticCount = document.getElementById("cosmeticCount");
const remoteError = document.getElementById("remoteError");
const sourceList = document.getElementById("sourceList");
const userRulesList = document.getElementById("userRulesList");
const toast = document.getElementById("toast");

let state = null;
const manifest = getRuntime()?.getManifest?.() || { version: "0.1.0" };
version.textContent = `v${manifest.version}`;

navItems.forEach((item) => {
  item.addEventListener("click", () => switchView(item.dataset.view));
});

themeControl.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-theme-value]");
  if (!button) return;
  await saveSettings({ theme: button.dataset.themeValue });
});

runUpdate.addEventListener("click", async () => {
  runUpdate.disabled = true;
  runUpdate.textContent = "Updating";

  try {
    const result = await sendMessage("RUN_REMOTE_UPDATE");
    showToast(`Updated ${result.networkRuleCount} network rules`);
    await load();
  } catch (error) {
    showToast(error.message);
    await load();
  } finally {
    runUpdate.disabled = false;
    runUpdate.textContent = "Update now";
  }
});

userRulesList.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-remove-rule]");
  if (!button) return;
  await sendMessage("REMOVE_USER_COSMETIC_RULE", { id: button.dataset.removeRule });
  showToast("Removed local rule");
  await load();
});

load();

async function load() {
  try {
    state = await sendMessage("GET_OPTIONS_STATE");
    render();
  } catch (error) {
    if (!hasRuntimeMessaging()) {
      state = getPreviewOptionsState();
      render();
      showToast("Preview mode. Load mv3 as an unpacked extension for live data.");
      return;
    }
    showToast(error.message);
  }
}

async function saveSettings(partial) {
  const response = await sendMessage("SAVE_SETTINGS", { settings: partial });
  state.settings = response.settings;
  render();
  showToast("Saved");
}

function render() {
  const settings = state.settings || {};
  const filters = state.filters || {};
  const packaged = state.cosmeticPackaged || {};
  const remote = state.cosmeticRemote || {};

  document.documentElement.dataset.theme = resolveTheme(settings.theme || "system");

  for (const button of themeControl.querySelectorAll("button")) {
    button.classList.toggle("is-active", button.dataset.themeValue === (settings.theme || "system"));
  }

  remoteVersion.textContent = filters.remoteVersion || "None";
  remoteUpdatedAt.textContent = filters.remoteUpdatedAt ? formatDate(filters.remoteUpdatedAt) : "Never";
  cosmeticCount.textContent = formatNumber(countCosmeticRules(packaged) + countCosmeticRules(remote));

  if (filters.remoteLastError) {
    remoteError.hidden = false;
    remoteError.textContent = filters.remoteLastError;
  } else {
    remoteError.hidden = true;
    remoteError.textContent = "";
  }

  renderSources(filters.sourceSummary || []);
  renderUserRules(state.userCosmeticRules || []);
}

function renderSources(sources) {
  if (sources.length === 0) {
    sourceList.innerHTML = `<div class="empty">No remote sources have been applied yet.</div>`;
    return;
  }

  sourceList.innerHTML = sources
    .map((source) => `
      <article class="list-item">
        <div>
          <strong>${escapeHtml(source.name || "Source")}</strong>
          <code>${escapeHtml(source.url || "")}</code>
        </div>
        <code>${escapeHtml(source.license || "unknown")}</code>
      </article>
    `)
    .join("");
}

function renderUserRules(rules) {
  if (rules.length === 0) {
    userRulesList.innerHTML = `<div class="empty">No element blocking rules yet.</div>`;
    return;
  }

  userRulesList.innerHTML = rules
    .map((rule) => `
      <article class="list-item">
        <div>
          <strong>${escapeHtml(rule.hostname)}</strong>
          <code>${escapeHtml(rule.selector)}</code>
        </div>
        <button data-remove-rule="${escapeHtml(rule.id)}">Remove</button>
      </article>
    `)
    .join("");
}

function switchView(viewName) {
  navItems.forEach((item) => item.classList.toggle("is-active", item.dataset.view === viewName));
  views.forEach((view) => view.classList.toggle("is-active", view.id === `view-${viewName}`));
}

function resolveTheme(theme) {
  if (theme === "dark" || theme === "light") return theme;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function countCosmeticRules(remote) {
  return (
    (remote.global || []).length +
    Object.values(remote.byHost || {}).reduce((sum, selectors) => sum + selectors.length, 0)
  );
}

function formatDate(timestamp) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(timestamp));
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(Number(value || 0));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function showToast(message) {
  toast.textContent = message;
  toast.hidden = false;
  setTimeout(() => {
    toast.hidden = true;
  }, 2200);
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

function getPreviewOptionsState() {
  return {
    settings: {
      theme: "system"
    },
    siteState: {},
    stats: {
      lifetimeBlocked: 0,
      pagesSeen: 0,
      bandwidthSavedBytesEstimate: 0,
      startedAt: Date.now()
    },
    userCosmeticRules: [],
    cosmeticPackaged: {
      global: [],
      byHost: {
        "cnn.com": [".ad-slot-dynamic", ".zone__ads"]
      },
      exceptions: {
        global: [],
        byHost: {
          "cnn.com": ["#outbrain_widget_0"]
        }
      }
    },
    cosmeticRemote: {
      global: [],
      byHost: {},
      exceptions: { global: [], byHost: {} }
    },
    filters: {
      remoteVersion: null,
      remoteUpdatedAt: null,
      remoteLastError: null,
      sourceSummary: []
    }
  };
}
