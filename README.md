# Creality Agent Tool

Local-first, agent-native control for Creality K1/K1C/K1 Max/K2-class 3D printers through a Klipper/Moonraker-compatible API.

The project exposes a clean TypeScript service API and a thin MCP stdio server. Read operations are direct; every physical mutation uses a short-lived, single-use confirmation token bound to the exact action and parameters.

> Early MVP: use on a supervised LAN printer. It has not yet been validated against every Creality firmware build.

## Highlights

- Creality profiles for `k1`, `k1c`, `k1-max`, and `k2`
- Printer status, current job, capabilities, files, and metadata
- Static G-code preflight before upload
- Temperature and build-volume enforcement
- Refusal of dangerous commands such as `M112`, `M502`, `SAVE_CONFIG`, `FORCE_MOVE`, and shell execution
- SSRF protection, private-network targeting by default, DNS/address validation, no redirects
- Dry-run planning and short-lived confirmation tickets
- SHA-256 audit records with credential and payload redaction
- No raw-G-code escape hatch
- Typed errors, bounded responses, request/upload timeouts

## Architecture

```text
Agent / OpenClaw / MCP client
          |
     MCP stdio facade
          |
    CrealityService        <- reusable native TypeScript API
      |    |    |
      |    |    +-- confirmation + audit policy
      |    +------- G-code preflight
      +------------ Moonraker adapter -> Creality printer on LAN
```

The core does not depend on MCP. A future OpenClaw-native wrapper can import `CrealityService` directly.

## Requirements

- Node.js 20.11 or newer
- A Creality printer exposing a Moonraker-compatible local endpoint
- The printer and agent host on a trusted LAN

Creality firmware varies by model and release. Some stock builds may expose a Creality-modified subset of Moonraker or require root/community firmware. Start with read-only calls and `CREALITY_DRY_RUN=true`.

## Install and verify

```bash
npm install
copy .env.example .env
npm run typecheck
npm run lint
npm test
npm run build
```

PowerShell environment example:

```powershell
$env:CREALITY_PRINTER_URL = "http://192.168.1.42:7125"
$env:CREALITY_PRINTER_MODEL = "k1"
$env:CREALITY_DRY_RUN = "true"
npm run build
npm run mcp
```

## MCP configuration

After `npm run build`:

```json
{
  "mcpServers": {
    "creality": {
      "command": "node",
      "args": ["/absolute/path/to/creality-agent-tool/dist/mcp/bin.js"],
      "env": {
        "CREALITY_PRINTER_URL": "http://192.168.1.42:7125",
        "CREALITY_PRINTER_MODEL": "k1",
        "CREALITY_DRY_RUN": "true"
      }
    }
  }
}
```

Tools:

- Read-only: `printer_status`, `printer_job`, `printer_capabilities`, `gcode_list`, `gcode_metadata`, `gcode_preflight`, `audit_tail`
- Mutating: `gcode_upload`, `print_start`, `print_pause`, `print_resume`, `print_cancel`

## Confirmation flow

1. Call a mutating tool with `dry_run: true` and the exact intended parameters.
2. Review the returned action plan, warnings, action fingerprint, and expiry.
3. Call the same tool with the returned `confirmation_token` and unchanged parameters.
4. The token is consumed once. Expired, reused, or parameter-mismatched tokens are refused and audited.

Upload always runs G-code preflight first. A preflight error prevents both upload and printing.

## Security model

- Public network targets are blocked unless explicitly enabled.
- Cloud metadata, malformed targets, URL credentials, unsafe protocols, mixed DNS answers, and redirects are refused.
- `CREALITY_ALLOWED_HOSTS` can further restrict targets.
- API keys are sent only as headers and are redacted from audit output.
- File paths are normalized under the printer's G-code area; traversal and absolute paths are refused.
- Audit output stores action hashes and bounded/redacted parameters, not full G-code payloads.
- Camera/AI monitoring is not a replacement for firmware thermal-runaway protection or human supervision.

## Development

```bash
npm run check
npm run build
```

The test suite uses mocked Moonraker HTTP responses and does not contact a real printer.

## Scope

This MVP intentionally excludes arbitrary G-code, temperature controls, axis movement, firmware updates, cloud control, slicing, and printer discovery. Those capabilities require separate threat models and hardware testing.

## License

MIT
