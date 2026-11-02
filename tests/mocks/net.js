// Fake TCP socket for central control: keeps the commands the module writes, and the tests play Kommander's side
import { EventEmitter } from 'node:events'

export class FakeSocket extends EventEmitter {
	static latest = null
	static count = 0

	constructor(options) {
		super()
		this.options = options
		this.lines = []
		this.destroyed = false
		FakeSocket.latest = this
		FakeSocket.count++
	}

	setEncoding() {}

	write(data) {
		this.lines.push(...String(data).split('\r\n').filter(Boolean))
	}

	destroy() {
		if (this.destroyed) return
		this.destroyed = true
		this.emit('close')
	}

	connectNow() {
		this.emit('connect')
	}

	// Like Kommander, with nothing between or after the messages; here they all come in the same chunk of data
	receive(...messages) {
		this.emit('data', messages.join(''))
	}
}

export default { connect: (options) => new FakeSocket(options) }
