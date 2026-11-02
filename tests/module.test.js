// Runs the module against a fake Kommander. The messages are the ones Kommander 360 8.2 sends and accepts
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { describe, it } from 'node:test'

register('./hooks.js', import.meta.url)
await import('../main.js')
const { default: FakeWebSocket } = await import('./mocks/ws.js')
const { FakeSocket } = await import('./mocks/net.js')
const { ANSWER_TIMEOUT, failureReason, MessageReader, parseLine, quote, READ_DELAY } = await import('../central.js')
const { instanceClass, upgradeScripts } = globalThis.kommander

const CONFIG = { url: 'ws://127.0.0.1:1702', reconnect: false }
const MEDIA_LIBS = [
	{ MediaGroup: 'Local', MediaGrouptype: 2048, data: [{ name: 'clip.mp4', type: 1 }] },
	{
		MediaGroup: 'Play plan',
		MediaGrouptype: 8,
		data: [
			{
				name: 'Abertura',
				isGroup: true,
				data: [
					{ id: '{vinheta}', name: 'Vinheta' },
					{ id: '{palco}', name: 'Palco' },
				],
			},
			{ name: 'Show', isGroup: true, data: [{ id: '{musica}', name: 'Música 1' }] },
		],
	},
]
const VERSION_1_ACTIONS = [
	'callPlan',
	'ChangePlanGroup',
	'ChangePlayStatus',
	'SoundControl',
	'PageTurn',
	'ScreenOnOff',
	'BrightContrast',
	'OutputOnOff',
	'MasterSwitch',
	'Lock',
	'SetVolumeValue',
	'CallByName',
	'SetBrightValue',
	'SetContrastValue',
	'CallTimeline',
]
const VERSION_1_FEEDBACKS = [
	'callByName',
	'plan',
	'playStatus',
	'unmute',
	'blackscreen',
	'monitorStatus',
	'lock',
	'preGroup',
]

async function start(config = CONFIG) {
	const instance = new instanceClass()
	await instance.init(config)
	return { instance, ws: FakeWebSocket.latest }
}

// An instance past the login and the media library
async function connect(config) {
	const { instance, ws } = await start(config)
	ws.open()
	ws.receive('Authentication', { isNotTimeLine: true })
	ws.receive('GetMediaLibs', undefined, { MediaLibs: MEDIA_LIBS })
	return { instance, ws }
}

const press = (instance, actionId, options = {}) =>
	instance.actions[actionId].callback({ options }, { parseVariablesInString: async (text) => text })
const isOn = (instance, feedbackId, options = {}) => instance.feedbacks[feedbackId].callback({ options })

// Every preset must use existing actions and feedbacks, with options and values they accept, and only
// variables of this connection
function presetProblems(instance) {
	const problems = []
	const variableIds = new Set(instance.variableDefinitions.map((variable) => variable.variableId))
	const checkOptions = (where, definition, options) => {
		for (const [key, value] of Object.entries(options)) {
			const option = definition.options.find((o) => o.id === key)
			if (!option) problems.push(`${where}: no option ${key}`)
			else if (option.type === 'dropdown' && !option.choices.some((c) => c.id === value))
				problems.push(`${where}: ${key}=${JSON.stringify(value)} is not a choice`)
		}
	}
	for (const [id, preset] of Object.entries(instance.presets)) {
		if (!['auto', '14', '18'].includes(preset.style.size)) problems.push(`${id}: size ${preset.style.size}`)
		for (const action of preset.steps.flatMap((step) => step.down)) {
			const definition = instance.actions[action.actionId]
			if (definition) checkOptions(`${id} ${action.actionId}`, definition, action.options)
			else problems.push(`${id}: no action ${action.actionId}`)
		}
		for (const feedback of preset.feedbacks) {
			const definition = instance.feedbacks[feedback.feedbackId]
			if (definition) checkOptions(`${id} ${feedback.feedbackId}`, definition, feedback.options)
			else problems.push(`${id}: no feedback ${feedback.feedbackId}`)
		}
		for (const [, label, variable] of preset.style.text.matchAll(/\$\(([^:)]+):([^)]+)\)/g)) {
			if (label !== instance.label) problems.push(`${id}: label ${label}`)
			if (!variableIds.has(variable)) problems.push(`${id}: no variable ${variable}`)
		}
	}
	return problems
}

describe('before Kommander answers', () => {
	it('defines the actions and feedbacks of version 1.0 and the new ones', async () => {
		const { instance } = await start()
		for (const id of VERSION_1_ACTIONS) assert.ok(instance.actions[id], id)
		for (const id of VERSION_1_FEEDBACKS) assert.ok(instance.feedbacks[id], id)
		for (const id of ['previewMode', 'take', 'copyToPreview', 'fileMute', 'fileVolume', 'record']) {
			assert.ok(instance.actions[id], id)
		}
		for (const id of ['previewMode', 'previewPlan', 'previewByName', 'recording']) assert.ok(instance.feedbacks[id], id)
	})

	it('defines the central control actions and feedbacks, without power-off or restart commands', async () => {
		const { instance } = await start()
		const central = ['planCall', 'randomPlan', 'mainKv', 'replay', 'timelineByName', 'timelineSeek', 'standby']
		central.push('muteSet', 'filePlay', 'fileSeek', 'fileSpeed', 'filePage', 'fileReplace', 'subtitleText')
		central.push('webPageAddress', 'blackScreenSet', 'turnPage', 'schedule', 'lockSet')
		for (const id of central) assert.ok(instance.actions[id], id)
		for (const id of ['schedule', 'displayProblem', 'outputProblem', 'deviceProblem'])
			assert.ok(instance.feedbacks[id], id)
		const source = Object.values(instance.actions).map((action) => action.callback.toString())
		assert.ok(!source.some((code) => /PowerOffDevice|RestartDevice|RestartApp/.test(code)))
	})

	it('starts with empty variables, not $NA', async () => {
		const { instance } = await start()
		assert.equal(instance.variableDefinitions.length, 36)
		for (const { variableId } of instance.variableDefinitions) {
			assert.equal(instance.variables[variableId], variableId === 'central_control' ? false : '', variableId)
		}
	})

	it('has valid presets whose words fit on the buttons', async () => {
		const { instance } = await start()
		assert.deepEqual(presetProblems(instance), [])
		const size = (id) => instance.presets[id].style.size
		assert.deepEqual(['group_1', 'pause', 'output_on', 'contrast_up', 'status_plan'].map(size), [
			'18',
			'18',
			'14',
			'18',
			'14',
		])
	})

	it('sends nothing without a connection', async () => {
		const { instance, ws } = await start()
		await press(instance, 'take')
		assert.deepEqual(ws.sent, [])
		assert.ok(instance.logs.some(([level, message]) => level === 'warn' && message.includes('OutPutToEchoWindow')))
	})

	it('reports a bad URL', async () => {
		const { instance } = await start({ url: 'http://kommander', reconnect: false })
		assert.equal(instance.statuses.at(-1)[0], 'bad_config')
	})
})

describe('login', () => {
	it("logs in like Kommander's Stream Deck access, with a device id of its own", async () => {
		const { instance, ws } = await start()
		assert.deepEqual(ws.options, { origin: 'streamDeck' })
		ws.open()
		const login = ws.sent[0]
		assert.equal(login.KommanderMsg, 'KommanderMsg_Authentication')
		assert.equal(login.identificationID, '10')
		assert.equal(login.params.username, 'streamDeck')
		assert.equal(login.params.password, 'streamDeck')
		assert.match(login.params.deviceId, /^\d{6}$/)
		assert.equal(login.params.connetType, 5)
		assert.equal(instance.statuses.at(-1)[0], 'connecting', 'connecting until Kommander accepts the login')
		ws.receive('Authentication', { isNotTimeLine: true })
		assert.equal(instance.statuses.at(-1)[0], 'ok')
		assert.equal(instance.variables.project_type, 'Plan')
		assert.equal(ws.sentNames().at(-1), 'GetMediaLibs')
	})

	it('uses the login of the settings', async () => {
		const { ws } = await start({ ...CONFIG, username: 'operador', password: 'segredo' })
		ws.open()
		assert.equal(ws.sent[0].params.username, 'operador')
		assert.equal(ws.sent[0].params.password, 'segredo')
	})

	it('shows why Kommander refused the login', async () => {
		const { instance, ws } = await start()
		ws.open()
		ws.receive('Authentication', { error: 4, msg: 'Maximum connection number' }, { code: 0 })
		ws.emit('close', 1000)
		assert.deepEqual(instance.statuses.at(-1), [
			'connection_failure',
			'Kommander refused the login: Maximum connection number',
		])
	})

	it('asks for the current state once, after the media library', async () => {
		const { ws } = await connect()
		assert.deepEqual(ws.sentNames().slice(2), [
			'GetGlobalState',
			'GetAllMonitor',
			'GetBlackScreen',
			'GetKommanderLock',
			'GetPretidingMode',
			'GetScreenContrastLight',
			'GetPrePlanUsingMark',
		])
		ws.receive('GetMediaLibs', undefined, { MediaLibs: MEDIA_LIBS })
		assert.equal(ws.sentNames().filter((name) => name === 'GetGlobalState').length, 1)
	})
})

describe('plans', () => {
	it('lists the plans of the open project in presets and menus', async () => {
		const { instance } = await connect()
		const named = instance.presets.plan_named_0_1
		assert.equal(named.category, 'Plans: Abertura')
		assert.equal(named.style.text, 'Palco')
		assert.deepEqual(named.steps[0].down, [{ actionId: 'CallByName', options: { CallByName: 'Abertura@@Palco' } }])
		assert.equal(instance.presets.group_named_1.style.text, 'Show')
		const planNames = instance.actions.CallByName.options[0].choices
		assert.ok(planNames.some((c) => c.id === 'Show@@Música 1' && c.label === 'Show / Música 1'))
		assert.equal(instance.actions.ChangePlanGroup.options[0].choices.find((c) => c.id === 1).label, 'Group 1: Abertura')
		assert.equal(instance.feedbacks.preGroup.options[0].choices[1].label, 'Group 2: Show')
		assert.deepEqual(presetProblems(instance), [])
	})

	it('finds the plans on air and in preview from the ids of the reply to GetPrePlanUsingMark', async () => {
		const { instance, ws } = await connect()
		ws.receive('GetPretidingMode', { realMode: false })
		ws.receive('UpdatePrePlanUsingMark', { editingPrePlanId: '{musica}', outPutingPrePlanId: '{palco}' })
		const v = instance.variables
		assert.deepEqual([v.plan_number, v.plan_name, v.group_number, v.group_name], [2, 'Palco', 1, 'Abertura'])
		assert.deepEqual(
			[v.preview_plan_number, v.preview_plan_name, v.preview_group_number, v.preview_group_name],
			[1, 'Música 1', 2, 'Show'],
		)
		assert.equal(isOn(instance, 'plan', { plan: 1 }), true)
		assert.equal(isOn(instance, 'callByName', { groupName: 'Abertura', planName: 'Palco' }), true)
		assert.equal(isOn(instance, 'previewPlan', { plan: 0 }), true)
		assert.equal(isOn(instance, 'previewByName', { groupName: 'Show', planName: 'Música 1' }), true)
	})

	it("takes positions and names from Kommander's notice", async () => {
		const { instance, ws } = await connect()
		ws.receive('UpdatePrePlanUsingMark', {
			EditGroupName: 'Show',
			editingId: 0,
			editingPrePlanName: 'Música 1',
			nEditGroupId: 1,
			nOutGroupId: 0,
			outGroupName: 'Abertura',
			outPutingId: 0,
			outPutingPrePlanName: 'Vinheta',
		})
		assert.equal(instance.variables.plan_name, 'Vinheta')
		assert.equal(instance.variables.preview_plan_name, 'Música 1')
	})

	it('shows the preview tally only in preview mode', async () => {
		const { instance, ws } = await connect()
		ws.receive('UpdatePrePlanUsingMark', { editingPrePlanId: '{musica}', outPutingPrePlanId: '{palco}' })
		ws.receive('GetPretidingMode', { realMode: true })
		assert.equal(isOn(instance, 'previewPlan', { plan: 0 }), false)
		assert.equal(isOn(instance, 'previewMode'), false)
		assert.equal(instance.variables.preview_mode, false)
		ws.receive('SetPretidingMode', { realMode: false })
		assert.equal(isOn(instance, 'previewPlan', { plan: 0 }), true)
		assert.equal(isOn(instance, 'previewMode'), true)
		assert.equal(instance.variables.preview_mode, true)
	})

	it('keeps the group when the plan on air is not in the media library', async () => {
		const { instance, ws } = await connect()
		ws.receive('UpdatePrePlanUsingMark', { editingPrePlanId: '{palco}', outPutingPrePlanId: '{palco}' })
		ws.receive('UpdatePrePlanUsingMark', { editingPrePlanId: '{other}', outPutingPrePlanId: '{other}' })
		assert.equal(instance.variables.plan_number, '')
		assert.equal(instance.variables.plan_name, '')
		assert.equal(instance.variables.group_name, 'Abertura')
	})

	it('reloads the plans when Kommander says they changed, rebuilding the lists only if they did', async (t) => {
		t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
		const { instance, ws } = await connect()
		const actions = instance.actions
		ws.receive('MediaLibsChanged')
		ws.receive('MediaLibsChanged')
		t.mock.timers.tick(300)
		assert.deepEqual(ws.sentNames().slice(-2), ['GetMediaLibs', 'GetPrePlanUsingMark'])
		assert.equal(ws.sentNames().filter((name) => name === 'GetMediaLibs').length, 2, 'one reload for both notices')
		ws.receive('GetMediaLibs', undefined, { MediaLibs: MEDIA_LIBS })
		assert.equal(instance.actions, actions, 'same plans: same lists')
		const edited = structuredClone(MEDIA_LIBS)
		edited[1].data[1].data.push({ id: '{bis}', name: 'Bis' })
		ws.receive('GetMediaLibs', undefined, { MediaLibs: edited })
		assert.notEqual(instance.actions, actions)
		assert.equal(instance.presets.plan_named_1_1.style.text, 'Bis')
		await instance.destroy()
	})

	it('copes with a media library without plans (timeline projects)', async () => {
		const { instance, ws } = await start()
		ws.open()
		ws.receive('Authentication', { isNotTimeLine: false })
		ws.receive('GetMediaLibs', undefined, { MediaLibs: [{ MediaGroup: 'Local', MediaGrouptype: 2048, data: [] }] })
		assert.equal(instance.variables.project_type, 'Timeline')
		assert.ok(!Object.keys(instance.presets).some((id) => id.startsWith('plan_named')))
		assert.deepEqual(presetProblems(instance), [])
	})
})

describe('state', () => {
	it('follows the play status, audio, black screen, outputs, lock and group', async () => {
		const { instance, ws } = await connect()
		const v = instance.variables
		ws.receive('GetGlobalState', { state: 1 }, { code: 0 })
		assert.equal(v.play_status, 'Pause')
		assert.equal(isOn(instance, 'playStatus', { playStatus: 1 }), true)
		ws.receive('Mute', { mute: true })
		assert.equal(v.mute, true)
		assert.equal(isOn(instance, 'unmute'), true)
		ws.receive('GetBlackScreen', { blackscreen: true, blackscreenSwitching: false })
		assert.equal(v.blackscreen, true)
		ws.receive('UpdateBlackScreen', { blackscreen: false })
		assert.equal(isOn(instance, 'blackscreen'), false)
		ws.receive('GetAllMonitor', { state: 3 }, { code: 0 })
		assert.equal(v.output, false)
		assert.equal(isOn(instance, 'monitorStatus'), false)
		ws.receive('GetAllMonitor', { state: 1 })
		assert.equal(v.output, true)
		ws.receive('GetKommanderLock', { lock: true })
		assert.equal(isOn(instance, 'lock'), true)
		ws.receive('UpdateLockKommander', { lock: false })
		assert.equal(v.lock, false)
		ws.receive('SwitchPlanPreGroup', { index: 1 })
		assert.deepEqual([v.group_number, v.group_name], [2, 'Show'])
		assert.equal(isOn(instance, 'preGroup', { preGroup: 1 }), true)
	})

	it('shows volume, brightness and contrast', async () => {
		const { instance, ws } = await connect()
		ws.receive('Volume', { volume: 20 })
		ws.receive('GetScreenContrastLight', { contrast: 10, light: -5 })
		const v = instance.variables
		assert.deepEqual([v.volume, v.brightness, v.contrast], [20, -5, 10])
	})

	it('counts down the video that plays, asking for its position every second', async (t) => {
		t.mock.timers.enable({ apis: ['setInterval'] })
		const { instance, ws } = await connect()
		const v = instance.variables
		ws.receive('UpdateProgFilePlayState', { id: '{v}', curPos: 0, duration: 69751, state: 1 })
		ws.receive('UpdateProgFileList', [
			{ id: '{v}', name: 'clip.mp4', bMute: false, media: { type: 1 } },
			{ id: '{p}', name: 'logo.png', bMute: false, media: { type: 4 } },
		])
		ws.receive('UpdateProgFilePlayState', { id: '{p}', curPos: 0, duration: 60000, state: 1 })
		assert.deepEqual(
			[v.video_name, v.video_elapsed, v.video_remaining, v.video_remaining_seconds, v.video_duration],
			['clip.mp4', '00:00', '01:10', 70, '01:10'],
		)
		t.mock.timers.tick(1000)
		assert.deepEqual(ws.last('GetProgFilePlayState').params, { id: '{v}' })
		ws.receive('GetProgFilePlayState', { curPos: '19366', duration: '69751', state: 1 })
		assert.deepEqual([v.video_elapsed, v.video_remaining], ['00:19', '00:51'])
		ws.receive('UpdateProgFilePlayState', { id: '{v}', curPos: 20000, duration: 69751, state: 0 })
		const sent = ws.sent.length
		t.mock.timers.tick(3000)
		assert.equal(ws.sent.length, sent, 'paused: no more questions')
		assert.equal(v.video_remaining, '00:50')
		ws.receive('DeleteProgFile', { id: '{v}' })
		assert.equal(v.video_name, '')
		await instance.destroy()
	})
})

describe('actions', () => {
	it('send what Kommander expects', async () => {
		const { instance, ws } = await connect()
		const sent = async (actionId, options) => {
			await press(instance, actionId, options)
			return ws.sent.at(-1)
		}
		const msg = (name, params) =>
			params === undefined ? { KommanderMsg: `KommanderMsg_${name}` } : { KommanderMsg: `KommanderMsg_${name}`, params }
		assert.deepEqual(
			await sent('callPlan', { callPlan: 3 }),
			msg('IndexInvokePrePlan', { index: 2, onlySetReal: true }),
		)
		assert.deepEqual(await sent('callPlan', { callPlan: 'PreviousPlan' }), msg('PrePlanNextOrPre', { next: false }))
		assert.deepEqual(await sent('ChangePlanGroup', { changePlanGroup: 4 }), msg('SwitchPlanPreGroup', { index: 3 }))
		assert.deepEqual(
			await sent('ChangePlanGroup', { changePlanGroup: 'next' }),
			msg('SwitchPlanPreGroup', { type: 'next' }),
		)
		assert.deepEqual(
			await sent('CallByName', { CallByName: 'Show@@Música 1' }),
			msg('ChangePlanGroupCallByName', { select: 'Show@@Música 1' }),
		)
		assert.deepEqual(await sent('ChangePlayStatus', { changePlayStatus: 'Pause' }), msg('Pause', { onlySetReal: true }))
		assert.deepEqual(await sent('SoundControl', { soundControl: 0 }), msg('Mute'))
		assert.deepEqual(await sent('SoundControl', { soundControl: -1 }), msg('Volume', { volume: -1 }))
		assert.deepEqual(await sent('SetVolumeValue', { SetVolumeValue: 40 }), msg('Volume', { volume: 40 }))
		assert.deepEqual(await sent('OutputOnOff', { outputOnOff: 0 }), msg('EnableAllMonitor', { bOpen: false }))
		assert.deepEqual(await sent('OutputOnOff', { outputOnOff: '1' }), msg('EnableAllMonitor', { bOpen: true }))
		assert.deepEqual(
			await sent('BrightContrast', { brightContrast: 'Contrast+' }),
			msg('SetScreenContrast', { contrast: -101 }),
		)
		assert.deepEqual(
			await sent('BrightContrast', { brightContrast: 'Brightness-' }),
			msg('SetScreenLight', { light: -102 }),
		)
		assert.deepEqual(await sent('SetBrightValue', { SetBrightValue: 0 }), msg('SetScreenLight', { light: 0 }))
		assert.deepEqual(await sent('SetContrastValue', { SetContrastValue: 5 }), msg('SetScreenContrast', { contrast: 5 }))
		assert.deepEqual(
			await sent('PageTurn', { pageTurn: 'NextPage' }),
			msg('NextPage', { isGlobalTurnPage: true, onlySetReal: true }),
		)
		assert.deepEqual(await sent('ScreenOnOff'), msg('UpdateBlackScreen'))
		assert.deepEqual(await sent('Lock'), msg('SetKommanderLock'))
		assert.deepEqual(await sent('MasterSwitch'), msg('RoleChange', { Switch: true }))
		assert.deepEqual(
			await sent('CallTimeline', { CallTimeline: 2, CallTimelineStatus: 1 }),
			msg('CallTimeline', { index: 2, status: 1 }),
		)
		assert.deepEqual(await sent('take'), msg('OutPutToEchoWindow'))
		assert.deepEqual(await sent('copyToPreview'), msg('CopyOutPutToEdit'))
	})

	it('calls any number of plans: the lists follow the project, and any number can be typed in', async () => {
		const { instance, ws } = await connect()
		const plans = Array.from({ length: 300 }, (_, i) => ({ id: `{p${i + 1}}`, name: `Cena ${i + 1}` }))
		const groups = Array.from({ length: 40 }, (_, g) => ({ name: `G${g + 1}`, isGroup: true, data: g ? [] : plans }))
		ws.receive('GetMediaLibs', undefined, {
			MediaLibs: [{ MediaGroup: 'Play plan', MediaGrouptype: 8, data: groups }],
		})
		assert.deepEqual(instance.actions.callPlan.options[0].choices.at(-1), { id: 300, label: 'Plan 300' })
		assert.equal(instance.actions.ChangePlanGroup.options[0].choices.at(-1).label, 'Group 40: G40')
		assert.equal(instance.feedbacks.plan.options[0].choices.length, 300)
		assert.equal(instance.feedbacks.preGroup.options[0].choices.length, 40)
		assert.ok(instance.presets.plan_300 && instance.presets.group_40 && instance.presets.plan_named_0_299)
		assert.deepEqual(presetProblems(instance), [])

		await press(instance, 'callPlan', { callPlan: 300 })
		assert.deepEqual(ws.last('IndexInvokePrePlan').params, { index: 299, onlySetReal: true })
		await press(instance, 'callPlan', { callPlan: '450' })
		assert.deepEqual(ws.last('IndexInvokePrePlan').params, { index: 449, onlySetReal: true })
		await press(instance, 'ChangePlanGroup', { changePlanGroup: '45' })
		assert.deepEqual(ws.last('SwitchPlanPreGroup').params, { index: 44 })
		await press(instance, 'CallTimeline', { CallTimeline: '40', CallTimelineStatus: 2 })
		assert.deepEqual(ws.last('CallTimeline').params, { index: 40, status: 2 })
		ws.receive('UpdatePrePlanUsingMark', { editingPrePlanId: '{p157}', outPutingPrePlanId: '{p157}' })
		assert.equal(instance.variables.plan_number, 157)
		assert.equal(isOn(instance, 'plan', { plan: 156 }), true)
	})

	it('calls the plan typed on the keypad, in the current group', async () => {
		const { instance, ws } = await connect()
		ws.receive('SwitchPlanPreGroup', { index: 0 })
		const type = async (...keys) => {
			for (const key of keys) await press(instance, 'planKeypad', { key })
		}
		await type('0', '1', '5', '7', '9', '3')
		assert.equal(instance.variables.keypad_plan, '1579', 'no leading zero, at most 4 digits')
		await type('back', 'back', 'back')
		assert.equal(instance.variables.keypad_plan, '1')
		await type('back', '2')
		assert.deepEqual([instance.variables.keypad_plan, instance.variables.keypad_plan_name], ['2', 'Palco'])
		ws.receive('SwitchPlanPreGroup', { index: 1 })
		assert.equal(instance.variables.keypad_plan_name, '', 'the group Show has no plan 2')
		await press(instance, 'planKeypadCall')
		assert.deepEqual(ws.last('IndexInvokePrePlan').params, { index: 1, onlySetReal: true })
		assert.equal(instance.variables.keypad_plan, '')
		const count = ws.sent.length
		await press(instance, 'planKeypadCall')
		await type('clear')
		assert.equal(ws.sent.length, count, 'nothing typed: nothing to call')
	})

	it('does not send the empty choice of CallByName', async () => {
		const { instance, ws } = await connect()
		const count = ws.sent.length
		await press(instance, 'CallByName', { CallByName: 'PlanGroupList_PlanList' })
		assert.equal(ws.sent.length, count)
	})

	it('switches preview mode on, off and back', async () => {
		const { instance, ws } = await connect()
		await press(instance, 'previewMode', { mode: 'toggle' })
		assert.deepEqual(ws.last('SetPretidingMode').params, { realMode: false })
		ws.receive('SetPretidingMode', { realMode: false })
		await press(instance, 'previewMode', { mode: 'toggle' })
		assert.deepEqual(ws.last('SetPretidingMode').params, { realMode: true })
		await press(instance, 'previewMode', { mode: 'on' })
		assert.deepEqual(ws.last('SetPretidingMode').params, { realMode: false })
	})

	it('records, with the time on the button', async (t) => {
		t.mock.timers.enable({ apis: ['setInterval', 'Date'] })
		const { instance, ws } = await connect()
		await press(instance, 'record', { mode: 'toggle' })
		assert.equal(ws.sentNames().at(-1), 'StartVideoRecord')
		ws.receive('StartVideoRecord', { res: 0 })
		assert.equal(isOn(instance, 'recording'), true)
		assert.equal(instance.variables.record_time, '00:00')
		t.mock.timers.tick(65000)
		assert.equal(instance.variables.record_time, '01:05')
		await press(instance, 'record', { mode: 'toggle' })
		assert.equal(ws.sentNames().at(-1), 'StopVideoRecord')
		ws.receive('StopVideoRecord', { res: 0 })
		assert.equal(instance.variables.recording, false)
		assert.equal(instance.variables.record_time, '')
		await instance.destroy()
	})

	it('runs every preset without errors', async () => {
		const { instance } = await connect()
		for (const [id, preset] of Object.entries(instance.presets)) {
			for (const action of preset.steps[0].down) {
				await assert.doesNotReject(async () => press(instance, action.actionId, action.options), id)
			}
		}
	})
})

// An instance past the login, with central control connected; destroyed after the test (it polls). The timers are
// mocked: receive plays Kommander's messages, then lets the moment pass after which the last one counts as complete.
// answer answers the last command with success, which lets the next one go; the first requests are answered so
async function connectCentral(t, config = CONFIG, answered = true) {
	t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] })
	const { instance, ws } = await connect(config)
	const socket = FakeSocket.latest
	socket.connectNow()
	t.after(() => instance.destroy())
	const receive = (...messages) => {
		socket.receive(...messages)
		t.mock.timers.tick(READ_DELAY)
	}
	const answer = () => receive(`${socket.lines.at(-1).split(' ')[0]} -success`)
	if (answered) while (instance.centralAwaited) answer()
	return { instance, ws, socket, receive, answer }
}

describe('central control (text protocol)', () => {
	it('reads replies, quoted values, flags and negative numbers', () => {
		assert.deepEqual(parseLine('GetGlobalStatus -volume 50 -mute off -brightness -5'), {
			command: 'GetGlobalStatus',
			volume: '50',
			mute: 'off',
			brightness: '-5',
		})
		assert.deepEqual(parseLine('SetHeartbeat -success'), { command: 'SetHeartbeat', success: true })
		assert.deepEqual(parseLine('GetDeviceslist -count 1 -name “主控” -status "network abnormal"'), {
			command: 'GetDeviceslist',
			count: '1',
			name: '主控',
			status: 'network abnormal',
		})
		assert.equal(quote('a "b" “c”'), `"a 'b' 'c'"`)
		assert.equal(failureReason(parseLine('GlobalSet -failed "project not open"')), 'project not open')
		assert.equal(failureReason(parseLine('ProgramInvoke -failed -name "Plan3 not exist ."')), 'Plan3 not exist .')
	})

	it('finds where messages start and end, which Kommander does not mark', () => {
		const reader = new MessageReader()
		reader.names.add('GetGlobalStatus').add('GetMedialist').add('SetHeartbeat')
		const heartbeat = '{"command":"Heartbeat","currentPreplan":"A {b}","timelines":[{"name":"\\"x\\""}]}'
		// several messages in one chunk of data: all but the last are complete
		assert.deepEqual(reader.read(`GetGlobalStatus -volume 10 -mute offSetHeartbeat -success${heartbeat}GetMedia`), [
			'GetGlobalStatus -volume 10 -mute off',
			'SetHeartbeat -success',
			heartbeat,
		])
		// a message in several chunks; the last one is complete once no more data comes
		assert.deepEqual(reader.read('list -count 2 -current 1 -name "a.png"GetMedialist -count 2 -current 2 -na'), [
			'GetMedialist -count 2 -current 1 -name "a.png"',
		])
		assert.deepEqual(reader.read('me "GetMedialist.mp4"'), [])
		assert.deepEqual(reader.flush(), ['GetMedialist -count 2 -current 2 -name "GetMedialist.mp4"'])
		assert.deepEqual(reader.flush(), [])
		// heartbeats, and messages ending with a newline, are complete at once
		assert.deepEqual(reader.read('{"command":"Heart'), [])
		assert.deepEqual(reader.read('beat"}SetHeartbeat -success\r\n'), [
			'{"command":"Heartbeat"}',
			'SetHeartbeat -success',
		])
		assert.equal(reader.text, '')
	})

	it('connects to the same host on port 5001 and asks for the state, one command at a time', async (t) => {
		const { socket, receive } = await connectCentral(t, CONFIG, false)
		assert.deepEqual(socket.options, { host: '127.0.0.1', port: 5001 })
		// Kommander reads only the first command of what arrives at once: the next one waits for its answer
		assert.deepEqual(socket.lines, ['SetHeartbeat -status on'])
		receive('SetHeartbeat -success')
		assert.deepEqual(socket.lines.at(-1), 'GetGlobalStatus')
		// or for a second without an answer
		t.mock.timers.tick(ANSWER_TIMEOUT - 1)
		assert.equal(socket.lines.length, 2)
		t.mock.timers.tick(1)
		assert.equal(socket.lines.at(-1), 'GetMedialist')
		receive('GetMedialist -count 0')
		assert.equal(socket.lines.at(-1), 'GetScheduleStates')
		receive('GetScheduleStates -status off')
		assert.equal(socket.lines.at(-1), 'GetDeviceslist')
	})

	it('uses the host of the URL and the port of the settings, and stays off when turned off', async () => {
		await start({ ...CONFIG, url: 'ws://10.0.0.5:1702', central_port: 6001 })
		assert.deepEqual(FakeSocket.latest.options, { host: '10.0.0.5', port: 6001 })
		const count = FakeSocket.count
		await start({ ...CONFIG, central_control: false })
		assert.equal(FakeSocket.count, count)
	})

	it("tries this computer's network addresses when Kommander is local, and warns when none answers", async (t) => {
		const { instance } = await connect()
		const loopback = FakeSocket.latest
		loopback.emit('error', new Error('connect ECONNREFUSED 127.0.0.1:5001'))
		loopback.destroy()
		await new Promise((resolve) => setTimeout(resolve, 5))
		const card = FakeSocket.latest
		assert.deepEqual(card.options, { host: '192.168.18.200', port: 5001 })
		assert.equal(instance.statuses.at(-1)[0], 'ok', 'no warning while there are addresses left to try')
		card.emit('error', new Error('connect ECONNREFUSED 192.168.18.200:5001'))
		card.destroy()
		assert.deepEqual(instance.statuses.at(-1), [
			'unknown_warning',
			'Central control not connected: connect ECONNREFUSED 192.168.18.200:5001',
		])
		assert.equal(instance.variables.central_control, false)

		// once an address answers, the warning goes and that address is tried first from then on
		instance.initCentralControl(1)
		FakeSocket.latest.connectNow()
		t.after(() => instance.destroy())
		assert.deepEqual(instance.statuses.at(-1), ['ok', null])
		assert.equal(instance.variables.central_control, true)
		instance.initCentralControl()
		assert.equal(FakeSocket.latest.options.host, '192.168.18.200')
	})

	it('gets the volume and the mute, which the WebSocket only tells when they change', async (t) => {
		const { instance, receive } = await connectCentral(t)
		receive('GetGlobalStatus -volume 30 -mute on -playstatus play -blackscreen off -brightness 0 -output on')
		assert.equal(instance.variables.volume, 30)
		assert.equal(instance.variables.mute, true)
		assert.equal(isOn(instance, 'unmute'), true)
	})

	it('follows the heartbeat: displays, output ports and timelines', async (t) => {
		const { instance, receive } = await connectCentral(t)
		receive(
			'SetHeartbeat -success',
			JSON.stringify({
				command: 'Heartbeat',
				time: '2026-07-18 14:30:15.123',
				displayStatus: 'abnormal',
				outputStatus: 'normal',
				currentPreplan: 'Palco',
				globalPlayStatus: 'play',
				timelines: [
					{ name: 'Main', progress: '00:01:23.456', playStatus: 'pause' },
					{ name: 'Show', progress: '00:00:05.000', playStatus: 'play' },
				],
			}),
		)
		const v = instance.variables
		assert.deepEqual(
			[v.display_status, v.output_ports_status, v.timeline_name, v.timeline_progress, v.timeline_status],
			['abnormal', 'normal', 'Show', '00:00:05.000', 'play'],
		)
		assert.equal(isOn(instance, 'displayProblem'), true)
		assert.equal(isOn(instance, 'outputProblem'), false)
	})

	it('reconnects when the heartbeat stops', async (t) => {
		const { instance, socket, receive } = await connectCentral(t)
		receive('SetHeartbeat -success')
		t.mock.timers.tick(10000)
		assert.equal(socket.destroyed, false)
		t.mock.timers.tick(10000)
		assert.equal(socket.destroyed, true)
		assert.ok(instance.logs.some(([, message]) => message.includes('no heartbeat')))
	})

	it('lists the subtitles and web pages of the media library in their actions', async (t) => {
		const { instance, receive } = await connectCentral(t)
		receive(
			'GetMedialist -count 4 -current 1 -node folder -name "Textos" -guid "f1" -parentGuid ""',
			'GetMedialist -count 4 -current 2 -node file -name "Legenda" -guid "m1" -parentGuid "f1" -index 7 -type subtitle',
			'GetMedialist -count 4 -current 3 -node file -name "Site" -guid "m2" -parentGuid "" -index 9 -type browser',
			'GetMedialist -count 4 -current 4 -node file -name "clip.mp4" -guid "m3" -parentGuid "" -index 3 -type videofile',
		)
		assert.deepEqual(instance.actions.subtitleText.options[0].choices, [{ id: 7, label: '7: Legenda' }])
		assert.equal(instance.actions.subtitleText.options[0].default, 7)
		assert.deepEqual(instance.actions.webPageAddress.options[0].choices, [{ id: 9, label: '9: Site' }])
	})

	it('reports the machines of a multi-machine setup', async (t) => {
		const { instance, receive } = await connectCentral(t)
		receive(
			'GetDeviceslist -count 2 -current 1 -name "主控" -ip "192.168.1.10" -role Host -status "normal" -cpu 35',
			'GetDeviceslist -count 2 -current 2 -name "节点1" -ip "192.168.1.11" -role Slave -status "network abnormal"',
		)
		assert.equal(instance.variables.devices_count, 2)
		assert.equal(instance.variables.devices_problems, '节点1 (network abnormal)')
		assert.equal(isOn(instance, 'deviceProblem'), true)
		receive('GetDeviceslist -count 0')
		assert.equal(instance.variables.devices_count, 0)
		assert.equal(isOn(instance, 'deviceProblem'), false)
	})

	it('follows task management', async (t) => {
		const { instance, socket, receive } = await connectCentral(t)
		receive('GetScheduleStates -status on')
		assert.equal(isOn(instance, 'schedule'), true)
		assert.equal(instance.variables.schedule, true)
		await press(instance, 'schedule', { mode: 'toggle' })
		assert.equal(socket.lines.at(-1), 'SetScheduleStates -status switch')
		receive('SetScheduleStates -success')
		assert.equal(socket.lines.at(-1), 'GetScheduleStates')
	})

	it('logs refused commands, quietly for the queries it sends by itself', async (t) => {
		const { instance, receive } = await connectCentral(t)
		await press(instance, 'filePlay', { by: 'name', file: 'a.mp4', status: 'play' })
		await press(instance, 'planCall', { group: 'MappingWork', plan: 'Plan3', after: 'play' })
		receive(
			'GetGlobalStatus -failed "project not open"',
			'FilePlayControl -failed "file not exist."',
			'ProgramInvoke -failed -name "Plan3 not exist ."',
		)
		const logged = (level, text) => instance.logs.some(([l, message]) => l === level && message.endsWith(text))
		assert.ok(logged('debug', '"GetGlobalStatus": project not open'))
		assert.ok(logged('warn', '"FilePlayControl": file not exist.'))
		assert.ok(logged('warn', '"ProgramInvoke": Plan3 not exist .'))
	})

	it('sends nothing while central control is not connected', async () => {
		const { instance } = await connect()
		await press(instance, 'replay', { mode: 'replay' })
		assert.deepEqual(FakeSocket.latest.lines, [])
		assert.ok(instance.logs.some(([level, message]) => level === 'warn' && message.includes('GlobalSet -playstatus')))
	})

	it("sends the commands of Kommander's text protocol", async (t) => {
		const { instance, ws, socket, answer } = await connectCentral(t)
		const sent = async (actionId, options) => {
			await press(instance, actionId, options)
			const line = socket.lines.at(-1)
			answer()
			return line
		}
		const byName = { by: 'name', file: 'clip "final".mp4' }
		const byWindow = { by: 'window', file: '3' }
		const lines = [
			[['planCall', { group: '', plan: '2', after: 'play' }], 'ProgramInvoke -currentGroup -index 2 -status play'],
			[
				['planCall', { group: 'Show', plan: 'Música 1', after: 'pause' }],
				'ProgramInvoke -groupName "Show" -name "Música 1" -status pause',
			],
			[
				['planCall', { group: '2', plan: '1', after: 'continue' }],
				'ProgramInvoke -groupIndex 2 -index 1 -status continue',
			],
			[['randomPlan', { group: '', after: 'play' }], 'ProgramInvoke -currentGroup -random -status play'],
			[['mainKv', { kv: 2 }], 'ProgramInvoke -kv -index 2'],
			[['replay', { mode: 'firstframe' }], 'GlobalSet -playstatus firstframe'],
			[['timelineByName', { name: 'Main', status: 'toggle' }], 'ProgramPlayControl -name "Main" -playstatus switch'],
			[
				['timelineSeek', { name: 'Main', mode: 'time', value: '00:00:25:000' }],
				'ProgramSeek -name "Main" -value 00:00:25:000',
			],
			[['timelineSeek', { name: '', mode: 'step', value: '-100' }], 'ProgramSeek -step -100'],
			[['standby', { mode: 'off' }], 'GlobalSet -standby off'],
			[['muteSet', { mode: 'toggle' }], 'GlobalSet -mute switch'],
			[['blackScreenSet', { mode: 'on' }], 'GlobalSet -blackscreen on'],
			[['filePlay', { ...byName, status: 'pause' }], `FilePlayControl -name "clip 'final'.mp4" -status pause`],
			[['filePlay', { ...byWindow, status: 'toggle' }], 'FilePlayControl -winid 3 -status switch'],
			[
				['fileSeek', { ...byWindow, mode: 'time', value: '00:01:00:000', after: 'play' }],
				'FileSeek -winid 3 -value "00:01:00:000" -status play',
			],
			[
				['fileSeek', { ...byWindow, mode: 'step', value: '-1000', after: 'continue' }],
				'FileSeek -winid 3 -step -1000 -status continue',
			],
			[
				['fileSeek', { ...byWindow, mode: 'percent', value: '50', after: 'pause' }],
				'FileSeek -winid 3 -percent -value 50 -status pause',
			],
			[['fileSpeed', { ...byWindow, mode: 'value', value: 2 }], 'FilePlayControl -winid 3 -multiple -value 2'],
			[['fileMute', { ...byWindow, mode: 'toggle' }], 'FileVolumeControl -winid 3 -mute switch'],
			[['fileVolume', { ...byWindow, mode: 'step', volume: -10 }], 'FileVolumeControl -winid 3 -step -10'],
			[['filePage', { ...byWindow, mode: 'page', page: 5 }], 'FileTurnPage -winid 3 -value 5'],
			[['filePage', { ...byWindow, mode: 'next', page: 1 }], 'FileTurnPage -winid 3 -next'],
			[['fileReplace', { ...byWindow, source: '12' }], 'WindowReplace -winid 3 -srcid 12'],
			[['fileReplace', { ...byWindow, source: 'b.mp4' }], 'WindowReplace -winid 3 -srcname "b.mp4"'],
			[['subtitleText', { media: 7, text: 'Bem-vindos "amigos"' }], `MediaSet -id 7 -text "Bem-vindos 'amigos'"`],
			[['webPageAddress', { media: '9', url: 'https://example.com' }], 'MediaSet -id 9 -url "https://example.com"'],
			[
				['turnPage', { type: 'teleprompter', mode: 'next', page: 1, program: '' }],
				'ProgramTurnPage -type teleprompter -next',
			],
			[
				['turnPage', { type: 'office', mode: 'page', page: 3, program: 'Main' }],
				'ProgramTurnPage -type office -page 3 -name "Main"',
			],
		]
		for (const [[actionId, options], line] of lines) assert.equal(await sent(actionId, options), line, actionId)

		// toggles and the lock go through the WebSocket (Kommander refuses central control while locked)
		ws.receive('GetAllMonitor', { state: 1 })
		await press(instance, 'OutputOnOff', { outputOnOff: 2 })
		assert.deepEqual(ws.last('EnableAllMonitor').params, { bOpen: false })
		const count = ws.sent.length
		await press(instance, 'lockSet', { mode: 'off' })
		assert.equal(ws.sent.length, count, 'already unlocked: nothing to send')
		await press(instance, 'lockSet', { mode: 'on' })
		assert.equal(ws.sentNames().at(-1), 'SetKommanderLock')
	})
})

describe('settings', () => {
	it('updates the variables in the presets when the connection is renamed', async () => {
		const { instance } = await connect()
		instance.labelValue = 'KMD'
		await instance.configUpdated(CONFIG)
		assert.match(instance.presets.status_plan.style.text, /\$\(KMD:plan_name\)/)
		assert.deepEqual(presetProblems(instance), [])
	})

	it('fills in the login of version 1.0 when an existing connection is upgraded', () => {
		const [upgrade] = upgradeScripts
		const result = upgrade({}, { config: { url: 'ws://10.0.0.2:1702', reconnect: true }, actions: [], feedbacks: [] })
		assert.deepEqual(result.updatedConfig, {
			url: 'ws://10.0.0.2:1702',
			reconnect: true,
			username: 'streamDeck',
			password: 'streamDeck',
			debug_messages: false,
		})
		assert.equal(upgrade({}, { config: { url: 'ws://10.0.0.2:1702', username: 'op' } }).updatedConfig, null)
		assert.equal(upgrade({}, { config: null }).updatedConfig, null)
	})

	it('turns central control on for existing connections', () => {
		const upgrade = upgradeScripts[1]
		assert.deepEqual(upgrade({}, { config: { url: 'ws://10.0.0.2:1702' } }).updatedConfig, {
			url: 'ws://10.0.0.2:1702',
			central_control: true,
			central_port: 5001,
		})
		assert.equal(upgrade({}, { config: { url: 'ws://10.0.0.2:1702', central_control: false } }).updatedConfig, null)
	})
})
