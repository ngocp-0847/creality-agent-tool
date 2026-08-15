import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { mapFileEntry, mapJob, mapMetadata, mapStatus } from '../src/moonraker/mappers.js';
import type { RawObjectQuery } from '../src/moonraker/types.js';

function query(printStats: Record<string, unknown>, extra: Record<string, unknown> = {}): RawObjectQuery {
  return { status: { print_stats: printStats, ...extra } };
}

describe('mapJob', () => {
  it('maps an idle printer', () => {
    const job = mapJob(query({ state: 'standby' }));
    assert.equal(job.active, false);
    assert.equal(job.state, 'ready');
    assert.equal(job.progress, 0);
  });

  it('maps a running job', () => {
    const job = mapJob(
      query(
        { state: 'printing', filename: 'benchy.gcode', print_duration: 600, total_duration: 650 },
        { virtual_sdcard: { progress: 0.25 } },
      ),
    );
    assert.equal(job.active, true);
    assert.equal(job.state, 'printing');
    assert.equal(job.filename, 'benchy.gcode');
    assert.equal(job.progress, 0.25);
    assert.equal(job.printDurationSec, 600);
    assert.equal(job.totalDurationSec, 650);
  });

  it('treats a paused job as active', () => {
    assert.equal(mapJob(query({ state: 'paused' })).active, true);
  });

  it('estimates remaining time from elapsed time and progress', () => {
    const job = mapJob(
      query({ state: 'printing', print_duration: 300 }, { virtual_sdcard: { progress: 0.5 } }),
    );
    assert.equal(job.estimatedRemainingSec, 300);
  });

  it('does not estimate when progress is zero or complete', () => {
    assert.equal(
      mapJob(query({ state: 'printing', print_duration: 10 }, { virtual_sdcard: { progress: 0 } }))
        .estimatedRemainingSec,
      undefined,
    );
    assert.equal(
      mapJob(query({ state: 'printing', print_duration: 10 }, { virtual_sdcard: { progress: 1 } }))
        .estimatedRemainingSec,
      undefined,
    );
  });

  it('falls back to display_status progress', () => {
    assert.equal(mapJob(query({ state: 'printing' }, { display_status: { progress: 0.4 } })).progress, 0.4);
  });

  it('clamps progress into 0..1', () => {
    assert.equal(mapJob(query({ state: 'printing' }, { virtual_sdcard: { progress: 5 } })).progress, 1);
    assert.equal(mapJob(query({ state: 'printing' }, { virtual_sdcard: { progress: -2 } })).progress, 0);
  });

  it('normalises both spellings of cancelled and completed', () => {
    assert.equal(mapJob(query({ state: 'canceled' })).state, 'cancelled');
    assert.equal(mapJob(query({ state: 'cancelled' })).state, 'cancelled');
    assert.equal(mapJob(query({ state: 'completed' })).state, 'complete');
    assert.equal(mapJob(query({ state: 'complete' })).state, 'complete');
  });

  it('reports an unrecognised state as unknown rather than guessing', () => {
    assert.equal(mapJob(query({ state: 'wibble' })).state, 'unknown');
    assert.equal(mapJob({}).state, 'unknown');
  });

  it('omits an empty filename', () => {
    assert.equal('filename' in mapJob(query({ state: 'printing', filename: '' })), false);
  });
});

describe('mapStatus', () => {
  const base = {
    model: 'k1' as const,
    printerInfo: { state: 'ready', state_message: 'Printer is ready', software_version: 'v0.12.0' },
    serverInfo: { klippy_connected: true, klippy_state: 'ready', moonraker_version: 'v0.9.1' },
    sampledAt: new Date('2024-05-01T12:00:00.000Z'),
  };

  it('maps an idle printer', () => {
    const status = mapStatus({ ...base, query: query({ state: 'standby' }) });
    assert.equal(status.model, 'k1');
    assert.equal(status.state, 'ready');
    assert.equal(status.stateText, 'Printer is ready');
    assert.equal(status.klipperVersion, 'v0.12.0');
    assert.equal(status.moonrakerVersion, 'v0.9.1');
    assert.equal(status.sampledAt, '2024-05-01T12:00:00.000Z');
  });

  it('lets the job state drive the printer state while Klipper is ready', () => {
    assert.equal(mapStatus({ ...base, query: query({ state: 'printing' }) }).state, 'printing');
    assert.equal(mapStatus({ ...base, query: query({ state: 'paused' }) }).state, 'paused');
  });

  it('reports offline when Klippy is disconnected, whatever the job says', () => {
    const status = mapStatus({
      ...base,
      serverInfo: { klippy_connected: false, klippy_state: 'disconnected' },
      query: query({ state: 'printing' }),
    });
    assert.equal(status.state, 'offline');
  });

  it('lets a Klipper fault override the job state', () => {
    for (const [klippyState, expected] of [
      ['shutdown', 'shutdown'],
      ['error', 'error'],
      ['startup', 'startup'],
    ] as const) {
      const status = mapStatus({
        ...base,
        serverInfo: { klippy_connected: true, klippy_state: klippyState },
        query: query({ state: 'printing' }),
      });
      assert.equal(status.state, expected, `klippy ${klippyState}`);
    }
  });

  it('maps heaters, position and fan', () => {
    const status = mapStatus({
      ...base,
      query: query(
        { state: 'printing' },
        {
          extruder: { temperature: 209.87, target: 210, power: 0.812_3 },
          heater_bed: { temperature: 59.94, target: 60 },
          toolhead: { position: [10.123, 20.456, 0.2, 5], homed_axes: 'xyz' },
          fan: { speed: 0.6667 },
        },
      ),
    });
    assert.deepEqual(status.extruder, { current: 209.9, target: 210, power: 0.812 });
    assert.deepEqual(status.bed, { current: 59.9, target: 60 });
    assert.deepEqual(status.position, { x: 10.12, y: 20.46, z: 0.2 });
    assert.equal(status.homedAxes, 'xyz');
    assert.equal(status.fanSpeed, 0.667);
  });

  it('reads the chamber from either sensor name', () => {
    const generic = mapStatus({
      ...base,
      query: query({ state: 'standby' }, { 'heater_generic chamber': { temperature: 40, target: 45 } }),
    });
    assert.deepEqual(generic.chamber, { current: 40, target: 45 });

    const sensor = mapStatus({
      ...base,
      query: query({ state: 'standby' }, { 'temperature_sensor chamber': { temperature: 35 } }),
    });
    assert.deepEqual(sensor.chamber, { current: 35, target: 0 });
  });

  it('omits absent readings rather than reporting zeroes', () => {
    const status = mapStatus({ ...base, query: query({ state: 'standby' }) });
    assert.equal('extruder' in status, false);
    assert.equal('bed' in status, false);
    assert.equal('chamber' in status, false);
    assert.equal('position' in status, false);
  });

  it('ignores a truncated position array', () => {
    const status = mapStatus({
      ...base,
      query: query({ state: 'standby' }, { toolhead: { position: [1, 2] } }),
    });
    assert.equal('position' in status, false);
  });
});

describe('mapFileEntry', () => {
  it('maps a listing entry', () => {
    const file = mapFileEntry({ path: 'benchy.gcode', size: 2048.7, modified: 1_700_000_000 });
    assert.equal(file?.filename, 'benchy.gcode');
    assert.equal(file?.sizeBytes, 2049);
    assert.equal(file?.modified, new Date(1_700_000_000_000).toISOString());
  });

  it('drops entries with no usable path', () => {
    assert.equal(mapFileEntry({ size: 1 }), undefined);
    assert.equal(mapFileEntry({ path: '' }), undefined);
  });

  it('defaults a missing size to zero', () => {
    assert.equal(mapFileEntry({ path: 'a.gcode' })?.sizeBytes, 0);
  });

  it('falls back to the epoch for a missing mtime', () => {
    assert.equal(mapFileEntry({ path: 'a.gcode' })?.modified, new Date(0).toISOString());
  });
});

describe('mapMetadata', () => {
  it('maps slicer metadata', () => {
    const file = mapMetadata('benchy.gcode', {
      size: 2048,
      modified: 1_700_000_000,
      estimated_time: 3600.4,
      filament_total: 2500.55,
      first_layer_bed_temp: 60,
      first_layer_extr_temp: 210,
      object_height: 48.234,
      slicer: 'PrusaSlicer',
    });
    assert.equal(file.filename, 'benchy.gcode');
    assert.equal(file.estimatedTimeSec, 3600);
    assert.equal(file.filamentTotalMm, 2500.6);
    assert.equal(file.firstLayerBedTemp, 60);
    assert.equal(file.firstLayerExtruderTemp, 210);
    assert.equal(file.objectHeightMm, 48.23);
    assert.equal(file.slicer, 'PrusaSlicer');
  });

  it('prefers the name Moonraker reports', () => {
    assert.equal(mapMetadata('requested.gcode', { filename: 'actual.gcode' }).filename, 'actual.gcode');
  });

  it('falls back to the requested name', () => {
    assert.equal(mapMetadata('requested.gcode', {}).filename, 'requested.gcode');
  });

  it('omits fields the slicer did not provide', () => {
    const file = mapMetadata('a.gcode', { size: 10 });
    assert.equal('estimatedTimeSec' in file, false);
    assert.equal('slicer' in file, false);
  });
});
