# Dispatch Pendency

Live warehouse packing and bin workload dashboard for facility NXS2.

## GitHub Pages

The dashboard is a static site. In the repository's **Settings → Pages**, publish from the `main` branch and the `/ (root)` folder. The dashboard entry point is `index.html`.

The browser loads the latest `PackingPrintList` snapshot from the public Google Apps Script Web App configured in `js/app.js`. No NEXS API credentials or server are required.

## Local preview

Open `index.html` in a browser. The page fetches the live snapshot and refreshes it every 60 seconds.

## Source data

The dashboard expects the Web App response from `?type=packingPrintList&includeRows=true`, with `rowCount`, `timestamp`, and `rows` containing the source columns:

- Shipping Package ID
- Shipping Provider Code
- Store Code
- Bin Code

The workload-by-prefix view groups each `Bin Code` by its leading letters up to the first digit (for example, `NDD1158` is in prefix `NDD`). Missing or non-letter-prefixed bin codes remain visible in their own groups. Selecting a prefix filters the dashboard without changing the source data.

The bin-range view also groups NDD bins into `NDD1-NDD175`, `NDD176-NDD355`, `NDD356-NDD525`, `NDD526-NDD698`, `NDD699-NDD868`, `NDD869-NDD1008`, `NDD1009-NDD1188`, and `NDD1189-NDD END`. P bins are grouped into `P1-P195` and `P196-PEND`; GP bins into `GP1-GP263` and `GP264-GP END`. S, V and D each have a whole-prefix group. The specified range boundaries are inclusive.

The summary includes the busiest bin group for the current filters. Data-quality counts are clickable and filter the shipment explorer to rows with missing fields, duplicate package IDs, or invalid source rows. Use the header theme button to switch between dark and light themes; the preference is saved in the browser.
