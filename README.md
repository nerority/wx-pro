# WX Pro

A personal pro weather web app for US locations. It compares 8 forecast sources side by side (NWS official, HRRR, NBM, GFS, ECMWF IFS, ECMWF AIFS, ICON, GEM), shows how much they agree, and reads current conditions from the nearest NWS station.

## Screens

- **Now** — station conditions, alerts, severe outlook, confidence summary, 24-hour and 10-day forecast
- **Compare** — every source on one chart, with the model range and a day-by-day table
- **Radar** — animated NEXRAD loop (last hour), NWS warning areas, SPC storm outlook
- **Alerts** — NWS alerts and SPC Day 1–3 risk for every saved place
- **Accuracy** — grades each source against the nearest station; feeds the skill-weighted best guess

Live at: https://nerority.github.io/wx-pro/ — open it in Chrome on Android and choose "Add to Home screen".

## Data Sources

- Forecast models: [Open-Meteo](https://open-meteo.com/) (CC BY 4.0), free non-commercial tier
- Official forecast, alerts and station observations: NOAA / National Weather Service API
- Past forecasts for grading: Open-Meteo Previous Runs API
- Radar: [Iowa Environmental Mesonet](https://mesonet.agron.iastate.edu/) NEXRAD composite tiles
- Severe outlooks: NOAA SPC via the NWS map services
- Base map: Esri World Dark Gray Canvas (fallback: OpenStreetMap)
- Charts: [Chart.js](https://www.chartjs.org/) (MIT); maps: [Leaflet](https://leafletjs.com/) (BSD-2), bundled in `vendor/`

Not an official warning source. For life-safety decisions, rely on NWS warnings and local officials.
