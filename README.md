# claude-code-plugin-betting-markets

Search and aggregate betting/prediction markets from Polymarket, Kalshi, and Betfair with normalized odds and USD volume data.

![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)

## Quick Start

```bash
git clone https://github.com/your-username/claude-code-plugin-betting-markets.git
cd claude-code-plugin-betting-markets && npm install && npm run build
# Copy config.template.json to config.json and configure credentials
node scripts/dist/cli.js search --query "election"
```

## Features

-   **Cross-Platform Search**: Unified search across Polymarket, Kalshi, and Betfair.
-   **Data Normalization**: All odds converted to percentage (0-100%).
-   **Currency Standardization**: Volumes converted to USD automatically.
-   **Markdown Output**: Generate formatted tables for easy reading.
-   **Flexible Filtering**: Filter by volume, platform, or result count.
-   **Authentication Check**: Built-in tools to verify API credentials.
-   **Market Details**: Retrieve specific details for individual market IDs.

## Prerequisites

-   Node.js >= 18
-   Claude Code CLI
-   Service API credentials (Kalshi and Betfair require accounts)

## Installation

```bash
# Clone the repository
git clone https://github.com/your-username/claude-code-plugin-betting-markets.git

# Navigate to directory
cd claude-code-plugin-betting-markets

# Install dependencies
npm install

# Build the scripts
npm run build
```

## Configuration

Create a `config.json` file based on `config.template.json`.

-   **Polymarket**: No authentication required for read operations.
-   **Kalshi**: Requires Email and Password.
-   **Betfair**: Requires App Key and Login credentials.

## Available Commands

Run commands using: `node scripts/dist/cli.js <command> [options]`

| Command | Description | Options |
|---------|-------------|---------|
| `list-tools` | List all available commands | |
| `search` | Search markets across platforms | `--query`, `--platform`, `--min-volume`, `--max-results` |
| `format-table` | Search and output markdown table | `--query`, `--min-volume`, `--sort-by` |
| `market` | Get single market details | `--id`, `--platform` |
| `auth-test` | Test authentication for all platforms | |

## Usage Examples

**Search all platforms:**
```bash
node scripts/dist/cli.js search --query "election"
```

**Get a formatted table with minimum volume filter:**
```bash
node scripts/dist/cli.js format-table --query "inflation" --min-volume 100000
```

**Search only Polymarket:**
```bash
node scripts/dist/cli.js search --query "sports" --platform polymarket
```

## How it Works

This plugin uses CLI scripts to interface directly with the HTTP APIs of the supported betting exchanges. It aggregates results, normalizes disparate data formats (like binary yes/no vs. sports odds) into a unified structure, and handles currency conversion for consistent comparisons.

## Troubleshooting

1.  **Authentication Errors**: Verify credentials in `config.json`. Betfair sessions may require re-authentication.
2.  **Empty Results**: Try a broader query or lower the `--min-volume` threshold.
3.  **Platform Specific Issues**: If one platform fails, check if the API is down or if your rate limit has been exceeded.
4.  **Script Errors**: Ensure `npm run build` completed successfully and `node_modules` are installed.

## Contributing

Issues and pull requests are welcome.

## License

MIT
