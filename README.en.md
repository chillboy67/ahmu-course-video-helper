# AHMU Course Video Helper

[中文](README.md) | English

A Tampermonkey userscript that helps manage course video playback and check viewing progress on the Anhui Medical University learning platform.

[Install from Greasy Fork](https://greasyfork.org/en/scripts/604904)

## Features

- Supports course pages on the university learning platform and its WebVPN.
- Mutes course videos and offers playback speeds of 1×, 1.25×, 1.5× and 2×.
- Assists with background playback and warns about or attempts to recover from playback problems.
- Reloads after a video finishes to check for unwatched segments displayed by the platform; can replay from near an unwatched segment through to the end.
- When activity state can be confirmed, attempts to find unfinished videos and move to the next video, skipping tests.

## Development history

This project began with a problem encountered while using the course platform: videos played, but yellow unwatched segments remained after playback finished. Investigation showed that the media playback state, the page's play button state, and the viewing segments recorded by the platform were not always consistent. The helper gradually gained playback-state checks, warnings, rewinding and replay, and a post-playback reload to check the recorded segments.

Based on subsequent feedback, the helper gained replay from approximately 30 seconds before an estimated yellow segment through the end of the video, followed by another progress check. Muting, playback speed controls, unfinished-video discovery, attempts to skip tests when moving to the next video, and WebVPN support were also added. This version focuses on videos; users handle tests themselves.

## Known limitations

- **On macOS, do not minimize the browser using the yellow window button.** In observed use, minimizing Edge paused the video. Leave the browser window unminimized; you can switch to other applications and leave it in the background, but check playback and platform progress.
- Playing a video does not guarantee that the platform records the entire session. Background scheduling, network conditions and platform state can affect the result; check the platform's actual progress.
- Yellow segment positions are estimated from progress-bar geometry and may be inaccurate. Recheck progress after replay.
- Finding unfinished videos and switching to the next video depend on page structure and course data and may not work for every course.

## Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/) in Microsoft Edge or another compatible browser.
2. Open the [Greasy Fork script page](https://greasyfork.org/en/scripts/604904) and install the script.
3. If required by your browser, follow Tampermonkey's instructions to allow userscripts.
4. Open a course page, choose a playback speed and select “开始” (Start) in the video helper.

Behavior depends on the platform's page structure and course settings; not all courses have been tested. To replay an unwatched segment, stop the helper first and then select “补看黄色区段”.

## Privacy and scope

The script does not include quiz answering or paid features, user accounts, or API keys. It uses browser storage for the selected playback speed, course running state, and information needed to recheck progress after a reload. Course page URLs and activity identifiers are used for runtime checks. The script itself does not contain functionality to send data to third-party services.

## License

This project is licensed under the [GNU Affero General Public License v3.0 or later](LICENSE); the userscript metadata declares `AGPL-3.0-or-later`.

This is an independently developed userscript, not an official Anhui Medical University product.
