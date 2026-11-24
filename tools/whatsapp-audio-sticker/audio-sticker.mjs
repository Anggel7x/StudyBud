#!/usr/bin/env node
// Send a WhatsApp "sticker with sound" (audioStickerMessage, Message field 134) using Baileys.
//
// Wire shape (reverse-engineered by the community, not official):
//   Message {
//     messageContextInfo { messageSecret: 32 random bytes }
//     [134] audioStickerMessage: FutureProofMessage {
//       [1] message: Message {
//         [26] stickerMessage: StickerMessage {
//           ...normal uploaded WebP sticker fields...
//           [26] audioMessage: AudioMessage { ...uploaded Ogg/Opus, ptt: true... }
//         }
//       }
//     }
//   }
// Baileys' bundled protobuf schema does not know field 134 or StickerMessage field 26,
// so we encode those two layers by hand and splice them in when Baileys encodes the message.
//
// Usage:
//   node audio-sticker.mjs build <image|gif|video> <audio> [--seconds 10]
//   node audio-sticker.mjs send  <image|gif|video> <audio> --to <number|jid> [--seconds 10]
//                                [--stanza text|media] [--pair <your number>] [--auth ./auth]

import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import {
	Browsers,
	DisconnectReason,
	default as makeWASocket,
	prepareWAMessageMedia,
	proto,
	useMultiFileAuthState
} from 'baileys'
import pino from 'pino'
import sharp from 'sharp'
import qrcode from 'qrcode-terminal'

const run = promisify(execFile)
const MAX_STICKER_BYTES = 1024 * 1024 // WhatsApp rejects stickers over ~1 MB

const TAG_STICKER_AUDIO = (26 << 3) | 2 // StickerMessage.audioMessage
const TAG_AUDIO_STICKER = (134 << 3) | 2 // Message.audioStickerMessage
const TAG_FP_MESSAGE = (1 << 3) | 2 // FutureProofMessage.message
const TAG_MSG_STICKER = (26 << 3) | 2 // Message.stickerMessage

// ---------- protobuf helpers ----------

const varint = n => {
	const out = []
	while (n > 127) {
		out.push((n & 0x7f) | 0x80)
		n >>>= 7
	}
	out.push(n)
	return Buffer.from(out)
}
const lengthDelimited = (tag, bytes) => Buffer.concat([varint(tag), varint(bytes.length), Buffer.from(bytes)])

/** Bytes of FutureProofMessage{ message: { stickerMessage: { ...sticker, audioMessage } } } */
export function encodeAudioStickerWrapper(stickerMessage, audioMessage) {
	const audioBytes = proto.Message.AudioMessage.encode(audioMessage).finish()
	const stickerBytes = Buffer.concat([
		proto.Message.StickerMessage.encode(stickerMessage).finish(),
		lengthDelimited(TAG_STICKER_AUDIO, audioBytes)
	])
	const innerMessage = lengthDelimited(TAG_MSG_STICKER, stickerBytes)
	return lengthDelimited(TAG_FP_MESSAGE, innerMessage)
}

// Messages carrying this symbol get field 134 appended when Baileys encodes them.
const RAW_134 = Symbol('audioStickerMessage')
const MEDIA_STANZA = Symbol('mediaStanza')
const originalEncode = proto.Message.encode
proto.Message.encode = function encode(m, w) {
	const writer = originalEncode.call(this, m, w)
	if (m && m[RAW_134]) writer.uint32(TAG_AUDIO_STICKER).bytes(m[RAW_134])
	return writer
}

/**
 * The message object to hand to sock.relayMessage().
 * mediaStanza=true makes Baileys label the stanza type="media" + mediatype="sticker"
 * (via a non-own getter it reads but the encoder ignores); otherwise it goes as type="text".
 */
export function buildAudioStickerMessage(stickerMessage, audioMessage, { mediaStanza = false } = {}) {
	const proto_ = mediaStanza ? { get stickerMessage() { return { [MEDIA_STANZA]: true } } } : Object.prototype
	const msg = Object.create(proto_)
	msg.messageContextInfo = { messageSecret: randomBytes(32) }
	msg[RAW_134] = encodeAudioStickerWrapper(stickerMessage, audioMessage)
	return msg
}

// ---------- media conversion ----------

async function probe(file) {
	const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,nb_frames', '-of', 'json', file])
	const info = JSON.parse(stdout)
	const video = info.streams?.find(s => s.codec_type === 'video')
	const duration = Number(info.format?.duration) || 0
	const frames = Number(video?.nb_frames) || 0
	return { duration, hasVideo: !!video, animated: !!video && (frames > 1 || (frames === 0 && duration > 0.2)) }
}

async function toWebp(input, workdir) {
	const { animated } = await probe(input)
	const scale = 'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000'
	const attempts = animated
		? [{ q: 50, fps: 15, t: 10 }, { q: 30, fps: 10, t: 8 }, { q: 20, fps: 8, t: 6 }, { q: 10, fps: 6, t: 4 }]
		: [{ q: 80 }, { q: 50 }, { q: 25 }]
	// ffmpeg only resizes/decodes into formats every build has (PNG / GIF); WebP encoding is done
	// by sharp, because many ffmpeg builds (e.g. Homebrew's) ship without libwebp.
	for (const [i, a] of attempts.entries()) {
		const mid = path.join(workdir, `frame${i}.${animated ? 'gif' : 'png'}`)
		const args = animated
			? ['-y', '-i', input, '-t', String(a.t), '-an', '-vf',
				`${scale},fps=${a.fps},split[s0][s1];[s0]palettegen=reserve_transparent=1[p];[s1][p]paletteuse`, '-loop', '0', mid]
			: ['-y', '-i', input, '-an', '-frames:v', '1', '-update', '1', '-vf', scale, mid]
		await run('ffmpeg', ['-v', 'error', ...args])
		const out = path.join(workdir, `sticker${i}.webp`)
		await sharp(mid, { animated }).webp({ quality: a.q, loop: 0, effort: 6 }).toFile(out)
		const buf = await readFile(out)
		if (buf.length <= MAX_STICKER_BYTES) return { buffer: buf, animated, file: out }
	}
	throw new Error('Could not get the sticker under 1 MB; use a shorter/smaller input')
}

async function toOggOpus(input, workdir, maxSeconds) {
	const out = path.join(workdir, 'sound.ogg')
	// -vbr/-compression_level/-frame_duration/-avoid_negative_ts: without them phones show the
	// sticker but refuse to play its sound (per the zapota implementation).
	await run('ffmpeg', ['-v', 'error', '-y', '-i', input, '-vn', '-t', String(maxSeconds),
		'-ar', '16000', '-ac', '1', '-c:a', 'libopus', '-b:a', '32k', '-vbr', 'on', '-compression_level', '10',
		'-frame_duration', '20', '-application', 'voip', '-avoid_negative_ts', 'make_zero', '-map_metadata', '-1',
		'-f', 'ogg', out])
	const { duration } = await probe(out)
	const { stdout: pcm } = await run('ffmpeg', ['-v', 'error', '-i', out, '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1'],
		{ encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 })
	return { buffer: await readFile(out), seconds: Math.min(maxSeconds, Math.max(1, Math.ceil(duration))), waveform: waveformFromPcm(pcm), file: out }
}

function waveformFromPcm(pcm, bars = 64) {
	const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2))
	const size = Math.max(1, Math.floor(samples.length / bars))
	const peaks = Array.from({ length: bars }, (_, b) => {
		let sum = 0
		for (let i = b * size; i < Math.min((b + 1) * size, samples.length); i++) sum += Math.abs(samples[i])
		return sum / size
	})
	const max = Math.max(...peaks) || 1
	return new Uint8Array(peaks.map(p => Math.round((p / max) * 100)))
}

export async function prepareFiles(visual, audio, seconds, workdir) {
	const [sticker, sound] = await Promise.all([toWebp(visual, workdir), toOggOpus(audio, workdir, seconds)])
	return { sticker, sound }
}

// ---------- WhatsApp ----------

function connect(authDir, pairNumber) {
	return new Promise(async (resolve, reject) => {
		const { state, saveCreds } = await useMultiFileAuthState(authDir)
		const sock = makeWASocket({ auth: state, logger: pino({ level: 'warn' }), browser: Browsers.macOS('Chrome') })
		sock.ev.on('creds.update', saveCreds)
		let pairingRequested = false
		sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
			if (qr) {
				if (pairNumber && !pairingRequested) {
					pairingRequested = true
					const code = await sock.requestPairingCode(pairNumber.replace(/\D/g, ''))
					console.log(`\nPairing code: ${code}\nWhatsApp > Linked devices > Link with phone number instead\n`)
				} else if (!pairNumber) {
					console.log('\nScan this QR with WhatsApp > Linked devices:\n')
					qrcode.generate(qr, { small: true })
				}
			}
			if (connection === 'open') resolve(sock)
			if (connection === 'close') {
				const code = lastDisconnect?.error?.output?.statusCode
				if (code === DisconnectReason.restartRequired) {
					resolve(connect(authDir, pairNumber)) // normal right after first login
				} else {
					reject(lastDisconnect?.error ?? new Error('connection closed'))
				}
			}
		})
	})
}

const toJid = to => (to.includes('@') ? to : `${to.replace(/\D/g, '')}@s.whatsapp.net`)

async function send({ visual, audio, to, seconds, stanza, pair, auth }, workdir) {
	const { sticker, sound } = await prepareFiles(visual, audio, seconds, workdir)
	console.log(`sticker ${sticker.buffer.length} B (animated=${sticker.animated}), sound ${sound.buffer.length} B, ${sound.seconds}s`)

	const sock = await connect(auth, pair)
	const upload = sock.waUploadToServer
	const { stickerMessage } = await prepareWAMessageMedia({ sticker: sticker.buffer }, { upload })
	const { audioMessage } = await prepareWAMessageMedia(
		{ audio: sound.buffer, mimetype: 'audio/ogg; codecs=opus', ptt: true, seconds: sound.seconds, waveform: sound.waveform },
		{ upload }
	)
	stickerMessage.isAnimated = sticker.animated
	stickerMessage.width = 512
	stickerMessage.height = 512

	const jid = toJid(to)
	const message = buildAudioStickerMessage(stickerMessage, audioMessage, { mediaStanza: stanza === 'media' })
	const id = await sock.relayMessage(jid, message, {})
	console.log(`sent ${id} to ${jid} (stanza ${stanza === 'media' ? 'type=media mediatype=sticker' : 'type=text'})`)
	await new Promise(r => setTimeout(r, 3000)) // let acks flush
	sock.end(undefined)
}

// ---------- CLI ----------

function parseArgs(argv) {
	const [cmd, visual, audio, ...rest] = argv
	const opts = { cmd, visual, audio, seconds: 10, stanza: 'text', auth: './auth' }
	for (let i = 0; i < rest.length; i += 2) opts[rest[i].replace(/^--/, '')] = rest[i + 1]
	opts.seconds = Math.min(30, Math.max(1, Number(opts.seconds) || 10))
	return opts
}

async function main() {
	const opts = parseArgs(process.argv.slice(2))
	if (!['build', 'send'].includes(opts.cmd) || !opts.visual || !opts.audio || (opts.cmd === 'send' && !opts.to)) {
		console.log(`usage:
  node audio-sticker.mjs build <image|gif|video> <audio> [--seconds 10] [--out ./out]
  node audio-sticker.mjs send  <image|gif|video> <audio> --to <number|jid> [--seconds 10]
                               [--stanza text|media] [--pair <your number>] [--auth ./auth]`)
		process.exit(1)
	}
	await stat(opts.visual)
	await stat(opts.audio)
	const workdir = await mkdtemp(path.join(tmpdir(), 'audio-sticker-'))
	try {
		if (opts.cmd === 'build') {
			const { sticker, sound } = await prepareFiles(opts.visual, opts.audio, opts.seconds, workdir)
			const out = opts.out ?? './out'
			await run('mkdir', ['-p', out])
			await run('cp', [sticker.file, path.join(out, 'sticker.webp')])
			await run('cp', [sound.file, path.join(out, 'sound.ogg')])
			console.log(`wrote ${out}/sticker.webp (${sticker.buffer.length} B, animated=${sticker.animated})`)
			console.log(`wrote ${out}/sound.ogg (${sound.buffer.length} B, ${sound.seconds}s)`)
		} else {
			await send(opts, workdir)
		}
	} finally {
		await rm(workdir, { recursive: true, force: true })
	}
	process.exit(0)
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch(err => {
		console.error(err)
		process.exit(1)
	})
}
