// Kommander's text protocol for control systems ("central control", TCP port 5001): one command per line,
// answered with "<command> -success", "<command> -failed "<reason>"" or "<command> -<key> <value> ...".
// Once asked to (SetHeartbeat), Kommander also sends a JSON heartbeat every 3 seconds about its displays and outputs.
// Kommander ends neither its replies nor its heartbeats with a newline (see MessageReader).
// The commands that power off or restart machines and Kommander are deliberately left out of this module.

export const CENTRAL_PORT = 5001
// How long MessageReader's user waits for more data before taking the last message as complete, in milliseconds
export const READ_DELAY = 50
// Kommander reads only the first command of what arrives at once, so commands go one at a time: the next one once
// Kommander answered the last, or after this long without an answer, in milliseconds
export const ANSWER_TIMEOUT = 1000

// Data from Kommander can hold several messages, or part of one, and nothing marks where a message ends. So a message
// ends where the next one starts: at a heartbeat ("{"), or at the name of a command sent before, which Kommander's
// reply starts with. The last message is taken as complete when no more data comes for a moment (flush), or at once
// for a heartbeat whose braces close or a message that ends with a newline
export class MessageReader {
	// names of the commands sent, which start the replies
	names = new Set()
	text = ''

	// Adds data that came; returns the messages it completes
	read(data) {
		this.text += data
		const messages = []
		for (;;) {
			this.text = this.text.trimStart()
			const end = this.text.startsWith('{') ? jsonEnd(this.text) : this.nextStart()
			if (end < 0) return messages
			messages.push(this.text.slice(0, end).trim())
			this.text = this.text.slice(end)
		}
	}

	// The rest, once no more data came
	flush() {
		const rest = this.text.trim()
		this.text = ''
		return rest ? [rest] : []
	}

	// Where the message after the first one starts, or -1 while it hasn't come
	nextStart() {
		const names = [...this.names].filter((name) => /^\w+$/.test(name))
		const start = new RegExp(`\\n|\\{"${names.map((name) => `|${name} -`).join('')}`, 'g')
		start.lastIndex = 1
		return start.exec(this.text)?.index ?? -1
	}
}

// Where the JSON object at the start of the text ends, or -1 while it hasn't all come
function jsonEnd(text) {
	let depth = 0
	let inString = false
	for (let i = 0; i < text.length; i++) {
		const char = text[i]
		if (inString) {
			if (char === '\\') i++
			else if (char === '"') inString = false
		} else if (char === '"') inString = true
		else if (char === '{' || char === '[') depth++
		else if ((char === '}' || char === ']') && --depth === 0) return i + 1
	}
	return -1
}

// Values go in double quotes; the protocol has no escapes, so quotes inside become single ones
export function quote(value) {
	return `"${String(value).replace(/["“”]/g, "'")}"`
}

// 'GetGlobalStatus -volume 50 -mute off' -> { command: 'GetGlobalStatus', volume: '50', mute: 'off' }. A flag
// without a value, like -success, is true; negative numbers are values, not flags
export function parseLine(line) {
	const tokens = [...line.matchAll(/"([^"]*)"|“([^”]*)”|(\S+)/g)].map((match) => ({
		text: match[1] ?? match[2] ?? match[3],
		isFlag: match[3] !== undefined && /^-[A-Za-z]/.test(match[3]),
	}))
	const reply = { command: tokens[0]?.text ?? '' }
	for (let i = 1; i < tokens.length; i++) {
		if (!tokens[i].isFlag) continue
		const next = tokens[i + 1]
		const hasValue = next !== undefined && !next.isFlag
		reply[tokens[i].text.slice(1)] = hasValue ? next.text : true
		if (hasValue) i++
	}
	return reply
}

// Why Kommander refused a command: 'X -failed "reason"', or 'X -failed -name "reason"' in some of its replies
export function failureReason(reply) {
	if (typeof reply.failed === 'string') return reply.failed
	const details = Object.entries(reply).filter(([key]) => key !== 'command' && key !== 'failed')
	return details.map(([, value]) => value).join(' ') || 'no reason given'
}
