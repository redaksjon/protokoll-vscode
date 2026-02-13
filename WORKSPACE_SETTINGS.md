# Workspace-Specific Filter Settings

## Overview

The Protokoll VSCode extension now persists filter settings (project filter, status filters, and sort order) on a per-workspace basis. This means each workspace can have its own filter configuration that is automatically restored when you open that workspace.

## What's Changed

### Before
- Filter settings were stored in memory only
- When you reopened a workspace, filters would reset to defaults
- All workspaces shared the same filter state

### After
- Filter settings are stored in VSCode's workspace state
- Each workspace maintains its own filter configuration
- Settings are automatically restored when you open a workspace
- Changes to filters are automatically saved

## Persisted Settings

The following settings are now workspace-specific:

1. **Project Filter** (`protokoll.projectFilter`)
   - The currently selected project filter
   - Stored as: project ID string or `null` for "Show All"

2. **Status Filters** (`protokoll.statusFilters`)
   - Which transcript statuses to show
   - Stored as: array of status strings
   - Default: `['initial', 'enhanced', 'reviewed', 'in_progress', 'closed']`

3. **Sort Order** (`protokoll.sortOrder`)
   - How transcripts are sorted in the list
   - Stored as: `'date-desc'`, `'date-asc'`, `'title-asc'`, or `'title-desc'`
   - Default: `'date-desc'`

## How It Works

### Automatic Saving
When you change any filter setting using the UI:
- Click "Filter by Project" → selection is saved
- Click "Filter by Status" → selection is saved
- Click "Sort" → selection is saved

The extension automatically saves these settings to the workspace state in the background.

### Automatic Loading
When you open a workspace:
- The extension loads the saved filter settings
- The transcript list is filtered/sorted according to your saved preferences
- No manual action required

## Implementation Details

### Storage Location
Settings are stored in VSCode's workspace state, which is:
- Specific to each workspace folder
- Stored in VSCode's internal storage (not in your project files)
- Automatically managed by VSCode

### Code Changes

#### `src/transcriptsView.ts`
- Added `loadWorkspaceSettings()` method to load settings on initialization
- Added `saveWorkspaceSettings()` method to persist settings
- Modified `setProjectFilter()`, `setStatusFilters()`, and `setSortOrder()` to save on change
- Constructor now calls `loadWorkspaceSettings()` to restore previous state

#### `tests/setup.ts`
- Enhanced `ExtensionContext` mock to properly track workspace state
- Added stateful storage using `Map` for both `globalState` and `workspaceState`

#### `tests/transcriptsView.test.ts`
- Added comprehensive tests for workspace settings persistence
- Tests verify both saving and loading of all filter settings

## Benefits

1. **Workspace Isolation**: Different projects can have different default filters
2. **Convenience**: No need to reapply filters every time you open a workspace
3. **Context Preservation**: Your view configuration is preserved across sessions
4. **No Configuration Required**: Works automatically without any setup

## Example Use Cases

### Scenario 1: Multiple Projects
You have two workspaces:
- **Work Workspace**: Filter to show only "work-project" transcripts
- **Personal Workspace**: Filter to show only "personal-project" transcripts

Each workspace remembers its filter, so you don't have to switch filters when switching workspaces.

### Scenario 2: Different Workflows
You have workspaces with different workflows:
- **Active Work**: Show only `in_progress` and `reviewed` statuses
- **Archive Review**: Show only `archived` and `closed` statuses

Each workspace maintains its own status filter configuration.

### Scenario 3: Team Collaboration
Your team uses a shared workspace:
- Each team member can set their own filter preferences
- Settings are stored locally, not in version control
- No conflicts between team members' preferences

## Technical Notes

- Settings are stored using VSCode's `ExtensionContext.workspaceState` API
- Storage is asynchronous but non-blocking
- Failed saves are logged but don't interrupt normal operation
- Settings are loaded synchronously during extension activation
- Default values are used if no saved settings exist

## Testing

Run the test suite to verify workspace settings functionality:

```bash
npm test -- transcriptsView.test.ts
```

The test suite includes:
- Saving project filter to workspace state
- Loading project filter from workspace state
- Saving status filters to workspace state
- Loading status filters from workspace state
- Saving sort order to workspace state
- Loading sort order from workspace state
