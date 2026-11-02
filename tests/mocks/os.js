// Stand-in for node:os: a computer with one network card, at a fixed address
export function networkInterfaces() {
	return {
		Loopback: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
		'Wi-Fi': [{ family: 'IPv4', address: '192.168.18.200', internal: false }],
	}
}
