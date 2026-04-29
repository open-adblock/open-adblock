(() => {
  if (window.__openAdblockPickerActive) return;
  window.__openAdblockPickerActive = true;

  const UI_ATTR = "data-openadblock-picker-ui";
  const STYLE_ID = "openadblock-picker-style";
  let currentElement = null;

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.setAttribute(UI_ATTR, "true");
  style.textContent = `
    .openadblock-picker-box {
      position: fixed;
      z-index: 2147483646;
      border: 2px solid #84cc16;
      background: rgba(132, 204, 22, 0.12);
      box-shadow: 0 0 0 99999px rgba(0, 0, 0, 0.22);
      pointer-events: none;
      box-sizing: border-box;
    }
    .openadblock-picker-label {
      position: fixed;
      z-index: 2147483647;
      max-width: min(420px, calc(100vw - 24px));
      padding: 7px 9px;
      border-radius: 6px;
      background: #111;
      color: #f7f7f5;
      font: 12px/1.35 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      pointer-events: none;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
    }
  `;

  const box = document.createElement("div");
  box.className = "openadblock-picker-box";
  box.setAttribute(UI_ATTR, "true");

  const label = document.createElement("div");
  label.className = "openadblock-picker-label";
  label.setAttribute(UI_ATTR, "true");
  label.textContent = "Click an element to block. Press Esc to cancel.";

  document.documentElement.append(style, box, label);
  document.addEventListener("mousemove", onMouseMove, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("scroll", refreshOverlay, true);
  window.addEventListener("resize", refreshOverlay, true);

  function onMouseMove(event) {
    const target = event.target;
    if (!(target instanceof Element) || target.hasAttribute(UI_ATTR)) return;
    currentElement = target;
    refreshOverlay(event.clientX, event.clientY);
  }

  function refreshOverlay(mouseX, mouseY) {
    if (!currentElement || !document.documentElement.contains(currentElement)) return;

    const rect = currentElement.getBoundingClientRect();
    box.style.left = `${Math.max(0, rect.left)}px`;
    box.style.top = `${Math.max(0, rect.top)}px`;
    box.style.width = `${Math.max(0, rect.width)}px`;
    box.style.height = `${Math.max(0, rect.height)}px`;

    const selector = buildSelector(currentElement);
    label.textContent = selector || "Click an element to block. Press Esc to cancel.";

    const x = typeof mouseX === "number" ? mouseX : Math.max(12, rect.left);
    const y = typeof mouseY === "number" ? mouseY : Math.max(12, rect.top);
    label.style.left = `${Math.min(window.innerWidth - 24, Math.max(12, x + 12))}px`;
    label.style.top = `${Math.min(window.innerHeight - 40, Math.max(12, y + 12))}px`;
  }

  function onClick(event) {
    if (!currentElement || currentElement.hasAttribute(UI_ATTR)) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    const selector = buildSelector(currentElement);
    if (!selector) {
      cleanup();
      return;
    }

    const elementToHide = currentElement;
    const runtime = globalThis.chrome?.runtime;
    if (!runtime?.sendMessage) {
      elementToHide.style.setProperty("display", "none", "important");
      cleanup();
      return;
    }

    runtime.sendMessage(
      {
        type: "ADD_USER_COSMETIC_RULE",
        hostname: location.hostname,
        selector
      },
      () => {
        elementToHide.style.setProperty("display", "none", "important");
        cleanup();
      }
    );
  }

  function onKeyDown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cleanup();
    }
  }

  function cleanup() {
    document.removeEventListener("mousemove", onMouseMove, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("scroll", refreshOverlay, true);
    window.removeEventListener("resize", refreshOverlay, true);
    style.remove();
    box.remove();
    label.remove();
    window.__openAdblockPickerActive = false;
  }

  function buildSelector(element) {
    if (!(element instanceof Element)) return "";

    if (element.id) {
      const byId = `#${cssEscape(element.id)}`;
      if (isUnique(byId)) return byId;
    }

    const parts = [];
    let node = element;

    while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.documentElement) {
      const part = selectorPart(node);
      if (!part) break;
      parts.unshift(part);

      const selector = parts.join(" > ");
      if (isUnique(selector)) return selector;

      node = node.parentElement;
      if (parts.length >= 5) break;
    }

    return parts.join(" > ");
  }

  function selectorPart(element) {
    const tag = element.localName;
    if (!tag || tag === "html") return "";

    const stableClasses = [...element.classList]
      .filter((name) => /^[a-zA-Z][a-zA-Z0-9_-]{2,}$/.test(name))
      .slice(0, 3)
      .map((name) => `.${cssEscape(name)}`)
      .join("");

    let part = `${tag}${stableClasses}`;
    if (!isUniqueWithinParent(element, part)) {
      part += `:nth-of-type(${nthOfType(element)})`;
    }

    return part;
  }

  function isUnique(selector) {
    try {
      return document.querySelectorAll(selector).length === 1;
    } catch {
      return false;
    }
  }

  function isUniqueWithinParent(element, selector) {
    try {
      return element.parentElement?.querySelectorAll(`:scope > ${selector}`).length === 1;
    } catch {
      return false;
    }
  }

  function nthOfType(element) {
    let index = 1;
    let sibling = element.previousElementSibling;
    while (sibling) {
      if (sibling.localName === element.localName) index += 1;
      sibling = sibling.previousElementSibling;
    }
    return index;
  }

  function cssEscape(value) {
    if (window.CSS?.escape) return window.CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }
})();
