import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CrealityError } from '../src/errors.js';
import {
  assertPreflightOk,
  formatBytes,
  preflightGcode,
  type PreflightCode,
  type PreflightReport,
} from '../src/gcode/preflight.js';
import { getProfile } from '../src/profiles.js';
import { GOOD_GCODE } from './helpers.js';

const K1 = getProfile('k1');
const K2 = getProfile('k2');

function run(
  source: string | Uint8Array,
  options: { profile?: typeof K1; maxBytes?: number; maxScanLines?: number } = {},
): PreflightReport {
  return preflightGcode(source, {
    filename: 'part.gcode',
    profile: options.profile ?? K1,
    maxBytes: options.maxBytes ?? 1024 * 1024,
    ...(options.maxScanLines === undefined ? {} : { maxScanLines: options.maxScanLines }),
  });
}

function codes(findings: readonly { code: PreflightCode }[]): PreflightCode[] {
  return findings.map((finding) => finding.code);
}

describe('preflight — a clean program', () => {
  const report = run(GOOD_GCODE);

  it('passes with no error findings', () => {
    assert.equal(report.ok, true, `unexpected errors: ${JSON.stringify(report.errors)}`);
    assert.deepEqual(report.errors, []);
  });

  it('raises no warnings for a well-formed program', () => {
    assert.deepEqual(codes(report.warnings), []);
  });

  it('reports what it observed', () => {
    assert.equal(report.homed, true);
    assert.equal(report.extrudes, true);
    assert.equal(report.maxExtruderTempC, 210);
    assert.equal(report.maxBedTempC, 60);
    assert.equal(report.filename, 'part.gcode');
    assert.equal(report.sizeBytes, Buffer.byteLength(GOOD_GCODE, 'utf8'));
    assert.match(report.sha256, /^[0-9a-f]{64}$/);
    assert.equal(report.truncated, false);
  });

  it('extracts the toolhead bounding box', () => {
    assert.deepEqual(report.bounds, {
      minX: 10,
      maxX: 100,
      minY: 10,
      maxY: 100,
      minZ: 0.2,
      maxZ: 0.2,
    });
  });

  it('sniffs slicer and estimated time from the header', () => {
    assert.equal(report.slicer, 'PrusaSlicer 2.6.0');
    assert.equal(report.estimatedTimeSec, 3600);
  });

  it('summarises in one human-readable line', () => {
    assert.match(report.summary, /part\.gcode/);
    assert.match(report.summary, /passed preflight/);
  });
});

describe('preflight — thermal limits', () => {
  it('rejects an extruder target above the model limit', () => {
    const report = run('G28\nM104 S350\nG1 X10 Y10 E1\n');
    assert.equal(report.ok, false);
    assert.ok(codes(report.errors).includes('EXTRUDER_TEMP_TOO_HIGH'));
    const finding = report.errors.find((f) => f.code === 'EXTRUDER_TEMP_TOO_HIGH');
    assert.equal(finding?.line, 2);
    assert.equal(finding?.detail?.['requested'], 350);
    assert.equal(finding?.detail?.['limit'], K1.maxExtruderTempC);
  });

  it('rejects a bed target above the model limit', () => {
    const report = run('G28\nM140 S150\nG1 X10 Y10 E1\n');
    assert.equal(report.ok, false);
    assert.ok(codes(report.errors).includes('BED_TEMP_TOO_HIGH'));
  });

  it('checks the blocking wait variants too (M109 / M190)', () => {
    assert.equal(run('G28\nM109 S400\nG1 X1 Y1 E1\n').ok, false);
    assert.equal(run('G28\nM190 S200\nG1 X1 Y1 E1\n').ok, false);
  });

  it('accepts a target exactly at the limit', () => {
    const report = run(`G28\nM104 S${K1.maxExtruderTempC}\nG1 X10 Y10 E1\n`);
    assert.equal(report.ok, true);
    assert.equal(report.maxExtruderTempC, K1.maxExtruderTempC);
  });

  it('honours the higher K2 envelope', () => {
    assert.equal(run('G28\nM104 S330\nG1 X1 Y1 E1\n').ok, false, 'K1 rejects 330C');
    assert.equal(
      run('G28\nM104 S330\nG1 X1 Y1 E1\n', { profile: K2 }).ok,
      true,
      'K2 allows 330C',
    );
  });

  it('reads Klipper SET_HEATER_TEMPERATURE targets', () => {
    const report = run('G28\nSET_HEATER_TEMPERATURE HEATER=extruder TARGET=400\nG1 X1 Y1 E1\n');
    assert.equal(report.ok, false);
    assert.ok(codes(report.errors).includes('EXTRUDER_TEMP_TOO_HIGH'));
  });

  it('routes SET_HEATER_TEMPERATURE to the bed by heater name', () => {
    const report = run('G28\nSET_HEATER_TEMPERATURE HEATER=heater_bed TARGET=200\nG1 X1 Y1 E1\n');
    assert.ok(codes(report.errors).includes('BED_TEMP_TOO_HIGH'));
  });

  it('tracks the highest target seen, not the last', () => {
    const report = run('G28\nM104 S200\nM104 S250\nM104 S180\nG1 X1 Y1 E1\n');
    assert.equal(report.maxExtruderTempC, 250);
  });
});

describe('preflight — chamber handling', () => {
  it('warns rather than fails when the model has no heated chamber', () => {
    const report = run('G28\nM141 S50\nG1 X10 Y10 E1\n');
    assert.equal(report.ok, true);
    assert.ok(codes(report.warnings).includes('CHAMBER_UNSUPPORTED'));
  });

  it('rejects a chamber target above the K2 limit', () => {
    const report = run('G28\nM141 S90\nG1 X10 Y10 E1\n', { profile: K2 });
    assert.equal(report.ok, false);
    assert.ok(codes(report.errors).includes('CHAMBER_TEMP_TOO_HIGH'));
  });

  it('accepts a chamber target within the K2 limit', () => {
    const report = run('G28\nM141 S50\nG1 X10 Y10 E1\n', { profile: K2 });
    assert.equal(report.ok, true);
  });
});

describe('preflight — build volume', () => {
  it('rejects motion beyond the build volume', () => {
    const report = run('G28\nG90\nG1 X500 Y10 E1\n');
    assert.equal(report.ok, false);
    const finding = report.errors.find((f) => f.code === 'OUT_OF_BOUNDS');
    assert.ok(finding);
    assert.match(finding.message, /X max 500 > 220/);
  });

  it('rejects motion below the bed origin', () => {
    const report = run('G28\nG90\nG1 X-50 Y10 E1\n');
    assert.equal(report.ok, false);
    assert.ok(codes(report.errors).includes('OUT_OF_BOUNDS'));
  });

  it('allows a small tolerance at the edge', () => {
    const report = run('G28\nG90\nG1 X220.5 Y10 E1\n');
    assert.equal(report.ok, true);
  });

  it('tracks relative moves through G91', () => {
    const report = run('G28\nG91\nG1 X200 E1\nG1 X200 E1\n');
    assert.equal(report.ok, false, 'two relative +200 moves should leave the 220mm bed');
    assert.ok(codes(report.errors).includes('OUT_OF_BOUNDS'));
  });

  it('downgrades a bounds violation to a warning when G92 rebases coordinates', () => {
    const report = run('G28\nG90\nG92 X0 Y0\nG1 X500 E1\n');
    assert.equal(report.ok, true, 'a G92 rebase makes our coordinates advisory');
    const finding = report.warnings.find((f) => f.code === 'OUT_OF_BOUNDS');
    assert.ok(finding);
    assert.match(finding.message, /G92 offsets/);
  });

  it('warns when the program drives Z below the bed', () => {
    const report = run('G28\nG90\nG1 X10 Y10 Z-5 E1\n');
    assert.ok(codes(report.warnings).includes('NEGATIVE_Z'));
  });

  it('honours the larger K1 Max volume', () => {
    const source = 'G28\nG90\nG1 X280 Y280 E1\n';
    assert.equal(run(source).ok, false, 'K1 rejects 280mm');
    assert.equal(run(source, { profile: getProfile('k1-max') }).ok, true, 'K1 Max allows 280mm');
  });
});

describe('preflight — dangerous commands', () => {
  const cases: readonly { source: string; code: PreflightCode; label: string }[] = [
    { source: 'M112', code: 'EMERGENCY_STOP', label: 'M112 emergency stop' },
    { source: 'M302 P1', code: 'COLD_EXTRUSION', label: 'M302 cold extrusion' },
    { source: 'M502', code: 'FIRMWARE_MUTATION', label: 'M502 factory reset' },
    { source: 'M997', code: 'FIRMWARE_MUTATION', label: 'M997 firmware update' },
    { source: 'SAVE_CONFIG', code: 'FIRMWARE_MUTATION', label: 'SAVE_CONFIG' },
    { source: 'RESTART', code: 'FIRMWARE_RESTART', label: 'RESTART' },
    { source: 'FIRMWARE_RESTART', code: 'FIRMWARE_RESTART', label: 'FIRMWARE_RESTART' },
    { source: 'RUN_SHELL_COMMAND CMD=rm', code: 'SHELL_COMMAND', label: 'RUN_SHELL_COMMAND' },
    { source: 'FORCE_MOVE STEPPER=stepper_x DISTANCE=10', code: 'UNSAFE_MOTION', label: 'FORCE_MOVE' },
    {
      source: 'SET_KINEMATIC_POSITION X=0',
      code: 'UNSAFE_MOTION',
      label: 'SET_KINEMATIC_POSITION',
    },
  ];

  for (const { source, code, label } of cases) {
    it(`refuses ${label}`, () => {
      const report = run(`G28\n${source}\nG1 X10 Y10 E1\n`);
      assert.equal(report.ok, false, `${label} should fail preflight`);
      assert.ok(codes(report.errors).includes(code), `expected ${code} for ${label}`);
    });
  }

  it('warns without failing on driver-current and tuning commands', () => {
    for (const source of ['M906 X800', 'SET_TMC_CURRENT STEPPER=stepper_x CURRENT=1.0', 'M500']) {
      const report = run(`G28\n${source}\nG1 X10 Y10 E1\n`);
      assert.equal(report.ok, true, `${source} should warn, not fail`);
      assert.ok(report.warnings.length > 0, `${source} should raise a warning`);
    }
  });

  it('ignores dangerous-looking text inside comments', () => {
    const report = run('G28\n; M112 would stop the printer\nG1 X10 Y10 E1\n');
    assert.equal(report.ok, true);
    assert.deepEqual(codes(report.errors), []);
  });

  it('deduplicates a repeated danger so one bad macro cannot flood the report', () => {
    const report = run(`G28\n${'M112\n'.repeat(50)}G1 X10 Y10 E1\n`);
    assert.equal(codes(report.errors).filter((code) => code === 'EMERGENCY_STOP').length, 1);
  });

  it('records the line number of the offending command', () => {
    const report = run('G28\nG90\nM112\n');
    assert.equal(report.errors.find((f) => f.code === 'EMERGENCY_STOP')?.line, 3);
  });
});

describe('preflight — content shape', () => {
  it('rejects an empty file', () => {
    const report = run('');
    assert.equal(report.ok, false);
    assert.ok(codes(report.errors).includes('EMPTY_FILE'));
  });

  it('rejects binary content', () => {
    const report = run(new Uint8Array([0x47, 0x00, 0x31, 0x0a]));
    assert.equal(report.ok, false);
    assert.ok(codes(report.errors).includes('BINARY_CONTENT'));
  });

  it('rejects a file above the byte ceiling', () => {
    const report = run('G28\nG1 X1 Y1 E1\n', { maxBytes: 4 });
    assert.equal(report.ok, false);
    assert.ok(codes(report.errors).includes('TOO_LARGE'));
  });

  it('warns when the program never homes', () => {
    const report = run('G90\nG1 X10 Y10 E1\n');
    assert.ok(codes(report.warnings).includes('NO_HOMING'));
  });

  it('warns when the program never extrudes', () => {
    const report = run('G28\nG90\nG1 X10 Y10\n');
    assert.ok(codes(report.warnings).includes('NO_EXTRUSION'));
    assert.equal(report.extrudes, false);
  });

  it('handles CRLF line endings', () => {
    const report = run('G28\r\nG90\r\nM104 S210\r\nG1 X10 Y10 E1\r\n');
    assert.equal(report.ok, true);
    assert.equal(report.maxExtruderTempC, 210);
  });

  it('handles a file with no trailing newline', () => {
    const report = run('G28\nG90\nG1 X10 Y10 E1');
    assert.equal(report.ok, true);
    assert.equal(report.lineCount, 3);
  });

  it('flags a truncated scan instead of silently checking part of the file', () => {
    const source = `G28\n${'G1 X1 Y1 E1\n'.repeat(50)}`;
    const report = run(source, { maxScanLines: 10 });
    assert.equal(report.truncated, true);
    assert.equal(report.scannedLines, 10);
    assert.ok(codes(report.warnings).includes('SCAN_TRUNCATED'));
  });

  it('uses a caller-supplied digest when given one', () => {
    const report = preflightGcode('G28\nG1 X1 Y1 E1\n', {
      filename: 'part.gcode',
      profile: K1,
      maxBytes: 1024,
      sha256: 'deadbeef',
    });
    assert.equal(report.sha256, 'deadbeef');
  });

  it('accepts a Uint8Array and a string identically', () => {
    const text = 'G28\nG90\nM104 S210\nG1 X10 Y10 E1\n';
    const fromString = run(text);
    const fromBytes = run(Buffer.from(text, 'utf8'));
    assert.equal(fromString.sha256, fromBytes.sha256);
    assert.equal(fromString.ok, fromBytes.ok);
  });
});

describe('assertPreflightOk', () => {
  it('does nothing for a passing report', () => {
    assert.doesNotThrow(() => {
      assertPreflightOk(run(GOOD_GCODE));
    });
  });

  it('throws PREFLIGHT_FAILED carrying the findings', () => {
    const report = run('G28\nM104 S350\nG1 X10 Y10 E1\n');
    assert.throws(
      () => {
        assertPreflightOk(report);
      },
      (error: unknown) => {
        assert.ok(CrealityError.is(error));
        assert.equal(error.code, 'PREFLIGHT_FAILED');
        assert.match(error.message, /exceeds the Creality K1 limit/);
        assert.equal(error.details?.['filename'], 'part.gcode');
        assert.ok(Array.isArray(error.details?.['errors']));
        return true;
      },
    );
  });
});

describe('formatBytes', () => {
  it('scales the unit to the magnitude', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(2048), '2.0 KiB');
    assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MiB');
  });
});
