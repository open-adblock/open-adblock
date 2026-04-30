export const DEFAULT_RESOURCE_TYPES = [
  "script",
  "image",
  "stylesheet",
  "font",
  "object",
  "xmlhttprequest",
  "ping",
  "media",
  "websocket",
  "sub_frame",
  "other"
];

const FRAME_RESOURCE_TYPES = new Set(["main_frame", "sub_frame"]);

export function compileNetworkRules(sources, startId, maxRules) {
  const candidates = [];
  const unsupported = [];
  const badfilters = [];

  for (const source of sources) {
    for (const rawLine of source.text.split(/\r?\n/)) {
      const parsed = parseNetworkFilterLine(rawLine, source.defaultAction);
      if (!parsed) continue;

      if (parsed.badfilter) {
        badfilters.push(parsed);
        continue;
      }

      if (parsed.unsupported) {
        unsupported.push(parsed);
        continue;
      }

      candidates.push(parsed);
    }
  }

  const disabledKeys = new Set(badfilters.map((badfilter) => badfilter.key));
  const rules = [];
  let nextId = startId;

  for (const candidate of candidates) {
    if (rules.length >= maxRules) break;
    if (disabledKeys.has(candidate.key)) continue;

    rules.push({
      id: nextId++,
      priority: candidate.priority,
      action: { type: candidate.action },
      condition: candidate.condition
    });
  }

  return { rules, unsupported, badfilters };
}

export function parseNetworkFilterLine(rawLine, defaultAction) {
  let line = rawLine.trim();
  if (!line || line.startsWith("!") || line.startsWith("#") || line.startsWith("[")) {
    return null;
  }

  line = normalizeHostsFilterLine(line);
  if (!line) return null;

  if (line.includes("##") || line.includes("#@#") || line.includes("#?#") || line.includes("#$#")) {
    return null;
  }

  const unsupportedMarkers = ["+js(", "script:inject", "urlskip=", "replace=", "csp=", "redirect=", "removeparam="];
  if (unsupportedMarkers.some((marker) => line.includes(marker))) {
    return { rawLine, unsupported: true, reason: "unsupported-option" };
  }

  let action = defaultAction === "allow" ? "allow" : "block";
  let priority = action === "allow" ? 5000 : 100;

  if (line.startsWith("@@")) {
    action = "allow";
    priority = 5000;
    line = line.slice(2);
  }

  const [patternPart, optionPart] = splitFirst(line, "$");
  const pattern = patternPart.trim();

  if (!pattern || pattern.length > 1000 || pattern.startsWith("/") || pattern.includes(" ")) {
    return { rawLine, unsupported: true, reason: "unsupported-pattern" };
  }

  const options = parseNetworkOptions(optionPart);
  const key = createNetworkFilterKey(action, pattern, options.tokensWithoutBadfilter);

  if (options.badfilter) {
    return { rawLine, badfilter: true, key };
  }

  const condition = {
    urlFilter: pattern,
    resourceTypes: [...DEFAULT_RESOURCE_TYPES]
  };

  if (options.unsupported) {
    return { rawLine, unsupported: true, reason: options.reason };
  }

  if (options.domainType) {
    condition.domainType = options.domainType;
  }

  if (options.caseSensitive) {
    condition.isUrlFilterCaseSensitive = true;
  }

  if (options.initiatorDomains.length) {
    condition.initiatorDomains = options.initiatorDomains;
  }

  if (options.excludedInitiatorDomains.length) {
    condition.excludedInitiatorDomains = options.excludedInitiatorDomains;
  }

  if (options.resourceTypes.size > 0) {
    condition.resourceTypes = [...options.resourceTypes];
  }

  if (options.excludedResourceTypes.size > 0) {
    condition.resourceTypes = condition.resourceTypes.filter((type) => !options.excludedResourceTypes.has(type));
    if (condition.resourceTypes.length === 0) {
      return { rawLine, unsupported: true, reason: "empty-resource-types" };
    }
  }

  priority += options.priorityBoost;

  if (action === "allow" && shouldAllowAllRequests(condition.resourceTypes, options.resourceTypes.size > 0)) {
    return {
      action: "allowAllRequests",
      priority,
      condition: {
        ...condition,
        resourceTypes: condition.resourceTypes.filter((type) => FRAME_RESOURCE_TYPES.has(type))
      },
      key
    };
  }

  return { action, priority, condition, key };
}

function parseNetworkOptions(optionPart) {
  const options = {
    badfilter: false,
    caseSensitive: false,
    domainType: null,
    excludedInitiatorDomains: [],
    excludedResourceTypes: new Set(),
    initiatorDomains: [],
    priorityBoost: 0,
    resourceTypes: new Set(),
    tokensWithoutBadfilter: [],
    unsupported: false,
    reason: null
  };

  if (!optionPart) return options;

  for (const rawToken of optionPart.split(",")) {
    const token = rawToken.trim();
    if (!token) continue;

    if (token === "badfilter") {
      options.badfilter = true;
      continue;
    }

    options.tokensWithoutBadfilter.push(token);

    if (token === "important") {
      options.priorityBoost += 1000;
      continue;
    }

    if (token === "match-case") {
      options.caseSensitive = true;
      continue;
    }

    if (token === "third-party") {
      options.domainType = "thirdParty";
      continue;
    }

    if (token === "~third-party" || token === "first-party") {
      options.domainType = "firstParty";
      continue;
    }

    if (token.startsWith("domain=")) {
      const domains = parseDomainOption(token.slice("domain=".length));
      if (domains.unsupported) {
        options.unsupported = true;
        options.reason = domains.reason;
        return options;
      }
      options.initiatorDomains.push(...domains.included);
      options.excludedInitiatorDomains.push(...domains.excluded);
      continue;
    }

    const negated = token.startsWith("~");
    const resourceType = mapResourceType(negated ? token.slice(1) : token);
    if (resourceType) {
      if (negated) {
        options.excludedResourceTypes.add(resourceType);
      } else {
        options.resourceTypes.add(resourceType);
      }
      continue;
    }

    options.unsupported = true;
    options.reason = `unsupported-option:${token}`;
    return options;
  }

  return options;
}

function shouldAllowAllRequests(resourceTypes, hasExplicitResourceTypes) {
  return (
    hasExplicitResourceTypes &&
    resourceTypes.length > 0 &&
    resourceTypes.every((resourceType) => FRAME_RESOURCE_TYPES.has(resourceType))
  );
}

function createNetworkFilterKey(action, pattern, optionTokens) {
  const normalizedOptions = optionTokens
    .filter(Boolean)
    .map((token) => token.trim())
    .sort()
    .join(",");
  return `${action}:${pattern}${normalizedOptions ? `$${normalizedOptions}` : ""}`;
}

function mapResourceType(type) {
  const map = {
    document: "main_frame",
    subdocument: "sub_frame",
    frame: "sub_frame",
    image: "image",
    script: "script",
    stylesheet: "stylesheet",
    font: "font",
    media: "media",
    object: "object",
    xhr: "xmlhttprequest",
    xmlhttprequest: "xmlhttprequest",
    websocket: "websocket",
    ping: "ping",
    other: "other"
  };

  return map[type] || null;
}

function normalizeHostsFilterLine(line) {
  const withoutComment = line.replace(/\s+#.*$/, "").trim();
  if (!withoutComment) return "";

  const tokens = withoutComment.split(/\s+/);
  let hostname = "";

  if (tokens.length >= 2 && isHostsAddress(tokens[0])) {
    hostname = tokens[1];
  } else if (tokens.length === 1 && !isHostsAddress(tokens[0]) && isHostnameToken(tokens[0])) {
    hostname = tokens[0];
  } else {
    return line;
  }

  const normalized = normalizeHostname(hostname);
  if (!normalized || normalized === "localhost") return "";

  return `||${normalized}^`;
}

function isHostsAddress(value) {
  return (
    value === "::" ||
    value === "::1" ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)
  );
}

function isHostnameToken(value) {
  return /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/i.test(value) && !value.includes("..");
}

function parseDomainOption(value) {
  const included = [];
  const excluded = [];

  for (const rawDomain of value.split("|")) {
    const trimmed = rawDomain.trim();
    if (!trimmed) continue;

    const domainValue = trimmed.startsWith("~") ? trimmed.slice(1) : trimmed;
    if (domainValue.includes("*")) {
      return {
        included,
        excluded,
        unsupported: true,
        reason: "unsupported-domain-option:wildcard"
      };
    }

    const negated = trimmed.startsWith("~");
    const domain = normalizeHostname(domainValue);
    if (!domain || !isValidDnrDomain(domain)) {
      return {
        included,
        excluded,
        unsupported: true,
        reason: "unsupported-domain-option:invalid-domain"
      };
    }

    if (negated) {
      excluded.push(domain);
    } else {
      included.push(domain);
    }
  }

  return { included, excluded, unsupported: false, reason: null };
}

export function compileCosmeticRules(sources, version) {
  const result = {
    version: version || null,
    updatedAt: Date.now(),
    global: [],
    byHost: {},
    exceptions: {
      global: [],
      byHost: {}
    },
    unsupported: []
  };

  for (const source of sources) {
    for (const rawLine of source.text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("!") || line.startsWith("[") || isCosmeticComment(line)) {
        continue;
      }

      const marker = line.includes("#@#") ? "#@#" : line.includes("##") ? "##" : null;
      if (!marker) continue;

      const [domainPart, selectorPart] = splitFirst(line, marker);
      const selector = sanitizeSelector(selectorPart);

      if (!selector || isUnsupportedCosmeticSelector(selector)) {
        result.unsupported.push({ rawLine, reason: "unsupported-selector" });
        continue;
      }

      const domainSet = parseCosmeticDomains(domainPart);
      const target = marker === "#@#" || source.defaultException ? result.exceptions : result;

      addCosmeticSelector(target, domainSet.included, selector);

      if (domainSet.excluded.length === 0) {
        continue;
      }

      if (target === result) {
        addCosmeticSelector(result.exceptions, domainSet.excluded, selector);
      } else {
        addCosmeticSelector(result, domainSet.excluded, selector);
      }
    }
  }

  dedupeCosmeticRules(result);
  return result;
}

function parseCosmeticDomains(value) {
  const included = [];
  const excluded = [];

  if (!value) return { included, excluded };

  for (const rawDomain of value.split(",")) {
    const trimmed = rawDomain.trim();
    if (!trimmed) continue;

    const negated = trimmed.startsWith("~");
    const hostname = normalizeHostname(negated ? trimmed.slice(1) : trimmed);
    if (!hostname) continue;

    if (negated) {
      excluded.push(hostname);
    } else {
      included.push(hostname);
    }
  }

  return { included, excluded };
}

function isCosmeticComment(line) {
  return line.startsWith("#") && !line.startsWith("##") && !line.startsWith("#@#");
}

function addCosmeticSelector(target, domains, selector) {
  if (domains.length === 0) {
    target.global.push(selector);
    return;
  }

  for (const domain of domains) {
    if (!target.byHost[domain]) target.byHost[domain] = [];
    target.byHost[domain].push(selector);
  }
}

function isUnsupportedCosmeticSelector(selector) {
  const lowered = selector.toLowerCase();
  return [
    "+js(",
    ":has-text(",
    ":matches-css(",
    ":upward(",
    ":xpath(",
    ":remove(",
    ":style(",
    ":-abp-",
    "{",
    "}"
  ].some((marker) => lowered.includes(marker));
}

function dedupeCosmeticRules(index) {
  index.global = [...new Set(index.global)];
  for (const host of Object.keys(index.byHost)) {
    index.byHost[host] = [...new Set(index.byHost[host])];
  }
  index.exceptions.global = [...new Set(index.exceptions.global)];
  for (const host of Object.keys(index.exceptions.byHost)) {
    index.exceptions.byHost[host] = [...new Set(index.exceptions.byHost[host])];
  }
}

export function countCosmeticRules(index) {
  return (
    index.global.length +
    Object.values(index.byHost).reduce((sum, selectors) => sum + selectors.length, 0)
  );
}

export function normalizeHostname(value) {
  if (!value || typeof value !== "string") return "";
  const raw = value.trim().toLowerCase();
  if (!raw) return "";

  try {
    const hostname = raw.includes("://") ? new URL(raw).hostname : raw;
    return hostname
      .replace(/^\*\./, "")
      .replace(/[^a-z0-9.-]/g, "")
      .replace(/^\.+|\.+$/g, "");
  } catch {
    return "";
  }
}

function isValidDnrDomain(value) {
  if (!value || value.length > 253 || value.includes("..")) return false;
  return value
    .split(".")
    .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

export function sanitizeSelector(selector) {
  if (!selector || typeof selector !== "string") return "";
  const trimmed = selector.trim();
  if (!trimmed || trimmed.length > 1000) return "";
  return trimmed.replace(/[\u0000-\u001f\u007f]/g, "");
}

function splitFirst(value, separator) {
  const index = value.indexOf(separator);
  if (index === -1) return [value, ""];
  return [value.slice(0, index), value.slice(index + separator.length)];
}
