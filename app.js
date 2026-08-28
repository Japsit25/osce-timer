"use strict";

const $ = (id) => document.getElementById(id);
const sounds = {
  warning: new Audio("sound/เสียงเตือน.wav"),
  longBell: new Audio("sound/กริ่งยาว.wav"),
  finish: new Audio("sound/กริ่งหมดเวลา.wav")
};

const state = {
  running: false, paused: false, transitioning: false, finished: false, finishing: false,
  station: 0, endAt: 0, pausedRemaining: 0, warningPlayed: [], timer: null
};

let wakeLock = null;
let audioUnlocked = false;
let stationToken = 0;
const MAX_WARNINGS = 3;

function getWarningRows() {
  return [...document.querySelectorAll(".warning-time-row")];
}

function getFields() {
  return [
    $("stationCount"), $("endHours"), $("endMinutes"), $("endSeconds"),
    ...getWarningRows().flatMap(row => [...row.querySelectorAll("input")])
  ];
}

function seconds(prefix) {
  return (+$(prefix + "Hours").value || 0) * 3600 +
         (+$(prefix + "Minutes").value || 0) * 60 +
         (+$(prefix + "Seconds").value || 0);
}

function rowSeconds(row) {
  const inputs = row.querySelectorAll("input");
  return (+inputs[0].value || 0) * 3600 +
         (+inputs[1].value || 0) * 60 +
         (+inputs[2].value || 0);
}

function getWarningTimes() {
  return getWarningRows().map(rowSeconds);
}

function formatTime(value) {
  const n = Math.max(0, Math.ceil(value));
  return [Math.floor(n / 3600), Math.floor(n % 3600 / 60), n % 60]
    .map(v => String(v).padStart(2, "0")).join(":");
}

// iOS/WebKit only allows an <audio> element to autoplay later if that exact
// element was already played during a real user tap. Priming all sounds
// together on Start prevents later timer-triggered playback from being blocked.
function unlockAllAudio() {
  if (audioUnlocked) return;
  audioUnlocked = true;
  Object.values(sounds).forEach(audio => {
    audio.muted = true;
    const playPromise = audio.play();
    if (playPromise && playPromise.catch) playPromise.catch(() => {});
    audio.pause();
    audio.currentTime = 0;
    audio.muted = false;
  });
}

function play(sound, retry = true) {
  const audio = sounds[sound];
  audio.pause();
  audio.currentTime = 0;
  audio.play().catch(() => {
    if (retry) setTimeout(() => play(sound, false), 300);
  });
}

function playAndWait(sound, timeoutMs = 12000) {
  const audio = sounds[sound];
  audio.pause();
  audio.currentTime = 0;
  return new Promise(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      audio.removeEventListener("ended", finish);
      clearTimeout(fallback);
      resolve();
    };
    const fallback = setTimeout(finish, timeoutMs);
    audio.addEventListener("ended", finish, { once: true });
    audio.play().catch(() => {
      setTimeout(() => { audio.play().catch(finish); }, 300);
    });
  });
}

function silenceAllAudio() {
  Object.values(sounds).forEach(audio => {
    audio.pause();
    audio.currentTime = 0;
  });
}

async function requestWakeLock() {
  try {
    if ("wakeLock" in navigator) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    }
  } catch (err) {}
}

function releaseWakeLock() {
  if (wakeLock) {
    wakeLock.release();
    wakeLock = null;
  }
}

document.addEventListener("visibilitychange", () => {
  if (state.running && !state.paused && !state.finished && document.visibilityState === "visible") {
    requestWakeLock();
  }
});

function toggleFullscreen() {
  const el = document.documentElement;
  const isFullscreen = document.fullscreenElement || document.webkitFullscreenElement;
  if (!isFullscreen) {
    (el.requestFullscreen || el.webkitRequestFullscreen || function(){}).call(el).catch(() => {});
  } else {
    (document.exitFullscreen || document.webkitExitFullscreen || function(){}).call(document).catch(() => {});
  }
}

function normalizeField(field) {
  const max = Number(field.max);
  const min = Number(field.min);
  if (field.value === "") return;
  field.value = Math.min(max, Math.max(min, Math.floor(Number(field.value) || 0)));
}

function validSettings(showMessage = true) {
  getFields().forEach(normalizeField);

  const end = seconds("end");
  const warningTimes = getWarningTimes();
  let message = "";

  if (end <= 0) {
    message = "เวลาหมดเวลาต้องมากกว่า 00:00:00";
  } else if (warningTimes.some(time => time >= end && time > 0)) {
    message = "เวลาเตือนต้องน้อยกว่าเวลาหมดเวลา";
  }

  $("validationMessage").textContent = showMessage ? message : "";
  $("startButton").disabled = Boolean(message) || state.running || state.finishing;
  return !message;
}

function setControls() {
  $("startButton").disabled = state.running || state.finishing || !validSettings(false);
  $("pauseButton").disabled = !state.running || state.transitioning || state.finished;
  $("pauseButton").innerHTML = state.paused
    ? "<span>▶</span> นับต่อ"
    : "<span>Ⅱ</span> หยุดชั่วคราว";
  $("stopButton").disabled = !state.running || state.finished;

  getFields().forEach(field => {
    field.disabled = state.running || state.finishing;
  });

  const addButton = $("addWarningButton");
  if (addButton) {
    addButton.disabled = state.running || state.finishing || getWarningRows().length >= MAX_WARNINGS;
  }

  document.querySelectorAll(".warning-remove-button").forEach(button => {
    button.disabled = state.running || state.finishing;
  });
}

function remainingNow() {
  return state.paused
    ? state.pausedRemaining
    : Math.max(0, (state.endAt - Date.now()) / 1000);
}

function updateDisplay(currentRemaining = null) {
  const count = +$("stationCount").value || 0;
  const currentTimeDisplay = $("currentTime");

  if (!state.running && currentRemaining === null && !state.finished) {
    $("currentStation").textContent = "—";
    $("stationsRemaining").textContent = "—";
    currentTimeDisplay.className = "display clock-display";
    currentTimeDisplay.textContent = formatTime(seconds("end"));
    $("totalTime").textContent = formatTime(seconds("end") * count);
    return;
  }

  const current = currentRemaining ?? remainingNow();
  $("currentStation").textContent = state.station || "—";
  $("stationsRemaining").textContent = count;
  currentTimeDisplay.className = "display clock-display" +
    (state.finished ? " is-finished" :
     state.transitioning && state.station > 1 ? " is-next-station" : "");
  currentTimeDisplay.textContent = state.finished
    ? "หมดเวลา"
    : state.transitioning
      ? (state.station > 1 ? "สถานีต่อไป" : "เริ่มจับเวลา")
      : formatTime(current);

  const totalRemaining = state.transitioning
    ? (count - state.station + 1) * seconds("end")
    : current + (count - state.station) * seconds("end");

  $("totalTime").textContent = formatTime(state.finished ? 0 : totalRemaining);
}

async function completeSession() {
  clearInterval(state.timer);
  state.timer = null;
  state.running = false;
  state.paused = false;
  state.finished = true;
  state.finishing = true;
  updateDisplay(0);
  setControls();
  releaseWakeLock();
  await playAndWait("finish");
  state.finishing = false;
  setControls();
}

async function beginStation() {
  if (!state.running) return;

  const token = ++stationToken;
  state.transitioning = true;
  updateDisplay();
  setControls();

  await playAndWait("longBell");

  if (!state.running || token !== stationToken) return;

  state.transitioning = false;
  state.warningPlayed = getWarningTimes().map(() => false);
  state.endAt = Date.now() + seconds("end") * 1000;
  state.timer = setInterval(tick, 200);
  updateDisplay();
  setControls();
}

function tick() {
  if (!state.running || state.paused) return;

  const remain = remainingNow();
  const endSeconds = seconds("end");
  const elapsed = Math.max(0, endSeconds - remain);
  const warningTimes = getWarningTimes();

  updateDisplay(remain);

  // Each configured warning is played once per station.
  warningTimes.forEach((warningTime, index) => {
    if (warningTime > 0 && !state.warningPlayed[index] && elapsed >= warningTime) {
      state.warningPlayed[index] = true;
      play("warning");
    }
  });

  if (remain > 0) return;

  if (state.station < +$("stationCount").value) {
    clearInterval(state.timer);
    state.timer = null;
    state.station += 1;
    beginStation();
  } else {
    completeSession();
  }
}

function start() {
  if (!validSettings()) return;

  unlockAllAudio();
  requestWakeLock();
  state.running = true;
  state.paused = false;
  state.finished = false;
  state.station = 1;
  state.warningPlayed = [];
  beginStation();
}

function pauseOrResume() {
  if (!state.running) return;

  if (state.paused) {
    state.endAt = Date.now() + state.pausedRemaining * 1000;
    state.paused = false;
    state.timer = setInterval(tick, 200);
  } else {
    state.pausedRemaining = remainingNow();
    state.paused = true;
    clearInterval(state.timer);
    state.timer = null;
  }

  updateDisplay();
  setControls();
}

function stop() {
  stationToken++;
  clearInterval(state.timer);
  silenceAllAudio();
  Object.assign(state, {
    running: false, paused: false, transitioning: false, finished: false,
    finishing: false, station: 0, pausedRemaining: 0, warningPlayed: [], timer: null
  });
  updateDisplay();
  setControls();
  releaseWakeLock();
}

function reset() {
  stop();
  $("stationCount").value = 1;
  $("endHours").value = 0;
  $("endMinutes").value = 0;
  $("endSeconds").value = 0;

  // Keep the original first warning exactly as supplied, then remove extras.
  $("warningHours").value = 0;
  $("warningMinutes").value = 0;
  $("warningSeconds").value = 0;
  getWarningRows().slice(1).forEach(row => row.remove());

  validSettings();
  updateDisplay();
  setControls();
}

function addWarningTime() {
  const rows = getWarningRows();
  if (rows.length >= MAX_WARNINGS || state.running || state.finishing) return;

  const index = rows.length;
  const row = document.createElement("fieldset");
  row.className = "time-row warning-time-row";
  row.dataset.warningIndex = String(index);
  row.innerHTML = `
    <legend>เตือนเวลา ${index + 1}</legend>
    <div class="time-inputs">
      <label>ชั่วโมง<input type="number" min="0" max="99" value="0" /></label>
      <label>นาที<input type="number" min="0" max="59" value="0" /></label>
      <label>วินาที<input type="number" min="0" max="59" value="0" /></label>
    </div>
    <button class="warning-remove-button" type="button" title="ลบเวลาเตือน" aria-label="ลบเวลาเตือน">×</button>
  `;

  $("warningTimesContainer").insertBefore(row, $("validationMessage"));
  row.querySelectorAll("input").forEach(input => {
    input.addEventListener("input", handleSettingsInput);
  });
  row.querySelector(".warning-remove-button").addEventListener("click", () => {
    if (state.running || state.finishing) return;
    row.remove();
    renumberWarningRows();
    validSettings();
    updateDisplay();
    setControls();
  });

  renumberWarningRows();
  validSettings();
  updateDisplay();
  setControls();

  // Put focus on the first field of the newly-created warning.
  row.querySelector("input")?.focus();
}

function renumberWarningRows() {
  getWarningRows().forEach((row, index) => {
    row.dataset.warningIndex = String(index);
    row.querySelector("legend").textContent = `เตือนเวลา ${index + 1}`;
  });

  const addButton = $("addWarningButton");
  if (addButton) addButton.disabled = state.running || state.finishing || getWarningRows().length >= MAX_WARNINGS;
}

function handleSettingsInput() {
  validSettings();
  if (state.finished && !state.finishing) {
    state.finished = false;
    state.station = 0;
  }
  if (!state.running) updateDisplay();
  setControls();
}

$("startButton").addEventListener("click", start);
$("pauseButton").addEventListener("click", pauseOrResume);
$("stopButton").addEventListener("click", stop);
$("resetButton").addEventListener("click", reset);
$("fullscreenButton").addEventListener("click", toggleFullscreen);
$("addWarningButton").addEventListener("click", addWarningTime);

$("stationCount").addEventListener("input", handleSettingsInput);
$("endHours").addEventListener("input", handleSettingsInput);
$("endMinutes").addEventListener("input", handleSettingsInput);
$("endSeconds").addEventListener("input", handleSettingsInput);
$("warningHours").addEventListener("input", handleSettingsInput);
$("warningMinutes").addEventListener("input", handleSettingsInput);
$("warningSeconds").addEventListener("input", handleSettingsInput);

document.querySelectorAll("[data-sound]").forEach(button => {
  button.addEventListener("click", () => play(button.dataset.sound));
});

validSettings();
updateDisplay();
setControls();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js").catch(() => {});
  });
}
