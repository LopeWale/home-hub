# Third party notices

This project builds on the work below. None of it is copied into this repository
except where stated: `install.sh` downloads each piece at the pinned version.

## Installed by `install.sh`

| Component | Version | License | Copyright |
|---|---|---|---|
| [MagicMirror²](https://github.com/MagicMirrorOrg/MagicMirror) | v2.38.0 | MIT | © 2016-2026 Michael Teeuw |
| [MMM-pages](https://github.com/edward-shen/MMM-pages) | commit e5fa545 | MIT | © 2017 Edward Shen |
| [MMM-page-indicator](https://github.com/edward-shen/MMM-page-indicator) | commit c431bb9 | MIT | © 2017 Edward Shen |
| [MMM-SmartTouch](https://github.com/EbenKouao/MMM-SmartTouch) | commit 2e8ce83 | MIT | © SmartBuilds.io, Inc. and its affiliates |
| [MMM-Keyboard](https://github.com/JHWelch/MMM-Keyboard) | commit 283c008 | MIT | © 2026 Jordan Welch |
| [MMM-MyGCalendar](https://github.com/johnster000/MMM-MyGCalendar) | commit 4d118c6 | MIT | © 2025 johnster000 |
| [MMM-TodoList](https://github.com/tomoki13/MMM-TodoList) | commit ba98002 | MIT | © 2025 tomoki13 |
| [MMM-MyScoreboard](https://github.com/dathbe/MMM-MyScoreboard) | commit 6318b28 | MIT | © dathbe |
| [yt-cast-receiver](https://github.com/patrickkfkan/yt-cast-receiver) (npm dependency of MMM-YouTubeCast) | commit 83d61fa | MIT | patrickkfkan |
| [qrcode](https://www.npmjs.com/package/qrcode) (npm dependency of MMM-GuestNet) | 1.5.4 | MIT | Ryan Day |
| [globe.gl](https://github.com/vasturiano/globe.gl) and three-globe (fetched by `scripts/fetch-globe-assets.sh`, licenses copied next to them) | see script | MIT | Vasco Asturiano |

## Patches in `patches/`

`patches/*.patch` modify MMM-TodoList, MMM-MyGCalendar, MMM-MyScoreboard and
MMM-SmartTouch after checkout. The patches contain parts of those modules'
original code and are distributed under each module's MIT license, with the
copyright notices above.

## Included in this repository

| Item | License |
|---|---|
| Literata font (`config/fonts/`) | SIL Open Font License 1.1, © 2017 The Literata Project Authors. Full text: `config/fonts/OFL-Literata.txt` |

## Services used at runtime

Google Maps Platform (Weather, Air Quality, Geocoding, Geolocation, Time Zone,
Maps JavaScript 3D maps), ESPN's public scoreboard and game summary feeds,
Google News RSS search, Wikipedia and Wikidata. Their terms of service apply to
your use; the ESPN and Google News feeds are unofficial and may change.
