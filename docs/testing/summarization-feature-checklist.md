# Summarization Feature Checklist

## Feature Flag

- Ensure `protokoll.features.summaryEnabled` is `true` in VS Code settings.
- Open a transcript in detail view and confirm a `Summary` tab is visible.

## First-Run Setup Flow

- Open `Summary` tab for a transcript without an existing summary.
- Click `Configure Summary`.
- Fill:
  - title
  - audience
  - guidance note
  - style preset
- Confirm setup preview is shown in the Summary tab.

## Generation Flow

- Click `Generate Summary`.
- Verify success notification appears.
- Verify generated summary text appears in Summary tab.
- Verify `Generated` timestamp appears.

## Regenerate / Edit Workflow

- Click `Reconfigure` and change audience and/or guidance.
- Click `Regenerate`.
- Verify new summary replaces active summary.
- Verify `Previous summary versions kept` count increments.

## Audience-Safety Scenario

Use guidance like:

`Exclude internal reflections and sensitive personal notes. Keep this attendee-safe.`

Verify resulting summary avoids private/internal wording.
