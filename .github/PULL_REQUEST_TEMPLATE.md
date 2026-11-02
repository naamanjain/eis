<!-- What this changes and why. Name the file and line where the defect lived, not just
     the symptom. If it fixes an issue, link it. -->
### What changed

### Why

<!-- Run the commands and paste real numbers. A check you did not run is stated as not run —
     that is information, not a failure. Never replace a failing check with a skipped one. -->
### Checks

- [ ] `node scripts/check.js` — passed ____ / ____
- [ ] `npm run vendor:check`
- [ ] `npm run lint`
- [ ] `npm run typecheck`
- [ ] `npm run package:ext` then `npm run verify:package`
- [ ] `npm run check:vscode` and `npm run check:vscode:package` (if the extension host runs changed)
- [ ] `npm run check:layout` (if webview layout or scrolling changed)

Not run, and why:

### Behaviour a user would notice

<!-- Screenshots or a short recording for any webview change. Describe the state you
     measured, not the attribute you set. -->

### Anything else a reviewer should know

<!-- Unrelated problems you noticed but did not fix belong here, not in this diff. -->
