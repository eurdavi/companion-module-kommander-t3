import { InstanceBase, InstanceStatus, runEntrypoint } from '@companion-module/base'
import net from 'node:net'
import { networkInterfaces } from 'node:os'
import WebSocket from 'ws'
import { getActionDefinitions } from './actions.js'
import { ANSWER_TIMEOUT, CENTRAL_PORT, failureReason, MessageReader, parseLine, READ_DELAY } from './central.js'
import { getFeedbackDefinitions } from './feedbacks.js'
import { getPresetDefinitions } from './presets.js'
import { upgradeScripts } from './upgrade.js'
import {
	formatTime,
	getEmptyVariableValues,
	getVariableDefinitions,
	indexToNumber,
	PLAY_STATUS_NAMES,
} from './variables.js'

const URL_REGEX = '^wss?:\\/\\/([\\da-z\\.-]+)(:\\d{1,5})?(?:\\/(.*))?$'
// Login of Kommander's Stream Deck access, which works without any setup in Kommander
export const DEFAULT_LOGIN = 'streamDeck'
// Kommander only reports changes: this is asked for once the plans are known
const STATE_REQUESTS = [
	'GetGlobalState',
	'GetAllMonitor',
	'GetBlackScreen',
	'GetKommanderLock',
	'GetPretidingMode',
	'GetScreenContrastLight',
	'GetPrePlanUsingMark',
]
// Asked over central control once connected, the last two again every 10 seconds (they have no notice)
const CENTRAL_REQUESTS = [
	'SetHeartbeat -status on',
	'GetGlobalStatus',
	'GetMedialist',
	'GetScheduleStates',
	'GetDeviceslist',
]
// Media type of videos, in the media library and on the canvas
const VIDEO = 1

// Kommander tells clients apart by device id: one per Companion connection, so two of them don't clash
function deviceIdFor(connectionId) {
	let hash = 0
	for (const char of connectionId) hash = (hash * 31 + char.charCodeAt(0)) % 900000
	return String(100000 + hash)
}

// This computer's IPv4 addresses on its network cards
function localAddresses() {
	return Object.values(networkInterfaces())
		.flat()
		.filter((address) => address.family === 'IPv4' && !address.internal)
		.map((address) => address.address)
}

function localAddress() {
	return localAddresses()[0] ?? '127.0.0.1'
}

class KommanderInstance extends InstanceBase {
	// plan groups of the open project, from the media library
	planGroups = []
	planSignature = ''
	// why Kommander refused the last login, shown as the connection status
	loginError = null
	// subtitles and web pages of the media library (by central control), for the menus of their actions
	subtitleChoices = []
	webPageChoices = []
	mediaSignature = ''

	async init(config) {
		this.config = config
		this.resetState()
		this.setVariableDefinitions(getVariableDefinitions())
		this.setVariableValues(getEmptyVariableValues())
		this.initDefinitions()
		this.initWebSocket()
		this.initCentralControl()
	}

	async destroy() {
		this.isDestroyed = true
		clearTimeout(this.reconnectTimer)
		clearTimeout(this.centralReconnectTimer)
		this.stopTimers()
		this.closeWebSocket()
		this.closeCentralControl()
	}

	async configUpdated(config) {
		this.config = config
		// the presets show this connection's variables, which go by its label
		this.initPresets()
		this.initWebSocket()
		this.initCentralControl()
	}

	getConfigFields() {
		return [
			{
				type: 'textinput',
				id: 'url',
				label: 'Kommander URL',
				tooltip: 'ws://<ip>:1702',
				width: 12,
				regex: `/${URL_REGEX}/`,
				default: 'ws://127.0.0.1:1702',
			},
			{
				type: 'textinput',
				id: 'username',
				label: 'Username',
				tooltip: 'A user of Kommander (System Settings > Users). The default works without any setup',
				width: 6,
				default: DEFAULT_LOGIN,
			},
			{ type: 'textinput', id: 'password', label: 'Password', width: 6, default: DEFAULT_LOGIN },
			{
				type: 'checkbox',
				id: 'reconnect',
				label: 'Reconnect',
				tooltip: 'Reconnect 5 seconds after the connection drops',
				width: 6,
				default: true,
			},
			{
				type: 'checkbox',
				id: 'debug_messages',
				label: 'Log messages',
				tooltip: 'Log every message to and from Kommander (debug level)',
				width: 6,
				default: false,
			},
			{
				type: 'checkbox',
				id: 'central_control',
				label: 'Central control',
				tooltip:
					"Also connect to Kommander's central control (text commands), for the file, subtitle, timeline and monitoring features. Kommander: System Settings > Connection > Enable Central Control via Network",
				width: 6,
				default: true,
			},
			{
				type: 'number',
				id: 'central_port',
				label: 'Central control port',
				width: 6,
				default: CENTRAL_PORT,
				min: 1,
				max: 65535,
			},
		]
	}

	// Kommander's state as last reported, null while unknown
	resetState() {
		this.stopTimers()
		this.isNotTimeLine = true
		this.playStatus = null
		this.isMute = false
		this.isBlackScreen = false
		this.monitorStatus = null
		this.isLock = false
		this.realMode = null
		this.groupIndex = null
		this.planIndex = null
		this.currentName = ''
		this.previewIndex = null
		this.previewName = ''
		this.recording = false
		// digits typed on the plan keypad
		this.keypad = ''
		// files on the canvases (on air and preview) by id: name, type, mute, volume, state, position, duration
		this.files = new Map()
	}

	stopTimers() {
		clearTimeout(this.libraryTimer)
		clearInterval(this.videoTimer)
		clearInterval(this.recordTimer)
		this.videoTimer = null
		this.recordTimer = null
	}

	initDefinitions() {
		this.setActionDefinitions(getActionDefinitions(this))
		this.setFeedbackDefinitions(getFeedbackDefinitions(this))
		this.initPresets()
	}

	initPresets() {
		this.setPresetDefinitions(getPresetDefinitions(this.label, this.planGroups))
	}

	initWebSocket() {
		clearTimeout(this.reconnectTimer)
		this.closeWebSocket()
		this.resetState()
		this.setVariableValues(getEmptyVariableValues())
		this.checkFeedbacks()

		const url = this.config.url
		if (!url || !new RegExp(URL_REGEX).test(url)) {
			this.updateStatus(InstanceStatus.BadConfig, 'The Kommander URL must look like ws://<ip>:1702')
			return
		}
		this.updateStatus(InstanceStatus.Connecting)
		this.loginError = null
		this.loggedIn = false
		this.stateRequested = false

		const ws = new WebSocket(url, { origin: 'streamDeck' })
		this.ws = ws
		ws.on('open', () => this.login())
		ws.on('message', (data) => this.messageReceived(data))
		ws.on('error', (error) => {
			// while Kommander is off this repeats every 5 seconds: log it once
			if (error.message !== this.lastError) this.log('error', `WebSocket error: ${error.message}`)
			this.lastError = error.message
		})
		ws.on('close', (code) => {
			this.log('debug', `Connection closed with code ${code}`)
			this.loggedIn = false
			this.stopTimers()
			if (this.loginError) {
				this.updateStatus(InstanceStatus.ConnectionFailure, `Kommander refused the login: ${this.loginError}`)
			} else {
				this.updateStatus(InstanceStatus.Disconnected, `Connection closed with code ${code}`)
			}
			this.maybeReconnect()
		})
	}

	// Closes the connection without the reconnect its close event would start
	closeWebSocket() {
		if (!this.ws) return
		this.ws.removeAllListeners()
		// closing before the connection is up emits an error: nothing to report
		this.ws.on('error', () => {})
		this.ws.close(1000)
		delete this.ws
	}

	maybeReconnect() {
		if (this.isDestroyed || !this.config.reconnect) return
		clearTimeout(this.reconnectTimer)
		this.reconnectTimer = setTimeout(() => this.initWebSocket(), 5000)
	}

	login() {
		this.send(
			'Authentication',
			{
				username: this.config.username || DEFAULT_LOGIN,
				password: this.config.password || DEFAULT_LOGIN,
				ip: localAddress(),
				deviceId: deviceIdFor(this.id),
				connetType: 5,
			},
			{ identificationID: '10' },
		)
	}

	// Sends KommanderMsg_<name>; false when there is no connection
	send(name, params, extra = {}) {
		if (this.ws?.readyState !== WebSocket.OPEN) {
			this.log('warn', `Not connected to Kommander: ${name} not sent`)
			return false
		}
		const message = { KommanderMsg: `KommanderMsg_${name}`, ...extra }
		if (params !== undefined) message.params = params
		if (this.config.debug_messages) this.log('debug', `Sent: ${JSON.stringify(message)}`)
		this.ws.send(JSON.stringify(message))
		return true
	}

	messageReceived(data) {
		if (this.config.debug_messages) this.log('debug', `Received: ${data}`)
		let message
		try {
			message = JSON.parse(data)
		} catch {
			this.log('warn', `Not a Kommander message: ${data}`)
			return
		}
		this.handleMessage(String(message.KommanderMsg).replace('KommanderMsg_', ''), message)
	}

	handleMessage(name, message) {
		const data = message.data ?? {}
		switch (name) {
			case 'Authentication':
				if (message.code !== 1) {
					// e.g. "Maximum connection number": Kommander closes the connection right after this
					this.loginError = data.msg ?? `error ${data.error}`
					this.log('error', `Kommander refused the login: ${this.loginError}`)
					break
				}
				this.lastError = null
				this.isNotTimeLine = data.isNotTimeLine
				this.loggedIn = true
				this.refreshStatus()
				this.setVariableValues({ project_type: this.isNotTimeLine ? 'Plan' : 'Timeline' })
				this.send('GetMediaLibs')
				break
			case 'GetMediaLibs': {
				const plans =
					message.code === 1
						? message.MediaLibs?.find((library) => library.MediaGroup === '播放预案' || library.MediaGrouptype === 8)
						: undefined
				this.updatePlanGroups(plans?.data ?? [])
				if (!this.stateRequested) {
					this.stateRequested = true
					STATE_REQUESTS.forEach((request) => this.send(request))
				}
				break
			}
			case 'MediaLibsChanged':
				// Sent when plans are edited and when a plan goes on air (also after a Take, which has no notice of
				// its own): refresh both once things settle
				clearTimeout(this.libraryTimer)
				this.libraryTimer = setTimeout(() => {
					this.send('GetMediaLibs')
					this.send('GetPrePlanUsingMark')
					this.sendCentral('GetMedialist', true)
				}, 300)
				break
			case 'GetGlobalState':
				this.playStatus = data.state
				this.checkFeedbacks('playStatus')
				this.setVariableValues({ play_status: PLAY_STATUS_NAMES[data.state] ?? '' })
				break
			case 'Mute':
				this.isMute = data.mute
				this.checkFeedbacks('unmute')
				this.setVariableValues({ mute: Boolean(data.mute) })
				break
			case 'Volume':
				if (typeof data.volume === 'number') this.setVariableValues({ volume: data.volume })
				break
			case 'GetScreenContrastLight':
				this.setVariableValues({ brightness: data.light, contrast: data.contrast })
				break
			case 'GetBlackScreen':
			case 'UpdateBlackScreen':
				this.isBlackScreen = data.blackscreen
				this.checkFeedbacks('blackscreen')
				this.setVariableValues({ blackscreen: Boolean(data.blackscreen) })
				break
			case 'GetAllMonitor':
				this.monitorStatus = data.state
				this.checkFeedbacks('monitorStatus')
				this.setVariableValues({ output: data.state === 1 })
				break
			case 'GetKommanderLock':
			case 'UpdateLockKommander':
				this.isLock = data.lock
				this.checkFeedbacks('lock')
				this.setVariableValues({ lock: Boolean(data.lock) })
				break
			case 'GetPretidingMode':
			case 'SetPretidingMode':
				// the reply to SetPretidingMode has no data, the notice that follows has the mode
				if (typeof data.realMode !== 'boolean') break
				this.realMode = data.realMode
				this.checkFeedbacks('previewMode', 'previewPlan', 'previewByName')
				this.setVariableValues({ preview_mode: !data.realMode })
				break
			case 'SwitchPlanPreGroup':
				this.groupIndex = data.index
				this.checkFeedbacks('preGroup')
				this.setVariableValues({
					group_number: indexToNumber(data.index),
					group_name: this.planGroups[data.index]?.name ?? '',
				})
				this.updateKeypad()
				break
			case 'UpdatePrePlanUsingMark':
				this.updatePlans(data)
				break
			case 'UpdateProgFileList':
				for (const file of Array.isArray(message.data) ? message.data : []) {
					this.updateFile(file.id, { name: file.name, type: file.media?.type, mute: file.bMute })
				}
				this.updateVideo()
				break
			case 'DeleteProgFile':
				this.files.delete(data.id)
				this.updateVideo()
				break
			case 'SetProgFileMute':
				// also the reply to our own SetProgFileMute, which has no data
				if (data.id) this.updateFile(data.id, { mute: data.bMute })
				break
			case 'UpdateProgFileVolume':
				this.updateFile(data.id, { volume: data.volume })
				break
			case 'UpdateProgFilePlayState':
				this.updateFile(data.id, { state: data.state, position: Number(data.curPos), duration: Number(data.duration) })
				this.updateVideo()
				break
			case 'GetProgFilePlayState':
				// the reply has no file id: it is about the video asked for last
				if (!this.videoAsked) break
				this.updateFile(this.videoAsked, {
					state: data.state,
					position: Number(data.curPos),
					duration: Number(data.duration),
				})
				this.updateVideo()
				break
			case 'StartVideoRecord':
			case 'StopVideoRecord':
				if (message.code === 1) this.setRecording(name === 'StartVideoRecord')
				break
		}
	}

	// The plan lists (actions, feedbacks, presets) are rebuilt only when the plans changed
	updatePlanGroups(groups) {
		this.planGroups = groups
		this.updateKeypad()
		const signature = JSON.stringify(groups.map((group) => [group.name, (group.data ?? []).map((plan) => plan.name)]))
		if (signature === this.planSignature) return
		this.planSignature = signature
		this.initDefinitions()
	}

	// Plans on air and in preview. Kommander's notice has their positions and names, but the reply to
	// GetPrePlanUsingMark only has their ids, so those come from the media library
	updatePlans(data) {
		const onAir =
			data.outPutingId === undefined
				? this.findPlan(data.outPutingPrePlanId, this.groupIndex)
				: {
						index: data.outPutingId,
						groupIndex: data.nOutGroupId,
						group: data.outGroupName,
						name: data.outPutingPrePlanName,
					}
		const preview =
			data.editingId === undefined
				? this.findPlan(data.editingPrePlanId)
				: {
						index: data.editingId,
						groupIndex: data.nEditGroupId,
						group: data.EditGroupName,
						name: data.editingPrePlanName,
					}
		this.planIndex = onAir.index
		this.groupIndex = onAir.groupIndex
		this.currentName = `${onAir.group}-${onAir.name}`
		this.previewIndex = preview.index
		this.previewName = `${preview.group}-${preview.name}`
		this.checkFeedbacks('plan', 'callByName', 'preGroup', 'previewPlan', 'previewByName')
		this.setVariableValues({
			plan_number: indexToNumber(onAir.index),
			plan_name: onAir.name ?? '',
			group_number: indexToNumber(onAir.groupIndex),
			group_name: onAir.group ?? '',
			preview_plan_number: indexToNumber(preview.index),
			preview_plan_name: preview.name ?? '',
			preview_group_number: indexToNumber(preview.groupIndex),
			preview_group_name: preview.group ?? '',
		})
		this.updateKeypad()
	}

	// Plan keypad: the number of a plan of the current group, typed digit by digit
	typePlanKey(key) {
		if (key === 'clear') this.keypad = ''
		else if (key === 'back') this.keypad = this.keypad.slice(0, -1)
		else if (this.keypad.length < 4) this.keypad = `${this.keypad}${key}`.replace(/^0+/, '')
		this.updateKeypad()
	}

	callTypedPlan() {
		const number = Number(this.keypad)
		if (number > 0) this.send('IndexInvokePrePlan', { index: number - 1, onlySetReal: true })
		this.keypad = ''
		this.updateKeypad()
	}

	updateKeypad() {
		const plan = this.planGroups[this.groupIndex]?.data?.[Number(this.keypad) - 1]
		this.setVariableValues({ keypad_plan: this.keypad, keypad_plan_name: plan?.name ?? '' })
	}

	// Position and names of a plan of the media library (index -1 when it isn't there)
	findPlan(planId, groupIndex = -1) {
		for (const [g, group] of this.planGroups.entries()) {
			const p = (group.data ?? []).findIndex((plan) => plan.id === planId)
			if (p !== -1) return { index: p, groupIndex: g, group: group.name, name: group.data[p].name }
		}
		return { index: -1, groupIndex, group: this.planGroups[groupIndex]?.name ?? '', name: '' }
	}

	updateFile(id, changes) {
		if (id) this.files.set(id, { ...this.files.get(id), ...changes })
	}

	// The video that plays (the longest one left, if several) and its times. Kommander sends no progress while it
	// plays, so its position is asked for every second
	updateVideo() {
		const left = ([, file]) => file.duration - (file.position || 0)
		const videos = [...this.files.entries()].filter(([, file]) => file.type === VIDEO && file.duration > 0)
		const playing = videos.filter(([, file]) => file.state === 1)
		const [id, video] = (playing.length ? playing : videos).sort((a, b) => left(b) - left(a))[0] ?? []
		this.setVariableValues({
			video_name: video?.name ?? '',
			video_elapsed: video ? formatTime(video.position || 0) : '',
			video_remaining: video ? formatTime(left([id, video]), true) : '',
			video_remaining_seconds: video ? Math.ceil(left([id, video]) / 1000) : '',
			video_duration: video ? formatTime(video.duration, true) : '',
		})
		this.playingVideo = playing.length ? id : null
		if (this.playingVideo && !this.videoTimer) {
			this.videoTimer = setInterval(() => {
				if (this.send('GetProgFilePlayState', { id: this.playingVideo })) this.videoAsked = this.playingVideo
			}, 1000)
		} else if (!this.playingVideo) {
			clearInterval(this.videoTimer)
			this.videoTimer = null
		}
	}

	// Kommander has no notice for recording, so this follows the replies to our own commands
	setRecording(recording) {
		this.recording = recording
		clearInterval(this.recordTimer)
		this.recordTimer = null
		if (recording) {
			const start = Date.now()
			this.recordTimer = setInterval(
				() => this.setVariableValues({ record_time: formatTime(Date.now() - start) }),
				1000,
			)
		}
		this.checkFeedbacks('recording')
		this.setVariableValues({ recording, record_time: recording ? formatTime(0) : '' })
	}

	// OK once Kommander accepts the login; central control failing to connect only adds a warning
	refreshStatus() {
		this.setVariableValues({ central_control: Boolean(this.centralReady) })
		if (!this.loggedIn) return
		if (this.config.central_control !== false && !this.centralReady && this.centralError) {
			this.updateStatus(InstanceStatus.UnknownWarning, `Central control not connected: ${this.centralError}`)
		} else {
			this.updateStatus(InstanceStatus.Ok)
		}
	}

	resetCentralState() {
		this.centralReady = false
		// commands waiting to be sent, and the name of the one whose answer is awaited
		this.centralQueue = []
		this.centralAwaited = null
		clearTimeout(this.centralAnswerTimer)
		this.centralLists = {}
		this.lastHeartbeat = null
		this.scheduleOn = false
		this.displayProblem = false
		this.outputProblem = false
		this.deviceProblem = false
		this.checkFeedbacks('schedule', 'displayProblem', 'outputProblem', 'deviceProblem')
	}

	// Central control: a second connection, for Kommander's text protocol (see central.js). Kommander listens for it
	// only on the network card chosen in its Connection settings, so when it runs on this computer (127.0.0.1),
	// this computer's network addresses are tried too, starting from the one that worked last
	initCentralControl(tried = 0) {
		clearTimeout(this.centralReconnectTimer)
		this.closeCentralControl()
		this.resetCentralState()
		this.refreshStatus()
		if (this.config.central_control === false || !new RegExp(URL_REGEX).test(this.config.url ?? '')) return

		const port = Number(this.config.central_port) || CENTRAL_PORT
		const urlHost = new URL(this.config.url).hostname.replace(/^\[|\]$/g, '')
		const hosts = ['127.0.0.1', 'localhost', '::1'].includes(urlHost) ? [urlHost, ...localAddresses()] : [urlHost]
		const hostIndex = ((this.centralHostIndex ?? 0) + tried) % hosts.length
		const socket = net.connect({ host: hosts[hostIndex], port })
		const reader = new MessageReader()
		this.central = socket
		this.centralReader = reader
		socket.setEncoding('utf8')
		socket.on('connect', () => {
			this.centralReady = true
			this.centralError = null
			this.centralHostIndex = hostIndex
			this.refreshStatus()
			CENTRAL_REQUESTS.forEach((request) => this.sendCentral(request, true))
			this.centralTimer = setInterval(() => this.pollCentral(), 10000)
		})
		socket.on('data', (data) => {
			clearTimeout(this.centralReadTimer)
			reader.read(data).forEach((message) => this.centralMessageReceived(message))
			// nothing marks the end of the last message: it is complete once no more data comes for a moment
			if (!reader.text) return
			this.centralReadTimer = setTimeout(
				() => reader.flush().forEach((message) => this.centralMessageReceived(message)),
				READ_DELAY,
			)
		})
		socket.on('error', (error) => {
			this.lastCentralError = error.message
		})
		socket.on('close', () => {
			const wasConnected = this.centralReady
			this.centralReady = false
			clearInterval(this.centralTimer)
			clearTimeout(this.centralAnswerTimer)
			if (!wasConnected && tried + 1 < hosts.length) {
				// another address of this computer to try right away
				this.centralReconnectTimer = setTimeout(() => this.initCentralControl(tried + 1), 0)
				return
			}
			const error = wasConnected ? 'connection closed' : (this.lastCentralError ?? 'connection closed')
			if (error !== this.centralError) this.log('warn', `Central control (port ${port}): ${error}`)
			this.centralError = error
			this.refreshStatus()
			if (!this.isDestroyed && this.config.reconnect) {
				this.centralReconnectTimer = setTimeout(() => this.initCentralControl(), 5000)
			}
		})
	}

	// Closes central control without the reconnect its close event would start
	closeCentralControl() {
		clearInterval(this.centralTimer)
		clearTimeout(this.centralReadTimer)
		clearTimeout(this.centralAnswerTimer)
		if (!this.central) return
		this.central.removeAllListeners()
		this.central.on('error', () => {})
		this.central.destroy()
		delete this.central
		this.centralReady = false
	}

	// Sends a line of the text protocol, after the commands before it (see ANSWER_TIMEOUT); false when central control
	// is not connected
	sendCentral(command, quiet = false) {
		if (!this.centralReady) {
			if (!quiet) this.log('warn', `Central control is not connected: "${command}" not sent`)
			return false
		}
		// the reply starts with the command's name, which tells where it starts
		this.centralReader.names.add(command.split(' ')[0])
		this.centralQueue.push(command)
		this.sendNextCentral()
		return true
	}

	sendNextCentral() {
		if (!this.centralReady || this.centralAwaited || !this.centralQueue.length) return
		const command = this.centralQueue.shift()
		if (this.config.debug_messages) this.log('debug', `Sent (central control): ${command}`)
		this.centralAwaited = command.split(' ')[0]
		this.centralAnswerTimer = setTimeout(() => this.centralAnswered(), ANSWER_TIMEOUT)
		this.central.write(`${command}\r\n`)
	}

	centralAnswered() {
		clearTimeout(this.centralAnswerTimer)
		this.centralAwaited = null
		this.sendNextCentral()
	}

	pollCentral() {
		// the heartbeat comes every 3 seconds: without it for this long, the connection is gone
		if (this.lastHeartbeat !== null && Date.now() - this.lastHeartbeat > 15000) {
			this.log('warn', 'Central control: no heartbeat from Kommander, reconnecting')
			this.central?.destroy()
			return
		}
		this.sendCentral('GetScheduleStates', true)
		this.sendCentral('GetDeviceslist', true)
	}

	centralMessageReceived(message) {
		if (this.config.debug_messages) this.log('debug', `Received (central control): ${message}`)
		if (message.startsWith('{')) {
			try {
				this.heartbeatReceived(JSON.parse(message))
			} catch {
				this.log('warn', `Central control: not a heartbeat: ${message}`)
			}
			return
		}
		const reply = parseLine(message)
		if (reply.command === this.centralAwaited) this.centralAnswered()
		if (reply.failed) {
			// the queries this module sends by itself fail while no project is open: not worth a warning
			const asked = CENTRAL_REQUESTS.some((request) => request.split(' ')[0] === reply.command)
			this.log(asked ? 'debug' : 'warn', `Kommander refused "${reply.command}": ${failureReason(reply)}`)
			return
		}
		switch (reply.command) {
			case 'SetHeartbeat':
				if (reply.success) this.lastHeartbeat = Date.now()
				break
			case 'GetGlobalStatus':
				// over WebSocket, Kommander only tells the volume and the mute when they change
				if (reply.volume !== undefined) this.setVariableValues({ volume: Number(reply.volume) })
				if (reply.mute !== undefined) {
					this.isMute = reply.mute === 'on'
					this.checkFeedbacks('unmute')
					this.setVariableValues({ mute: this.isMute })
				}
				break
			case 'GetScheduleStates':
				this.scheduleOn = reply.status === 'on'
				this.checkFeedbacks('schedule')
				this.setVariableValues({ schedule: this.scheduleOn })
				break
			case 'SetScheduleStates':
				this.sendCentral('GetScheduleStates', true)
				break
			case 'GetMedialist':
			case 'GetDeviceslist': {
				// one line per item, gathered until the last one
				const count = Number(reply.count) || 0
				const items = Number(reply.current) > 1 ? (this.centralLists[reply.command] ?? []) : []
				if (count) items.push(reply)
				this.centralLists[reply.command] = items
				if (Number(reply.current || 0) < count) break
				delete this.centralLists[reply.command]
				if (reply.command === 'GetMedialist') this.updateMediaList(items)
				else this.updateDevices(items)
				break
			}
		}
	}

	heartbeatReceived(heartbeat) {
		if (heartbeat.command !== 'Heartbeat') return
		this.lastHeartbeat = Date.now()
		this.displayProblem = heartbeat.displayStatus === 'abnormal'
		this.outputProblem = heartbeat.outputStatus === 'abnormal'
		this.checkFeedbacks('displayProblem', 'outputProblem')
		const timelines = Array.isArray(heartbeat.timelines) ? heartbeat.timelines : []
		const timeline = timelines.find((t) => t.playStatus === 'play') ?? timelines[0]
		this.setVariableValues({
			display_status: heartbeat.displayStatus ?? '',
			output_ports_status: heartbeat.outputStatus ?? '',
			timeline_name: timeline?.name ?? '',
			timeline_progress: timeline?.progress ?? '',
			timeline_status: timeline?.playStatus ?? '',
		})
	}

	// Subtitles and web pages of the media library, by the id Kommander shows when hovering them
	updateMediaList(items) {
		const choices = (types) =>
			items
				.filter((item) => item.node === 'file' && types.includes(item.type))
				.map((item) => ({ id: Number(item.index), label: `${item.index}: ${item.name}` }))
		const subtitles = choices(['subtitle'])
		const webPages = choices(['browser', 'http'])
		const signature = JSON.stringify([subtitles, webPages])
		if (signature === this.mediaSignature) return
		this.mediaSignature = signature
		this.subtitleChoices = subtitles
		this.webPageChoices = webPages
		this.setActionDefinitions(getActionDefinitions(this))
	}

	// Machines of a multi-machine setup (none when Kommander works alone)
	updateDevices(devices) {
		const problems = devices.filter((device) => device.status !== 'normal')
		this.deviceProblem = problems.length > 0
		this.checkFeedbacks('deviceProblem')
		this.setVariableValues({
			devices_count: devices.length,
			devices_problems: problems.map((device) => `${device.name} (${device.status})`).join(', '),
		})
	}
}

runEntrypoint(KommanderInstance, upgradeScripts)
