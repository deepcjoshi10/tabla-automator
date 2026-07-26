// Master sound buffer store for polyphonic playback
const soundBuffers = {};

// Fallback synths
const bayanSynth = new Tone.MembraneSynth().toDestination();
const dayanSynth = new Tone.MetalSynth({
  frequency: 220,
  envelope: { attack: 0.001, decay: 0.08, release: 0.01 },
  harmonicity: 5.1,
  modulationIndex: 16,
  resonance: 2000,
  octaves: 1.5
}).toDestination();

let loopEvent = null;
let isPlaying = false;
let parsedMatras = [];

// Stepped Tempo Tracking Variables
let currentBpm = 80;
let targetBpm = 160;
let bpmStep = 10;
let holdTimeSeconds = 10;
let stepStartTime = 0;
let timerInterval = null;

// DOM Elements
const startBtn = document.getElementById('startBtn');
const bolsInput = document.getElementById('bolsInput');
const gridContainer = document.getElementById('gridContainer');

const startBpmInput = document.getElementById('startBpm');
const targetBpmInput = document.getElementById('targetBpm');
const bpmStepInput = document.getElementById('bpmStep');
const holdSecsInput = document.getElementById('holdSecs');
const timerDisplay = document.getElementById('timerDisplay');

const recBtn = document.getElementById('recBtn');
const newBolNameInput = document.getElementById('newBolName');
const statusMsg = document.getElementById('statusMsg');

// Explicit mapping of preset files in sound/ folder
const soundFileMap = {
  "dha": ["sound/Dha.webm", "sound/dha.webm", "sounds/dha.webm", "sounds/dha.mp3"],
  "dhi": ["sound/Dhi.webm", "sound/dhi.webm", "sounds/dhi.webm"],
  "dhin": ["sound/Dhin.webm", "sound/dhin.webm", "sounds/dhin.webm"],
  "na": ["sound/Na.webm", "sound/na.webm", "sounds/na.webm"],
  "ta": ["sound/Ta.webm", "sound/ta.webm", "sounds/ta.webm"],
  "ti": ["sound/Ti.webm", "sound/ti.webm", "sounds/ti.webm"],
  "tin": ["sound/Tin.webm", "sound/tin.webm", "sounds/tin.webm"],
  "tirakit": ["sound/Tirakit.webm", "sound/tirakit.webm", "sounds/tirakit.webm"]
};

// ============================================================
// INDEXEDDB DATABASE (PERMANENT STORAGE)
// ============================================================
const DB_NAME = 'TablaAutomatorDB';
const STORE_NAME = 'custom_bols';

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveBolToDB(bolName, arrayBuffer) {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(arrayBuffer, bolName.toLowerCase());
  } catch (err) {
    console.warn("Failed to save to IndexedDB:", err);
  }
}

async function loadSavedBolsFromDB() {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.openCursor();

    req.onsuccess = async (e) => {
      const cursor = e.target.result;
      if (cursor) {
        const bolName = cursor.key;
        const arrayBuffer = cursor.value;
        const rawCtx = Tone.context.rawContext || Tone.context;
        const decodedBuffer = await rawCtx.decodeAudioData(arrayBuffer.slice(0));
        soundBuffers[bolName] = processAudioBuffer(decodedBuffer);
        console.log(`📱 Loaded clean custom bol "${bolName}" from database.`);
        cursor.continue();
      }
    };
  } catch (err) {
    console.warn("IndexedDB Load Error:", err);
  }
}

// ============================================================
// AUDIO PROCESSOR (SILENCE TRIMMER + PEAK NORMALIZER)
// ============================================================
function processAudioBuffer(audioBuffer, targetPeak = 0.85) {
  const channelData = audioBuffer.getChannelData(0);
  let startIndex = 0;
  
  // 1. Trim leading silence
  for (let i = 0; i < channelData.length; i++) {
    if (Math.abs(channelData[i]) > 0.015) {
      startIndex = i;
      break;
    }
  }

  const safetyPadding = Math.floor(audioBuffer.sampleRate * 0.001);
  startIndex = Math.max(0, startIndex - safetyPadding);

  const newLength = audioBuffer.length - startIndex;
  const rawCtx = Tone.context.rawContext || Tone.context;
  const processedBuffer = rawCtx.createBuffer(
    audioBuffer.numberOfChannels,
    newLength,
    audioBuffer.sampleRate
  );

  let maxPeak = 0;
  for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
    const srcData = audioBuffer.getChannelData(c);
    const destData = processedBuffer.getChannelData(c);
    for (let i = 0; i < newLength; i++) {
      const val = srcData[startIndex + i];
      destData[i] = val;
      if (Math.abs(val) > maxPeak) maxPeak = Math.abs(val);
    }
  }

  // 2. Normalize gain to prevent screeching/clipping
  if (maxPeak > 0) {
    const scale = targetPeak / maxPeak;
    for (let c = 0; c < processedBuffer.numberOfChannels; c++) {
      const destData = processedBuffer.getChannelData(c);
      for (let i = 0; i < destData.length; i++) {
        destData[i] *= scale;
      }
    }
  }

  return processedBuffer;
}

// Load preset sound files from sound/ folder
async function loadAudioFile(bolKey, urlPath) {
  try {
    const response = await fetch(urlPath);
    if (!response.ok) return false;
    
    const arrayBuffer = await response.arrayBuffer();
    const rawCtx = Tone.context.rawContext || Tone.context;
    const rawAudioBuffer = await rawCtx.decodeAudioData(arrayBuffer);
    
    soundBuffers[bolKey] = processAudioBuffer(rawAudioBuffer);
    console.log(`⚡ Processed & Loaded clean audio for "${bolKey}" from ${urlPath}`);
    return true;
  } catch (err) {
    return false;
  }
}

async function initSoundLibrary() {
  for (const [bolKey, pathList] of Object.entries(soundFileMap)) {
    for (const path of pathList) {
      const loaded = await loadAudioFile(bolKey, path);
      if (loaded) break;
    }
  }
  await loadSavedBolsFromDB();
}

initSoundLibrary();

// Parse sequence text into visual grid
function parsePattern(inputText) {
  gridContainer.innerHTML = '';
  parsedMatras = [];

  const rawVibhags = inputText.split('|');
  
  rawVibhags.forEach((vibhagStr, vIdx) => {
    let text = vibhagStr.trim();
    let taliKhaliTag = `Vibhag ${vIdx + 1}`;

    if (text.includes(':')) {
      const parts = text.split(':');
      const tag = parts[0].trim().toUpperCase();
      text = parts[1].trim();

      if (tag === 'X' || tag === '+') taliKhaliTag = 'Sam (X)';
      else if (tag === '0') taliKhaliTag = 'Khali (0)';
      else taliKhaliTag = `Tali (${tag})`;
    }

    const bols = text.split(' ').map(b => b.trim()).filter(b => b.length > 0);
    if (bols.length === 0) return;

    const vibhagBox = document.createElement('div');
    vibhagBox.className = 'vibhag-box';

    const header = document.createElement('div');
    header.className = 'vibhag-header';
    header.textContent = taliKhaliTag;
    vibhagBox.appendChild(header);

    const matraList = document.createElement('div');
    matraList.className = 'matra-list';

    bols.forEach((bol) => {
      const matraCard = document.createElement('div');
      matraCard.className = 'matra-card';
      matraCard.textContent = bol;
      matraList.appendChild(matraCard);

      parsedMatras.push({
        bol: bol.toLowerCase(),
        element: matraCard
      });
    });

    vibhagBox.appendChild(matraList);
    gridContainer.appendChild(vibhagBox);
  });
}

if (bolsInput) {
  parsePattern(bolsInput.value);
  bolsInput.addEventListener('input', () => { if (!isPlaying) parsePattern(bolsInput.value); });
}

// Play sound safely
function playBol(bolName, time) {
  const bol = bolName.trim().toLowerCase();
  const buffer = soundBuffers[bol];

  if (buffer) {
    try {
      const rawCtx = Tone.context.rawContext || Tone.context;
      const source = rawCtx.createBufferSource();
      source.buffer = buffer;
      source.connect(rawCtx.destination);
      source.start(time);
      return;
    } catch (e) {
      console.warn(`Playback error for ${bol}:`, e);
    }
  }

  // Fallback Synth if audio file is missing
  if (['dha', 'dhin', 'ge', 'ga', 'ghe'].includes(bol)) {
    bayanSynth.triggerAttackRelease("C2", "8n", time);
    dayanSynth.triggerAttackRelease("C4", "16n", time, 0.2);
  } else {
    dayanSynth.triggerAttackRelease("G4", "16n", time);
  }
}

// ============================================================
// CLEAN MIC RECORDER (MIC CONSTRAINTS PREVENT SCREECHING)
// ============================================================
if (recBtn) {
  recBtn.addEventListener('click', async () => {
    await Tone.start();
    await initSoundLibrary();

    const bolName = newBolNameInput.value
      .trim()
      .toLowerCase()
      .replace(/\.(wav|mp3|ogg|m4a|webm)$/i, '');
    
    if (!bolName) {
      alert("Please type a name for the bol first (e.g. 'ghe')");
      return;
    }

    try {
      // Audio constraints to prevent distortion, squeaking, and gain spikes
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: false // Prevents mic gain pumping / squealing
        }
      });

      statusMsg.textContent = "🎙️ Get ready to speak...";
      statusMsg.style.color = "#ff007f";

      let mimeType = 'audio/webm';
      if (!MediaRecorder.isTypeSupported('audio/webm') && MediaRecorder.isTypeSupported('audio/mp4')) {
        mimeType = 'audio/mp4';
      }

      const mediaRecorder = new MediaRecorder(stream, { mimeType });
      const audioChunks = [];

      mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
      
      mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(audioChunks, { type: mimeType });
        const arrayBuffer = await audioBlob.arrayBuffer();

        await saveBolToDB(bolName, arrayBuffer);

        const rawCtx = Tone.context.rawContext || Tone.context;
        const decodedBuffer = await rawCtx.decodeAudioData(arrayBuffer);
        
        // Clean, trim, and normalize peak volume
        soundBuffers[bolName] = processAudioBuffer(decodedBuffer);

        statusMsg.innerHTML = `<span style="color: #00f2fe;">✅ Recorded Cleanly! Bol "${bolName}" saved.</span>`;
        newBolNameInput.value = '';

        stream.getTracks().forEach(track => track.stop());
      };

      setTimeout(() => {
        mediaRecorder.start();
        statusMsg.textContent = "🔴 RECORDING NOW (1 SEC)... SPEAK!";
        
        setTimeout(() => {
          mediaRecorder.stop();
        }, 1000);

      }, 800);

    } catch (err) {
      alert("Microphone permission blocked or unavailable!");
      console.error(err);
    }
  });
}

// PLAYBACK LOGIC
function stopSession() {
  Tone.Transport.stop();
  if (loopEvent) loopEvent.dispose();
  clearInterval(timerInterval);
  document.querySelectorAll('.matra-card').forEach(el => el.classList.remove('active'));

  isPlaying = false;
  startBtn.textContent = '▶ Start Practice Session';
  startBtn.style.backgroundColor = '#00f2fe';
}

if (startBtn) {
  startBtn.addEventListener('click', async () => {
    await Tone.start();
    await initSoundLibrary();

    if (!isPlaying) {
      parsePattern(bolsInput.value);
      if (parsedMatras.length === 0) return;

      currentBpm = parseFloat(startBpmInput.value);
      targetBpm = parseFloat(targetBpmInput.value);
      bpmStep = Math.abs(parseFloat(bpmStepInput.value));
      holdTimeSeconds = parseFloat(holdSecsInput.value);

      stepStartTime = Date.now();
      let beatIndex = 0;

      loopEvent = new Tone.Loop((time) => {
        const currentBeat = parsedMatras[beatIndex % parsedMatras.length];

        playBol(currentBeat.bol, time);

        Tone.Draw.schedule(() => {
          document.querySelectorAll('.matra-card').forEach(el => el.classList.remove('active'));
          if (currentBeat.element) currentBeat.element.classList.add('active');
        }, time);

        beatIndex++;
      }, "4n").start(0);

      Tone.Transport.bpm.value = currentBpm;
      Tone.Transport.start();

      timerInterval = setInterval(() => {
        const elapsedSecondsInStep = (Date.now() - stepStartTime) / 1000;
        const timeRemainingInStep = Math.ceil(holdTimeSeconds - elapsedSecondsInStep);

        if (timeRemainingInStep <= 0) {
          if (currentBpm < targetBpm) {
            currentBpm = Math.min(targetBpm, currentBpm + bpmStep);
            Tone.Transport.bpm.value = currentBpm;
            stepStartTime = Date.now();
          } else if (currentBpm > targetBpm) {
            currentBpm = Math.max(targetBpm, currentBpm - bpmStep);
            Tone.Transport.bpm.value = currentBpm;
            stepStartTime = Date.now();
          }
        }

        if (currentBpm === targetBpm) {
          timerDisplay.textContent = `🔥 Target Tempo Reached: ${currentBpm} BPM`;
        } else {
          const stepSign = currentBpm < targetBpm ? `+${bpmStep}` : `-${bpmStep}`;
          timerDisplay.textContent = `Current Tempo: ${currentBpm} BPM | Next (${stepSign} BPM) in: ${Math.max(0, timeRemainingInStep)}s`;
        }

      }, 200);

      isPlaying = true;
      startBtn.textContent = '⏹ Stop Practice Session';
      startBtn.style.backgroundColor = '#ff4b4b';

    } else {
      stopSession();
    }
  });
}