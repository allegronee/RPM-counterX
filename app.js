// RPMcounterX - ESP32-C3 BLE
// Service: 12345678-1234-1234-1234-1234567890ab
// RPM:     12345678-1234-1234-1234-1234567890ac
// Command: 12345678-1234-1234-1234-1234567890ad

const SERVICE_UUID = '12345678-1234-1234-1234-1234567890ab';
const RPM_UUID = '12345678-1234-1234-1234-1234567890ac';
const COMMAND_UUID = '12345678-1234-1234-1234-1234567890ad';
const DEVICE_NAME = 'Beyblade RPM';

let device = null;
let rpmChar = null;
let commandChar = null;
let currentRpm = 0;
let maxRpm = 0;

const rpmEl = document.getElementById('rpmValue');
const maxEl = document.getElementById('maxValue');
const saveBtn = document.getElementById('saveBtn');
const resetBtn = document.getElementById('resetBtn');
const historyList = document.getElementById('historyList');
const emptyHistory = document.getElementById('emptyHistory');
const recordCount = document.getElementById('recordCount');
const statusPill = document.getElementById('status');
const connectBtn = document.getElementById('connectBtn');

function setStatus(text, connected = false) {
    statusPill.textContent = text;
    statusPill.classList.toggle('connected', connected);
}

function updateDisplay(rpm, maxFromEsp = null) {
    currentRpm = Math.max(0, Math.round(Number(rpm) || 0));
    rpmEl.textContent = currentRpm.toLocaleString('it-IT');

    if (maxFromEsp !== null) {
        maxRpm = Math.max(0, Math.round(Number(maxFromEsp) || 0));
    } else if (currentRpm > maxRpm) {
        maxRpm = currentRpm;
    }

    maxEl.textContent = maxRpm.toLocaleString('it-IT');
    rpmEl.classList.remove('pulse');
    void rpmEl.offsetWidth;
    rpmEl.classList.add('pulse');
}

function parseBleMessage(text) {
    // Accetta sia "RPM:12345,MAX:12345" sia un semplice numero.
    const rpmMatch = text.match(/RPM\s*:\s*(\d+)/i);
    const maxMatch = text.match(/MAX\s*:\s*(\d+)/i);

    if (rpmMatch) {
        updateDisplay(Number(rpmMatch[1]), maxMatch ? Number(maxMatch[1]) : null);
        return;
    }

    const numberMatch = text.match(/\d+/);
    if (numberMatch) updateDisplay(Number(numberMatch[0]));
}

function onRpmNotification(event) {
    const value = event.target.value;
    const text = new TextDecoder().decode(value).trim();
    if (text) parseBleMessage(text);
}

async function connectLauncher() {
    if (!navigator.bluetooth) {
        alert('Bluetooth BLE non supportato da questo browser. Prova Chrome su Android o un browser compatibile Web Bluetooth.');
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

        setStatus('CONNESSO', true);
        connectBtn.textContent = 'LAUNCHER CONNESSO';
        saveBtn.disabled = false;
        resetBtn.disabled = commandChar === null;
    } catch (err) {
        console.error(err);
        setStatus('DISCONNESSO');
        connectBtn.disabled = false;
        connectBtn.textContent = 'CONNETTI LAUNCHER';

        if (err.name !== 'NotFoundError') {
            alert('Connessione BLE non riuscita: ' + err.message);
        }
    }
}

function onDisconnected() {
    rpmChar = null;
    commandChar = null;
    setStatus('DISCONNESSO');
    connectBtn.disabled = false;
    connectBtn.textContent = 'RICONNETTI LAUNCHER';
    saveBtn.disabled = true;
    resetBtn.disabled = true;
}

async function resetMax() {
    if (!commandChar) {
        maxRpm = 0;
        maxEl.textContent = '0';
        return;
    }

    try {
        const data = new TextEncoder().encode('RESET');
        await commandChar.writeValue(data);
        maxRpm = 0;
        maxEl.textContent = '0';
    } catch (err) {
        console.error(err);
        alert('Impossibile inviare il RESET al launcher.');
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
        date: now.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }) +
              ' - ' + now.toLocaleDateString('it-IT')
    };

    const history = JSON.parse(localStorage.getItem('beyDB') || '[]');
    history.unshift(record);
    localStorage.setItem('beyDB', JSON.stringify(history));
    document.getElementById('noteInput').value = '';
    renderHistory();
});

function renderHistory() {
    const history = JSON.parse(localStorage.getItem('beyDB') || '[]');
    historyList.innerHTML = history.map((r) => `
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
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

document.getElementById('clearBtn').addEventListener('click', () => {
    if (confirm('Cancellare tutto lo storico?')) {
        localStorage.removeItem('beyDB');
        renderHistory();
    }
});

document.getElementById('exportBtn').addEventListener('click', () => {
    const history = JSON.parse(localStorage.getItem('beyDB') || '[]');
    if (!history.length) {
        alert('Nessun record da esportare.');
        return;
    }

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
resetBtn.addEventListener('click', resetMax);

if (!navigator.bluetooth) {
    setStatus('BLE NON SUPPORTATO');
}

renderHistory();
