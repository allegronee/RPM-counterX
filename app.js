let bleCharacteristic;
let lastRpm = 0;

const connectBtn = document.getElementById('connectBtn');
const saveBtn = document.getElementById('saveBtn');
const rpmValue = document.getElementById('rpmValue');
const statusDiv = document.getElementById('status');
const historyTable = document.querySelector('#historyTable tbody');

// Connessione Bluetooth
connectBtn.addEventListener('click', async () => {
    try {
        const device = await navigator.bluetooth.requestDevice({
            filters: [{ namePrefix: 'BeyPowerX' }],
            optionalServices: [0x180D]
        });

        statusDiv.innerText = "Connessione in corso...";
        const server = await device.gatt.connect();
        const service = await server.getPrimaryService(0x180D);
        bleCharacteristic = await service.getCharacteristic(0x2A37);

        await bleCharacteristic.startNotifications();
        bleCharacteristic.addEventListener('characteristicvaluechanged', (event) => {
            const val = new TextDecoder().decode(event.target.value);
            const match = val.match(/\d+/);
            if (match) {
                lastRpm = match[0];
                rpmValue.innerText = lastRpm;
            }
        });

        statusDiv.innerText = "CONNESSO: " + device.name;
        statusDiv.classList.add('connected');
        connectBtn.style.display = 'none';
        saveBtn.disabled = false;

    } catch (err) {
        console.error(err);
        statusDiv.innerText = "Errore: " + err.message;
    }
});

// Salvataggio Dati
saveBtn.addEventListener('click', () => {
    const note = document.getElementById('noteInput').value || "-";
    const record = {
        rpm: lastRpm,
        note: note,
        date: new Date().toLocaleString('it-IT', {day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit'})
    };

    let history = JSON.parse(localStorage.getItem('beyRecords')) || [];
    history.unshift(record);
    localStorage.setItem('beyRecords', JSON.stringify(history));
    
    document.getElementById('noteInput').value = "";
    renderHistory();
});

function renderHistory() {
    let history = JSON.parse(localStorage.getItem('beyRecords')) || [];
    historyTable.innerHTML = history.map(r => `
        <tr>
            <td><strong>${r.rpm}</strong></td>
            <td>${r.note}</td>
            <td>${r.date}</td>
        </tr>
    `).join('');
}

// Utility
document.getElementById('clearBtn').addEventListener('click', () => {
    if(confirm("Vuoi cancellare la cronologia?")) {
        localStorage.removeItem('beyRecords');
        renderHistory();
    }
});

document.getElementById('exportBtn').addEventListener('click', () => {
    const data = localStorage.getItem('beyRecords');
    const blob = new Blob([data], {type: 'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'beypower_records.json';
    a.click();
});

renderHistory();
