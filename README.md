<!-- AUTO-GENERATED README — DO NOT EDIT. Changes will be overwritten on next publish. -->
# claude-code-plugin-betting-markets

Search and aggregate betting/prediction markets from Polymarket, Kalshi, Manifold, Betfair, and 40+ bookmakers via The Odds API

![Version](https://img.shields.io/badge/version-1.5.0-blue) ![License: MIT](https://img.shields.io/badge/License-MIT-green) ![Node >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)

## Features

- **list-tools** — List all available commands
- **search** — Search markets across platforms
- **format-table** — Search and output markdown table
- **market** — Get single market details
- **auth-test** — Test authentication for all platforms
- **credit-status** — Show The Odds API credit usage
- **list-sports** — List available The Odds API sports (0 credits)
- **account-funds** — Show Betfair account balance and exposure
- **account-statement** — Show Betfair transaction history
- **current-orders** — List open Betfair orders
- **cleared-orders** — List settled/voided Betfair orders
- **account-summary** — Betfair account dashboard (balance + orders + P&L)
- Chart Generation
- **chart** — Generate historical probability chart

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

## Configuration

Copy `config.template.json` to `config.json` and fill in the required values:

| Field | Placeholder |
|-------|-------------|
| `credentials_path` | `/path/to/your/credentials` |

## Available Commands

### CLI Commands

| Command             | Description                                        | Options                                                                                                                                     |
| ------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `list-tools`        | List all available commands                        |                                                                                                                                             |
| `search`            | Search markets across platforms                    | `--query`, `--platform`, `--min-volume`, `--max-results`, `--sport`                                                                         |
| `format-table`      | Search and output markdown table                   | `--query`, `--min-volume`, `--sort-by`                                                                                                      |
| `market`            | Get single market details                          | `--id`, `--platform`                                                                                                                        |
| `auth-test`         | Test authentication for all platforms              |                                                                                                                                             |
| `credit-status`     | Show The Odds API credit usage                     |                                                                                                                                             |
| `list-sports`       | List available The Odds API sports (0 credits)     |                                                                                                                                             |
| `account-funds`     | Show Betfair account balance and exposure          |                                                                                                                                             |
| `account-statement` | Show Betfair transaction history                   | `--date-from`, `--date-to`, `--include-item`, `--limit`, `--max-pages`                                                                      |
| `current-orders`    | List open Betfair orders                           | `--order-projection`, `--market-ids`, `--date-from`, `--date-to`, `--order-by`, `--sort-dir`, `--limit`, `--max-pages`                      |
| `cleared-orders`    | List settled/voided Betfair orders                 | `--bet-status` (required), `--event-type-ids`, `--market-ids`, `--side`, `--date-from`, `--date-to`, `--group-by`, `--limit`, `--max-pages` |
| `account-summary`   | Betfair account dashboard (balance + orders + P&L) |                                                                                                                                             |

### Chart Generation

| Command | Description                           | Options                                                                           |
| ------- | ------------------------------------- | --------------------------------------------------------------------------------- |
| `chart` | Generate historical probability chart | `--market` (required), `--platform`, `--output`, `--width`, `--height`, `--title` |

### Common Options

| Option          | Description                                                                        | Default             |
| --------------- | ---------------------------------------------------------------------------------- | ------------------- |
| `--query`       | Search term (e.g., "greenland", "trump")                                           | Required for search |
| `--platform`    | Filter to single platform (polymarket, kalshi, manifold, myriad, betfair, theodds) | All platforms       |
| `--min-volume`  | Minimum volume in USD (e.g., 100000)                                               | 0                   |
| `--max-results` | Maximum results to return                                                          | 50                  |
| `--sort-by`     | Sort by: volume, odds, platform                                                    | volume              |
| `--sport`       | The Odds API sport key (e.g., soccer_epl) - bypasses alias matching                |                     |

## Usage Examples

```bash
# Search all platforms for "trump" markets
node scripts/dist/cli.js search --query "trump"

# Get formatted table with minimum $100k volume
node scripts/dist/cli.js format-table --query "greenland" --min-volume 100000

# Search only Polymarket
node scripts/dist/cli.js search --query "bitcoin" --platform polymarket

# Search Kalshi markets via FinFeedAPI
node scripts/dist/cli.js search --query "fed rate" --platform kalshi

# Search The Odds API for Premier League
node scripts/dist/cli.js search --query "premier league" --platform theodds --sport soccer_epl

# Search The Odds API for US politics
node scripts/dist/cli.js search --query "election" --platform theodds

# Check credit usage
node scripts/dist/cli.js credit-status

# List available sports (free - 0 credits)
node scripts/dist/cli.js list-sports

# Test authentication
node scripts/dist/cli.js auth-test
```

```bash
# Check account balance
node scripts/dist/cli.js account-funds

# View transaction history (last 100)
node scripts/dist/cli.js account-statement

# Filter to exchange transactions only
node scripts/dist/cli.js account-statement --include-item EXCHANGE --max-pages 2

# List open bets
node scripts/dist/cli.js current-orders --order-projection EXECUTABLE

# View settled bet history with P&L
node scripts/dist/cli.js cleared-orders --bet-status SETTLED

# View only BACK bets settled this month
node scripts/dist/cli.js cleared-orders --bet-status SETTLED --side BACK --date-from 2026-02-01

# Full account dashboard
node scripts/dist/cli.js account-summary
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
