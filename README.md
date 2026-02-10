<!-- AUTO-GENERATED README — DO NOT EDIT. Changes will be overwritten on next publish. -->
# claude-code-plugin-betting-markets

Search and aggregate betting/prediction markets from Polymarket, Kalshi, and Betfair

![Version](https://img.shields.io/badge/version-1.2.10-blue) ![License: MIT](https://img.shields.io/badge/License-MIT-green) ![Node >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)

## Features

- **list-tools** — List all available commands
- **search** — Search markets across platforms
- **format-table** — Search and output markdown table
- **market** — Get single market details
- **auth-test** — Test authentication for all platforms

## Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI
- API credentials for the target service (see Configuration)

## Quick Start

```bash
git clone https://github.com/YOUR_GITHUB_USER/claude-code-plugin-betting-markets.git
cd claude-code-plugin-betting-markets
cp config.template.json config.json  # fill in your credentials
cd scripts && npm install
```

```bash
node scripts/dist/cli.js list-tools
```

## Installation

1. Clone this repository
2. Copy `config.template.json` to `config.json` and fill in your credentials
3. Install dependencies:
   ```bash
   cd scripts && npm install
   ```

## Available Commands

| Command        | Description                           | Options                                                  |
| -------------- | ------------------------------------- | -------------------------------------------------------- |
| `list-tools`   | List all available commands           |                                                          |
| `search`       | Search markets across platforms       | `--query`, `--platform`, `--min-volume`, `--max-results` |
| `format-table` | Search and output markdown table      | `--query`, `--min-volume`, `--sort-by`                   |
| `market`       | Get single market details             | `--id`, `--platform`                                     |
| `auth-test`    | Test authentication for all platforms |                                                          |

### Common Options

| Option          | Description                                             | Default             |
| --------------- | ------------------------------------------------------- | ------------------- |
| `--query`       | Search term (e.g., "greenland", "trump")                | Required for search |
| `--platform`    | Filter to single platform (polymarket, kalshi, betfair) | All platforms       |
| `--min-volume`  | Minimum volume in USD (e.g., 100000)                    | 0                   |
| `--max-results` | Maximum results to return                               | 50                  |
| `--sort-by`     | Sort by: volume, odds, platform                         | volume              |

## Usage Examples

```bash
# Search all platforms for "greenland" markets
node scripts/dist/cli.js search --query "greenland"

# Get formatted table with minimum $100k volume
node scripts/dist/cli.js format-table --query "greenland" --min-volume 100000

# Search only Polymarket
node scripts/dist/cli.js search --query "trump" --platform polymarket

# Test authentication
node scripts/dist/cli.js auth-test
```

## How It Works

This plugin connects directly to the service's HTTP API. The CLI handles authentication, request formatting, pagination, and error handling, returning structured JSON responses.

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Authentication errors | Verify credentials in `config.json` |
| `ERR_MODULE_NOT_FOUND` | Run `cd scripts && npm install` |
| Rate limiting | The CLI handles retries automatically; wait and retry if persistent |
| Unexpected JSON output | Check API credentials haven't expired |

## Contributing

Issues and pull requests are welcome.

## License

MIT
