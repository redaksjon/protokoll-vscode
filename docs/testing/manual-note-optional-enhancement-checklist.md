# Manual Note Optional Enhancement Checklist

## Scope

Validation checklist for plan `manual-note-optional-enhancement` covering create flow, manual note editing, enhancement behavior, and tree representation.

## Automated Verification

- [x] TypeScript compile passes: `npm run compile`
- [x] Tree icon behavior covered in `tests/transcriptsView.test.ts`
- [x] Manual note/original/enhance tab rendering covered in `tests/transcriptDetailView.test.ts`

## Manual Verification

- [ ] New item chooser shows exactly two options: upload audio transcript or create manual note.
- [ ] Choosing upload audio runs the existing upload flow unchanged.
- [ ] Choosing manual note prompts for title and opens detail view immediately.
- [ ] Manual note opens in `Original` tab with cursor focused in editable textarea.
- [ ] `Save Original` is explicit and enabled only when content is dirty.
- [ ] Attempting to leave `Original` with unsaved edits prompts for confirmation.
- [ ] `Enhance` button appears in `Original` for both manual notes and transcripts.
- [ ] `Enhance` is blocked when `Original` is empty.
- [ ] Re-enhance prompts before overwriting existing enhanced output.
- [ ] For manual notes, `Enhanced` tab is hidden before enhancement and appears after successful enhancement.
- [ ] On enhancement failure, existing enhanced output remains and error messaging indicates content was kept.
- [ ] Manual notes appear in the same tree as transcripts and show note icon (without title prefix).

## Notes

- This checklist intentionally mixes automated and manual verification because some interactions rely on VS Code webview behavior and user focus flows that are best validated interactively.

## Identify Tasks in Transcript (MVP) Quick Checks

- [x] Automated: `tests/transcriptDetailView.test.ts` covers identify flow message handling and selective task creation.
- [ ] Manual: `Identify Tasks` button is visible in transcript detail view and defaults to no candidates preselected.
- [ ] Manual: transcripts tree context menu exposes `Identify Tasks in Transcript` for no-detail workflow.
- [ ] Manual: duplicate candidates are blocked from creation when semantically similar tasks already exist.
- [ ] Manual: optional tag prompt appears only when selected candidates include suggested tags.
- [ ] Manual: info message reports created count and duplicate-blocked count after completion.
