# Phase 4 — Manual QA Checklist

Open the project in VS Code with the extension loaded (F5 > "Extension Development Host").

## 1. Error badge
- [ ] Open a file with at least one error — an `E` badge (or count/dot per config) appears next to the file in the Explorer tree
- [ ] Badge uses the error foreground color (typically red)

## 2. Warning badge
- [ ] Open a file with at least one warning — a `W` badge appears
- [ ] Badge uses the warning foreground color (typically yellow/orange)

## 3. Info badge
- [ ] Open a file with at least one info diagnostic — an `!` badge appears
- [ ] Badge uses the info foreground color (typically blue)

## 4. Badge disappears after fixing
- [ ] Fix all problems in a file that had a badge — the badge disappears within a few seconds
- [ ] Badge also immediately disappears after running "Refresh Problem Decorations" command

## 5. Badge survives editor switching
- [ ] File A has a badge, File B has a different badge
- [ ] Switch tab to File B — File B's badge shows, File A retains its badge when switching back
- [ ] Open a split editor group — badges show in both groups
- [ ] Close a tab and re-open it — badge reappears

## 6. Folder propagation
- [ ] A folder containing files with errors shows an aggregate badge at the folder level
- [ ] The worst severity (error > warning > info) wins for the folder badge
- [ ] Counts sum correctly from all children

## 7. Refresh
- [ ] Run "Refresh Problem Decorations" command — all badges re-query correctly
- [ ] No flickering or temporary disappearance

## 8. Performance
- [ ] Opening a large workspace (1000+ files) does not cause noticeable lag
- [ ] Rapidly editing files does not cause stuttering
