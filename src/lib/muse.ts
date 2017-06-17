import { Observable } from 'rxjs/Observable';
import { BehaviorSubject } from 'rxjs/BehaviorSubject';
import 'rxjs/add/observable/merge';
import 'rxjs/add/operator/first';
import 'rxjs/add/operator/share';

import { EEGReading, TelemetryData, AccelerometerData, GyroscopeData, XYZ, MuseControlResponse } from './muse-interfaces';
import { parseControl, decodeEEGSamples, parseTelemetry, parseAccelerometer, parseGyroscope } from './muse-parse';
import { encodeCommand, decodeResponse, observableCharacteristic } from './muse-utils';

export { EEGReading, TelemetryData, AccelerometerData, GyroscopeData, XYZ, MuseControlResponse };

const MUSE_SERVICE = 0xfe8d;
const CONTROL_CHARACTERISTIC = '273e0001-4c4d-454d-96be-f03bac821358';
const TELEMETRY_CHARACTERISTIC = '273e000b-4c4d-454d-96be-f03bac821358';
const GYROSCOPE_CHARACTERISTIC = '273e0009-4c4d-454d-96be-f03bac821358';
const ACCELEROMETER_CHARACTERISTIC = '273e000a-4c4d-454d-96be-f03bac821358';
const EEG_CHARACTERISTICS = [
    '273e0003-4c4d-454d-96be-f03bac821358',
    '273e0004-4c4d-454d-96be-f03bac821358',
    '273e0005-4c4d-454d-96be-f03bac821358',
    '273e0006-4c4d-454d-96be-f03bac821358',
    '273e0007-4c4d-454d-96be-f03bac821358'
];

export class MuseClient {
    private gatt: BluetoothRemoteGATTServer | null = null;
    private controlChar: BluetoothRemoteGATTCharacteristic;
    private eegCharacteristics: BluetoothRemoteGATTCharacteristic[];

    public connectionStatus = new BehaviorSubject<boolean>(false);
    public rawControlData: Observable<string>;
    public controlResponses: Observable<MuseControlResponse>;
    public telemetryData: Observable<TelemetryData>;
    public gyroscopeData: Observable<GyroscopeData>;
    public accelerometerData: Observable<AccelerometerData>;
    public eegReadings: Observable<EEGReading>;

    async connect() {
        const device = await navigator.bluetooth.requestDevice({
            filters: [{ services: [MUSE_SERVICE] }]
        });
        this.gatt = await device.gatt!.connect();
        const service = await this.gatt.getPrimaryService(MUSE_SERVICE);
        Observable.fromEvent<void>(device, 'gattserverdisconnected').first().subscribe(() => {
            this.gatt = null;
            this.connectionStatus.next(false);
        });

        // Control
        this.controlChar = await service.getCharacteristic(CONTROL_CHARACTERISTIC);
        this.rawControlData = (await observableCharacteristic(this.controlChar))
            .map(data => decodeResponse(new Uint8Array(data.buffer)))
            .share();
        this.controlResponses = parseControl(this.rawControlData);

        // Battery
        const telemetryCharacteristic = await service.getCharacteristic(TELEMETRY_CHARACTERISTIC);
        this.telemetryData = (await observableCharacteristic(telemetryCharacteristic))
            .map(parseTelemetry);

        // Gyroscope
        const gyroscopeCharacteristic = await service.getCharacteristic(GYROSCOPE_CHARACTERISTIC);
        this.gyroscopeData = (await observableCharacteristic(gyroscopeCharacteristic))
            .map(parseGyroscope);

        // Accelerometer
        const accelerometerCharacteristic = await service.getCharacteristic(ACCELEROMETER_CHARACTERISTIC);
        this.accelerometerData = (await observableCharacteristic(accelerometerCharacteristic))
            .map(parseAccelerometer);

        // EEG
        this.eegCharacteristics = [];
        const eegObservables = [];
        for (let index = 0; index < EEG_CHARACTERISTICS.length; index++) {
            let characteristicId = EEG_CHARACTERISTICS[index];
            const eegChar = await service.getCharacteristic(characteristicId);
            eegObservables.push(
                (await observableCharacteristic(eegChar)).map(data => {
                    return {
                        electrode: index,
                        timestamp: data.getUint16(0),
                        samples: decodeEEGSamples(new Uint8Array(data.buffer).subarray(2))
                    };
                }));
            this.eegCharacteristics.push(eegChar);
        }
        this.eegReadings = Observable.merge(...eegObservables);
        await this.sendCommand('v1');
        this.connectionStatus.next(true);
    }

    async sendCommand(cmd: string) {
        await this.controlChar.writeValue((encodeCommand(cmd)));
    }

    async start() {
        // Subscribe to egg characteristics
        await this.pause();
        // Select preset number 20
        await this.controlChar.writeValue(encodeCommand('p20'));
        await this.controlChar.writeValue(encodeCommand('s'));
        await this.resume();
    }

    async pause() {
        await this.sendCommand('h');
    }

    async resume() {
        await this.sendCommand('d');
    }

    disconnect() {
        if (this.gatt) {
            this.gatt.disconnect();
            this.connectionStatus.next(false);
        }
    }
}
