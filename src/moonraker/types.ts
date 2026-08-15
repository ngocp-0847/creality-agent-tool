/** Raw Moonraker wire shapes. Everything is optional: firmware builds differ. */

export interface MoonrakerEnvelope<T> {
  readonly result?: T;
  readonly error?: { readonly message?: string } | string;
}

export interface RawPrinterInfo {
  readonly state?: string;
  readonly state_message?: string;
  readonly hostname?: string;
  readonly software_version?: string;
  readonly klipper_path?: string;
  readonly python_version?: string;
}

export interface RawServerInfo {
  readonly klippy_connected?: boolean;
  readonly klippy_state?: string;
  readonly components?: readonly string[];
  readonly moonraker_version?: string;
  readonly api_version_string?: string;
}

export interface RawHeater {
  readonly temperature?: number;
  readonly target?: number;
  readonly power?: number;
}

export interface RawPrintStats {
  readonly filename?: string;
  readonly total_duration?: number;
  readonly print_duration?: number;
  readonly filament_used?: number;
  readonly state?: string;
  readonly message?: string;
}

export interface RawToolhead {
  readonly position?: readonly number[];
  readonly homed_axes?: string;
  readonly max_velocity?: number;
  readonly max_accel?: number;
}

export interface RawObjectQuery {
  readonly eventtime?: number;
  readonly status?: {
    readonly extruder?: RawHeater;
    readonly heater_bed?: RawHeater;
    readonly 'heater_generic chamber'?: RawHeater;
    readonly 'temperature_sensor chamber'?: RawHeater;
    readonly print_stats?: RawPrintStats;
    readonly display_status?: { readonly progress?: number; readonly message?: string };
    readonly virtual_sdcard?: { readonly progress?: number; readonly is_active?: boolean };
    readonly toolhead?: RawToolhead;
    readonly fan?: { readonly speed?: number };
  };
}

export interface RawFileEntry {
  readonly path?: string;
  readonly modified?: number;
  readonly size?: number;
  readonly permissions?: string;
}

export interface RawFileMetadata {
  readonly filename?: string;
  readonly size?: number;
  readonly modified?: number;
  readonly estimated_time?: number;
  readonly filament_total?: number;
  readonly first_layer_bed_temp?: number;
  readonly first_layer_extr_temp?: number;
  readonly object_height?: number;
  readonly slicer?: string;
  readonly slicer_version?: string;
}

export interface RawUploadResult {
  readonly item?: { readonly path?: string; readonly root?: string };
  readonly print_started?: boolean;
  readonly action?: string;
}
