let bleChar;
let maxRpm = 0;

const rpmEl = document.getElementById('rpmValue');
const saveBtn = document.getElementById('saveBtn');
const historyList = document.getElementById('historyList');
const statusPill = document.getElementById('status');

// Connessione Bluetooth
document.getElementById('connectBtn').addEventListener('click', async () => {
    try {
        const device = await navigator.bluetooth.requestDevice({
            filters: [{ namePrefix: 'BeyPowerX' }],
            optionalServices: [0x180D]
        });

        const server = await device.gatt.connect();
        const service = await server.getPrimaryService(0x180D);
        bleChar = await service.getCharacteristic(0x2A37);

        await bleChar.startNotifications();
        bleChar.addEventListener('characteristicvaluechanged', (e) => {
            const val = new TextDecoder().decode(e.target.value);
            const match = val.match(/\d+/);
            if (match) {
                maxRpm = match[0];
                rpmEl.innerText = maxRpm;
                // Effetto "flash" quando cambia il valore
                rpmEl.style.textShadow = "0 0 30px #00ff88";
                setTimeout(() => rpmEl.style.textShadow = "0 0 20px rgba(0,255,136,0.5)", 100);
            }
        });

        statusPill.innerText = "CONNESSO: " + device.name.split('_')[1];
        statusPill.classList.add('connected');
        document.getElementById('connectBtn').style.display = 'none';
        saveBtn.disabled = false;

    } catch (err) {
        console.error(err);
    }
});

// Salvataggio con LocalStorage
saveBtn.addEventListener('click', () => {
    const note = document.getElementById('noteInput').value || "Lancio";
    const record = {
        rpm: maxRpm,
        note: note,
        date: new Date().toLocaleTimeString('it-IT', {hour:'2-digit', minute:'2-digit'}) + " - " + new Date().toLocaleDateString('it-IT')
    };

    let history = JSON.parse(localStorage.getItem('beyDB')) || [];
    history.unshift(record);
    localStorage.setItem('beyDB', JSON.stringify(history));
    
    document.getElementById('noteInput').value = "";
    renderHistory();
});

function renderHistory() {
    let history = JSON.parse(localStorage.getItem('beyDB')) || [];
    historyList.innerHTML = history.map(r => `
        <div class="history-item">
            <div class="h-rpm">${r.rpm}</div>
            <div class="h-info">
                <span class="h-note">${r.note}</span>
                <span class="h-date">${r.date}</span>
            </div>
        </div>
    `).join('');
}

document.getElementById('clearBtn').addEventListener('click', () => {
    if(confirm("Cancellare tutto lo storico?")) {
        localStorage.removeItem('beyDB');
        renderHistory();
    }
});

renderHistory();
