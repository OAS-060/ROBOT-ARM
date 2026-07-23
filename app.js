"use strict";

const AXES = [
  { channel: 0, ar: "دوران القاعدة", en: "Base", servo: "MG996R", min: 0, max: 180, home: 90 },
  { channel: 1, ar: "الكتف", en: "Shoulder", servo: "MG996R", min: 0, max: 180, home: 90 },
  { channel: 2, ar: "الكوع", en: "Elbow", servo: "MG996R", min: 0, max: 180, home: 90 },
  { channel: 3, ar: "ميل المعصم", en: "Wrist Pitch", servo: "MG90S", min: 0, max: 180, home: 90 },
  { channel: 4, ar: "دوران المعصم", en: "Wrist Rotate", servo: "MG90S", min: 0, max: 180, home: 90 },
  { channel: 5, ar: "الملقط", en: "Gripper", servo: "MG90S", min: 0, max: 180, home: 70 }
].map(axis => ({ ...axis, current: null, step: 5, reverse: false, card: null }));

let port = null;
let reader = null;
let writer = null;
let keepReading = false;
let connected = false;
let activeMove = null;
let sessionStartedAt = null;
let sequenceRunning = false;

const els = {
  axesGrid: document.getElementById("axesGrid"),
  template: document.getElementById("axisCardTemplate"),
  connectBtn: document.getElementById("connectBtn"),
  disconnectBtn: document.getElementById("disconnectBtn"),
  baudRate: document.getElementById("baudRate"),
  statusDot: document.getElementById("statusDot"),
  statusText: document.getElementById("statusText"),
  commandsEnabled: document.getElementById("commandsEnabled"),
  zeroAllBtn: document.getElementById("zeroAllBtn"),
  homeBtn: document.getElementById("homeBtn"),
  stopBtn: document.getElementById("stopBtn"),
  disableOutputsBtn: document.getElementById("disableOutputsBtn"),
  globalSpeed: document.getElementById("globalSpeed"),
  globalSpeedValue: document.getElementById("globalSpeedValue"),
  commandLog: document.getElementById("commandLog"),
  clearLogBtn: document.getElementById("clearLogBtn"),
  activeAxisBadge: document.getElementById("activeAxisBadge"),
  sequenceProgressWrap: document.getElementById("sequenceProgressWrap"),
  sequenceProgressText: document.getElementById("sequenceProgressText"),
  sequenceProgressValue: document.getElementById("sequenceProgressValue"),
  sequenceProgressBar: document.getElementById("sequenceProgressBar"),
  confirmZero: document.getElementById("confirmZero"),
  lockDuringMove: document.getElementById("lockDuringMove"),
  sessionTime: document.getElementById("sessionTime"),
  toastContainer: document.getElementById("toastContainer")
};

function buildAxisCards() {
  AXES.forEach(axis => {
    const fragment = els.template.content.cloneNode(true);
    const card = fragment.querySelector(".axis-card");
    axis.card = card;
    card.dataset.channel = axis.channel;

    card.querySelector(".axis-channel").textContent = `CH${axis.channel}`;
    card.querySelector(".axis-name").textContent = `${axis.ar} — ${axis.en}`;
    const servoBadge = card.querySelector(".servo-badge");
    servoBadge.textContent = axis.servo;
    if (axis.servo === "MG90S") servoBadge.classList.add("small");

    const angleValue = card.querySelector(".angle-value");
    const slider = card.querySelector(".angle-slider");
    slider.min = axis.min;
    slider.max = axis.max;
    slider.value = axis.home;
    card.querySelector(".min-label").textContent = `${axis.min}°`;
    card.querySelector(".max-label").textContent = `${axis.max}°`;

    card.querySelectorAll(".segmented button").forEach(btn => {
      btn.addEventListener("click", () => {
        card.querySelectorAll(".segmented button").forEach(x => x.classList.remove("selected"));
        btn.classList.add("selected");
        axis.step = Number(btn.dataset.step);
      });
    });

    card.querySelector(".reverse-toggle").addEventListener("change", event => {
      axis.reverse = event.target.checked;
      if (axis.current !== null) {
        axis.current = axis.min + axis.max - axis.current;
        syncAxisUI(axis);
      }
      addLog(`CH${axis.channel} reverse = ${axis.reverse ? "ON" : "OFF"}`, "info");
    });

    slider.addEventListener("input", () => {
      angleValue.textContent = `${slider.value}°`;
    });
    slider.addEventListener("change", async () => {
      const uiAngle = Number(slider.value);
      await requestAxisMove(axis, uiAngle);
    });

    card.querySelector(".move-minus").addEventListener("click", async () => {
      const base = axis.current ?? axis.home;
      const next = clamp(base - axis.step, axis.min, axis.max);
      await requestAxisMove(axis, next);
    });

    card.querySelector(".move-plus").addEventListener("click", async () => {
      const base = axis.current ?? axis.home;
      const next = clamp(base + axis.step, axis.min, axis.max);
      await requestAxisMove(axis, next);
    });

    card.querySelector(".zero-axis").addEventListener("click", async () => {
      if (!canMove()) return;
      await moveAxis(axis, axis.home, getAxisSpeed(axis));
    });

    angleValue.textContent = "--°";
    els.axesGrid.appendChild(fragment);
  });
}

function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }

function getAxisSpeed(axis) {
  const value = axis.card.querySelector(".axis-speed").value;
  return value === "global" ? Number(els.globalSpeed.value) : Number(value);
}

function logicalToPhysical(axis, logicalAngle) {
  if (!axis.reverse) return logicalAngle;
  return axis.min + axis.max - logicalAngle;
}

function physicalToLogical(axis, physicalAngle) {
  if (!axis.reverse) return physicalAngle;
  return axis.min + axis.max - physicalAngle;
}

async function requestAxisMove(axis, logicalAngle) {
  if (!canMove()) {
    syncAxisUI(axis);
    return;
  }
  const physicalTarget = logicalToPhysical(axis, logicalAngle);
  await moveAxis(axis, physicalTarget, getAxisSpeed(axis), logicalAngle);
}

function canMove(showMessage = true) {
  if (!connected) {
    if (showMessage) toast("اتصل بالأردوينو أولًا.", "error");
    return false;
  }
  if (!els.commandsEnabled.checked) {
    if (showMessage) toast("فعّل الأوامر أولًا.", "error");
    return false;
  }
  if (activeMove || sequenceRunning) {
    if (showMessage) toast("يوجد محور يتحرك الآن. انتظر حتى ينتهي.", "error");
    return false;
  }
  return true;
}

async function connectSerial() {
  if (!("serial" in navigator)) {
    toast("المتصفح لا يدعم Web Serial. استخدم Chrome أو Edge.", "error");
    addLog("Web Serial is not supported", "error");
    return;
  }

  try {
    port = await navigator.serial.requestPort();
    await port.open({ baudRate: Number(els.baudRate.value) });
    writer = port.writable.getWriter();
    connected = true;
    keepReading = true;
    sessionStartedAt = Date.now();
    updateConnectionUI();
    addLog("Serial connected — OE remains disabled and no motion command was sent", "ok");
    readSerialLoop();
    await sendCommand("PING");
  } catch (error) {
    addLog(`Connection error: ${error.message}`, "error");
    toast(`فشل الاتصال: ${error.message}`, "error");
    await cleanupSerial();
  }
}

async function disconnectSerial() {
  try {
    if (activeMove) await sendCommand("STOP");
  } catch (_) {}
  await cleanupSerial();
  addLog("Serial disconnected", "warn");
}

async function cleanupSerial() {
  keepReading = false;
  connected = false;
  els.commandsEnabled.checked = false;

  try { if (reader) { await reader.cancel(); reader.releaseLock(); } } catch (_) {}
  reader = null;
  try { if (writer) writer.releaseLock(); } catch (_) {}
  writer = null;
  try { if (port) await port.close(); } catch (_) {}
  port = null;

  if (activeMove?.reject) activeMove.reject(new Error("Disconnected"));
  activeMove = null;
  sequenceRunning = false;
  setBusyUI(null);
  updateConnectionUI();
}

async function readSerialLoop() {
  const decoder = new TextDecoder();
  let buffer = "";

  while (port?.readable && keepReading) {
    reader = port.readable.getReader();
    try {
      while (keepReading) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        lines.map(x => x.trim()).filter(Boolean).forEach(handleSerialLine);
      }
    } catch (error) {
      if (keepReading) {
        addLog(`Read error: ${error.message}`, "error");
        toast("انقطع الاتصال التسلسلي.", "error");
      }
    } finally {
      try { reader.releaseLock(); } catch (_) {}
      reader = null;
    }
  }
}

function handleSerialLine(line) {
  addLog(`RX  ${line}`, line.startsWith("ERR") ? "error" : "info");
  const parts = line.split(",");
  const type = parts[0];

  if (type === "READY" || type === "PONG") {
    setStatus("جاهز", "connected");
    return;
  }

  if (type === "START") {
    const channel = Number(parts[1]);
    setBusyUI(channel);
    return;
  }

  if (type === "DONE") {
    const channel = Number(parts[1]);
    const physicalAngle = Number(parts[2]);
    const axis = AXES[channel];
    if (axis) {
      axis.current = physicalToLogical(axis, physicalAngle);
      syncAxisUI(axis);
    }
    if (activeMove && activeMove.channel === channel) {
      const resolve = activeMove.resolve;
      activeMove = null;
      setBusyUI(null);
      resolve({ channel, physicalAngle });
    }
    return;
  }

  if (type === "STOPPED") {
    const channel = Number(parts[1]);
    const angle = Number(parts[2]);
    if (Number.isInteger(channel) && AXES[channel]) {
      AXES[channel].current = physicalToLogical(AXES[channel], angle);
      syncAxisUI(AXES[channel]);
    }
    if (activeMove) {
      const reject = activeMove.reject;
      activeMove = null;
      reject(new Error("Stopped"));
    }
    setBusyUI(null);
    return;
  }

  if (type === "RELEASED") {
    const channel = Number(parts[1]);
    const angle = Number(parts[2]);
    if (Number.isInteger(channel) && AXES[channel] && Number.isFinite(angle)) {
      AXES[channel].current = physicalToLogical(AXES[channel], angle);
      syncAxisUI(AXES[channel]);
      AXES[channel].card?.classList.add("released");
      window.setTimeout(() => AXES[channel].card?.classList.remove("released"), 500);
    }
    return;
  }

  if (type === "OFF") {
    AXES.forEach(axis => { axis.current = null; syncAxisUI(axis); });
    if (activeMove) {
      activeMove.reject(new Error("Outputs disabled"));
      activeMove = null;
    }
    setBusyUI(null);
    return;
  }

  if (type === "ERR") {
    const message = parts.slice(1).join(",") || "Unknown controller error";
    if (activeMove) {
      activeMove.reject(new Error(message));
      activeMove = null;
    }
    setBusyUI(null);
    toast(`خطأ من الأردوينو: ${message}`, "error");
  }
}

async function sendCommand(command) {
  if (!writer || !connected) throw new Error("Serial is not connected");
  addLog(`TX  ${command}`, "ok");
  const data = new TextEncoder().encode(`${command}\n`);
  await writer.write(data);
}

function moveAxis(axis, physicalTarget, speed, logicalTarget = null) {
  return new Promise(async (resolve, reject) => {
    if (activeMove) return reject(new Error("Another axis is active"));

    const safeTarget = clamp(Math.round(physicalTarget), axis.min, axis.max);
    activeMove = { channel: axis.channel, resolve, reject, logicalTarget };
    setBusyUI(axis.channel);

    try {
      await sendCommand(`MOVE,${axis.channel},${safeTarget},${clamp(Math.round(speed), 1, 100)}`);
      window.setTimeout(() => {
        if (activeMove?.channel === axis.channel) {
          const timeoutReject = activeMove.reject;
          activeMove = null;
          setBusyUI(null);
          timeoutReject(new Error("Move timeout"));
          toast(`انتهت مهلة حركة CH${axis.channel}.`, "error");
        }
      }, 20000);
    } catch (error) {
      activeMove = null;
      setBusyUI(null);
      reject(error);
    }
  });
}

async function runSequentialHome(label = "تصفير المحاور") {
  if (!canMove()) return;
  if (els.confirmZero.checked && !window.confirm("سيتم تحريك المحاور واحدًا بعد الآخر إلى وضع البداية. هل تريد المتابعة؟")) return;

  sequenceRunning = true;
  showSequenceProgress(true, label, 0);
  updateCommandControls();

  try {
    for (let i = 0; i < AXES.length; i++) {
      const axis = AXES[i];
      showSequenceProgress(true, `${label}: CH${axis.channel} — ${axis.ar}`, i);
      const physicalTarget = logicalToPhysical(axis, axis.home);
      await moveAxis(axis, physicalTarget, getAxisSpeed(axis), axis.home);
      showSequenceProgress(true, `${label}: اكتمل CH${axis.channel}`, i + 1);
      await sleep(250);
    }
    toast("اكتمل تصفير جميع المحاور بالتسلسل.", "success");
    addLog("Sequential home completed", "ok");
  } catch (error) {
    if (error.message !== "Stopped") {
      toast(`توقفت العملية: ${error.message}`, "error");
      addLog(`Sequence failed: ${error.message}`, "error");
    }
  } finally {
    sequenceRunning = false;
    showSequenceProgress(false);
    updateCommandControls();
  }
}

async function emergencyStop() {
  if (!connected) return;
  try {
    await sendCommand("STOP");
    addLog("Emergency stop requested", "warn");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function disableOutputs() {
  if (!connected) return;
  if (!window.confirm("سيتم فصل إشارة جميع السيرفوات وقد تتحرك الذراع بسبب وزنها. هل تريد المتابعة؟")) return;
  try {
    await sendCommand("DISABLE");
    addLog("All servo outputs disabled", "warn");
  } catch (error) {
    toast(error.message, "error");
  }
}

function setBusyUI(channel) {
  const busy = channel !== null && channel !== undefined;
  AXES.forEach(axis => axis.card?.classList.toggle("active", busy && axis.channel === channel));
  els.activeAxisBadge.textContent = busy ? `المحور النشط: CH${channel}` : "لا يوجد محور نشط";
  els.activeAxisBadge.classList.toggle("busy", busy);
  setStatus(busy ? `يتحرك CH${channel}` : connected ? "جاهز" : "غير متصل", busy ? "busy" : connected ? "connected" : "");
  updateCommandControls();
}

function updateCommandControls() {
  const enabled = connected && els.commandsEnabled.checked;
  const busy = Boolean(activeMove) || sequenceRunning;
  document.querySelectorAll(".command-control").forEach(control => {
    control.disabled = !enabled || (els.lockDuringMove.checked && busy);
  });
  els.stopBtn.disabled = !connected;
  els.disableOutputsBtn.disabled = !connected;
}

function updateConnectionUI() {
  els.connectBtn.disabled = connected;
  els.disconnectBtn.disabled = !connected;
  els.baudRate.disabled = connected;
  els.commandsEnabled.disabled = !connected;
  els.stopBtn.disabled = !connected;
  els.disableOutputsBtn.disabled = !connected;
  if (!connected) setStatus("غير متصل", "");
  else setStatus("جاهز", "connected");
  updateCommandControls();
}

function setStatus(text, type) {
  els.statusText.textContent = text;
  els.statusDot.className = `dot ${type || ""}`.trim();
}

function syncAxisUI(axis) {
  if (!axis.card) return;
  const display = axis.card.querySelector(".angle-value");
  const slider = axis.card.querySelector(".angle-slider");
  if (axis.current === null) {
    display.textContent = "--°";
    slider.value = axis.home;
  } else {
    const rounded = Math.round(axis.current);
    display.textContent = `${rounded}°`;
    slider.value = clamp(rounded, axis.min, axis.max);
  }
}

function showSequenceProgress(show, text = "", completed = 0) {
  els.sequenceProgressWrap.classList.toggle("hidden", !show);
  if (!show) return;
  els.sequenceProgressText.textContent = text;
  els.sequenceProgressValue.textContent = `${completed} / ${AXES.length}`;
  els.sequenceProgressBar.style.width = `${(completed / AXES.length) * 100}%`;
}

function addLog(message, type = "info") {
  const line = document.createElement("div");
  line.className = `log-line ${type}`;
  const time = new Date().toLocaleTimeString("en-GB", { hour12: false });
  line.textContent = `[${time}] ${message}`;
  els.commandLog.appendChild(line);
  els.commandLog.scrollTop = els.commandLog.scrollHeight;
}

function toast(message, type = "") {
  const item = document.createElement("div");
  item.className = `toast ${type}`.trim();
  item.textContent = message;
  els.toastContainer.appendChild(item);
  setTimeout(() => item.remove(), 3600);
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function updateSessionClock() {
  if (!sessionStartedAt || !connected) {
    els.sessionTime.textContent = "وقت الجلسة: 00:00:00";
    return;
  }
  const seconds = Math.floor((Date.now() - sessionStartedAt) / 1000);
  const h = String(Math.floor(seconds / 3600)).padStart(2, "0");
  const m = String(Math.floor((seconds % 3600) / 60)).padStart(2, "0");
  const s = String(seconds % 60).padStart(2, "0");
  els.sessionTime.textContent = `وقت الجلسة: ${h}:${m}:${s}`;
}

els.connectBtn.addEventListener("click", connectSerial);
els.disconnectBtn.addEventListener("click", disconnectSerial);
els.commandsEnabled.addEventListener("change", () => {
  updateCommandControls();
  addLog(`Commands ${els.commandsEnabled.checked ? "enabled" : "disabled"}`, els.commandsEnabled.checked ? "ok" : "warn");
});
els.globalSpeed.addEventListener("input", () => { els.globalSpeedValue.value = `${els.globalSpeed.value}%`; });
els.zeroAllBtn.addEventListener("click", () => runSequentialHome("تصفير المحاور"));
els.homeBtn.addEventListener("click", () => runSequentialHome("وضع البداية"));
els.stopBtn.addEventListener("click", emergencyStop);
els.disableOutputsBtn.addEventListener("click", disableOutputs);
els.clearLogBtn.addEventListener("click", () => { els.commandLog.innerHTML = ""; });
els.lockDuringMove.addEventListener("change", updateCommandControls);

navigator.serial?.addEventListener("disconnect", async event => {
  if (port && event.target === port) {
    toast("تم فصل الأردوينو.", "error");
    await cleanupSerial();
  }
});

buildAxisCards();
updateConnectionUI();
addLog("Dashboard ready — servo signals remain released", "ok");
setInterval(updateSessionClock, 1000);
