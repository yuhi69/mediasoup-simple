"use strict";

const https = require('https');
const express = require('express');
const fs = require('fs');

// for graceful shutdown.
const GracefulShutdownManager = require('@moebius/http-graceful-shutdown').GracefulShutdownManager;

const app = express();
app.use(express.static('public'));
let webServer = https.createServer({
	key: fs.readFileSync('./certs/server-key.pem'),
	cert: fs.readFileSync('./certs/server-crt.pem')
}, app).listen(8443, () => {
	console.log('server start.');
});

// socket.io server.
const io = require('socket.io')(webServer, {
	cors: {
		origin: "*",
		methods: ["GET", "POST"]
	}
});

io.on('connection', (socket) => {

	socket.on('disconnect', () => {
		console.log('disconnect', socket.id);
		cleanUpPeer(socket.id);
	});
	socket.on('error', (error) => {
		console.log('error', socket.id, error);
	});
	socket.on('connect_error', (error) => {
		console.log('connect_error', socket.id, error);
	});
	socket.on('consume', async (data, callback) => {
		console.error('ERROR - socket.on(consume) not supported.');
	});
	socket.on('resume', async (data, callback) => {
		console.error('ERROR - socket.on(resume) not supported.');
	});

	socket.on('getRouterRtpCapabilities', (data, callback) => {
		if (_router) {
			sendResponse(_router.rtpCapabilities, callback);
		} else {
			sendReject({ text: 'ERROR - router not ready' }, callback);
		}
	});

	// producer.
	socket.on('createProducerTransport', async (data, callback) => {
		const { transport, params } = await createTransport();
		addProducerTransport(socket.id, transport);
		transport.observer.on('close', () => {
			console.log('ProducerTransport.observer', 'close');
			const videoProducer = getProducer(socket.id, 'video');
			if (videoProducer) {
				videoProducer.close();
				removeProducer(socket.id, 'video');
			}
			const audioProducer = getProducer(socket.id, 'audio');
			if (audioProducer) {
				audioProducer.close();
				removeProducer(socket.id, 'audio');
			}
			removeProducerTransport(socket.id);
		});
		transport.observer.on('newproducer', (producer) => {
			console.log('ProducerTransport.observer', 'newproducer');
			producer.observer.on('close', () => {
				console.log('ProducerTransport.observer[NEW]', 'close');
			});
		});

		sendResponse(params, callback);
	});
	socket.on('connectProducerTransport', async (data, callback) => {
		const producerTransport = getProducerTransport(socket.id);
		if (!producerTransport) {
			sendReject({ text: 'producerTransport not exist' }, callback);
			return;
		}
		await producerTransport.connect({ dtlsParameters: data.dtlsParameters });
		sendResponse({}, callback);
	});
	socket.on('produce', async (data, callback) => {
		const { kind, rtpParameters } = data;
		const producerTransport = getProducerTransport(socket.id);
		if (!producerTransport) {
			sendReject({ text: 'producerTransport not exist' }, callback);
			return;
		}
		const producer = await producerTransport.produce({ kind, rtpParameters });
		addProducer(socket.id, producer, kind);

		sendResponse({ id: producer.id }, callback);
		// broadcast 'newProducer'.
		socket.broadcast.emit('newProducer', { remoteId: socket.id, producerId: producer.id, kind: producer.kind });
	});

	// consumer.
	socket.on('createConsumerTransport', async (data, callback) => {
		const { transport, params } = await createTransport();
		addConsumerTransport(socket.id, transport);
		transport.observer.on('close', () => {
			console.log('ConsumerTransport.observer', 'close');
			removeConsumerSetDeep(socket.id);
			removeConsumerTransport(socket.id);
		});
		transport.observer.on('newconsumer', (consumer) => {
			console.log('ConsumerTransport.observer', 'newconsumer');
		});
		sendResponse(params, callback);
	});
	socket.on('connectConsumerTransport', async (data, callback) => {
		let consumerTransport = getConsumerTransport(socket.id);
		if (!consumerTransport) {
			sendReject({ text: 'consumerTransport not exist' }, callback);
			return;
		}
		await consumerTransport.connect({ dtlsParameters: data.dtlsParameters });
		sendResponse({}, callback);
	});

	socket.on('getCurrentProducers', async (data, callback) => {
		const clientId = data.localId;
		const remoteVideoIds = getRemoteVideoIds(clientId);
		const remoteAudioIds = getRemoteAudioIds(clientId);
		sendResponse({ remoteVideoIds, remoteAudioIds }, callback);
	});

	socket.on('newConsumer', async (data, callback) => {
		const kind = data.kind;

		let consumerTransport = getConsumerTransport(socket.id);
		if (!consumerTransport) {
			sendReject({ text: 'consumerTransport not exist' }, callback);
			return;
		}

		const rtpCapabilities = data.rtpCapabilities;
		const remoteId = data.remoteId;
		console.log('newConsumer', remoteId, socket.id);
		const producer = getProducer(remoteId, kind);
		if (!producer) {
			sendReject({ text: `${kind} producer not exist` }, callback);
			return;
		}
		const { consumer, params } = await createConsumer(consumerTransport, producer, rtpCapabilities);
		addConsumer(socket.id, remoteId, consumer, kind);
		consumer.observer.on('close', () => {
			console.log('consumer.observer', 'close');
		});
		consumer.on('producerclose', () => {
			console.log('consumer', 'producerclose');
			consumer.close();
			removeConsumer(socket.id, remoteId, kind);
			socket.emit('producerClosed', { localId: socket.id, remoteId, kind });
		});

		sendResponse(params, callback);
	});

	socket.on('resumeConsumer', async (data, callback) => {
		const remoteId = data.remoteId;
		const kind = data.kind;
		let consumer = getConsumer(socket.id, remoteId, kind);
		if (!consumer) {
			sendReject({ text: `${kind} consumer not exist` }, callback);
			return;
		}
		await consumer.resume();
		sendResponse({}, callback);
	});

	function sendResponse(response, callback) {
		callback(null, response);
	}

	function sendReject(error, callback) {
		callback(error.toString(), null);
	}
});

function cleanUpPeer(id) {
	removeConsumerSetDeep(id);

	const transport = getConsumerTransport(id);
	if (transport) {
		transport.close();
		removeConsumerTransport(id);
	}

	const videoProducer = getProducer(id, 'video');
	if (videoProducer) {
		videoProducer.close();
		removeProducer(id, 'video');
	}
	const audioProducer = getProducer(id, 'audio');
	if (audioProducer) {
		audioProducer.close();
		removeProducer(id, 'audio');
	}

	const producerTransport = getProducerTransport(id);
	if (producerTransport) {
		producerTransport.close();
		removeProducerTransport(id);
	}
}

// mediasoup
//process.env.MEDIASOUP_WORKER_BIN = './mediasoup-worker';
//console.log(process.env);

const mediasoup = require('mediasoup');
console.log(mediasoup.version);
const mediasoupOptions = {
	// Worker settings
	worker: {
		rtcMinPort: 10000,
		rtcMaxPort: 10100,
		logLevel: 'warn',
		logTags: [
			'info',
			'ice',
			'dtls',
			'rtp',
			'srtp',
			'rtcp',
			// 'rtx',
			// 'bwe',
			// 'score',
			// 'simulcast',
			// 'svc'
		],
	},
	// Router settings
	router: {
		mediaCodecs:
		[
			{
				kind: 'audio',
				mimeType: 'audio/opus',
				clockRate: 48000,
				channels: 2
			},
			{
				kind: 'video',
				mimeType: 'video/VP8',
				clockRate: 90000,
				parameters:
				{
					'x-google-start-bitrate': 1000
				}
			},
		]
	},
	// WebRtcTransport settings
	webRtcTransport: {
		listenIps: [
			{ ip: '127.0.0.1' },
			{ ip: '0.0.0.0', announcedIp: '192.168.0.13' }
		],
		enableUdp: true,
		enableTcp: true,
		preferUdp: true,
		enableSctp: true, // add
		maxIncomingBitrate: 1500000,
		initialAvailableOutgoingBitrate: 1000000,
	}
};

let _worker = undefined;
let _router = undefined;

async function startWorker() {
	const mediaCodecs = mediasoupOptions.router.mediaCodecs;
	_worker = await mediasoup.createWorker();
	_router = await _worker.createRouter({ mediaCodecs });
}

startWorker();


// multi producers.
let producerTransports = {};
let videoProducers = {};
let audioProducers = {};

function getProducerTransport(id) {
	return producerTransports[id];
}

function addProducerTransport(id, transport) {
	producerTransports[id] = transport;
}

function removeProducerTransport(id) {
	delete producerTransports[id];
}

function getProducer(id, kind) {
	if ('video' === kind) {
		return videoProducers[id];
	} else if ('audio' === kind) {
		return audioProducers[id];
	}
}

function addProducer(id, producer, kind) {
	if ('video' === kind) {
		videoProducers[id] = producer;
	} else if ('audio' === kind) {
		audioProducers[id] = producer;
	}
}

function removeProducer(id, kind) {
	if ('video' === kind) {
		delete videoProducers[id];
	} else if ('audio' === kind) {
		delete audioProducers[id];
	}
}

function getRemoteVideoIds(clientId) {
	let remoteIds = [];
	for (let key in videoProducers) {
		if (key !== clientId) {
			remoteIds.push(key);
		}
	}
	return remoteIds;
}

function getRemoteAudioIds(clientId) {
	let remoteIds = [];
	for (let key in audioProducers) {
		if (key !== clientId) {
			remoteIds.push(key);
		}
	}
	return remoteIds;
}

// multi consumers
let consumerTransports = {};
let videoConsumers = {};
let audioConsumers = {};

function getConsumerTransport(id) {
	return consumerTransports[id];
}

function addConsumerTransport(id, transport) {
	consumerTransports[id] = transport;
}

function removeConsumerTransport(id) {
	delete consumerTransports[id];
}

function getConsumerSet(localId, kind) {
	if ('video' === kind) {
		return videoConsumers[localId];
	} else if ('audio' === kind) {
		return audioConsumers[localId];
	}
}

function getConsumer(localId, remoteId, kind) {
	const set = getConsumerSet(localId, kind);
	if (set) {
		return set[remoteId];
	}
}

function addConsumer(localId, remoteId, consumer, kind) {
	const set = getConsumerSet(localId, kind);
	if (set) {
		set[remoteId] = consumer;
		return;
	}

	// new set.
	const newSet = {};
	newSet[remoteId] = consumer;
	addConsumerSet(localId, newSet, kind);
}

function removeConsumer(localId, remoteId, kind) {
	const set = getConsumerSet(localId, kind);
	if (set) {
		delete set[remoteId];
	}
}

function removeConsumerSetDeep(localId) {
	const videoSet = getConsumerSet(localId, 'video');
	delete videoConsumers[localId];
	if (videoSet) {
		for (let key in videoSet) {
			const consumer = videoSet[key];
			consumer.close();
			delete videoSet[key];
		}
	}

	const audioSet = getConsumerSet(localId, 'audio');
	delete audioConsumers[localId];
	if (audioSet) {
		for (let key in audioSet) {
			const consumer = audioSet[key];
			consumer.close();
			delete audioSet[key];
		}
	}
}

function addConsumerSet(localId, set, kind) {
	if ('video' === kind) {
		videoConsumers[localId] = set;
	} else if ('audio' === kind) {
		audioConsumers[localId] = set;
	}
}

async function createTransport() {
	const transport = await _router.createWebRtcTransport(mediasoupOptions.webRtcTransport);
	//console.log('sctpParameters', transport.sctpParameters);
	return {
		transport: transport,
		params: {
			id: transport.id,
			iceParameters: transport.iceParameters,
			iceCandidates: transport.iceCandidates,
			dtlsParameters: transport.dtlsParameters,
			sctpParameters: transport.sctpParameters
		}
	};
}

async function createConsumer(transport, producer, rtpCapabilities) {
	let consumer = null;
	if (!_router.canConsume({ producerId: producer.id, rtpCapabilities })) {
		return;
	}

	consumer = await transport.consume({
		producerId: producer.id,
		rtpCapabilities,
		paused: producer.kind === 'video',
	}).catch(error => {
		return;
	});

	return {
		consumer: consumer,
		params: {
			producerId: producer.id,
			id: consumer.id,
			kind: consumer.kind,
			rtpParameters: consumer.rtpParameters,
			type: consumer.type,
			producerPaused: consumer.producerPaused
		}
	};
}

// graceful shutdown.
if (process.platform === "win32") {
	console.log('windows platform');
	const readline = require("readline").createInterface({
		input: process.stdin,
		output: process.stdout
	});

	readline.on("SIGINT", function () {
		console.log('SIGINT (readline)');
		process.emit("SIGINT");
	});
}

const shutdownManager = new GracefulShutdownManager(webServer);
process.on('SIGINT', () => {
	console.log('\nSIGINT');
	shutdownManager.terminate(() => {
		console.log('Server is gracefully terminated.');
		process.exit();
	});
});
