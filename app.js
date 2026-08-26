"use strict";

const $ = (id) => document.getElementById(id);
const fields = ["stationCount", "endHours", "endMinutes", "endSeconds", "warningHours", "warningMinutes", "warningSeconds"].map($);
const sounds = {
  warning: new Audio("sound/เสียงเตือน.wav"),
  longBell: new Audio("sound/กริ่งยาว.wav"),
  finish: new Audio("sound/กริ่งหมดเวลา.wav")
};
const state = { running: false, paused: false, transitioning: false, finished: false, finishing: false, station: 0, endAt: 0, pausedRemaining: 0, warningPlayed: false, timer: null };
let wakeLock = null;
let audioUnlocked = false;
let stationToken = 0;

function seconds(prefix) {
  return (+$(prefix + "Hours").value || 0) * 3600 + (+$(prefix + "Minutes").value || 0) * 60 + (+$(prefix + "Seconds").value || 0);
}
function formatTime(value) {
  const n = Math.max(0, Math.ceil(value));
  return [Math.floor(n / 3600), Math.floor(n % 3600 / 60), n % 60].map(v => String(v).padStart(2, "0")).join(":");
}
// iOS/WebKit only allows an <audio> element to autoplay later if that exact
// element was already played (even silently) during a real user tap. Priming
// all three sounds together on the Start button tap prevents the finish bell
// from being silently blocked when it fires later from a timer callback.
function unlockAllAudio() {
  if (audioUnlocked) return;
  audioUnlocked = true;
  Object.values(sounds).forEach(audio => {
    audio.muted = true;
    const playPromise = audio.play();
    // Pause synchronously (not inside .then()) so the mute/unmute happens
    // before any later real play() call on the same element can race it.
    if (playPromise && playPromise.catch) playPromise.catch(() => {});
    audio.pause();
    audio.currentTime = 0;
    audio.muted = false;
  });
}
function play(sound, retry = true) {
  const audio = sounds[sound];
  audio.pause(); audio.currentTime = 0;
  audio.play().catch(() => {
    // Playback can be blocked once (e.g. device just woke from sleep); retry shortly.
    if (retry) setTimeout(() => play(sound, false), 300);
  });
}
function playAndWait(sound, timeoutMs = 12000) {
  const audio = sounds[sound];
  audio.pause(); audio.currentTime = 0;
  return new Promise(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      audio.removeEventListener("ended", finish);
      clearTimeout(fallback);
      resolve();
    };
    // Safety net: if playback never actually starts (e.g. blocked by the
    // browser), don't leave the caller waiting forever for "ended".
    const fallback = setTimeout(finish, timeoutMs);
    audio.addEventListener("ended", finish, { once: true });
    audio.play().catch(() => {
      setTimeout(() => { audio.play().catch(finish); }, 300);
    });
  });
}
function silenceAllAudio() {
  Object.values(sounds).forEach(audio => { audio.pause(); audio.currentTime = 0; });
}
async function requestWakeLock() {
  try {
    if ("wakeLock" in navigator) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    }
  } catch (err) { /* Wake Lock unsupported or unavailable (e.g. low battery); not critical. */ }
}
function releaseWakeLock() {
  if (wakeLock) { wakeLock.release(); wakeLock = null; }
}
document.addEventListener("visibilitychange", () => {
  // Re-acquire the wake lock after returning from a background tab/app switch.
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
  const max = Number(field.max); const min = Number(field.min);
  if (field.value === "") return;
  field.value = Math.min(max, Math.max(min, Math.floor(Number(field.value) || 0)));
}
function validSettings(showMessage = true) {
  fields.forEach(normalizeField);
  const end = seconds("end"), warning = seconds("warning");
  let message = "";
  if (end <= 0) message = "เวลาหมดเวลาต้องมากกว่า 00:00:00";
  else if (warning >= end) message = "เวลาเตือนต้องน้อยกว่าเวลาหมดเวลา";
  $("validationMessage").textContent = showMessage ? message : "";
  $("startButton").disabled = Boolean(message) || state.running;
  return !message;
}
function setControls() {
  $("startButton").disabled = state.running || state.finishing || !validSettings(false);
  $("pauseButton").disabled = !state.running || state.transitioning || state.finished;
  $("pauseButton").innerHTML = state.paused ? "<span>▶</span> นับต่อ" : "<span>Ⅱ</span> หยุดชั่วคราว";
  $("stopButton").disabled = !state.running || state.finished;
  fields.forEach(field => field.disabled = state.running || state.finishing);
}
function remainingNow() { return state.paused ? state.pausedRemaining : Math.max(0, (state.endAt - Date.now()) / 1000); }
function updateDisplay(currentRemaining = null) {
  const count = +$("stationCount").value || 0;
  const currentTimeDisplay = $("currentTime");
  if (!state.running && currentRemaining === null && !state.finished) {
    $("currentStation").textContent = "—"; $("stationsRemaining").textContent = "—";
    currentTimeDisplay.className = "display clock-display";
    currentTimeDisplay.textContent = formatTime(seconds("end")); $("totalTime").textContent = formatTime(seconds("end") * count); return;
  }
  const current = currentRemaining ?? remainingNow();
  $("currentStation").textContent = state.station || "—";
  $("stationsRemaining").textContent = count;
  currentTimeDisplay.className = "display clock-display" + (state.finished ? " is-finished" : state.transitioning && state.station > 1 ? " is-next-station" : "");
  currentTimeDisplay.textContent = state.finished ? "หมดเวลา" : state.transitioning ? (state.station > 1 ? "สถานีต่อไป" : "เริ่มจับเวลา") : formatTime(current);
  // During the bell, the next station has not begun counting down, so its full allotted time remains.
  const totalRemaining = state.transitioning ? (count - state.station + 1) * seconds("end") : current + (count - state.station) * seconds("end");
  $("totalTime").textContent = formatTime(state.finished ? 0 : totalRemaining);
}
async function completeSession() {
  clearInterval(state.timer); state.timer = null; state.running = false; state.paused = false; state.finished = true; state.finishing = true;
  updateDisplay(0); setControls(); releaseWakeLock();
  await playAndWait("finish");
  state.finishing = false;
  setControls();
}
async function beginStation() {
  if (!state.running) return;
  const token = ++stationToken;
  state.transitioning = true; updateDisplay(); setControls();
  await playAndWait("longBell");
  // If stop/reset/another beginStation happened while we were waiting for the
  // bell, this call is stale — bail out instead of overwriting newer state.
  if (!state.running || token !== stationToken) return;
  state.transitioning = false; state.warningPlayed = false; state.endAt = Date.now() + seconds("end") * 1000;
  state.timer = setInterval(tick, 200); updateDisplay(); setControls();
}
function tick() {
  if (!state.running || state.paused) return;
  const remain = remainingNow(), warningElapsed = seconds("warning"), warningAtRemaining = seconds("end") - warningElapsed;
  updateDisplay(remain);
  if (!state.warningPlayed && warningElapsed > 0 && remain <= warningAtRemaining) { state.warningPlayed = true; play("warning"); }
  if (remain > 0) return;
  if (state.station < +$("stationCount").value) {
    clearInterval(state.timer); state.timer = null; state.station += 1; beginStation();
  } else completeSession();
}
function start() {
  if (!validSettings()) return;
  unlockAllAudio();
  requestWakeLock();
  state.running = true; state.paused = false; state.finished = false; state.station = 1; state.warningPlayed = false; beginStation();
}
function pauseOrResume() {
  if (!state.running) return;
  if (state.paused) { state.endAt = Date.now() + state.pausedRemaining * 1000; state.paused = false; state.timer = setInterval(tick, 200); }
  else { state.pausedRemaining = remainingNow(); state.paused = true; clearInterval(state.timer); }
  updateDisplay(); setControls();
}
function stop() {
  stationToken++;
  clearInterval(state.timer); silenceAllAudio(); Object.assign(state, { running:false, paused:false, transitioning:false, finished:false, finishing:false, station:0, pausedRemaining:0, timer:null }); updateDisplay(); setControls(); releaseWakeLock();
}
function reset() {
  stop(); $("stationCount").value = 1; $("endHours").value = 0; $("endMinutes").value = 0; $("endSeconds").value = 0; $("warningHours").value = 0; $("warningMinutes").value = 0; $("warningSeconds").value = 0; validSettings(); updateDisplay();
}

fields.forEach(field => field.addEventListener("input", () => {
  validSettings();
  if (state.finished && !state.finishing) { state.finished = false; state.station = 0; }
  if (!state.running) updateDisplay();
}));
$("startButton").addEventListener("click", start); $("pauseButton").addEventListener("click", pauseOrResume); $("stopButton").addEventListener("click", stop); $("resetButton").addEventListener("click", reset);
$("fullscreenButton").addEventListener("click", toggleFullscreen);
document.querySelectorAll("[data-sound]").forEach(button => button.addEventListener("click", () => play(button.dataset.sound)));
validSettings(); updateDisplay(); setControls();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js").catch(() => {});
  });
}
