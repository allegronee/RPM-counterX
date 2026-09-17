// RPMcounterX - ESP32-C3 BLE + USB Serial
const SERVICE_UUID = '12345678-1234-1234-1234-1234567890ab';
const RPM_UUID = '12345678-1234-1234-1234-1234567890ac';
const COMMAND_UUID = '12345678-1234-1234-1234-1234567890ad';
const DEVICE_NAME = 'Beyblade RPM';

// Display/measurement range. The ESP32 deliberately does not clamp RPM.
const DISPLAY_MAX_RPM = 40000;
const DISPLAY_UPDATE_MS = 50;

let device = null;
let rpmChar = null;
let commandChar = null;
let serialPort = null;
let serialReader = null;
let serialKeepReading = false;
let currentRpm = 0;
let maxRpm = 0;
let lastDisplayMs = 0;
let pendingRpm = null;
let pendingMax = null;

const rpmEl = document.getElementById('rpmValue');
const maxEl = document.getElementById('maxValue');
const saveBtn = document.getElementById('saveBtn');
const resetBtn = document.getElementById('resetBtn');
const historyList = document.getElementById('historyList');
const emptyHistory = document.getElementById('emptyHistory');
const recordCount = document.getElementById('recordCount');
const statusPill = document.getElementById('status');
const connectBtn = document.getElementById('connectBtn');
const serialBtn = document.getElementById('serialBtn');

function setStatus(text, connected = false) {
    statusPill.textContent = text;
    statusPill.classList.toggle('connected', connected);
}

function setConnectedUi(connected) {
    saveBtn.disabled = !connected;
    resetBtn.disabled = !connected;
}

function drawDisplay(rpm, maxFromDevice = null) {
    currentRpm = Math.max(0, Math.round(Number(rpm) || 0));
    rpmEl.textContent = currentRpm.toLocaleString('it-IT');

    if (maxFromDevice !== null) {
        maxRpm = Math.max(0, Math.round(Number(maxFromDevice) || 0));
    } else if (currentRpm > maxRpm) {
        maxRpm = currentRpm;
    }

    maxEl.textContent = maxRpm.toLocaleString('it-IT');
    rpmEl.classList.remove('pulse');
    void rpmEl.offsetWidth;
    rpmEl.classList.add('pulse');
}

function updateDisplay(rpm, maxFromDevice = null) {
    pendingRpm = rpm;
    if (maxFromDevice !== null) pendingMax = maxFromDevice;

    const now = performance.now();
    if (now - lastDisplayMs >= DISPLAY_UPDATE_MS) {
        lastDisplayMs = now;
        drawDisplay(pendingRpm, pendingMax);
        pendingRpm = null;
        pendingMax = null;
    }
}

function parseData(text) {
    const rpmMatch = text.match(/RPM\s*:\s*(\d+)/i);
    const maxMatch = text.match(/MAX\s*:\s*(\d+)/i);

    if (rpmMatch) {
        updateDisplay(Number(rpmMatch[1]), maxMatch ? Number(maxMatch[1]) : null);
        return true;
    }

    const numberMatch = text.match(/\d+/);
    if (numberMatch) {
        updateDisplay(Number(numberMatch[0]));
        return true;
    }
    return false;
}

function onRpmNotification(event) {
    const text = new TextDecoder().decode(event.target.value).trim();
    if (text) parseData(text);
}

async function connectLauncher() {
    if (!navigator.bluetooth) {
        alert('Web Bluetooth non disponibile. Su PC usa Chrome o Edge aggiornato, oppure USB PC.');
        return;
    }

    try {
        connectBtn.disabled = true;
        connectBtn.textContent = 'RICERCA...';
        setStatus('RICERCA BLE...');

        device = await navigator.bluetooth.requestDevice({
            filters: [{ name: DEVICE_NAME }],
            optionalServices: [SERVICE_UUID]
        });

        device.addEventListener('gattserverdisconnected', onDisconnected);
        setStatus('CONNESSIONE...');

        const server = await device.gatt.connect();
        const service = await server.getPrimaryService(SERVICE_UUID);
        rpmChar = await service.getCharacteristic(RPM_UUID);
        await rpmChar.startNotifications();
        rpmChar.addEventListener('characteristicvaluechanged', onRpmNotification);

        try {
            commandChar = await service.getCharacteristic(COMMAND_UUID);
        } catch (_) {
            commandChar = null;
        }

        setStatus('BLE CONNESSO', true);
        connectBtn.textContent = 'BLUETOOTH CONNESSO';
        setConnectedUi(true);
    } catch (err) {
        console.error(err);
        setStatus('DISCONNESSO');
        connectBtn.disabled = false;
        connectBtn.textContent = '📡 BLUETOOTH';
        if (err.name !== 'NotFoundError') alert('Connessione BLE non riuscita: ' + err.message);
    }
}

function onDisconnected() {
    rpmChar = null;
    commandChar = null;
    setStatus('DISCONNESSO');
    connectBtn.disabled = false;
    connectBtn.textContent = '📡 BLUETOOTH';
    setConnectedUi(false);
}

async function connectSerial() {
    if (!('serial' in navigator)) {
        alert('Web Serial non disponibile. Su PC usa Chrome o Edge aggiornato.');
        return;
    }

    if (serialPort) return;

    try {
        serialBtn.disabled = true;
        serialBtn.textContent = 'RICERCA USB...';
        setStatus('SELEZIONA PORTA USB...');

        serialPort = await navigator.serial.requestPort();
        await serialPort.open({ baudRate: 115200 });

        serialKeepReading = true;
        setStatus('USB CONNESSO', true);
        serialBtn.textContent = 'USB CONNESSO';
        setConnectedUi(true);
        readSerialLoop();
    } catch (err) {
        console.error(err);
        serialPort = null;
        serialBtn.disabled = false;
        serialBtn.textContent = '🔌 USB PC';
        setStatus('DISCONNESSO');
        if (err.name !== 'AbortError') alert('Connessione USB non riuscita: ' + err.message);
    }
}

async function readSerialLoop() {
    let buffer = '';

    while (serialPort && serialPort.readable && serialKeepReading) {
        serialReader = serialPort.readable.getReader();
        try {
            while (true) {
                const { value, done } = await serialReader.read();
                if (done) break;
                if (value) {
                    buffer += new TextDecoder().decode(value);
                    const lines = buffer.split(/\r?\n/);
                    buffer = lines.pop() || '';
                    for (const line of lines) {
                        if (line.trim()) parseData(line.trim());
                    }
                }
            }
        } catch (err) {
            console.error(err);
        } finally {
            serialReader.releaseLock();
            serialReader = null;
        }
    }
}

async function resetMax() {
    try {
        if (commandChar) {
            await commandChar.writeValue(new TextEncoder().encode('RESET'));
        } else if (serialPort && serialPort.writable) {
            const writer = serialPort.writable.getWriter();
            await writer.write(new TextEncoder().encode('RESET\n'));
            writer.releaseLock();
        }
        maxRpm = 0;
        maxEl.textContent = '0';
    } catch (err) {
        console.error(err);
        alert('Impossibile inviare il RESET.');
    }
}

saveBtn.addEventListener('click', () => {
    if (maxRpm <= 0 && currentRpm <= 0) {
        alert('Nessun RPM da salvare.');
        return;
    }

    const note = document.getElementById('noteInput').value.trim() || 'Lancio';
    const now = new Date();
    const record = {
        rpm: maxRpm || currentRpm,
        note,
        date: now.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }) + ' - ' +
              now.toLocaleDateString('it-IT')
    };

    const history = JSON.parse(localStorage.getItem('beyDB') || '[]');
    history.unshift(record);
    localStorage.setItem('beyDB', JSON.stringify(history));
    document.getElementById('noteInput').value = '';
    renderHistory();
});

function renderHistory() {
    const history = JSON.parse(localStorage.getItem('beyDB') || '[]');
    historyList.innerHTML = history.map(r => `
        <div class="history-item">
            <div class="h-rpm">${Number(r.rpm || 0).toLocaleString('it-IT')}</div>
            <div class="h-info">
                <span class="h-note">${escapeHtml(r.note || 'Lancio')}</span>
                <span class="h-date">${escapeHtml(r.date || '')}</span>
            </div>
        </div>
    `).join('');
    recordCount.textContent = history.length;
    emptyHistory.style.display = history.length ? 'none' : 'block';
}

function escapeHtml(value) {
    return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

document.getElementById('clearBtn').addEventListener('click', () => {
    if (confirm('Cancellare tutto lo storico?')) {
        localStorage.removeItem('beyDB');
        renderHistory();
    }
});

document.getElementById('exportBtn').addEventListener('click', () => {
    const history = JSON.parse(localStorage.getItem('beyDB') || '[]');
    if (!history.length) return alert('Nessun record da esportare.');
    const header = 'RPM;Nota;Data';
    const rows = history.map(r => `${r.rpm};"${String(r.note || '').replaceAll('"', '""')}";${r.date}`);
    const blob = new Blob([header + '\n' + rows.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'RPMcounterX-storico.csv';
    a.click();
    URL.revokeObjectURL(url);
});

connectBtn.addEventListener('click', connectLauncher);
serialBtn.addEventListener('click', connectSerial);
resetBtn.addEventListener('click', resetMax);

if (!navigator.bluetooth && !('serial' in navigator)) setStatus('BROWSER NON COMPATIBILE');
else if (!navigator.bluetooth) setStatus('USB DISPONIBILE');

renderHistory();
