/*
 * RPMcounterX - ESP32-C3 SuperMini + QRE1113 + BLE/USB
 *
 * QRE1113 OUT -> GPIO3
 * Half white / half black disk: one FALLING edge = one revolution.
 *
 * Measurement optimized for high-speed Beyblade X launches.
 * Reference: ~24,000 RPM strong launches.
 * 24,000 RPM = 2,500 us/revolution.
 *
 * The algorithm uses:
 * - minimum period validation
 * - median filter to reject isolated bad readings
 * - short rolling average for stable RPM
 * - fast response during acceleration
 * - timeout to zero when the Bey stops
 */

#include <Arduino.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

#define SENSOR_PIN 3

#define SERVICE_UUID  "12345678-1234-1234-1234-1234567890ab"
#define RPM_UUID      "12345678-1234-1234-1234-1234567890ac"
#define COMMAND_UUID  "12345678-1234-1234-1234-1234567890ad"

// Measurement limits.
// 40,000 RPM -> 1,500 us/revolution.
// We deliberately allow up to 100,000 RPM to avoid clipping real data.
const uint32_t MIN_PERIOD_US = 600;
const uint32_t MAX_PERIOD_US = 3000000;

// No valid edge for 180 ms = Bey stopped.
const uint32_t STOP_TIMEOUT_US = 180000;

// Number of recent periods used by the robust filter.
const uint8_t FILTER_SAMPLES = 5;

// Send data to BLE/USB every 50 ms.
const uint32_t UPDATE_MS = 50;

BLECharacteristic* rpmCharacteristic = nullptr;
BLECharacteristic* commandCharacteristic = nullptr;

volatile uint32_t periodsUs[FILTER_SAMPLES] = {0};
volatile uint8_t periodIndex = 0;
volatile uint8_t periodCount = 0;
volatile uint32_t lastEdgeUs = 0;

uint32_t currentRpm = 0;
uint32_t maxRpm = 0;
uint32_t lastUpdateMs = 0;

class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer* server) override {
    Serial.println("BLE client connesso");
  }

  void onDisconnect(BLEServer* server) override {
    Serial.println("BLE client disconnesso");
    delay(50);
    server->getAdvertising()->start();
  }
};

class CommandCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* characteristic) override {
    String command = characteristic->getValue();
    command.trim();
    command.toUpperCase();

    if (command == "RESET") {
      maxRpm = 0;
      Serial.println("MAX RPM resettato");
    }
  }
};

void ARDUINO_ISR_ATTR onSensorEdge() {
  const uint32_t now = micros();

  if (lastEdgeUs == 0) {
    lastEdgeUs = now;
    return;
  }

  const uint32_t period = now - lastEdgeUs;

  // Ignore impossible/noise pulses without moving the reference edge.
  if (period < MIN_PERIOD_US || period > MAX_PERIOD_US) {
    return;
  }

  lastEdgeUs = now;
  periodsUs[periodIndex] = period;
  periodIndex = (periodIndex + 1) % FILTER_SAMPLES;

  if (periodCount < FILTER_SAMPLES) {
    periodCount++;
  }
}

uint32_t median5(uint32_t values[], uint8_t count) {
  // Small insertion sort; max 5 elements.
  for (uint8_t i = 1; i < count; i++) {
    uint32_t key = values[i];
    int8_t j = i - 1;
    while (j >= 0 && values[j] > key) {
      values[j + 1] = values[j];
      j--;
    }
    values[j + 1] = key;
  }
  return values[count / 2];
}

uint32_t calculateRpm() {
  noInterrupts();
  uint8_t count = periodCount;
  uint32_t samples[FILTER_SAMPLES];
  for (uint8_t i = 0; i < FILTER_SAMPLES; i++) {
    samples[i] = periodsUs[i];
  }
  uint32_t lastEdge = lastEdgeUs;
  interrupts();

  if (count == 0 || lastEdge == 0) {
    return 0;
  }

  if ((uint32_t)(micros() - lastEdge) > STOP_TIMEOUT_US) {
    return 0;
  }

  // First reject old/empty entries.
  uint32_t valid[FILTER_SAMPLES];
  uint8_t validCount = 0;
  for (uint8_t i = 0; i < count; i++) {
    if (samples[i] >= MIN_PERIOD_US && samples[i] <= MAX_PERIOD_US) {
      valid[validCount++] = samples[i];
    }
  }

  if (validCount == 0) {
    return 0;
  }

  // Median rejects a single bad optical reading very effectively.
  uint32_t medianPeriod = median5(valid, validCount);

  // Use only samples close to the median for the final average.
  // This prevents one erroneous period from shifting the RPM.
  uint64_t sum = 0;
  uint8_t accepted = 0;

  for (uint8_t i = 0; i < validCount; i++) {
    uint32_t p = valid[i];
    uint32_t difference = (p > medianPeriod) ? (p - medianPeriod) : (medianPeriod - p);

    // Accept readings within +/- 25% of the median.
    if ((uint64_t)difference * 4ULL <= (uint64_t)medianPeriod) {
      sum += p;
      accepted++;
    }
  }

  if (accepted == 0) {
    return 60000000UL / medianPeriod;
  }

  uint32_t averagePeriod = (uint32_t)(sum / accepted);
  if (averagePeriod == 0) {
    return 0;
  }

  return 60000000UL / averagePeriod;
}

void resetMeasurement() {
  noInterrupts();
  periodIndex = 0;
  periodCount = 0;
  lastEdgeUs = 0;
  for (uint8_t i = 0; i < FILTER_SAMPLES; i++) {
    periodsUs[i] = 0;
  }
  interrupts();
  currentRpm = 0;
}

void setupBle() {
  BLEDevice::init("Beyblade RPM");

  BLEServer* server = BLEDevice::createServer();
  server->setCallbacks(new ServerCallbacks());

  BLEService* service = server->createService(SERVICE_UUID);

  rpmCharacteristic = service->createCharacteristic(
    RPM_UUID,
    BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY
  );
  rpmCharacteristic->addDescriptor(new BLE2902());
  rpmCharacteristic->setValue("RPM:0,MAX:0");

  commandCharacteristic = service->createCharacteristic(
    COMMAND_UUID,
    BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR
  );
  commandCharacteristic->setCallbacks(new CommandCallbacks());

  service->start();

  BLEAdvertising* advertising = BLEDevice::getAdvertising();
  advertising->addServiceUUID(SERVICE_UUID);
  advertising->setScanResponse(true);
  advertising->setMinPreferred(0x06);
  advertising->setMinPreferred(0x12);
  BLEDevice::startAdvertising();
}

void setup() {
  Serial.begin(115200);
  delay(1000);

  pinMode(SENSOR_PIN, INPUT);
  attachInterrupt(digitalPinToInterrupt(SENSOR_PIN), onSensorEdge, FALLING);

  setupBle();

  Serial.println("=== RPMcounterX HIGH SPEED ===");
  Serial.println("QRE1113 -> GPIO3");
  Serial.println("1 FALLING = 1 giro");
  Serial.println("Target: 0-40000+ RPM");
  Serial.println("Pronto!");
}

void loop() {
  currentRpm = calculateRpm();

  if (currentRpm > maxRpm) {
    maxRpm = currentRpm;
  }

  const uint32_t nowMs = millis();
  if (nowMs - lastUpdateMs >= UPDATE_MS) {
    lastUpdateMs = nowMs;

    char payload[48];
    snprintf(payload, sizeof(payload), "RPM:%lu,MAX:%lu",
             (unsigned long)currentRpm,
             (unsigned long)maxRpm);

    rpmCharacteristic->setValue(payload);
    rpmCharacteristic->notify();
    Serial.println(payload);
  }

  delay(1);
}
