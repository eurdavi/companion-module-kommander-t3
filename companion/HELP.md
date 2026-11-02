## Kommander Media Server

This module controls a Kommander media server (Kommander T0/T1/T3, F1/F1Pro/F2/F9 and PS-Series) over its two control interfaces: the WebSocket API (port 1702) and central control, Kommander's text protocol for control systems (port 5001).

### Configuration

- **Kommander URL**: `ws://<ip>:1702`, with the IP address of the Kommander computer (`ws://127.0.0.1:1702` when Companion runs on the same computer).
- **Username** and **Password**: a user of Kommander (**System Settings > Users**). The default, `streamDeck`, works without any setup.
- **Reconnect**: reconnect 5 seconds after a connection drops.
- **Log messages**: log every message to and from Kommander, for troubleshooting.
- **Central control** and **Central control port**: also connect to central control (port 5001 by default), for the actions marked "central control" below and for monitoring.

In Kommander, **System Settings > Connection** must have:

- **Enable Cloud Control/Third-Party Platform Access** checked. The number next to it is how many clients can connect at the same time: leave room for Companion and anything else that connects (2 or more).
- **Enable Central Control via Network** checked, for central control.

When Kommander refuses the login, for example with "Maximum connection number", the connection status shows the reason. When central control cannot connect, the status shows a warning and everything else keeps working. While Kommander is locked it refuses central control commands, so **Lock on/off** uses the WebSocket API.

### Preview (PVW) mode

Plan projects have a preview mode: while it is on, the plans you call go to the preview and **Take** puts the preview on air. The plan buttons of the presets show the plan in preview in green and the plan on air in red. Turn preview mode on and off from Companion (**Preview mode**) or from Kommander.

### Actions

Plans and groups. There is no limit on the number of plans: the lists of plan and group numbers go as far as the open project needs (at least 32), and you can also type any number in them.

- **CallPlan**: call a plan of the current group by its number, or the previous/next plan.
- **CallByName**: call a plan by its group and name.
- **Call plan and play/pause**: call a plan by name or number, of the current group or another one, then play, pause or keep the play state (central control). Variables work in the group and the plan.
- **Plan keypad: type** and **Plan keypad: call**: type the number of a plan of the current group digit by digit, then call it. Handy when there are more plans than buttons.
- **Call a random plan** of a group, and **Call main KV plan** 1–3 (central control).
- **ChangePlanGroup**: select a group by its number, or the previous/next group. Plan numbers call the plans of this group.
- **Preview mode (PVW)**, **Take (preview to air)** and **Copy air to preview**.

Playback and timelines:

- **ChangePlayStatus**: play, pause or stop. **Replay / first frame**: play again from the start, or go back to the first frame (central control).
- **CallTimeline**: toggle, play, pause or stop a timeline by its number. **Timeline by name** and **Timeline: go to** a time or forward/back (central control).
- **Standby** on or off (timeline projects, central control).

Files on air (central control), found by their name or by their window number in Kommander's playback progress window:

- **File: play/pause**, **File: go to** (a time, forward/back or a percentage), **File: speed** (0.1–4), **File: mute**, **File: volume**, **File: page** (previous, next or a page number) and **File: replace** (with another file of the media library).

Media (central control):

- **Subtitle text**: change the text of a subtitle of the media library. Variables work in the text.
- **Web page address**: change the address of a web page of the media library.

Screen, audio and system:

- **Screen On/Off** (black screen toggle) and **Black screen on/off** (central control).
- **Output On/Off**: turn all outputs on, off or toggle them.
- **Bright&Contrast**, **SetBrightValue** and **SetContrastValue**: brightness and contrast, by step or from -100 to 100.
- **SoundControl**, **SetVolumeValue** and **Mute on/off** (central control): volume and mute.
- **PageTurn**: previous/next page of the presentations on air. **Turn page**: previous, next or a page of the documents, image sequences, teleprompters or web pages on air (central control).
- **Record output**: start, stop or toggle recording the output to an .mp4 file, which Kommander saves (by default on the Windows desktop).
- **Task management on/off**: Kommander's scheduled tasks (central control).
- **Lock** and **Lock on/off**: lock or unlock the Kommander window. The output keeps going.
- **Master Switch**: switch between the main and the backup Kommander (only with a backup set up in Kommander's Online settings).

This module has no command to power off or restart Kommander or its computer.

### Feedbacks

- **CallPlan** / **CallByName**: the plan with this number or name is on air.
- **Plan in preview** / **Plan in preview (by name)**: in preview mode, the plan with this number or name is in the preview.
- **Preview mode**: Kommander is in preview mode.
- **PreGroup**: the group with this number is the current group.
- **PlayStatus**: Kommander is playing, paused or stopped (plan projects).
- **Muted**, **BlackScreen**, **MonitorStatus** (outputs on) and **Lock**.
- **Recording**: the output is being recorded (started from Companion).
- **Task management on** (central control).
- **Display problem**, **Output problem** and **Machine problem**: Kommander reports a problem with a display end, an output port or a machine of a multi-machine setup (central control; Kommander 8.2.99 and later).

### Variables

Use them as `$(<connection label>:<variable>)`, for example `$(kommander:plan_name)`.

| Variable                                     | Value                                                                |
| -------------------------------------------- | -------------------------------------------------------------------- |
| `plan_number`, `plan_name`                   | Plan on air                                                          |
| `group_number`, `group_name`                 | Current plan group                                                   |
| `preview_mode`                               | `true` in preview mode                                               |
| `preview_plan_number`, `preview_plan_name`   | Plan in preview                                                      |
| `preview_group_number`, `preview_group_name` | Group of the plan in preview                                         |
| `keypad_plan`, `keypad_plan_name`            | Plan number typed on the plan keypad, and its name                   |
| `play_status`                                | `Play`, `Pause` or `Stop`                                            |
| `video_name`                                 | Video playing (the one with the most time left, if several)          |
| `video_elapsed`, `video_remaining`           | Elapsed time and time left of that video (mm:ss)                     |
| `video_remaining_seconds`                    | Time left in seconds, for triggers and expressions                   |
| `video_duration`                             | Duration of the video (mm:ss)                                        |
| `volume`, `mute`                             | Volume (0–100) and `true` when muted                                 |
| `brightness`, `contrast`                     | Output brightness and contrast (-100 to 100)                         |
| `blackscreen`, `output`, `lock`              | `true` when the black screen is on, the outputs are on, it is locked |
| `recording`, `record_time`                   | Recording started from Companion, and its time (mm:ss)               |
| `project_type`                               | `Plan` or `Timeline`                                                 |
| `timeline_name`, `timeline_progress`         | Timeline playing (or the first one open) and its progress            |
| `timeline_status`                            | `play`, `pause` or `stop`                                            |
| `display_status`, `output_ports_status`      | `normal` or `abnormal`                                               |
| `devices_count`, `devices_problems`          | Machines of a multi-machine setup, and those that are not normal     |
| `schedule`                                   | `true` when task management is on                                    |
| `central_control`                            | `true` when central control is connected                             |

`volume` and `mute` come from central control when it connects; without it, Kommander only tells them when they change. The timeline, display, output and machine variables need central control (Kommander 8.2.99 and later; the heartbeat behind the first three needs 8.2.100).

### Presets

- **Plans** and **Groups**: plans and groups by number, as many as the open project has (at least 32). A plan is green while in preview and red while on air, and a group is blue while it is the current group.
- **Plans: _group name_** and **Groups by name**: one button for each plan and group of the open project, named after them. They follow the project: plans you add or rename in Kommander show up by themselves.
- **Plan keypad**: digits 0–9, delete, clear, and a call button that shows the number typed and the name of that plan.
- **Navigation**: previous/next plan and group, a random plan and main KV 1–3.
- **Preview (PVW)**: preview mode, Take, copy air to preview and the plan in preview.
- **Playback**, **Screen**, **Audio**, **System** and **Presentation** (with teleprompter previous/next): one button for each action, with its feedback where there is one.
- **Recording**: record on/off, with the recording time.
- **Timeline**: play/pause of timelines 1–32 (CallTimeline takes any number), and standby on/off.
- **Monitoring**: display ends, output ports and machines, red on a problem, and task management on/off.
- **Status**: the plan on air, the current group, the play status, the time left of the video, the volume and the timeline progress.
