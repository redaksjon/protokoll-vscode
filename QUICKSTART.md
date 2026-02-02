# Quick Start Guide

## Prerequisites

1. A running Protokoll HTTP MCP server (default: `http://127.0.0.1:3001`)
2. VS Code 1.90.0 or higher

## Installation

1. Open the extension folder in VS Code
2. Run `npm install` to install dependencies
3. Press `F5` to launch a new Extension Development Host window

## First Run

1. When the extension activates, it will check for a configured server URL
2. If not configured, you'll be prompted to enter the server URL
3. Enter the URL of your Protokoll HTTP MCP server (e.g., `http://127.0.0.1:3001`)
4. The extension will connect and attempt to discover transcripts

## Using the Extension

### View Transcripts

1. Look for the **Protokoll** icon (book) in the Activity Bar
2. Click on it to open the Protokoll sidebar
3. You'll see a **Transcripts** view
4. Click on any transcript to view its details

### Configure Server URL

- Use Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`)
- Run: **Protokoll: Configure Server URL**
- Enter the new server URL

### Transcript Details

When you click on a transcript:
- A new editor tab opens showing the transcript
- Metadata is displayed at the top (title, filename, date/time, path)
- The transcript content is rendered below with markdown formatting

## Troubleshooting

### Server Not Responding

- Check that the Protokoll HTTP MCP server is running
- Verify the server URL in settings (`protokoll.serverUrl`)
- Check the server logs for errors

### No Transcripts Found

- The extension needs to know the transcripts directory
- It will try to discover it from the server's resources
- If that fails, you'll be prompted to enter the directory path
- You can also set `protokoll.transcriptsDirectory` in settings

### Connection Errors

- Ensure the server URL is correct (including protocol: `http://` or `https://`)
- Check firewall settings
- Verify the server is accessible from your machine

## Development

```bash
# Install dependencies
npm install

# Compile TypeScript
npm run compile

# Watch for changes (auto-compile)
npm run watch

# Lint code
npm run lint
```

## Building for Distribution

```bash
# Install vsce globally
npm install -g @vscode/vsce

# Package the extension
vsce package
```

This creates a `.vsix` file that can be installed in VS Code.
