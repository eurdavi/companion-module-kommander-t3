// Module hooks for the tests: @companion-module/base, ws, node:net and node:os load the stand-ins in ./mocks
const mocks = {
	'@companion-module/base': new URL('./mocks/base.js', import.meta.url).href,
	ws: new URL('./mocks/ws.js', import.meta.url).href,
	'node:net': new URL('./mocks/net.js', import.meta.url).href,
	'node:os': new URL('./mocks/os.js', import.meta.url).href,
}

export async function resolve(specifier, context, nextResolve) {
	return mocks[specifier] ? { url: mocks[specifier], shortCircuit: true } : nextResolve(specifier, context)
}
