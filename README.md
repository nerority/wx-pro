# WX Pro

A personal pro weather web app for US locations. It compares 8 forecast sources side by side (NWS official, HRRR, NBM, GFS, ECMWF IFS, ECMWF AIFS, ICON, GEM), shows how much they agree, and reads current conditions from the nearest NWS station.

Live at: https://nerority.github.io/wx-pro/ — open it in Chrome on Android and choose "Add to Home screen".

## Data Sources

- Forecast models: [Open-Meteo](https://open-meteo.com/) (CC BY 4.0), free non-commercial tier
- Official forecast, alerts and station observations: NOAA / National Weather Service API
- Charts: [Chart.js](https://www.chartjs.org/) (MIT), bundled in `vendor/`

Not an official warning source. For life-safety decisions, rely on NWS warnings and local officials.
