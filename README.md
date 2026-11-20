# Batch Color Swap for Illustrator

Use this script to find any fill or stroke color in a folder of PDF, AI or EPS files and replace it with any other color. It runs inside Illustrator and opens its own dialog window. You don't need to install anything else.

## Install

- **One-off:** In Illustrator, choose **File > Scripts > Other Script...** and pick `Batch_Color_Swap.jsx`.
- **Permanent menu item:** Copy the file into Illustrator's scripts folder and restart Illustrator. It then appears under **File > Scripts**.
  - Mac: `/Applications/Adobe Illustrator 20xx/Presets/en_US/Scripts/`
  - Windows: `C:\Program Files\Adobe\Adobe Illustrator 20xx\Presets\en_US\Scripts\`

## Everyday workflow

1. **Load or build a color set.** Each rule says "FIND this color, REPLACE with that color."
   - Click **Add...** to create a rule.
   - Choose **Pick from Open Document / Selection...** to grab an exact color from the artwork. This avoids typing CMYK values by hand.
2. **Save the rules as a preset per brand** with **Save As...**. Next time, choose the preset from the dropdown and the rules load.
3. **Click Test on Open Document** to check the rules on one file before running a batch. The test doesn't save. Use **File > Revert** to undo it.
4. **Pick the source folder** and how to save the results. Then click **Run Batch**.

Tick **Dry run** to get a count of what would change without touching any files.

## How rules work

- **FIND** by CMYK, RGB or Grayscale values, or by spot/swatch name.
  - Value matching uses a tolerance, so a magenta of 99.6 still counts as 100. The default tolerance is ±0.5.
  - Global process swatches are matched by their values too.
  - Name matching can use "contains" or "is exactly". To match several names, separate them with commas, for example `white, wht, opaque white`.
- **REPLACE** with CMYK, RGB, Grayscale, a spot color, or None (which removes the fill or stroke).
  - If a file doesn't have the spot target yet, the script creates it. It uses the reference swatch file's definition if that file has it (see below), or the CMYK appearance you enter if not. If a file already has that spot, the file's own spot is used.
- Rules are checked from top to bottom, and **the first rule that matches wins**. A color is never changed twice in one pass, so A→B and B→C in the same set won't chain.
- **Only in files whose name contains** limits a rule to certain files. Start the text with `!` to mean "does NOT contain."
- Each rule can change fills, strokes, or both.

## Tints

**Keep the original spot's tint** is on by default for every target type:

- **Spot → spot:** a 30% tint of the old spot becomes a 30% tint of the new one.
- **Spot → CMYK or grayscale:** the ink values are scaled. A 30% tint becomes 30% of each value in the build.
- **Spot → RGB:** the color is lightened toward white by the same amount.

Untick it if every match should get the full-strength build.

## Reference swatch file (official Pantone definitions)

A script can't reach Pantone Connect or Illustrator's recently used swatches. Instead, keep the official swatches in a reference file:

1. Make a small .ai file, for example `Pantone_Reference.ai`.
2. Use Pantone Connect to add each Pantone color you'll need to that file's Swatches panel, then save it. You can add more colors at any time.
3. In the main window, under **Reference swatch file**, click **Choose...** and select it. The window shows how many spot swatches it loaded.
4. In a rule's REPLACE side, choose **Spot color**, then click **Choose from Reference Swatch File...**. This fills in the exact swatch name, so typos can't create a second plate. It also fills in the CMYK values.

**During a batch:**
- **Spot not in the file yet:** it's added with the reference file's official definition (Lab for Pantone library colors).
- **Spot already in the file:** the file's own definition is kept. Tick **Also update same-name swatches already in the files** to make every file match the reference.
- **Target name not in the reference file:** the spot is built from the CMYK values typed in the rule.

The log notes which of these happened for each file.

**Example: PMS 289 C → PMS 534 C**
- **FIND:** Spot / swatch name, "is exactly", `PANTONE 289 C`. Use "contains" with `289` if your files name it inconsistently.
- **REPLACE:** Spot color, picked from the reference file.
- **Leave "Delete old spot swatches after replacing them" on.** The old 289 swatch is then removed, so no stray separation is left behind.
- **Clear "Use SPOT targets only for files whose name contains"** if every file should get the spot.

## Your existing magenta → white workflow

The first time the script runs, it creates a preset called **"Magenta to White (SC-FC)"** that repeats what your old script did:

- Files with `SCProduction` in the name: magenta becomes spot "White". Process white and other white spots are also merged into spot "White", and the duplicate white swatches are deleted.
- All other files: magenta becomes process white (C0 M0 Y0 K0).
- The `BACKGROUND` layer is hidden.

The SC/FC switch is the **"Use SPOT targets only for files whose name contains"** option. It applies to any rule whose target is a spot color, so it works for brand spot colors too.

## Safety features

- When overwriting originals, the script first copies them to an `_ORIGINALS` folder that mirrors your subfolders. If a backup already exists from an earlier run, it isn't overwritten, so you always keep the true original. You can also save the results to a separate folder instead of overwriting.
- Files with no matching colors are not re-saved.
- Each run writes a log (`ColorSwap_Log_<date>.csv`) to the source folder. For every file it lists the counts of fills, strokes and text characters changed, plus any errors.
- Files that fail are copied to a `FAILED_FILES` folder.
- **Stop after this file** pauses a batch. Running it again offers to resume. The resume record is cleared once a batch finishes, so the next run starts fresh.
- Illustrator's pop-ups, such as missing-font warnings, are suppressed during a batch so the run doesn't stall.

## Improvements over the original magenta → white script

- The resume file was never cleared, so a second run on the same folder did nothing.
- Files with more than 2,000 paths were skipped silently. There's now no limit by default, and if you set one, skipped files are listed in the log.
- The log file was set up but never written.
- Originals were overwritten with no backup.
- Locked or hidden objects and layers, live text, and global swatches were missed.

## Things to know

- **Multi-page PDFs:** Illustrator opens only page 1 of a PDF. If you overwrite a multi-page PDF, the other pages are lost. The old script had the same problem. Use "Save to another folder" for those files.
- **Not changed:** Colors inside placed or embedded images, symbols, patterns and appearance effects aren't changed. Gradient support is marked beta, so spot-check those files.
- **RGB documents:** RGB documents store colors as RGB. If a CMYK rule finds nothing in an RGB file, add an RGB rule for the same color.
- **Presets are .json files:** Click **Show Folder** to find them and share them with teammates. Teammates add them with **Import...**.

## Tests

`tests/harness.js` runs the color-matching and replacement logic against a mocked Illustrator object model. It covers tolerance, global swatches, tints, spot creation, the reference swatch file, locked items, text and gradients. You need Node.js to run it:

```
node tests/harness.js
```

Test the dialogs and saving in Illustrator itself.
