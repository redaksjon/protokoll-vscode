# Protokoll VS Code Extension

A VS Code extension for viewing Protokoll transcripts and entities via the HTTP MCP server.

## Features

- **View Transcripts**: Browse and view transcripts from your Protokoll server
- **Transcript Details**: View full transcript content with metadata in a formatted view
- **Server Configuration**: Easy configuration of the Protokoll HTTP MCP server URL

## Requirements

- VS Code 1.90.0 or higher
- A running Protokoll HTTP MCP server (default: `http://127.0.0.1:3001`)

## Installation

1. Clone this repository
2. Run `npm install`
3. Press `F5` to open a new VS Code window with the extension loaded

## Usage

### First Time Setup

1. When you first activate the extension, you'll be prompted to configure the server URL
2. Enter the URL of your Protokoll HTTP MCP server (e.g., `http://127.0.0.1:3000`)
3. The extension will connect to the server and load available transcripts

### Viewing Transcripts

1. Open the **Protokoll** sidebar (book icon in the activity bar)
2. Click on **Protokoll Transcripts** to see the list of available transcripts
3. Click on any transcript to view its details in a new editor tab

### Configuring Server URL

- Use the command palette (`Cmd+Shift+P` / `Ctrl+Shift+P`) and run **Protokoll: Configure Server URL**
- Or update the setting `protokoll.serverUrl` in your VS Code settings

## Configuration

The extension supports the following settings:

- `protokoll.serverUrl`: URL of the Protokoll HTTP MCP server (default: `http://127.0.0.1:3001`)
- `protokoll.transcriptsDirectory`: Default directory path for transcripts (optional)

## Development

```bash
# Install dependencies
npm install

# Compile TypeScript
npm run compile

# Watch for changes
npm run watch

# Lint
npm run lint
```

## Building

```bash
# Install dependencies
npm install

# Compile
npm run compile

# Package extension (requires vsce)
npm install -g @vscode/vsce
vsce package
```

## License

Apache-2.0
