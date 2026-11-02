import { quote } from './central.js'

// Buttons store action ids and options: those of the actions from version 1.0 must not change.
// Actions marked "central control" use Kommander's text protocol (central.js), the others its WebSocket API

// Version 1.0 listed 32 plans, groups and timelines. The lists now go as far as the open project needs, at least 32;
// the actions also take any number typed in
const COUNT = 32
const NUMBER_REGEX = '/^\\d+$/'

export function planCount(planGroups) {
	return Math.max(COUNT, ...planGroups.map((group) => group.data?.length ?? 0))
}

export function groupCount(planGroups) {
	return Math.max(COUNT, planGroups.length)
}

export function groupLabel(planGroups, index) {
	const name = planGroups[index]?.name
	return name ? `Group ${index + 1}: ${name}` : `Group ${index + 1}`
}

const choice = (id, label) => ({ id, label })
const TOGGLE_CHOICES = (on, off) => [
	choice(on.toLowerCase(), on),
	choice(off.toLowerCase(), off),
	choice('toggle', 'Toggle'),
]
// Kommander's word for toggle in the text protocol
const switchWord = (mode) => (mode === 'toggle' ? 'switch' : mode)
const AFTER_CHOICES = [choice('play', 'Play'), choice('pause', 'Pause'), choice('continue', 'Keep as it was')]

const groupOption = {
	id: 'group',
	type: 'textinput',
	label: 'Group: name or number (empty: the current group)',
	default: '',
	useVariables: true,
}
const fileOptions = [
	{
		id: 'by',
		type: 'dropdown',
		label: 'Find the file by',
		choices: [choice('name', 'Name'), choice('window', 'Window number')],
		default: 'name',
	},
	{
		id: 'file',
		type: 'textinput',
		label: 'File name or window number',
		tooltip: "The window number is the one before the file's name in Kommander's playback progress window",
		default: '',
		useVariables: true,
	},
]

// Group of a plan call: a number is a position, other text a name, nothing the current group
async function groupArgument(options, context) {
	const group = (await context.parseVariablesInString(options.group)).trim()
	if (!group) return '-currentGroup'
	return /^\d+$/.test(group) ? `-groupIndex ${group}` : `-groupName ${quote(group)}`
}

// File on air by name or by window number. Kommander 8.2 takes -winid only in lowercase ("args error" otherwise),
// although some examples of its documentation write -winId
async function fileArgument(options, context) {
	const file = (await context.parseVariablesInString(options.file)).trim()
	return options.by === 'window' ? `-winid ${parseInt(file, 10)}` : `-name ${quote(file)}`
}

export function getActionDefinitions(self) {
	const planChoices = [choice('PreviousPlan', 'Previous plan'), choice('NextPlan', 'Next plan')]
	const groupChoices = [choice('pre', 'Previous group'), choice('next', 'Next group')]
	const timelineChoices = []
	for (let i = 1; i <= planCount(self.planGroups); i++) planChoices.push(choice(i, `Plan ${i}`))
	for (let i = 1; i <= groupCount(self.planGroups); i++)
		groupChoices.push(choice(i, groupLabel(self.planGroups, i - 1)))
	for (let i = 1; i <= COUNT; i++) timelineChoices.push(choice(i, `Timeline ${i}`))
	// a list of numbers that also takes any number typed in (which comes as text)
	const numberDropdown = (id, label, choices, defaultValue) => ({
		id,
		type: 'dropdown',
		label,
		tooltip: 'Not in the list? Type its number',
		choices,
		default: defaultValue,
		allowCustom: true,
		regex: NUMBER_REGEX,
	})
	const keyChoices = [...'1234567890'].map((digit) => choice(digit, digit))
	const planNameChoices = [choice('PlanGroupList_PlanList', '(choose a plan)')]
	for (const group of self.planGroups) {
		for (const plan of group.data ?? [])
			planNameChoices.push(choice(`${group.name}@@${plan.name}`, `${group.name} / ${plan.name}`))
	}
	const mediaOption = (label, choices) => ({
		id: 'media',
		type: 'dropdown',
		label,
		tooltip: 'Its id in the media library (shown when hovering it in Kommander). Type the id if it is not listed',
		choices,
		default: choices[0]?.id ?? '',
		allowCustom: true,
	})

	return {
		callPlan: {
			name: 'CallPlan',
			description: 'A plan of the current group, or the previous/next plan. In preview mode it goes to the preview',
			options: [numberDropdown('callPlan', 'Plan', planChoices, 'PreviousPlan')],
			callback: ({ options }) => {
				if (Number(options.callPlan) > 0) {
					self.send('IndexInvokePrePlan', { index: Number(options.callPlan) - 1, onlySetReal: true })
				} else if (['PreviousPlan', 'NextPlan'].includes(options.callPlan)) {
					self.send('PrePlanNextOrPre', { next: options.callPlan === 'NextPlan' })
				}
			},
		},
		planKeypad: {
			name: 'Plan keypad: type',
			description:
				'Type the number of a plan of the current group, digit by digit, to call it with "Plan keypad: call"',
			options: [
				{
					id: 'key',
					type: 'dropdown',
					label: 'Key',
					choices: [...keyChoices, choice('back', 'Delete the last digit'), choice('clear', 'Clear')],
					default: '1',
				},
			],
			callback: ({ options }) => self.typePlanKey(options.key),
		},
		planKeypadCall: {
			name: 'Plan keypad: call',
			description: 'Call the plan typed on the keypad, in the current group. In preview mode it goes to the preview',
			options: [],
			callback: () => self.callTypedPlan(),
		},
		CallByName: {
			name: 'CallByName',
			description: 'A plan by its group and name. In preview mode it goes to the preview',
			options: [
				{
					id: 'CallByName',
					type: 'dropdown',
					label: 'Plan',
					choices: planNameChoices,
					default: 'PlanGroupList_PlanList',
				},
			],
			callback: ({ options }) => {
				if (options.CallByName === 'PlanGroupList_PlanList') return
				self.send('ChangePlanGroupCallByName', { select: options.CallByName })
			},
		},
		planCall: {
			name: 'Call plan and play/pause',
			description: 'A plan by name or number, of any group, then play, pause or keep the play state (central control)',
			options: [
				groupOption,
				{ id: 'plan', type: 'textinput', label: 'Plan: name or number in its group', default: '1', useVariables: true },
				{ id: 'after', type: 'dropdown', label: 'Then', choices: AFTER_CHOICES, default: 'play' },
			],
			callback: async ({ options }, context) => {
				const plan = (await context.parseVariablesInString(options.plan)).trim()
				const planArgument = /^\d+$/.test(plan) ? `-index ${plan}` : `-name ${quote(plan)}`
				self.sendCentral(
					`ProgramInvoke ${await groupArgument(options, context)} ${planArgument} -status ${options.after}`,
				)
			},
		},
		randomPlan: {
			name: 'Call a random plan',
			description: 'A random plan of a group (central control)',
			options: [groupOption, { id: 'after', type: 'dropdown', label: 'Then', choices: AFTER_CHOICES, default: 'play' }],
			callback: async ({ options }, context) =>
				self.sendCentral(`ProgramInvoke ${await groupArgument(options, context)} -random -status ${options.after}`),
		},
		mainKv: {
			name: 'Call main KV plan',
			description: "One of the main KV buttons of Kommander's global control (central control)",
			options: [
				{
					id: 'kv',
					type: 'dropdown',
					label: 'Main KV',
					choices: [choice(1, 'KV 1'), choice(2, 'KV 2'), choice(3, 'KV 3')],
					default: 1,
				},
			],
			callback: ({ options }) => self.sendCentral(`ProgramInvoke -kv -index ${options.kv}`),
		},
		ChangePlanGroup: {
			name: 'ChangePlanGroup',
			description: 'Select the group whose plans the plan numbers call',
			options: [numberDropdown('changePlanGroup', 'Group', groupChoices, 'next')],
			callback: ({ options }) => {
				if (Number(options.changePlanGroup) > 0) {
					self.send('SwitchPlanPreGroup', { index: Number(options.changePlanGroup) - 1 })
				} else if (['pre', 'next'].includes(options.changePlanGroup)) {
					self.send('SwitchPlanPreGroup', { type: options.changePlanGroup })
				}
			},
		},
		previewMode: {
			name: 'Preview mode (PVW)',
			description: 'In preview mode, plans are called to the preview and go on air with Take',
			options: [
				{
					id: 'mode',
					type: 'dropdown',
					label: 'Preview mode',
					choices: TOGGLE_CHOICES('On', 'Off'),
					default: 'toggle',
				},
			],
			callback: ({ options }) => {
				const on = options.mode === 'toggle' ? self.realMode !== false : options.mode === 'on'
				self.send('SetPretidingMode', { realMode: !on })
			},
		},
		take: {
			name: 'Take (preview to air)',
			description: 'Put the plan in preview on air',
			options: [],
			callback: () => self.send('OutPutToEchoWindow'),
		},
		copyToPreview: {
			name: 'Copy air to preview',
			description: 'Copy what is on air to the preview, to adjust it there',
			options: [],
			callback: () => self.send('CopyOutPutToEdit'),
		},
		ChangePlayStatus: {
			name: 'ChangePlayStatus',
			options: [
				{
					id: 'changePlayStatus',
					type: 'dropdown',
					label: 'Play status',
					choices: [choice('Play', 'Play'), choice('Pause', 'Pause'), choice('Stop', 'Stop')],
					default: 'Play',
				},
			],
			callback: ({ options }) => self.send(options.changePlayStatus, { onlySetReal: true }),
		},
		replay: {
			name: 'Replay / first frame',
			description: 'Play everything again from the start, or go back to the first frame (central control)',
			options: [
				{
					id: 'mode',
					type: 'dropdown',
					label: 'Playback',
					choices: [choice('replay', 'Replay'), choice('firstframe', 'First frame')],
					default: 'replay',
				},
			],
			callback: ({ options }) => self.sendCentral(`GlobalSet -playstatus ${options.mode}`),
		},
		CallTimeline: {
			name: 'CallTimeline',
			description: 'For timeline projects',
			options: [
				numberDropdown('CallTimeline', 'Timeline', timelineChoices, 1),
				{
					id: 'CallTimelineStatus',
					type: 'dropdown',
					label: 'Status',
					choices: [choice(1, 'Toggle'), choice(2, 'Play'), choice(3, 'Pause'), choice(4, 'Stop')],
					default: 1,
				},
			],
			callback: ({ options }) =>
				self.send('CallTimeline', { index: Number(options.CallTimeline), status: options.CallTimelineStatus }),
		},
		timelineByName: {
			name: 'Timeline by name',
			description: 'Play, pause or stop a timeline by its name (timeline projects, central control)',
			options: [
				{ id: 'name', type: 'textinput', label: 'Timeline name', default: '', useVariables: true },
				{
					id: 'status',
					type: 'dropdown',
					label: 'Status',
					choices: [
						choice('play', 'Play'),
						choice('pause', 'Pause'),
						choice('stop', 'Stop'),
						choice('toggle', 'Toggle'),
					],
					default: 'toggle',
				},
			],
			callback: async ({ options }, context) => {
				const name = await context.parseVariablesInString(options.name)
				self.sendCentral(`ProgramPlayControl -name ${quote(name)} -playstatus ${switchWord(options.status)}`)
			},
		},
		timelineSeek: {
			name: 'Timeline: go to',
			description: 'Go to a time of a timeline, or forward/back by some milliseconds (central control)',
			options: [
				{
					id: 'name',
					type: 'textinput',
					label: 'Timeline name (timeline projects; empty: what is on air)',
					default: '',
					useVariables: true,
				},
				{
					id: 'mode',
					type: 'dropdown',
					label: 'Go',
					choices: [choice('time', 'To a time'), choice('step', 'Forward/back (ms)')],
					default: 'time',
				},
				{
					id: 'value',
					type: 'textinput',
					label: 'Time (hh:mm:ss:ms) or milliseconds (negative: back)',
					default: '00:00:00:000',
					useVariables: true,
				},
			],
			callback: async ({ options }, context) => {
				const name = (await context.parseVariablesInString(options.name)).trim()
				const value = (await context.parseVariablesInString(options.value)).trim()
				const target = name ? ` -name ${quote(name)}` : ''
				self.sendCentral(`ProgramSeek${target} -${options.mode === 'step' ? 'step' : 'value'} ${value}`)
			},
		},
		standby: {
			name: 'Standby',
			description: 'Standby on or off (timeline projects, central control)',
			options: [
				{
					id: 'mode',
					type: 'dropdown',
					label: 'Standby',
					choices: [choice('on', 'On'), choice('off', 'Off')],
					default: 'on',
				},
			],
			callback: ({ options }) => self.sendCentral(`GlobalSet -standby ${options.mode}`),
		},
		SoundControl: {
			name: 'SoundControl',
			options: [
				{
					id: 'soundControl',
					type: 'dropdown',
					label: 'Sound',
					choices: [choice(0, 'Mute/Unmute'), choice(-1, 'Volume+'), choice(-2, 'Volume-')],
					default: -1,
				},
			],
			callback: ({ options }) => {
				if (options.soundControl === 0) self.send('Mute')
				else self.send('Volume', { volume: options.soundControl })
			},
		},
		muteSet: {
			name: 'Mute on/off',
			description: 'Mute, unmute or toggle the audio (central control)',
			options: [{ id: 'mode', type: 'dropdown', label: 'Audio', choices: TOGGLE_CHOICES('On', 'Off'), default: 'on' }],
			callback: ({ options }) => self.sendCentral(`GlobalSet -mute ${switchWord(options.mode)}`),
		},
		SetVolumeValue: {
			name: 'SetVolumeValue',
			options: [{ id: 'SetVolumeValue', type: 'number', label: 'Volume', default: 100, min: 0, max: 100 }],
			callback: ({ options }) => self.send('Volume', { volume: options.SetVolumeValue }),
		},
		filePlay: {
			name: 'File: play/pause',
			description: 'Play, pause or stop one file on air (central control)',
			options: [
				...fileOptions,
				{
					id: 'status',
					type: 'dropdown',
					label: 'Status',
					choices: [
						choice('play', 'Play'),
						choice('pause', 'Pause'),
						choice('stop', 'Stop'),
						choice('toggle', 'Toggle'),
					],
					default: 'toggle',
				},
			],
			callback: async ({ options }, context) =>
				self.sendCentral(
					`FilePlayControl ${await fileArgument(options, context)} -status ${switchWord(options.status)}`,
				),
		},
		fileSeek: {
			name: 'File: go to',
			description: 'Go to a point of one file on air (central control)',
			options: [
				...fileOptions,
				{
					id: 'mode',
					type: 'dropdown',
					label: 'Go',
					choices: [
						choice('time', 'To a time (hh:mm:ss:ms)'),
						choice('step', 'Forward/back (ms)'),
						choice('percent', 'To a percentage'),
						choice('percentStep', 'Forward/back (percent)'),
					],
					default: 'time',
				},
				{
					id: 'value',
					type: 'textinput',
					label: 'Time, milliseconds or percent (negative: back)',
					default: '00:00:00:000',
					useVariables: true,
				},
				{ id: 'after', type: 'dropdown', label: 'Then', choices: AFTER_CHOICES, default: 'continue' },
			],
			callback: async ({ options }, context) => {
				const value = (await context.parseVariablesInString(options.value)).trim()
				const how = {
					time: `-value ${quote(value)}`,
					step: `-step ${value}`,
					percent: `-percent -value ${value}`,
					percentStep: `-percent -step ${value}`,
				}[options.mode]
				self.sendCentral(`FileSeek ${await fileArgument(options, context)} ${how} -status ${options.after}`)
			},
		},
		fileSpeed: {
			name: 'File: speed',
			description: 'Playback speed of one file on air, from 0.1 to 4 (central control)',
			options: [
				...fileOptions,
				{
					id: 'mode',
					type: 'dropdown',
					label: 'Speed',
					choices: [choice('value', 'Set to'), choice('step', 'Change by')],
					default: 'value',
				},
				{ id: 'value', type: 'number', label: 'Speed', default: 1, min: -4, max: 4, step: 0.1 },
			],
			callback: async ({ options }, context) =>
				self.sendCentral(
					`FilePlayControl ${await fileArgument(options, context)} -multiple -${options.mode} ${options.value}`,
				),
		},
		fileMute: {
			name: 'File: mute',
			description: 'Mute, unmute or toggle the audio of one file on air (central control)',
			options: [
				...fileOptions,
				{ id: 'mode', type: 'dropdown', label: 'Audio', choices: TOGGLE_CHOICES('Mute', 'Unmute'), default: 'toggle' },
			],
			callback: async ({ options }, context) => {
				const mute = { mute: 'on', unmute: 'off', toggle: 'switch' }[options.mode]
				self.sendCentral(`FileVolumeControl ${await fileArgument(options, context)} -mute ${mute}`)
			},
		},
		fileVolume: {
			name: 'File: volume',
			description: 'Volume of one file on air (central control)',
			options: [
				...fileOptions,
				{
					id: 'mode',
					type: 'dropdown',
					label: 'Volume',
					choices: [choice('value', 'Set to'), choice('step', 'Change by')],
					default: 'value',
				},
				{
					id: 'volume',
					type: 'number',
					label: 'Volume (0 to 100, or -100 to 100 to change by)',
					default: 100,
					min: -100,
					max: 100,
				},
			],
			callback: async ({ options }, context) =>
				self.sendCentral(
					`FileVolumeControl ${await fileArgument(options, context)} -${options.mode} ${options.volume}`,
				),
		},
		filePage: {
			name: 'File: page',
			description: 'Previous, next or a given page of one presentation or document on air (central control)',
			options: [
				...fileOptions,
				{
					id: 'mode',
					type: 'dropdown',
					label: 'Page',
					choices: [choice('previous', 'Previous'), choice('next', 'Next'), choice('page', 'Page number')],
					default: 'next',
				},
				{ id: 'page', type: 'number', label: 'Page number', default: 1, min: 1, max: 9999 },
			],
			callback: async ({ options }, context) => {
				const how = options.mode === 'page' ? `-value ${options.page}` : `-${options.mode}`
				self.sendCentral(`FileTurnPage ${await fileArgument(options, context)} ${how}`)
			},
		},
		fileReplace: {
			name: 'File: replace',
			description: 'Replace one file on air with another file of the media library (central control)',
			options: [
				...fileOptions,
				{
					id: 'source',
					type: 'textinput',
					label: 'New file: its id or its name in the media library',
					default: '',
					useVariables: true,
				},
			],
			callback: async ({ options }, context) => {
				const source = (await context.parseVariablesInString(options.source)).trim()
				const sourceArgument = /^\d+$/.test(source) ? `-srcid ${source}` : `-srcname ${quote(source)}`
				self.sendCentral(`WindowReplace ${await fileArgument(options, context)} ${sourceArgument}`)
			},
		},
		subtitleText: {
			name: 'Subtitle text',
			description: 'Change the text of a subtitle of the media library (central control)',
			options: [
				mediaOption('Subtitle', self.subtitleChoices),
				{ id: 'text', type: 'textinput', label: 'Text', default: '', useVariables: true },
			],
			callback: async ({ options }, context) => {
				const text = await context.parseVariablesInString(options.text)
				self.sendCentral(`MediaSet -id ${Number(options.media)} -text ${quote(text)}`)
			},
		},
		webPageAddress: {
			name: 'Web page address',
			description: 'Change the address of a web page of the media library (central control)',
			options: [
				mediaOption('Web page', self.webPageChoices),
				{ id: 'url', type: 'textinput', label: 'Address', default: 'https://', useVariables: true },
			],
			callback: async ({ options }, context) => {
				const url = await context.parseVariablesInString(options.url)
				self.sendCentral(`MediaSet -id ${Number(options.media)} -url ${quote(url)}`)
			},
		},
		ScreenOnOff: {
			name: 'Screen On/Off',
			description: 'Black screen on/off',
			options: [],
			callback: () => self.send('UpdateBlackScreen'),
		},
		blackScreenSet: {
			name: 'Black screen on/off',
			description: 'Turn the black screen on or off (central control)',
			options: [
				{
					id: 'mode',
					type: 'dropdown',
					label: 'Black screen',
					choices: [choice('on', 'On'), choice('off', 'Off')],
					default: 'on',
				},
			],
			callback: ({ options }) => self.sendCentral(`GlobalSet -blackscreen ${options.mode}`),
		},
		OutputOnOff: {
			name: 'Output On/Off',
			options: [
				{
					id: 'outputOnOff',
					type: 'dropdown',
					label: 'Outputs',
					choices: [choice(0, 'Off'), choice(1, 'On'), choice(2, 'Toggle')],
					default: 1,
				},
			],
			// version 1.0 stored its default as '1'
			callback: ({ options }) => {
				const value = Number(options.outputOnOff)
				self.send('EnableAllMonitor', { bOpen: value === 2 ? self.monitorStatus !== 1 : value === 1 })
			},
		},
		BrightContrast: {
			name: 'Bright&Contrast',
			options: [
				{
					id: 'brightContrast',
					type: 'dropdown',
					label: 'Step',
					choices: [
						choice('Brightness+', 'Brightness+'),
						choice('Brightness-', 'Brightness-'),
						choice('Contrast+', 'Contrast+'),
						choice('Contrast-', 'Contrast-'),
					],
					default: 'Brightness+',
				},
			],
			callback: ({ options }) => {
				// -101 and -102 are Kommander's step up and step down
				const step = options.brightContrast.endsWith('+') ? -101 : -102
				if (options.brightContrast.startsWith('Brightness')) self.send('SetScreenLight', { light: step })
				else self.send('SetScreenContrast', { contrast: step })
			},
		},
		SetBrightValue: {
			name: 'SetBrightValue',
			options: [{ id: 'SetBrightValue', type: 'number', label: 'Brightness', default: 0, min: -100, max: 100 }],
			callback: ({ options }) => self.send('SetScreenLight', { light: options.SetBrightValue }),
		},
		SetContrastValue: {
			name: 'SetContrastValue',
			options: [{ id: 'SetContrastValue', type: 'number', label: 'Contrast', default: 0, min: -100, max: 100 }],
			callback: ({ options }) => self.send('SetScreenContrast', { contrast: options.SetContrastValue }),
		},
		PageTurn: {
			name: 'PageTurn',
			description: 'Previous/next page of the presentations on air',
			options: [
				{
					id: 'pageTurn',
					type: 'dropdown',
					label: 'Page',
					choices: [choice('PrevPage', 'PageUP'), choice('NextPage', 'PageDown')],
					default: 'NextPage',
				},
			],
			callback: ({ options }) => self.send(options.pageTurn, { isGlobalTurnPage: true, onlySetReal: true }),
		},
		turnPage: {
			name: 'Turn page',
			description:
				'Previous, next or a given page of the documents, image sequences, teleprompters or web pages on air (central control)',
			options: [
				{
					id: 'type',
					type: 'dropdown',
					label: 'Of',
					choices: [
						choice('all', 'Everything'),
						choice('office', 'Documents and presentations'),
						choice('soframes', 'Image sequences turned by hand'),
						choice('teleprompter', 'Teleprompters'),
						choice('browser', 'Web pages'),
					],
					default: 'all',
				},
				{
					id: 'mode',
					type: 'dropdown',
					label: 'Page',
					choices: [choice('previous', 'Previous'), choice('next', 'Next'), choice('page', 'Page or line number')],
					default: 'next',
				},
				{ id: 'page', type: 'number', label: 'Page or line number', default: 1, min: 1, max: 99999 },
				{
					id: 'program',
					type: 'textinput',
					label: 'Only in this timeline (timeline projects; empty: all)',
					default: '',
					useVariables: true,
				},
			],
			callback: async ({ options }, context) => {
				const program = (await context.parseVariablesInString(options.program)).trim()
				const how = options.mode === 'page' ? `-page ${options.page}` : `-${options.mode}`
				self.sendCentral(`ProgramTurnPage -type ${options.type} ${how}${program ? ` -name ${quote(program)}` : ''}`)
			},
		},
		record: {
			name: 'Record output',
			description: 'Record the output to an .mp4 file, which Kommander saves (by default on the Windows desktop)',
			options: [
				{
					id: 'mode',
					type: 'dropdown',
					label: 'Recording',
					choices: TOGGLE_CHOICES('Start', 'Stop'),
					default: 'toggle',
				},
			],
			callback: ({ options }) => {
				const start = options.mode === 'toggle' ? !self.recording : options.mode === 'start'
				self.send(start ? 'StartVideoRecord' : 'StopVideoRecord')
			},
		},
		schedule: {
			name: 'Task management on/off',
			description: "Turn Kommander's task management (scheduled tasks) on or off (central control)",
			options: [
				{
					id: 'mode',
					type: 'dropdown',
					label: 'Task management',
					choices: TOGGLE_CHOICES('On', 'Off'),
					default: 'toggle',
				},
			],
			callback: ({ options }) => self.sendCentral(`SetScheduleStates -status ${switchWord(options.mode)}`),
		},
		Lock: {
			name: 'Lock',
			description: 'Lock or unlock the Kommander window (the output keeps going)',
			options: [],
			callback: () => self.send('SetKommanderLock'),
		},
		lockSet: {
			name: 'Lock on/off',
			description: 'Lock or unlock the Kommander window (the output keeps going)',
			options: [
				{
					id: 'mode',
					type: 'dropdown',
					label: 'Lock',
					choices: [choice('on', 'Lock'), choice('off', 'Unlock')],
					default: 'on',
				},
			],
			// Kommander only has a toggle, and refuses central control while locked
			callback: ({ options }) => {
				if ((options.mode === 'on') !== Boolean(self.isLock)) self.send('SetKommanderLock')
			},
		},
		MasterSwitch: {
			name: 'Master Switch',
			description: 'Switch between the main and the backup Kommander (only with a backup set up in Online)',
			options: [],
			callback: () => self.send('RoleChange', { Switch: true }),
		},
	}
}
