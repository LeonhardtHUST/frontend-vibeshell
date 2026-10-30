// Serialized and invoked by FrameManager after loading this file.
// eslint-disable-next-line no-unused-vars
function devShellPickerBridge(frameId, targetOrigin, configuredParentOrigin, longPressMs) {
  "use strict";

  if (window.parent === window || window.__devShellPickerBridgeInstalled) return;
  window.__devShellPickerBridgeInstalled = true;

  var parentOrigin;
  try {
    var parentUrl = new URL(configuredParentOrigin || document.referrer);
    if (!/^https?:$/.test(parentUrl.protocol)) return;
    parentOrigin = parentUrl.origin;
  } catch {
    return;
  }

  var armed = false;
  var armMode = "keyboard";
  var overlay = null;
  var overlayLabel = null;
  var longPress = null;
  var suppressClickUntil = 0;
  var suppressContextMenuUntil = 0;
  var lastClientPoint = { x: 0, y: 0 };

  function post(message) {
    var envelope = Object.assign({ protocolVersion: 1, frameId: frameId }, message);
    window.parent.postMessage(envelope, parentOrigin);
  }

  function originalPageUrl() {
    try {
      return new URL(window.location.pathname + window.location.search + window.location.hash, targetOrigin).href;
    } catch {
      return targetOrigin + "/";
    }
  }

  function frameInfo() {
    return {
      type: "bridge.frame.info",
      url: originalPageUrl(),
      title: document.title || "",
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
  }

  function reportError(code, error) {
    try {
      post({
        type: "bridge.error",
        code: code,
        message: String(error && error.message ? error.message : error).slice(0, 300),
      });
    } catch {}
  }

  function createOverlay() {
    if (overlay) return;
    overlay = document.createElement("div");
    overlay.setAttribute("data-dev-shell-picker", "");
    overlay.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;display:none;box-sizing:border-box;border:2px solid #7c3aed;background:rgba(124,58,237,.12);border-radius:3px;";
    overlayLabel = document.createElement("div");
    overlayLabel.style.cssText = "position:absolute;left:-2px;top:-25px;max-width:280px;padding:3px 7px;background:#7c3aed;color:white;font:12px/16px sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border-radius:3px;";
    overlay.appendChild(overlayLabel);
    (document.documentElement || document.body).appendChild(overlay);
  }

  function hideOverlay() {
    if (overlay) overlay.style.display = "none";
  }

  function highlight(element) {
    if (!armed || !element || element.nodeType !== 1 || (overlay && (element === overlay || overlay.contains(element)))) {
      hideOverlay();
      return;
    }
    createOverlay();
    var rect = element.getBoundingClientRect();
    overlay.style.display = "block";
    overlay.style.left = rect.left + "px";
    overlay.style.top = rect.top + "px";
    overlay.style.width = Math.max(0, rect.width) + "px";
    overlay.style.height = Math.max(0, rect.height) + "px";
    overlayLabel.textContent = "Picker · " + element.tagName.toLowerCase();
    overlayLabel.style.top = rect.top < 28 ? "2px" : "-25px";
  }

  function setArmed(next, mode, notify) {
    armed = Boolean(next);
    if (mode) armMode = mode;
    if (!armed) hideOverlay();
    if (notify !== false) post({ type: "picker.armed", armed: armed, mode: armMode });
  }

  function safeText(element) {
    var clone = element.cloneNode(true);
    var removable = clone.querySelectorAll("input,textarea,select,script,style,noscript,template");
    for (var i = 0; i < removable.length; i += 1) removable[i].remove();
    return (clone.textContent || "").replace(/\s+/g, " ").trim().slice(0, 2000);
  }

  function safeOuterHTML(element) {
    var clone = element.cloneNode(true);
    if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(clone.tagName)) return "";
    var removable = clone.querySelectorAll("script,style,noscript,template");
    for (var k = 0; k < removable.length; k += 1) removable[k].remove();
    var all = [clone].concat(Array.prototype.slice.call(clone.querySelectorAll("*")));
    var sensitive = /(?:password|passwd|secret|token|api[-_]?key|authorization|cookie|session|credential)/i;
    for (var i = 0; i < all.length; i += 1) {
      var node = all[i];
      var attributes = Array.prototype.slice.call(node.attributes || []);
      for (var j = 0; j < attributes.length; j += 1) {
        var name = attributes[j].name;
        if (sensitive.test(name) || !/^(?:id|class|role|type|title|alt|aria-[a-z-]+|data-(?:testid|test|cy|qa))$/i.test(name)) {
          node.removeAttribute(name);
        }
      }
      if (node.tagName === "TEXTAREA") node.textContent = "";
    }
    return clone.outerHTML.slice(0, 12000);
  }

  function accessibleName(element) {
    var label = element.getAttribute("aria-label");
    if (label) return label.trim().slice(0, 500);
    var labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      var text = labelledBy.split(/\s+/).map(function (id) {
        var referenced = document.getElementById(id);
        return referenced ? safeText(referenced) : "";
      }).join(" ").trim();
      if (text) return text.slice(0, 500);
    }
    if (element.id) {
      var labels = document.querySelectorAll("label[for]");
      for (var i = 0; i < labels.length; i += 1) {
        if (labels[i].htmlFor === element.id) return safeText(labels[i]).slice(0, 500);
      }
    }
    var closestLabel = element.closest ? element.closest("label") : null;
    if (closestLabel) return safeText(closestLabel).slice(0, 500);
    var alt = element.getAttribute("alt");
    if (alt) return alt.trim().slice(0, 500);
    var title = element.getAttribute("title");
    if (title) return title.trim().slice(0, 500);
    if (/^(BUTTON|A|SUMMARY|H1|H2|H3|H4|H5|H6)$/.test(element.tagName)) {
      return safeText(element).slice(0, 500);
    }
    return null;
  }

  function escapeCss(value) {
    if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, function (character) {
      return "\\" + character;
    });
  }

  function quoted(value) {
    return '"' + String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
  }

  function cssPath(element) {
    if (element.id) return "#" + escapeCss(element.id);
    var testAttributes = ["data-testid", "data-test", "data-cy", "data-qa"];
    for (var i = 0; i < testAttributes.length; i += 1) {
      var testValue = element.getAttribute(testAttributes[i]);
      if (testValue) return element.tagName.toLowerCase() + "[" + testAttributes[i] + "=" + quoted(testValue) + "]";
    }
    var parts = [];
    var current = element;
    while (current && current.nodeType === 1 && current.tagName !== "HTML") {
      if (current.id) {
        parts.unshift("#" + escapeCss(current.id));
        break;
      }
      var part = current.tagName.toLowerCase();
      var parent = current.parentElement;
      if (parent) {
        var siblings = Array.prototype.filter.call(parent.children, function (sibling) {
          return sibling.tagName === current.tagName;
        });
        if (siblings.length > 1) part += ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")";
      }
      parts.unshift(part);
      current = parent;
    }
    return parts.join(" > ") || element.tagName.toLowerCase();
  }

  function reactMetadata(element) {
    var result = { componentName: null, source: null, sourceConfidence: "dom" };
    try {
      var keys = Object.keys(element);
      var key = keys.find(function (name) {
        return name.indexOf("__reactFiber$") === 0 || name.indexOf("__reactInternalInstance$") === 0;
      });
      var fiber = key ? element[key] : null;
      while (fiber) {
        var type = fiber.type || fiber.elementType;
        var componentName = type && (type.displayName || type.name);
        var debugSource = fiber._debugSource || (type && type._debugSource);
        if (componentName || debugSource) {
          result.componentName = componentName || null;
          if (debugSource && debugSource.fileName) {
            result.source = { fileName: String(debugSource.fileName) };
            if (Number(debugSource.lineNumber) > 0) result.source.lineNumber = Number(debugSource.lineNumber);
            if (Number(debugSource.columnNumber) > 0) result.source.columnNumber = Number(debugSource.columnNumber);
          }
          result.sourceConfidence = "framework-metadata";
          return result;
        }
        fiber = fiber.return;
      }
    } catch {}
    return result;
  }

  function descriptor(element) {
    var rect = element.getBoundingClientRect();
    var safeAttributeNames = [
      "data-testid", "data-test", "data-cy", "data-qa", "role", "type",
      "aria-label", "aria-labelledby", "aria-describedby", "alt", "title",
    ];
    var attributes = {};
    safeAttributeNames.forEach(function (name) {
      var value = element.getAttribute(name);
      if (value !== null) attributes[name] = value.slice(0, 500);
    });
    var react = reactMetadata(element);
    return {
      tagName: element.tagName.toLowerCase(),
      id: element.id || null,
      classes: Array.prototype.slice.call(element.classList || []).slice(0, 100),
      role: element.getAttribute("role") || null,
      accessibleName: accessibleName(element),
      attributes: attributes,
      cssPath: cssPath(element),
      text: safeText(element),
      outerHTML: safeOuterHTML(element),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      pageUrl: originalPageUrl(),
      pageTitle: document.title || "",
      componentName: react.componentName,
      source: react.source,
      sourceConfidence: react.sourceConfidence,
    };
  }

  function select(element, point) {
    if (!element || element.nodeType !== 1) return;
    if (overlay && (element === overlay || overlay.contains(element))) return;
    lastClientPoint = { x: point.x, y: point.y };
    post({
      type: "picker.selected",
      descriptor: descriptor(element),
      clientPoint: lastClientPoint,
    });
  }

  function elementFromPoint(x, y, fallback) {
    var element = document.elementFromPoint(x, y);
    return element || fallback;
  }

  document.addEventListener("keydown", function (event) {
    if (event.key === "Control" && !event.repeat) setArmed(true, "keyboard");
    if (event.key === "Escape") setArmed(false, armMode);
  }, true);

  document.addEventListener("keyup", function (event) {
    if (event.key === "Control") setArmed(false, "keyboard");
  }, true);

  window.addEventListener("blur", function () {
    cancelLongPress();
    setArmed(false, armMode);
  }, true);

  document.addEventListener("pointermove", function (event) {
    if (longPress && Math.hypot(event.clientX - longPress.x, event.clientY - longPress.y) > 8) {
      cancelLongPress();
    }
    if (event.ctrlKey && !armed) setArmed(true, "keyboard");
    else if (!event.ctrlKey && armed && armMode === "keyboard") setArmed(false, "keyboard");
    if (armed) highlight(document.elementFromPoint(event.clientX, event.clientY));
  }, true);

  document.addEventListener("pointerover", function (event) {
    if (armed) highlight(event.target);
  }, true);

  document.addEventListener("click", function (event) {
    if (Date.now() < suppressClickUntil) {
      event.preventDefault();
      event.stopImmediatePropagation();
      suppressClickUntil = 0;
      return;
    }
    // Ctrl may have been pressed while focus was still in the parent shell.
    if (event.ctrlKey && !armed) setArmed(true, "keyboard");
    if (!armed) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    select(event.target, { x: event.clientX, y: event.clientY });
    if (armMode !== "explicit") setArmed(false, armMode);
  }, true);

  function cancelLongPress() {
    if (!longPress) return;
    clearTimeout(longPress.timer);
    longPress = null;
  }

  document.addEventListener("pointerdown", function (event) {
    if (event.pointerType === "mouse" || event.button !== 0) return;
    cancelLongPress();
    longPress = {
      x: event.clientX,
      y: event.clientY,
      target: event.target,
      timer: setTimeout(function () {
        var pending = longPress;
        longPress = null;
        if (!pending) return;
        suppressClickUntil = Date.now() + 1200;
        suppressContextMenuUntil = Date.now() + 1200;
        setArmed(true, "long-press");
        var element = elementFromPoint(pending.x, pending.y, pending.target);
        highlight(element);
        select(element, { x: pending.x, y: pending.y });
        setArmed(false, "long-press");
      }, Math.max(200, Math.min(2000, Number(longPressMs) || 500))),
    };
  }, true);

  ["pointerup", "pointercancel", "scroll", "dragstart"].forEach(function (name) {
    (name === "scroll" ? document : window).addEventListener(name, cancelLongPress, true);
  });

  document.addEventListener("contextmenu", function (event) {
    if (Date.now() >= suppressContextMenuUntil) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    suppressContextMenuUntil = 0;
  }, true);

  window.addEventListener("message", function (event) {
    if (event.source !== window.parent || event.origin !== parentOrigin) return;
    var message = event.data;
    if (!message || message.protocolVersion !== 1 || message.frameId !== frameId) return;
    if (message.type === "picker.arm" && ["keyboard", "explicit", "long-press"].includes(message.mode)) {
      setArmed(true, message.mode);
    } else if (message.type === "picker.disarm") {
      setArmed(false, armMode);
    } else if (message.type === "frame.ping") {
      post(frameInfo());
    }
  });

  function navigationChanged() {
    post(frameInfo());
  }
  window.addEventListener("popstate", navigationChanged);
  window.addEventListener("hashchange", navigationChanged);
  window.addEventListener("resize", navigationChanged);
  ["pushState", "replaceState"].forEach(function (name) {
    var original = window.history[name];
    if (typeof original !== "function") return;
    window.history[name] = function () {
      var result = original.apply(this, arguments);
      navigationChanged();
      return result;
    };
  });

  try {
    createOverlay();
    post({ type: "bridge.ready", url: originalPageUrl(), title: document.title || "" });
    post(frameInfo());
  } catch (error) {
    reportError("BRIDGE_INIT_FAILED", error);
  }
}
