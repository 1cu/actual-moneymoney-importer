# Category cutover

Run this cutover against a backed-up Actual budget. Keep the preview, generated
plan, and backup together until you have checked the imported categories.
1. Capture a MoneyMoney snapshot and preview the category changes without
   writing to Actual:

   ```sh
   node scripts/actual-category-cutover.mjs collect-money-money --output DIR
   node scripts/actual-category-cutover.mjs preview --config PATH --source-dir PATH --money-money DIR/money-money.json --output DIR
   ```

2. Inspect `DIR/report.json` and `DIR/proposal.json`. Apply the reviewed plan,
   then confirm the resulting categories and transaction assignments in Actual:

   ```sh
   node scripts/actual-category-cutover.mjs apply --output DIR
   ```

3. If the result needs to be undone, restore from the private cutover files.
   Verify the restored categories before resuming imports:

   ```sh
   node scripts/actual-category-cutover.mjs restore --output DIR
   ```

After a successful cutover, the private one-click launcher can be installed
with `installLauncher` from `scripts/cutover-launcher.mjs`. Supply the private
directory, repository and config paths, first import date, Actual URL, and
absolute Node path. It creates an executable `actual-synchronisieren.zsh` and
a signed `Actual synchronisieren.shortcut` in that directory. Open the signed
Shortcut file to import it into Shortcuts; macOS may require you to confirm the
import and allow the Run Shell Script action. No existing personal wrapper is
changed. In a personal wrapper, quote paths and URLs containing spaces or shell
metacharacters.

The launcher sources `~/.zsh_secrets`, runs `dist/index.js import` with the
explicit config and a date window through today, then opens Actual only after
a successful import. The first run (or malformed state) starts at the supplied
first import date. Later runs overlap by five days, or start 90 days before
today if that is earlier. A lock prevents parallel runs. The success date is
updated atomically only after the importer exits successfully.
