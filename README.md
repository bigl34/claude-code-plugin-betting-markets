<!-- AUTO-GENERATED README — DO NOT EDIT. Changes will be overwritten on next publish. -->
# claude-code-plugin-betting-markets

Search and aggregate betting and prediction markets from Polymarket, Kalshi, Manifold, Myriad, Betfair, and bookmakers via The Odds API

![Version](https://img.shields.io/badge/version-1.9.0-blue) ![License: MIT](https://img.shields.io/badge/License-MIT-green) ![Node >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)

## Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI
- API credentials for the target service (see Configuration)

## Quick Start

```bash
git clone https://github.com/bigl34/claude-code-plugin-betting-markets.git
cd claude-code-plugin-betting-markets
cp config.template.json config.json  # fill in your credentials
npm --prefix scripts install
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
| `polymarket.baseUrl` | `https://gamma-api.polymarket.com` |
| `polymarket.enabled` | `true` |
| `betfair.ssoUrl` | `https://identitysso.betfair.com/api/login` |
| `betfair.certSsoUrl` | `https://identitysso-cert.betfair.com/api/certlogin` |
| `betfair.baseUrl` | `https://api.betfair.com/exchange/betting/json-rpc/v1` |
| `betfair.accountBaseUrl` | `https://api.betfair.com/exchange/account/json-rpc/v1` |
| `betfair.appKey` | `<BETFAIR_APP_KEY>` |
| `betfair.username` | `<BETFAIR_USERNAME>` |
| `betfair.password` | `<BETFAIR_PASSWORD>` |
| `betfair.certPath` | `<RAM_PATH_TO_BETFAIR_CERTIFICATE>` |
| `betfair.keyPath` | `<RAM_PATH_TO_BETFAIR_PRIVATE_KEY>` |
| `betfair.enabled` | `true` |
| `theodds.apiKey` | `<THE_ODDS_API_KEY>` |
| `theodds.enabled` | `true` |
| `theodds.baseUrl` | `https://api.the-odds-api.com` |
| `theodds.region` | `uk` |
| `theodds.defaultMarket` | `h2h` |
| `theodds.monthlyBudget` | `400` |
| `finfeed.apiKey` | `<FINFEED_API_KEY>` |
| `finfeed.enabled` | `true` |
| `finfeed.baseUrl` | `https://api.finfeedapi.com` |
| `finfeed.exchanges` | `kalshi,manifold,myriad` |
| `settings.gbpToUsd` | `1.27` |
| `settings.defaultMaxResults` | `50` |
| `settings.cacheMarketsTTL` | `300` |
| `settings.cacheMetadataTTL` | `3600` |

## Available Commands

See `agents/betting-markets-manager.md` for the full command reference.

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
