/*
 * RPMcounterX - ESP32-C3 SuperMini + QRE1113 + BLE
 *
 * Hardware:
 *   QRE1113 VCC -> 3V3
 *   QRE1113 GND -> GND
 *   QRE1113 OUT -> GPIO3
 *
 * The optical disk is half white / half black.
 * One FALLING edge = one complete revolution.
 *
 * BLE protocol used by the GitHub Pages app:
 *   Device:  Beyblade RPM
 *   Service: 12345678-1234-1234-1234-1234567890ab
 *   RPM:     12345678-1234-1234-1234-1234567890ac (Notify)
 *   Command: 12345678-1234-1234-1234-1234567890ad (Write)
 *
 * Notification format:
 *   RPM:12345,MAX:12345
 *
 * Command accepted:
 *   RESET
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

// Reject impossible edges/noise shorter than this interval.
// 250 us corresponds to a theoretical maximum of 240,000 RPM.
// Increase to 500-1000 us if the real launcher produces noise.
const uint32_t MIN_PULSE_US = 250;

// If no valid edge arrives for this long, report 0 RPM.
const uint32_t STOP_TIMEOUT_US = 250000;

// Number of complete revolutions used for a rolling RPM average.
const uint8_t AVERAGE_SAMPLES = 4;

// BLE notification period.
const uint32_t BLE_UPDATE_MS = 100;

BLECharacteristic* rpmCharacteristic = nullptr;
BLECharacteristic* commandCharacteristic = nullptr;

volatile uint32_t lastEdgeUs = 0;
volatile uint32_t periodsUs[AVERAGE_SAMPLES] = {0};
volatile uint8_t periodIndex = 0;
volatile uint8_t periodCount = 0;
volatile bool newMeasurement = false;

uint32_t currentRpm = 0;
uint32_t maxRpm = 0;
uint32_t lastBleUpdate = 0;

class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer* server) override {
    Serial.println("BLE client connesso");
  }

  void onDisconnect(BLEServer* server) override {
    Serial.println("BLE client disconnesso");
    delay(50);
    server->getAdvertising()->start();
    Serial.println("Advertising BLE riavviato");
  }
};

class CommandCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* characteristic) override {
    String command = characteristic->getValue();
    command.trim();
    command.toUpperCase();

    Serial.print("Comando BLE: ");
    Serial.println(command);

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

  if (period < MIN_PULSE_US) {
    return;
  }

  lastEdgeUs = now;

  periodsUs[periodIndex] = period;
  periodIndex = (periodIndex + 1) % AVERAGE_SAMPLES;

  if (periodCount < AVERAGE_SAMPLES) {
    periodCount++;
  }

  newMeasurement = true;
}

uint32_t calculateRpm() {
  noInterrupts();
  uint8_t count = periodCount;
  uint32_t periods[AVERAGE_SAMPLES];

  for (uint8_t i = 0; i < AVERAGE_SAMPLES; i++) {
    periods[i] = periodsUs[i];
  }

  uint32_t lastEdge = lastEdgeUs;
  interrupts();

  if (count == 0 || lastEdge == 0) {
    return 0;
  }

  if ((micros() - lastEdge) > STOP_TIMEOUT_US) {
    return 0;
  }

  uint64_t sum = 0;
  uint8_t valid = 0;

  for (uint8_t i = 0; i < count; i++) {
    if (periods[i] > 0) {
      sum += periods[i];
      valid++;
    }
  }

  if (valid == 0) {
    return 0;
  }

  const uint32_t averagePeriod = sum / valid;
  if (averagePeriod == 0) {
    return 0;
  }

  // One FALLING edge = one revolution.
  return (uint32_t)(60000000ULL / averagePeriod);
}

void resetMeasurementWindow() {
  noInterrupts();
  periodCount = 0;
  periodIndex = 0;
  lastEdgeUs = 0;
  for (uint8_t i = 0; i < AVERAGE_SAMPLES; i++) {
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

  Serial.println("BLE pronto: Beyblade RPM");
}

void setup() {
  Serial.begin(115200);
  delay(1000);

  pinMode(SENSOR_PIN, INPUT);
  attachInterrupt(digitalPinToInterrupt(SENSOR_PIN), onSensorEdge, FALLING);

  setupBle();

  Serial.println();
  Serial.println("=== RPMcounterX ===");
  Serial.println("Sensore: QRE1113");
  Serial.println("GPIO: 3");
  Serial.println("Un FALLING = un giro");
  Serial.println("Pronto!");
}

void loop() {
  currentRpm = calculateRpm();

  if (currentRpm > maxRpm) {
    maxRpm = currentRpm;
  }

  const uint32_t nowMs = millis();

  if (nowMs - lastBleUpdate >= BLE_UPDATE_MS) {
    lastBleUpdate = nowMs;

    char payload[48];
    snprintf(payload, sizeof(payload), "RPM:%lu,MAX:%lu",
             (unsigned long)currentRpm,
             (unsigned long)maxRpm);

    rpmCharacteristic->setValue(payload);
    rpmCharacteristic->notify();

    Serial.println(payload);
  }

  delay(2);
}
